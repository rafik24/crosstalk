// rest-api.mjs — HTTP surface for the Crosstalk coordination bus.
//
// Exports a single factory, createRestRouter(db), returning an express.Router that
// the server mounts at /api. Every route is a thin, validated adapter over the db
// object's method interface: parse + check the request, call one db method, shape
// the JSON reply. All persistence lives in db.mjs; nothing here talks to SQL.
//
// Conventions used throughout:
//   - handlers are async and wrapped by run() so any rejection reaches the error
//     middleware (behaviourally identical to try/catch -> next(e));
//   - bad input -> 400 {error}; a missing referenced id/key -> 404 {error};
//   - success payloads follow the shapes named in the spec.

import express from 'express';
import { WORK_STATES, WORK_KINDS, normalizeChannelName } from './db.mjs';
import { canonicalShort } from '../src/cc-render.mjs';

// Canonicalize an identity's short name server-side (#5): whatever a client registers, the
// stored/advertised `host/<short>` has its short normalized the SAME way a dm-<short> channel is,
// so id == dm-channel byte-for-byte. The host part is left as-is (only the short drives dm routing).
function canonicalizeIdentity(id) {
  const s = String(id);
  const slash = s.lastIndexOf('/');
  if (slash < 0) return canonicalShort(s) || s;
  const host = s.slice(0, slash);
  const short = canonicalShort(s.slice(slash + 1));
  return short ? `${host}/${short}` : s;
}

// Accepted values for a message's message_type field. This is the wire vocabulary
// for chatter on a channel and is unrelated to the work-board's kinds/states.
const MESSAGE_TYPES = ['message', 'request', 'response', 'status', 'handoff', 'done'];

// A heartbeat older than this (seconds) is treated as offline when /instances is read.
const PRESENCE_STALE_SECONDS = 90;

// Defaults for the two list endpoints that page results.
const DEFAULT_MESSAGE_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 10;

// Hard ceiling on any client-supplied page size, so a single request can't ask for
// an unbounded scan. Applies on top of the defaults above.
const MAX_LIMIT = 200;

// Input size ceilings. Free-text bodies are capped by BYTE size (Buffer.byteLength,
// UTF-8) so a multibyte payload can't slip past a char count; short identifier-like
// fields (title, key) are capped by CHARACTER length. Oversize -> 413.
const MAX_CONTENT_BYTES = 16 * 1024; // 16 KB
const MAX_TITLE_CHARS = 512;
const MAX_KEY_CHARS = 256;

// --- small local helpers -------------------------------------------------------

