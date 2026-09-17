// db.mjs — Crosstalk storage layer. SQLite-only.
//
// One db object backed by SQLite via Node's built-in `node:sqlite` (DatabaseSync), file at
// ${CC_DATA_DIR||~/.crosstalk}/messages.db (migrated once from the old ~/.cross-claude-mcp).
// Using the built-in driver — instead of the native `better-sqlite3` addon — means the server
// has ZERO native dependencies, so it runs from a bare `claude plugin install` on any node
// (no compile step, survives every plugin update). See rafik24/crosstalk#18.
//
// The backend is hidden behind a small "adapter" whose query methods are ALWAYS async.
// The underlying node:sqlite calls are synchronous, so we just wrap their results in
// resolved promises; every db method below awaits the adapter, so callers already `await`
// everything and the async surface stays stable.
//
// SQL-injection safety: user-supplied values are ALWAYS passed as bound parameters (`?`),
// never interpolated into the SQL text. The only things interpolated are internal, trusted
// SQL fragments (SQL keywords, column names, and fixed retention amounts).

// node:sqlite is still marked experimental and prints a one-time ExperimentalWarning on load.
// That warning is emitted through an internal path that a `process.emitWarning` override does
// NOT intercept, so it is silenced at the process level instead: the bus server child is
// spawned with `--disable-warning=ExperimentalWarning` (cc-bus.mjs spawnLeader) and the `server`
// npm script carries the same flag — keeping every OTHER warning intact.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { dataDir as resolveDataDir } from '../src/cc-paths.mjs';

// ── Public constants ────────────────────────────────────────────────────────

// Lifecycle a work item moves through on the board.
export const WORK_STATES = [
  'queued',
  'claimed',
  'implementing',
  'in-review',
  'merged',
  'deployed',
  'blocked',
  'abandoned',
];

// The three shapes of work we track.
export const WORK_KINDS = ['epic', 'task', 'bug'];

/**
 * Reduce an arbitrary channel label to a safe slug:
 *   lowercase → spaces/underscores become dashes → drop anything outside [a-z0-9-]
 *   → collapse runs of dashes → trim leading/trailing dashes.
 * e.g. "  Hello World_Foo!! " → "hello-world-foo"
 */
export function normalizeChannelName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Backend adapter ─────────────────────────────────────────────────────────
//
// The adapter exposes:
//   raw                             underlying handle (used by tests + snapshot)
//   now                             SQL expression for "current timestamp"
//   maxOf(a, b)                     scalar max of two values
//   sendersCsv(col)                 distinct comma-joined aggregate of a column
//   olderThan(col, amount, unit)    -> { clause, params } comparing col against now-<amount unit>
//   all / get / run / insert        async query helpers ('?' placeholders)
//   exec(sql)                       run DDL (possibly multiple statements)
//   snapshot(dest) / close()

// Convert `undefined` binds to `null` — node:sqlite (like better-sqlite3 before it) rejects
// an undefined bind outright ("Provided value cannot be bound to SQLite parameter").
const cleanParams = (params) => (params ?? []).map((p) => (p === undefined ? null : p));

