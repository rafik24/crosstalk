// ---------------------------------------------------------------------------
// cc-receive.mjs — the RECEIVE ENGINE shared by every live receiver on the bus.
//
// Extracted from cc-ws.mjs (3.2.0) so a second agent class can receive without copying the
// engine: leader discovery + re-discovery, presence register + the liveness beacon the
// listen-gate reads, per-channel cursors with exactly-once dedup, REST backfill on (re)connect,
// WebSocket push with poll fallback, and the fleet version gate — all of it lives here. What
// differs per receiver is ONLY the sink: `emit(rendered, msg)`.
//
//   cc-ws.mjs           emit = console.log blocks   (a Claude Code Monitor reads stdout)
//   cc-codex-bridge.mjs emit = `codex queue --thread <sid> --message …`  (a subprocess)
//
// The emit sink MAY FAIL (a subprocess can). A failed message is NOT lost and NOT replayed via
// the cursor: the cursor always advances (so a reconnect never re-fetches what was seen), and the
// failed message OBJECT — already in hand — goes on a direct retry queue that re-emits it with
// backoff, up to RETRY_MAX_ATTEMPTS, after which it is PARKED with a log line. Rolling the cursor
// back instead (the first 3.2.0 draft) re-fetched every LATER message that had already succeeded
// — duplicates on a race, and a permanently-failing "poison" message flooded the sink with every
// subsequent message forever (crosstalk-reviewer, 2026-09-17). For an infallible sink (stdout)
// none of this triggers and behaviour is identical to the pre-3.2.0 cc-ws.
//
//   const rx = createReceiver({ instance, emit, pin, token, only, firehose, fromStart, desc });
//   await rx.start();        // discover → register → seed cursors → poll baseline → WS push
//   rx.stop();
//
// Lifecycle chatter goes to `log` (stderr by default), NEVER to stdout: a Monitor treats every
// stdout line as a wake event. Zero deps (Node's built-in WebSocket client).
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveFast, resolveFull } from './cc-discover.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';
import { addressedTo, renderLine } from './cc-render.mjs';

export const LIVE_DIR = join(homedir(), '.claude', '.cc-listen');
export function beaconPath(instance) { return join(LIVE_DIR, instance.replace(/[^A-Za-z0-9._-]/g, '_')); }

const RETRY_MS = Number(process.env.CC_RETRY_MS || 5000);           // first re-emit after a failure
const RETRY_MAX_MS = 60000;
export const RETRY_MAX_ATTEMPTS = Number(process.env.CC_RETRY_MAX_ATTEMPTS || 5);   // then PARK it
const MAX_BACKOFF = 15000;

