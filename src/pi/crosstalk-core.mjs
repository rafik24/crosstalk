// ---------------------------------------------------------------------------
// crosstalk-core.mjs — the pi.dev Crosstalk extension, as a pure host-agnostic module.
//
// pi.dev (the `pi` coding agent) is the THIRD agent class on the bus, after Claude Code
// (Monitor → cc-ws) and Codex (cc-codex-bridge → `codex queue`). Unlike those, pi runs an
// IN-PROCESS extension: no bridge daemon, no forked receiver. This module is what the thin
// host entry (crosstalk.ts) dynamic-imports from CC_LIVE and hands the live `pi` object.
//
// It is kept dependency-injected and free of any pi-runtime import so it unit-tests against a
// fake `pi` + the REAL receive engine and a REAL server (test/pi-extension.test.mjs):
//
//   installCrosstalk(pi, { Type, pin, token, env, createReceiver, createClient, log, host })
//
// Wiring (agreed with pi.dev in the 2026-09-17 POC (session pi-poc-1)):
//   - session_start  → build identity from ctx.sessionManager.getSessionId(); createReceiver
//     (the shared cc-receive.mjs engine: WS push + poll fallback, cursor backfill, exactly-once,
//     retry+park, version gate) with an IN-PROCESS emit → pi.sendMessage(..., deliverAs:'steer').
//     'steer' (not sendUserMessage) so a DM landing mid-turn is delivered AFTER the current turn,
//     never clobbering it; immediate when idle. The sink is infallible in-process, so the engine's
//     retry/park path stays dormant (same as stdout for cc-ws).
//   - session_shutdown → rx.stop() + clear the status line.
//   - tools bus_send / bus_ack / bus_peers → thin cc-client REST wrappers (no blocking wait tool:
//     inbound already arrives as a turn, so a block-until-reply tool could hang the session).
//   - /bus command → identity + leader + pending-retry count.
//   - version gate (426) → ctx.ui.notify(error) once, then stop (edits are pi's own concern).
// ---------------------------------------------------------------------------
import os from 'node:os';
import { createReceiver as realCreateReceiver } from '../cc-receive.mjs';
import { createClient as realCreateClient, normChannel } from '../cc-client.mjs';
import { canonicalShort } from '../cc-render.mjs';
import { loadConfig } from '../cc-discover.mjs';