function makeSqliteAdapter(handle) {
  return {
    raw: handle,
    now: "datetime('now')",
    maxOf: (a, b) => `max(${a}, ${b})`,
    sendersCsv: (col) => `group_concat(DISTINCT ${col})`,
    olderThan(col, amount, unit) {
      // The retention amount rides as a bound modifier string ("-7 days"); unit is trusted.
      return { clause: `${col} < datetime('now', ?)`, params: [`-${amount} ${unit}`] };
    },
    async all(sql, params) {
      return handle.prepare(sql).all(...cleanParams(params));
    },
    async get(sql, params) {
      return handle.prepare(sql).get(...cleanParams(params));
    },
    async run(sql, params) {
      const info = handle.prepare(sql).run(...cleanParams(params));
      return { changes: info.changes, lastId: Number(info.lastInsertRowid) };
    },
    async insert(sql, params) {
      const info = handle.prepare(sql).run(...cleanParams(params));
      return Number(info.lastInsertRowid);
    },
    async exec(sql) {
      handle.exec(sql);
    },
    async snapshot(dest) {
      // node:sqlite has no online .backup(); `VACUUM INTO` writes a single consistent,
      // WAL-safe copy of the live DB to `dest` — the equivalent for our export/replication path.
      // It REFUSES to write if the target already exists, so clear any stale file first
      // (mirrors better-sqlite3's overwrite semantics). `dest` is an internal, server-generated
      // temp path; double any single-quote defensively before it enters the SQL string literal.
      //
      // TRADE-OFF: unlike better-sqlite3's incremental .backup() (which yielded between page
      // batches), VACUUM INTO is one synchronous call that blocks the event loop for the whole
      // copy, so /cc/export and each replication tick briefly freeze request handling on the
      // leader — a cost that scales with DB size. Immaterial at the bus's scale (a few thousand
      // messages ⇒ single-digit ms); if the store ever grows large, revisit (e.g. checkpoint +
      // off-thread file copy, or a worker thread) rather than freezing the leader per tick.
      fs.rmSync(dest, { force: true });
      const safeDest = String(dest).replace(/'/g, "''");
      handle.exec(`VACUUM INTO '${safeDest}'`);
    },
    async close() {
      handle.close();
    },
  };
}

// ── Schema ──────────────────────────────────────────────────────────────────

function schemaStatements() {
  const pk = 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = "TEXT DEFAULT (datetime('now'))";
  const tsNullable = 'TEXT'; // for columns with no default (claimed_at)

  return [
    `CREATE TABLE IF NOT EXISTS channels (
       name TEXT PRIMARY KEY,
       description TEXT,
       created_at ${ts}
     )`,
    `CREATE TABLE IF NOT EXISTS messages (
       id ${pk},
       channel TEXT NOT NULL REFERENCES channels(name),
       sender TEXT NOT NULL,
       content TEXT NOT NULL,
       message_type TEXT DEFAULT 'message',
       in_reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
       created_at ${ts}
     )`,
    // Presence table. OAuth was dropped, so there is deliberately no session_token / invite_codes.
    `CREATE TABLE IF NOT EXISTS instances (
       instance_id TEXT PRIMARY KEY,
       description TEXT,
       last_seen ${ts},
       status TEXT DEFAULT 'online',
       rev TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS shared_data (
       key TEXT PRIMARY KEY,
       content TEXT NOT NULL,
       created_by TEXT NOT NULL,
       description TEXT,
       created_at ${ts}
     )`,
    `CREATE TABLE IF NOT EXISTS read_cursors (
       channel TEXT NOT NULL,
       instance_id TEXT NOT NULL,
       last_read_id INTEGER NOT NULL,
       updated_at ${ts},
       PRIMARY KEY (channel, instance_id)
     )`,
    `CREATE TABLE IF NOT EXISTS work_items (
       id ${pk},
       project TEXT NOT NULL DEFAULT 'default',
       title TEXT NOT NULL,
       external_ref TEXT,
       parent_id INTEGER REFERENCES work_items(id) ON DELETE SET NULL,
       kind TEXT NOT NULL DEFAULT 'task',
       domain TEXT,
       owner TEXT,
       state TEXT NOT NULL DEFAULT 'queued',
       created_by TEXT,
       claimed_at ${tsNullable},
       created_at ${ts},
       updated_at ${ts}
     )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_lookup ON messages (channel, sender, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_work_items_lookup ON work_items (project, state, owner, parent_id)`,
    // Hot-path indexes for the busy bus:
    //   messages(channel, id)     — the unread / since range scan (WHERE channel=? AND id>?)
    //   messages(created_at)      — cleanup's age sweep
    //   instances(last_seen,…)    — presence listing + markStaleOffline's status/last_seen scan
    //   shared_data(created_at)   — listSharedData ordering + cleanup
    //   read_cursors(updated_at)  — cleanup's 30-day cursor sweep
    `CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages (channel, id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_instances_last_seen_status ON instances (last_seen, status)`,
    `CREATE INDEX IF NOT EXISTS idx_shared_data_created_at ON shared_data (created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_read_cursors_updated_at ON read_cursors (updated_at)`,
  ];
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Open (creating if needed) the bus store and return a db object whose methods are all
 * awaitable regardless of backend.
 */
export async function createDB() {
  const dataDir = resolveDataDir();   // ~/.crosstalk (CC_DATA_DIR overrides); migrates old dir once
  fs.mkdirSync(dataDir, { recursive: true });
  const handle = new DatabaseSync(path.join(dataDir, 'messages.db'));
  // node:sqlite has no .pragma() helper — run pragmas as ordinary statements.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  const a = makeSqliteAdapter(handle);

  // Create schema (idempotent). DatabaseSync.exec accepts a batch of ';'-separated statements.
  await a.exec(schemaStatements().join(';\n'));

  const now = a.now;

  const db = {
    // Raw SQLite handle for tests to close directly.
    db: a.raw,
    dialect: 'sqlite',

    async close() {
      await a.close();
    },

    // ── Presence ────────────────────────────────────────────────────────────

    async registerInstance(id, description, rev) {
      // Upsert: refresh last_seen + status, keep an existing description/rev if the caller
      // passes nothing this time round.
      await a.run(
        `INSERT INTO instances (instance_id, description, last_seen, status, rev)
         VALUES (?, ?, ${now}, 'online', ?)
         ON CONFLICT (instance_id) DO UPDATE SET
           description = COALESCE(excluded.description, instances.description),
           last_seen   = ${now},
           status      = 'online',
           rev         = COALESCE(excluded.rev, instances.rev)`,
        [id, description ?? null, rev ?? null],
      );
      return this.getInstance(id);
    },

    async heartbeat(id) {
      const r = await a.run(
        `UPDATE instances SET last_seen = ${now}, status = 'online' WHERE instance_id = ?`,
        [id],
      );
      return r.changes > 0;
    },

    async markOffline(id) {
      const r = await a.run(`UPDATE instances SET status = 'offline' WHERE instance_id = ?`, [id]);
      return r.changes > 0;
    },

    async markStaleOffline(thresholdSeconds) {
      const cut = a.olderThan('last_seen', thresholdSeconds, 'seconds');
      const r = await a.run(
        `UPDATE instances SET status = 'offline' WHERE status = 'online' AND ${cut.clause}`,
        cut.params,
      );
      return r.changes; // number flipped to offline
    },

    async getInstance(id) {
      return a.get(`SELECT * FROM instances WHERE instance_id = ?`, [id]);
    },

    async listInstances() {
      return a.all(`SELECT * FROM instances ORDER BY last_seen DESC`);
    },

    // ── Channels ──────────────────────────────────────────────────────────────

    async createChannel(name, description) {
      await a.run(
        `INSERT INTO channels (name, description, created_at)
         VALUES (?, ?, ${now})
         ON CONFLICT (name) DO NOTHING`,
        [name, description ?? null],
      );
      return a.get(`SELECT * FROM channels WHERE name = ?`, [name]);
    },

    async listChannels() {
      return a.all(`SELECT * FROM channels ORDER BY name ASC`);
    },

    async listChannelsWithActivity() {
      // Left join so empty channels still appear, with a null last_message_at that sorts last.
      return a.all(
        `SELECT c.name, c.description, c.created_at,
                COUNT(m.id)              AS message_count,
                MAX(m.created_at)        AS last_message_at,
                ${a.sendersCsv('m.sender')} AS active_senders
           FROM channels c
           LEFT JOIN messages m ON m.channel = c.name
          GROUP BY c.name, c.description, c.created_at
          ORDER BY last_message_at DESC NULLS LAST`,
      );
    },

    async findChannels(query) {
      const like = `%${String(query ?? '').toLowerCase()}%`;
      return a.all(
        `SELECT * FROM channels
          WHERE LOWER(name) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ?
          ORDER BY name ASC`,
        [like, like],
      );
    },

    // ── Messages ──────────────────────────────────────────────────────────────

    async sendMessage(channel, sender, content, message_type = 'message', in_reply_to = null) {
      return a.insert(
        `INSERT INTO messages (channel, sender, content, message_type, in_reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ${now})`,
        [channel, sender, content, message_type ?? 'message', in_reply_to ?? null],
      );
    },

    async getMessages(channel, limit = 50) {
      // Newest first, each row annotated with how many direct replies it has.
      return a.all(
        `SELECT m.*,
                (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) AS reply_count
           FROM messages m
          WHERE m.channel = ?
          ORDER BY m.id DESC
          LIMIT ?`,
        [channel, limit],
      );
    },

    async getMessagesSince(channel, afterId) {
      return a.all(
        `SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC`,
        [channel, afterId],
      );
    },

    async getUnread(channel, afterId, instanceId) {
      // Everything after the cursor that the caller did not send themselves.
      return a.all(
        `SELECT * FROM messages
          WHERE channel = ? AND id > ? AND sender <> ?
          ORDER BY id ASC`,
        [channel, afterId, instanceId],
      );
    },

    async getMessage(id) {
      return a.get(`SELECT * FROM messages WHERE id = ?`, [id]);
    },

    // Highest message id in the store, or 0 when empty. Used as a monotonic DATA WATERMARK
    // (a freshness proxy) so a leader election among standbys that forked from a common
    // snapshot picks the branch that took the MOST writes — not an arbitrary hostname tie.
    // MAX(id) on the AUTOINCREMENT PK is an O(1) index probe, so it is cheap to read at boot.
    async maxMessageId() {
      const row = await a.get(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`);
      return Number(row?.m ?? 0);
    },

    async getReplies(messageId) {
      return a.all(`SELECT * FROM messages WHERE in_reply_to = ? ORDER BY id ASC`, [messageId]);
    },

    async searchMessages(query, limit = 10) {
      return a.all(
        `SELECT * FROM messages WHERE LOWER(content) LIKE ? ORDER BY id DESC LIMIT ?`,
        [`%${String(query ?? '').toLowerCase()}%`, limit],
      );
    },

    // ── Read cursors ──────────────────────────────────────────────────────────

    async getReadCursor(channel, instanceId) {
      const row = await a.get(
        `SELECT last_read_id FROM read_cursors WHERE channel = ? AND instance_id = ?`,
        [channel, instanceId],
      );
      return row ? Number(row.last_read_id) : undefined;
    },

    async setReadCursor(channel, instanceId, lastReadId) {
      // Monotonic: a cursor never moves backwards. On conflict we keep the greater of the
      // stored and incoming ids, so out-of-order / stale updates can't rewind read state.
      await a.run(
        `INSERT INTO read_cursors (channel, instance_id, last_read_id, updated_at)
         VALUES (?, ?, ?, ${now})
         ON CONFLICT (channel, instance_id) DO UPDATE SET
           last_read_id = ${a.maxOf('read_cursors.last_read_id', 'excluded.last_read_id')},
           updated_at   = ${now}`,
        [channel, instanceId, lastReadId],
      );
      return this.getReadCursor(channel, instanceId);
    },

    // ── Shared data ─────────────────────────────────────────────────────────

    async shareData(key, content, createdBy, description) {
      await a.run(
        `INSERT INTO shared_data (key, content, created_by, description, created_at)
         VALUES (?, ?, ?, ?, ${now})
         ON CONFLICT (key) DO UPDATE SET
           content     = excluded.content,
           created_by  = excluded.created_by,
           description = excluded.description`,
        [key, content, createdBy, description ?? null],
      );
      return { key, size_bytes: Buffer.byteLength(String(content), 'utf8') };
    },

    async getSharedData(key) {
      return a.get(`SELECT * FROM shared_data WHERE key = ?`, [key]);
    },

    async listSharedData() {
      // Metadata only — never the payload — with a byte size for each entry.
      return a.all(
        `SELECT key, created_by, description, LENGTH(content) AS size_bytes, created_at
           FROM shared_data
          ORDER BY created_at DESC, key ASC`,
      );
    },

    async deleteSharedData(key) {
      const r = await a.run(`DELETE FROM shared_data WHERE key = ?`, [key]);
      return r.changes > 0;
    },

    // ── Maintenance ─────────────────────────────────────────────────────────

    async cleanup(maxAgeDays = 7) {
      const msgCut = a.olderThan('created_at', maxAgeDays, 'days');
      const msgs = await a.run(`DELETE FROM messages WHERE ${msgCut.clause}`, msgCut.params);

      const instCut = a.olderThan('last_seen', maxAgeDays, 'days');
      const inst = await a.run(`DELETE FROM instances WHERE ${instCut.clause}`, instCut.params);

      const dataCut = a.olderThan('created_at', maxAgeDays, 'days');
      const data = await a.run(`DELETE FROM shared_data WHERE ${dataCut.clause}`, dataCut.params);

      // Cursors are cheap but unbounded; give them a fixed 30-day retention.
      const curCut = a.olderThan('updated_at', 30, 'days');
      const cursors = await a.run(`DELETE FROM read_cursors WHERE ${curCut.clause}`, curCut.params);

      return {
        messages: msgs.changes,
        instances: inst.changes,
        shared_data: data.changes,
        read_cursors: cursors.changes,
      };
    },

    async snapshot(destPath) {
      return a.snapshot(destPath);
    },

    // ── Work board ────────────────────────────────────────────────────────────

    async createWorkItem({
      project = 'default',
      title,
      external_ref = null,
      parent_id = null,
      kind = 'task',
      domain = null,
      owner = null,
      state,
      created_by = null,
    }) {
      // An item born with an owner is already claimed — default its state to 'claimed'
      // (never the contradictory owned-but-'queued') unless a state was passed explicitly.
      const effectiveState = state ?? (owner ? 'claimed' : 'queued');
      // claimed_at is stamped only when the item is created already owned.
      const claimedAt = owner ? now : 'NULL';
      const id = await a.insert(
        `INSERT INTO work_items
           (project, title, external_ref, parent_id, kind, domain, owner, state, created_by,
            claimed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${claimedAt}, ${now}, ${now})`,
        [project, title, external_ref, parent_id, kind, domain, owner, effectiveState, created_by],
      );
      return this.getWorkItem(id);
    },

    async getWorkItem(id) {
      return a.get(`SELECT * FROM work_items WHERE id = ?`, [id]);
    },

    async listWorkItems(filters = {}) {
      const where = [];
      const params = [];

      // Plain scalar equality filters. `state` is handled separately below because an
      // array `states` filter takes precedence over the single `state` when both are given.
      for (const field of ['project', 'owner', 'parent_id', 'kind']) {
        if (filters[field] !== undefined && filters[field] !== null) {
          where.push(`${field} = ?`);
          params.push(filters[field]);
        }
      }

      // states (array) → state IN (?, ?, …); prefer it over the single `state` if both set.
      const states = Array.isArray(filters.states) ? filters.states : null;
      if (states && states.length) {
        where.push(`state IN (${states.map(() => '?').join(', ')})`);
        params.push(...states);
      } else if (filters.state !== undefined && filters.state !== null) {
        where.push(`state = ?`);
        params.push(filters.state);
      }

      // updated_after (timestamp string) → only items touched since then.
      if (filters.updated_after !== undefined && filters.updated_after !== null) {
        where.push(`updated_at > ?`);
        params.push(filters.updated_after);
      }

      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      // Ordering groups each epic immediately before its children:
      //   COALESCE(parent_id, id)     — child sorts under its parent's id
      //   (parent_id IS NOT NULL)     — the parent (false=0) precedes its children (true=1)
      //   id                          — stable order within the group
      return a.all(
        `SELECT * FROM work_items
         ${clause}
         ORDER BY COALESCE(parent_id, id), (parent_id IS NOT NULL), id`,
        params,
      );
    },

    async claimWorkItem(id, owner) {
      // Atomic mutex. The WHERE guard only matches an unowned item or one already owned by
      // this same owner (idempotent re-claim), so a second session claiming an owned item
      // affects zero rows → claimed:false. queued→claimed on first take; other states kept.
      const res = await a.run(
        `UPDATE work_items
            SET owner = ?,
                state = CASE WHEN state = 'queued' THEN 'claimed' ELSE state END,
                claimed_at = ${now},
                updated_at = ${now}
          WHERE id = ? AND (owner IS NULL OR owner = ?)`,
        [owner, id, owner],
      );
      const item = await this.getWorkItem(id);
      return { claimed: res.changes > 0, item };
    },

    async transferWorkItem(id, newOwner) {
      // Reassign or, with a null owner, release. State is intentionally left as-is.
      await a.run(
        `UPDATE work_items SET owner = ?, updated_at = ${now} WHERE id = ?`,
        [newOwner ?? null, id],
      );
      return this.getWorkItem(id);
    },

    async setWorkItemState(id, state) {
      await a.run(
        `UPDATE work_items SET state = ?, updated_at = ${now} WHERE id = ?`,
        [state, id],
      );
      return this.getWorkItem(id);
    },
  };

  // Every bus starts with a `general` channel.
  await db.createChannel('general', 'General discussion');

  return db;
}

export default createDB;