export function createReceiver(opts) {
  const {
    instance, emit,
    pin = null, token = '',
    only = null, firehose = false, fromStart = false,
    desc = '',
    log = (line) => console.error(line),
    // Fatal, actionable terminal state: the bus refused our version. Default = print to STDOUT
    // (surfaces as a Monitor event), drop the beacon so the listen-gate blocks edits, exit 1.
    onVersionGate = null,
    // Called when a message exhausts its retries (parked). Default: log only.
    onParked = null,
  } = opts;
  if (!instance || typeof emit !== 'function') throw new Error('createReceiver: instance + emit are required');

  const H = { Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };
  const LIVE_FILE = beaconPath(instance);
  let BASE = null;

  async function ensureBase(full = false) {
    const leader = full ? await resolveFull({ pin, token }) : await resolveFast({ pin, token });
    if (leader && leader.base !== BASE) { BASE = leader.base; log(`[bus leader → ${leader.host} epoch=${leader.epoch} @ ${BASE}]`); }
    return BASE;
  }

  function beat() { try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(LIVE_FILE, String(Date.now())); } catch {} }

  function versionGateText(info) {
    const req = info.required || '?';
    const mine = info.yours || pkgVersion() || 'unknown';
    return [
      '',
      `⛔ CHAT BUS — VERSION GATE: this host runs ${mine} but the bus requires ${req}.`,
      info.how_to_update || `Update the crosstalk plugin on this host to ${req}, then re-arm receive.`,
      `Every host must run the same latest version. (Operator override: CC_VERSION_GATE_BYPASS=1 on the bus leader.)`,
      '',
    ].join('\n');
  }
  let gated = false;
  function failVersionGate(info) {
    // Terminal: fire ONCE. A callback sink (the bridge) is async, and start() would otherwise run
    // on into backfill, hit a second 426 and queue the warning twice (codex review, 2026-09-17).
    if (gated) return;
    gated = true;
    try { rmSync(LIVE_FILE, { force: true }); } catch {}
    stop();
    if (onVersionGate) { onVersionGate(versionGateText(info), info); return; }
    console.log(versionGateText(info));
    process.exit(1);
  }

  async function j(path, o = {}) {
    const r = await fetch(BASE + path, { ...o, headers: { ...H, ...(o.headers || {}) } });
    // A version-gate 426 on ANY /api call is fatal — surface it now, don't spin silently.
    if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} failVersionGate(info); }
    if (!r.ok) throw new Error(path + ' → ' + r.status);
    return r.json();
  }

  async function register() {
    beat();
    try {
      const r = await fetch(BASE + '/api/register', {
        method: 'POST', headers: { ...H },
        body: JSON.stringify({ instance_id: instance, description: desc || process.env.CC_DESC || '', rev: revString(), version: pkgVersion() }),
      });
      if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} failVersionGate(info); }
    } catch {}
  }

  // --- cursors + dedup ---
  const cursors = {};
  let seeded = false;

  // --- direct retry queue for failed emits (the cursor is NEVER rolled back) ---
  const retryQ = new Map();          // key `${channel}#${id}` → { msg, rendered, attempts }
  let retryTimer = null;
  let retryMs = RETRY_MS;
  let draining = false;

  function scheduleRetry() {
    if (stopped || retryTimer || retryQ.size === 0) return;   // never re-arm after stop()
    retryTimer = setTimeout(() => { retryTimer = null; drainRetry().catch(() => {}); }, retryMs);
    retryTimer.unref?.();
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }
  async function drainRetry() {
    if (draining) return;
    draining = true;
    try {
      for (const [key, item] of [...retryQ]) {
        if (stopped) return;
        try {
          await emit(item.rendered, item.msg);
          retryQ.delete(key);
          if (retryQ.size === 0) retryMs = RETRY_MS;   // backoff resets only once the queue is EMPTY —
                                                       // a still-failing message must not ride the floor cadence
        } catch (e) {
          item.attempts++;
          if (item.attempts >= RETRY_MAX_ATTEMPTS) {
            retryQ.delete(key);
            log(`[PARKED #${item.msg.channel} id=${item.msg.id} after ${item.attempts} failed emits: ${e && e.message ? e.message : e}]`);
            try { onParked && onParked(item.msg, e); } catch {}
          }
        }
      }
    } finally {
      draining = false;
      scheduleRetry();               // anything still queued gets another (longer) turn
    }
  }
  function deliver(rendered, msg) {
    let p;
    try { p = Promise.resolve(emit(rendered, msg)); } catch (e) { p = Promise.reject(e); }
    p.then(() => { if (retryQ.size === 0) retryMs = RETRY_MS; }).catch((e) => {
      const key = `${msg.channel}#${msg.id}`;
      if (!retryQ.has(key)) retryQ.set(key, { msg, rendered, attempts: 1 });
      log(`[emit failed for #${msg.channel} id=${msg.id}: ${e && e.message ? e.message : e} — queued for retry]`);
      scheduleRetry();
    });
  }

  // Decide-and-maybe-emit one message. Idempotent via the per-channel cursor, so a message that
  // arrives on BOTH the push and a backfill (a race on reconnect) is emitted exactly once. The
  // cursor advances for ALL messages, unconditionally — a failed emit is retried from the queue
  // above, never by re-fetching.
  function consider(msg) {
    if (stopped) return;
    const ch = msg.channel;
    if (only && ch !== only) return;          // --channel scope applies to PUSH frames too, not just backfill
    const cur = cursors[ch] ?? 0;
    if (msg.id <= cur) return;
    cursors[ch] = Math.max(cur, msg.id);
    if (msg.sender === instance) return;       // never echo my own
    const addressed = addressedTo(msg, instance);
    if (!firehose && !addressed) return;       // ambient, not for me → don't wake
    deliver(renderLine(msg, instance, addressed), msg);
  }

  // REST backfill: on the FIRST pass seed cursors to the tip and skip backlog (a fresh listener
  // isn't flooded); on later passes (reconnect) replay the gap through consider().
  async function backfill() {
    if (!BASE) { await ensureBase(true); if (!BASE) return; }
    let channels;
    try { channels = only ? [{ name: only }] : (await j('/api/channels')).channels; }
    catch { await ensureBase(true); return; }
    const isSeed = !seeded;
    for (const c of channels) {
      const after = cursors[c.name] ?? 0;
      let res;
      try { res = await j(`/api/messages/${encodeURIComponent(c.name)}?after_id=${after}`); }
      catch { continue; }
      if (isSeed && !fromStart && cursors[c.name] === undefined) { cursors[c.name] = res.last_id || 0; continue; }
      for (const m of res.messages.sort((a, b) => a.id - b.id)) consider(m);
      if (cursors[c.name] === undefined) cursors[c.name] = res.last_id || 0;
    }
    seeded = true;
  }

  // --- poll fallback: used only until/unless a WS connects ---
  let pollIv = null;
  function startPoll() { if (!pollIv) pollIv = setInterval(() => backfill().catch(() => {}), 2000); }
  function stopPoll() { if (pollIv) { clearInterval(pollIv); pollIv = null; } }

  // --- WebSocket push ---
  let ws = null, wsLive = false, backoff = 1000, stopped = false;
  function wsUrl() {
    // http://host:port → ws://host:port/cc/ws. Token rides in the Authorization header, not the
    // URL; &v carries our release version so the UPGRADE is version-gated too.
    const b = BASE.replace(/^http/, 'ws').replace(/\/$/, '');
    // firehose=1 asks the server for ambient traffic too (it filters addressed-only otherwise); without
    // it a --all/--channel receiver went deaf to ambient messages the moment push replaced the poll.
    return `${b}/cc/ws?identity=${encodeURIComponent(instance)}&v=${encodeURIComponent(pkgVersion() || '')}${firehose ? '&firehose=1' : ''}`;
  }
  async function connectWS() {
    if (typeof WebSocket === 'undefined') return false;
    if (!BASE) { await ensureBase(true); if (!BASE) return false; }
    try { ws = new WebSocket(wsUrl(), { headers: { Authorization: 'Bearer ' + token } }); } catch { return false; }
    ws.addEventListener('open', async () => {
      wsLive = true; backoff = 1000;
      log(`[push connected → ${BASE} as ${instance}]`);
      stopPoll();
      await backfill();
    });
    ws.addEventListener('message', (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (frame && frame.type === 'msg' && frame.message) consider(frame.message);
    });
    const onDown = () => {
      if (!wsLive && ws == null) return;
      wsLive = false;
      try { ws && ws.close(); } catch {}
      ws = null;
      if (stopped) return;
      startPoll();
      setTimeout(reconnect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
    ws.addEventListener('close', onDown);
    ws.addEventListener('error', onDown);
    return true;
  }
  async function reconnect() {
    if (wsLive || stopped) return;
    await ensureBase(true);
    const ok = await connectWS();
    if (!ok) { startPoll(); setTimeout(reconnect, backoff); backoff = Math.min(backoff * 2, MAX_BACKOFF); }
  }

  let regIv = null;
  async function start() {
    // A version-gate 426 during any of these awaits stops the receiver; nothing after it may run
    // (the next register() would re-create the beacon the gate just deleted).
    await ensureBase(true);           if (stopped) return;
    await register();                 if (stopped) return;
    await backfill();                 if (stopped) return;
    startPoll();
    await connectWS();                if (stopped) return;
    log(`[listening as ${instance} on ${only ? '#' + only : 'all channels'} @ ${BASE || 'discovering…'} (push+backfill)]`);
    regIv = setInterval(register, 20000);   // presence + beacon heartbeat, independent of transport
  }
  function stop() {
    stopped = true;
    stopPoll();
    if (regIv) { clearInterval(regIv); regIv = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try { ws && ws.close(); } catch {}
    ws = null;
  }

  return { start, stop, backfill, register, beat, consider, cursors, get pending() { return retryQ.size; }, get base() { return BASE; }, beaconFile: LIVE_FILE };
}