function isFilledString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Coerce a query/route value to a non-negative integer, or undefined when it is
// absent or not a clean integer. Used for ids, after_id and limits.
function toCount(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// Resolve a client-supplied page size: fall back to `fallback` when absent/invalid,
// then clamp to MAX_LIMIT so no request can ask for an unbounded scan.
function toLimit(value, fallback) {
  return Math.min(toCount(value) ?? fallback, MAX_LIMIT);
}

function reject(res, message) {
  return res.status(400).json({ error: message });
}

function notFound(res, message) {
  return res.status(404).json({ error: message });
}

function tooLarge(res, message) {
  return res.status(413).json({ error: message });
}

export function createRestRouter(db) {
  const router = express.Router();

  // Funnel an async handler's rejection into the error middleware below.
  const run = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

  // --- presence ---------------------------------------------------------------

  router.post(
    '/register',
    run(async (req, res) => {
      const { instance_id, description, rev } = req.body || {};
      if (!isFilledString(instance_id)) return reject(res, 'instance_id is required');
      // (The fleet version gate is enforced for the whole /api plane by versionGateMiddleware in
      // server.mjs — see version-gate.mjs — so a stale caller is already refused 426 before here.)
      // #5 backstop: canonicalize the short name so a rejoin re-attaches its dm channel and no
      // slug variant forks a duplicate peer. The response echoes the canonical id the client holds.
      const canonical = canonicalizeIdentity(instance_id);
      await db.registerInstance(canonical, description ?? null, rev ?? null);
      res.json({ ok: true, instance_id: canonical });
    })
  );

  router.get(
    '/instances',
    run(async (_req, res) => {
      // Sweep stale heartbeats to offline before reporting the roster.
      await db.markStaleOffline(PRESENCE_STALE_SECONDS);
      const instances = await db.listInstances();
      res.json({ instances });
    })
  );

  // --- channels ---------------------------------------------------------------

  router.post(
    '/channels',
    run(async (req, res) => {
      const { name, description } = req.body || {};
      const channel = normalizeChannelName(typeof name === 'string' ? name : '');
      if (!channel) return reject(res, 'a valid channel name is required');
      await db.createChannel(channel, description ?? null);
      res.json({ ok: true, channel });
    })
  );

  router.get(
    '/channels',
    run(async (_req, res) => {
      const channels = await db.listChannelsWithActivity();
      res.json({ channels });
    })
  );

  router.get(
    '/channels/search',
    run(async (req, res) => {
      const q = req.query.q;
      if (!isFilledString(q)) return reject(res, 'q is required');
      const channels = await db.findChannels(q);
      res.json({ channels });
    })
  );

  // --- messages ---------------------------------------------------------------

  router.post(
    '/messages',
    run(async (req, res) => {
      const body = req.body || {};
      const { sender, content } = body;
      const messageType = body.message_type ?? 'message';

      if (!isFilledString(sender)) return reject(res, 'sender is required');
      if (!isFilledString(content)) return reject(res, 'content is required');
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        return tooLarge(res, `content exceeds the ${MAX_CONTENT_BYTES}-byte limit`);
      }
      if (!MESSAGE_TYPES.includes(messageType)) {
        return reject(res, `message_type must be one of: ${MESSAGE_TYPES.join(', ')}`);
      }

      // in_reply_to, when supplied, must reference a real message. A missing parent
      // would otherwise hit the messages(in_reply_to) FK and surface as a 500 — so we
      // validate up front and 400, mirroring how /work checks parent_id.
      let inReplyTo = null;
      const rawReplyTo = body.in_reply_to;
      if (rawReplyTo !== undefined && rawReplyTo !== null && rawReplyTo !== '') {
        const candidate = toCount(rawReplyTo);
        // Message ids are positive integers; 0/invalid can never name a real row.
        const parent = candidate && candidate > 0 ? await db.getMessage(candidate) : null;
        if (!parent) return reject(res, `in_reply_to ${rawReplyTo} does not exist`);
        inReplyTo = candidate;
      }

      // Default to 'general', normalize, and make sure the channel row exists.
      const channel = normalizeChannelName(body.channel ?? 'general') || 'general';
      await db.createChannel(channel, null);

      const id = await db.sendMessage(channel, sender, content, messageType, inReplyTo);
      res.json({ ok: true, id, channel, message_type: messageType });
    })
  );

  router.get(
    '/messages/:channel',
    run(async (req, res) => {
      const channel = normalizeChannelName(req.params.channel);
      const afterId = toCount(req.query.after_id);
      const instanceId = isFilledString(req.query.instance_id) ? req.query.instance_id : undefined;
      const limit = toLimit(req.query.limit, DEFAULT_MESSAGE_LIMIT);

      let messages;
      if (instanceId !== undefined && afterId !== undefined) {
        // Everything newer than afterId that this instance did not itself send.
        messages = await db.getUnread(channel, afterId, instanceId);
      } else if (afterId !== undefined) {
        // Everything newer than afterId (ascending).
        messages = await db.getMessagesSince(channel, afterId);
      } else {
        // Latest `limit`, returned oldest-first for natural reading order.
        const latest = await db.getMessages(channel, limit);
        messages = latest.slice().reverse();
      }

      const lastId = messages.length ? messages[messages.length - 1].id : (afterId ?? 0);
      res.json({ messages, last_id: lastId });
    })
  );

  router.get(
    '/messages/:channel/:id/replies',
    run(async (req, res) => {
      const id = toCount(req.params.id);
      if (id === undefined) return reject(res, 'a numeric message id is required');
      const parent = await db.getMessage(id);
      if (!parent) return notFound(res, 'message not found');
      const replies = await db.getReplies(id);
      res.json({ parent, replies });
    })
  );

  router.get(
    '/search',
    run(async (req, res) => {
      const q = req.query.q;
      if (!isFilledString(q)) return reject(res, 'q is required');
      const limit = toLimit(req.query.limit, DEFAULT_SEARCH_LIMIT);
      const messages = await db.searchMessages(q, limit);
      res.json({ messages });
    })
  );

  // --- shared data ------------------------------------------------------------

  router.post(
    '/data',
    run(async (req, res) => {
      const { key, content, sender, description } = req.body || {};
      if (!isFilledString(key)) return reject(res, 'key is required');
      if (!isFilledString(content)) return reject(res, 'content is required');
      if (!isFilledString(sender)) return reject(res, 'sender is required');
      if (key.length > MAX_KEY_CHARS) {
        return tooLarge(res, `key exceeds the ${MAX_KEY_CHARS}-character limit`);
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        return tooLarge(res, `content exceeds the ${MAX_CONTENT_BYTES}-byte limit`);
      }
      await db.shareData(key, content, sender, description ?? null);
      res.json({ ok: true, key, size_bytes: Buffer.byteLength(content, 'utf8') });
    })
  );

  router.get(
    '/data',
    run(async (_req, res) => {
      const items = await db.listSharedData();
      res.json({ items });
    })
  );

  router.get(
    '/data/:key',
    run(async (req, res) => {
      const doc = await db.getSharedData(req.params.key);
      if (!doc) return notFound(res, 'shared data not found');
      res.json(doc);
    })
  );

  // --- work board -------------------------------------------------------------

  router.post(
    '/work',
    run(async (req, res) => {
      const body = req.body || {};
      if (!isFilledString(body.title)) return reject(res, 'title is required');
      if (body.title.length > MAX_TITLE_CHARS) {
        return tooLarge(res, `title exceeds the ${MAX_TITLE_CHARS}-character limit`);
      }

      const kind = body.kind ?? undefined;
      if (kind !== undefined && !WORK_KINDS.includes(kind)) {
        return reject(res, `kind must be one of: ${WORK_KINDS.join(', ')}`);
      }

      const state = body.state ?? undefined;
      if (state !== undefined && !WORK_STATES.includes(state)) {
        return reject(res, `state must be one of: ${WORK_STATES.join(', ')}`);
      }

      // parent_id, when supplied, must be a real integer id pointing at a live item.
      let parentId;
      if (body.parent_id !== undefined && body.parent_id !== null && body.parent_id !== '') {
        parentId = toCount(body.parent_id);
        if (parentId === undefined) return reject(res, 'parent_id must be a positive integer');
        const parent = await db.getWorkItem(parentId);
        if (!parent) return reject(res, 'parent work item not found');
      }

      const item = await db.createWorkItem({
        project: body.project,
        title: body.title,
        external_ref: body.external_ref,
        parent_id: parentId,
        kind,
        domain: body.domain,
        owner: body.owner,
        state,
        created_by: body.created_by,
      });
      res.json({ ok: true, item });
    })
  );

  router.get(
    '/work',
    run(async (req, res) => {
      // `state` accepts either a single value (state=queued) or a comma-separated
      // list (state=queued,claimed). A list is passed to the db as `states`; a lone
      // value stays on `state` so the single-filter path is unchanged.
      const rawState = req.query.state;
      let state;
      let states;
      if (typeof rawState === 'string' && rawState.includes(',')) {
        states = rawState.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        state = rawState;
      }

      const items = await db.listWorkItems({
        project: req.query.project,
        state,
        states,
        owner: req.query.owner,
        parent_id: toCount(req.query.parent_id),
        kind: req.query.kind,
        updated_after: req.query.updated_after,
      });
      res.json({ items });
    })
  );

  router.get(
    '/work/:id',
    run(async (req, res) => {
      const id = toCount(req.params.id);
      if (id === undefined) return reject(res, 'a numeric work id is required');
      const item = await db.getWorkItem(id);
      if (!item) return notFound(res, 'work item not found');
      res.json({ item });
    })
  );

  router.post(
    '/work/:id/claim',
    run(async (req, res) => {
      const id = toCount(req.params.id);
      if (id === undefined) return reject(res, 'a numeric work id is required');
      const { owner } = req.body || {};
      if (!isFilledString(owner)) return reject(res, 'owner is required');

      const existing = await db.getWorkItem(id);
      if (!existing) return notFound(res, 'work item not found');

      // The atomic mutex lives in db.claimWorkItem: a second session claiming an
      // already-owned item comes back claimed:false, which we surface as 409.
      const result = await db.claimWorkItem(id, owner);
      if (!result.claimed) {
        return res.status(409).json({
          error: 'already claimed',
          reason: 'already_claimed',
          owner: result.item?.owner ?? null,
          item: result.item,
        });
      }
      res.json({ ok: true, item: result.item });
    })
  );

  router.post(
    '/work/:id/handoff',
    run(async (req, res) => {
      const id = toCount(req.params.id);
      if (id === undefined) return reject(res, 'a numeric work id is required');
      const existing = await db.getWorkItem(id);
      if (!existing) return notFound(res, 'work item not found');

      // Owner-gate (F4): only the current owner may hand off or release an OWNED item; an unowned
      // item can be assigned by anyone. `by` is the caller's id (cooperative guard, see /state).
      const by = (req.body || {}).by;
      if (existing.owner && by !== existing.owner) {
        return res.status(403).json({ error: 'not the owner', reason: 'not_owner', owner: existing.owner });
      }
      // An empty/absent owner releases the item (owner -> null); state is preserved.
      const raw = (req.body || {}).owner;
      const newOwner = isFilledString(raw) ? raw : null;
      const item = await db.transferWorkItem(id, newOwner);

      // #9: a board handoff was otherwise SILENT — transferWorkItem changes ownership in
      // the DB but nothing wakes the new owner over the bus, so a verifier that isn't
      // polling `cc-work list --mine` never learns work is theirs. Emit an addressed
      // `handoff` message so their cc-ws/cc-poll wakes them (»HANDOFF — ACK REQUIRED«).
      // db.sendMessage is decorated (server.mjs) to persist AND broadcast via the ws hub.
      // Only on a real assignment (not a release, owner -> null); never let a failed
      // notification fail the handoff itself.
      if (newOwner) {
        try {
          const from = isFilledString(by) ? by : 'cc-work';
          // Strip '@' from the interpolated title so a title like "@all cleanup" can't
          // widen who the notification is addressed to (cc-render keys addressing off any
          // @mention / @all in the body). The intended `@${newOwner}` below is unaffected.
          const title = String(item?.title ?? '').replace(/@/g, '').slice(0, 120);
          await db.createChannel('general', null);
          await db.sendMessage(
            'general',
            from,
            `@${newOwner} board handoff — work #${id} is now yours: "${title}"`,
            'handoff',
          );
        } catch (err) {
          console.error('[rest-api] handoff notify failed (transfer still applied):', err);
        }
      }
      res.json({ ok: true, item });
    })
  );

  router.post(
    '/work/:id/state',
    run(async (req, res) => {
      const id = toCount(req.params.id);
      if (id === undefined) return reject(res, 'a numeric work id is required');
      const { state, by } = req.body || {};
      if (!isFilledString(state) || !WORK_STATES.includes(state)) {
        return reject(res, `state must be one of: ${WORK_STATES.join(', ')}`);
      }
      const existing = await db.getWorkItem(id);
      if (!existing) return notFound(res, 'work item not found');
      // Owner-gate (F4): only the CURRENT OWNER may change a claimed item's state, so a claim
      // actually protects the item's lifecycle. Transitions themselves stay FREE (any legal state,
      // incl. blocked/revert — agents know their workflow better than a hardcoded pipeline). An
      // UNOWNED item is open to anyone. `by` is a cooperative coordination guard, NOT a security
      // boundary: every agent shares the token, so it is deliberately not spoof-proof.
      if (existing.owner && by !== existing.owner) {
        return res.status(403).json({ error: 'not the owner', reason: 'not_owner', owner: existing.owner });
      }
      const item = await db.setWorkItemState(id, state);
      res.json({ ok: true, item });
    })
  );

  // --- error middleware -------------------------------------------------------
  // Any rejection surfaced by run() lands here: log it and answer 500.
  // eslint-disable-next-line no-unused-vars -- express detects an error handler by arity (4 args)
  router.use((err, _req, res, _next) => {
    // Log the real detail server-side; never leak err.message to the client.
    console.error('[rest-api] unhandled error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
  });

  return router;
}