// Instance-id charset matches beaconPath()'s sanitizer: [A-Za-z0-9._-].
const sanitizeHost = (h) => String(h || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'host';

// `host/pi-<8-char session slug>`, e.g. linux-box/pi-1a2b3c4d. CC_INSTANCE overrides wholesale.
export function makeIdentity({ env = process.env, host = os.hostname(), ctx } = {}) {
  if (env.CC_INSTANCE) return env.CC_INSTANCE;
  let sid = '';
  try { sid = ctx?.sessionManager?.getSessionId?.() || ''; } catch {}
  const slug = canonicalShort(sid).replace(/-/g, '').slice(0, 8) || 'nosid';
  return `${sanitizeHost(host)}/pi-${slug}`;
}

export function installCrosstalk(pi, options = {}) {
  const {
    Type = null,                         // TypeBox namespace, injected by crosstalk.ts
    env = process.env,
    createReceiver = realCreateReceiver,
    createClient = realCreateClient,
    log = (l) => console.error('[crosstalk] ' + l),
    host = os.hostname(),
  } = options;

  // Resolve pin+token HERE, including the ~/.claude/.crosstalk config, and pass the resolved values
  // down. The receiver (cc-receive.mjs) has no config fallback of its own — it takes whatever token
  // it is handed — so if we don't read the config the receiver auths with an empty token and never
  // registers. And an empty-string default (`?? ''`) is NOT nullish, so it would clobber cc-client's
  // own `?? cfg.token` fallback too — the bug pi hit on the first live install (2026-09-17): the
  // extension loaded and `bus_peers` ran, but returned "no CC_TOKEN" because '' shadowed the config.
  // Effective order (be precise — loadConfig() itself prefers process.env over the file, so the
  // real chain is: explicit option → injected options.env → process env → config file). A host
  // that injects options.env deliberately can still be outranked by a stray process CC_TOKEN;
  // that matches every other fleet client, so it is documented here rather than "fixed" locally.
  const cfg = loadConfig();
  const pin = options.pin ?? env.CC_BASE ?? cfg.pin ?? null;
  const token = options.token ?? env.CC_TOKEN ?? cfg.token ?? '';
  const client = createClient({ pin, token });

  let rx = null;
  let identity = null;
  let active = false;
  let gated = false;   // the fleet version gate fired during this session — never flip back to online

  // In-process, infallible sink: a bus line addressed to this session becomes a pi turn.
  function emit(rendered, msg) {
    pi.sendMessage(
      { customType: 'crosstalk', content: rendered, display: true, details: msg ? { channel: msg.channel, sender: msg.sender, id: msg.id, type: msg.message_type } : undefined },
      { triggerTurn: true, deliverAs: 'steer' },
    );
  }

  function setStatus(ctx, text) { try { ctx?.ui?.setStatus?.('crosstalk', text); } catch {} }

  function stop() {
    active = false;
    try { rx?.stop(); } catch {}
  }

  // --- lifecycle ---
  pi.on('session_start', async (_event, ctx) => {
    gated = false;
    identity = makeIdentity({ env, host, ctx });
    rx = createReceiver({
      instance: identity,
      emit,
      pin, token,
      desc: env.CC_DESC || 'pi',
      log: (l) => log(l),
      onVersionGate: (text) => {
        gated = true;
        try { ctx?.ui?.notify?.(String(text).trim(), 'error'); } catch {}
        setStatus(ctx, '⛔ crosstalk: version gate');
        stop();
      },
    });
    try {
      await rx.start();
      // The engine fires onVersionGate SYNCHRONOUSLY inside start() on a 426 (register/backfill) and
      // then resolves without throwing (it short-circuits on `stopped`). So a clean resolve does NOT
      // mean we joined — if the gate already fired, leave the receiver stopped and the ⛔ status up,
      // never flip to a green "● online" that would invite DMs into a dead session (reviewer, 2026-09-17).
      if (gated) return;
      active = true;
      setStatus(ctx, '● ' + identity);
      log(`joined the bus as ${identity}`);
    } catch (e) {
      log('start failed: ' + (e && e.message ? e.message : e));
      setStatus(ctx, '○ crosstalk: offline');
    }
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    stop();
    setStatus(ctx, '');
  });

  // --- tools (thin REST wrappers) ---
  if (Type) {
    pi.registerTool({
      name: 'bus_send',
      label: 'Bus: send',
      description: 'Send a message on the Crosstalk bus. channel is a peer DM (dm-<shortname>), a collaboration channel, or "all" to broadcast to #general. Use @<peer-id> in text or dm-<peer> to actually wake a peer.',
      promptSnippet: 'bus_send — talk to other coding-agent sessions on the Crosstalk bus.',
      parameters: Type.Object({
        channel: Type.String(),
        text: Type.String(),
        type: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const r = await client.send(currentId(), params.channel, params.text, params.type || 'message');
        return { content: [{ type: 'text', text: `sent #${normChannel(params.channel)} id=${r.id ?? '?'}` }] };
      },
    });

    pi.registerTool({
      name: 'bus_ack',
      label: 'Bus: ack',
      description: 'Acknowledge a handoff on the Crosstalk bus into the same channel (a response whose body starts "ACK"). Ack when a peer hands YOU ownership.',
      parameters: Type.Object({
        channel: Type.String(),
        note: Type.String(),
      }),
      async execute(_id, params) {
        const r = await client.ack(currentId(), params.channel, params.note);
        return { content: [{ type: 'text', text: `ack #${normChannel(params.channel)} id=${r.id ?? '?'}` }] };
      },
    });

    pi.registerTool({
      name: 'bus_peers',
      label: 'Bus: peers',
      description: 'List the coding-agent sessions currently online on the Crosstalk bus.',
      parameters: Type.Object({}),
      async execute() {
        const j = await client.peers();
        const online = (j?.instances || []).filter((i) => i.status === 'online').map((i) => i.instance_id);
        return { content: [{ type: 'text', text: online.length ? online.join('\n') : '(no peers online)' }] };
      },
    });
  } else {
    log('TypeBox (Type) not provided — bus_send/bus_ack/bus_peers not registered; receive is still active.');
  }

  // --- /bus command: identity + leader + pending ---
  if (typeof pi.registerCommand === 'function') {
    pi.registerCommand('bus', {
      description: 'Show this session\'s Crosstalk bus identity, leader, and pending retries.',
      handler: async (_args, ctx) => {
        const leader = client.base || rx?.base || '(discovering…)';
        const pending = rx?.pending ?? 0;
        const line = `crosstalk: ${identity || '(not joined)'} · leader ${leader} · ${active ? 'online' : 'offline'} · pending ${pending}`;
        try { ctx?.ui?.notify?.(line, 'info'); } catch { log(line); }
      },
    });
  }

  // Never mint a fallback identity here: a send under a slug nobody derived (e.g. `pi-nosid`, with
  // no ctx) would land on a dm- channel no peer is listening on. If a tool somehow runs before
  // session_start set the identity, fail loudly instead (reviewer, 2026-09-17).
  function currentId() {
    if (!identity) throw new Error('crosstalk: not joined yet (session_start has not run) — cannot send');
    return identity;
  }

  // Exposed for tests + the host entry.
  return {
    get identity() { return identity; },
    get receiver() { return rx; },
    get active() { return active; },
    stop,
    emit,
    client,
  };
}
