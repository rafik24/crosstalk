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
const HELD_CAP = 2000;   // live frames parked while a term change is being reconciled
const SEEN_CAP = 500;   // per-channel memory of seen (id → signature) for the rewind check (issue 46)

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

  // The leader's TERM. A new term may have REWOUND history (issue 46): after an unclean failover
  // the promoted node serves its last replicated snapshot, so the newest messages of the old term
  // are gone and their ids get RE-ISSUED. Our cursors still sit above them — every re-issued id
  // would be discarded as "already seen", silently. A term change therefore schedules a
  // reconciliation (see reconcileTerm) before the next backfill.
  let leaderEpoch = null, termChanged = false, termSeq = 0;
  // From the moment a term change is noticed until its reconciliation has finished, live frames
  // are HELD, not judged: judged against the stale cursor a re-issued id would be dropped for
  // good, and judged mid-reconcile a newer one would be delivered twice (once by the push, once
  // by the reconcile's own fetch). They are replayed through consider() afterwards.
  let reconciling = false;
  let pendingReconcile = null;   // channels whose check failed and must be retried
  let retryTimerR = null;        // the single pending reconcile retry (never one per poll tick)
  const held = [];

  async function ensureBase(full = false) {
    const leader = full ? await resolveFull({ pin, token }) : await resolveFast({ pin, token });
    if (leader && leader.base !== BASE) { BASE = leader.base; log(`[bus leader → ${leader.host} epoch=${leader.epoch} @ ${BASE}]`); }
    if (leader && typeof leader.epoch === 'number') {
      if (leaderEpoch !== null && leader.epoch !== leaderEpoch && seeded) {
        termChanged = true; reconciling = true; termSeq++;
        // Whatever path noticed it, make sure a backfill (which runs the reconcile and releases
        // the held frames) actually follows — a live socket schedules none by itself.
        const t = setTimeout(() => backfill().catch(() => {}), 50); t.unref?.();
      }
      leaderEpoch = leader.epoch;
    }
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
  // What we have already SEEN, per channel: id → signature, newest SEEN_CAP. The cursor alone says
  // "I saw id 7"; the signature says WHICH message id 7 was — the only way to tell a re-issued id
  // from a replay after the history was rewound.
  const seen = {};
  const sigOf = (m) => `${m.sender}|${m.created_at}|${(m.content || '').length}|${(m.content || '').slice(0, 48)}`;
  function remember(m) {
    const s = (seen[m.channel] ??= new Map());
    s.delete(m.id); s.set(m.id, sigOf(m));
    while (s.size > SEEN_CAP) s.delete(s.keys().next().value);
  }

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
    if (reconciling) { if (held.length < HELD_CAP) held.push(msg); return; }   // (beyond the cap the reconcile's own fetch recovers them)
    const ch = msg.channel;
    if (only && ch !== only) return;          // --channel scope applies to PUSH frames too, not just backfill
    const cur = cursors[ch] ?? 0;
    if (msg.id <= cur) return;
    cursors[ch] = Math.max(cur, msg.id);
    admit(msg);
  }
  // Remember + maybe deliver, with NO cursor test (reconcileTerm feeds re-issued ids through here).
  function admit(msg) {
    remember(msg);
    if (msg.sender === instance) return;       // never echo my own
    const addressed = addressedTo(msg, instance);
    if (!firehose && !addressed) return;       // ambient, not for me → don't wake
    deliver(renderLine(msg, instance, addressed), msg);
  }

  // A new term began: check every channel we track against what we remember. Where the server's
  // copy of an id we saw is now a DIFFERENT message — or our newest seen id is simply gone — the
  // history was rewound: deliver what is new to us and pull the cursor back so the next ids are
  // not discarded. "New to us" is decided by SIGNATURE, never by the cursor, so nothing is
  // delivered twice; a loss-free handover (drain stepdown) matches everywhere and changes nothing.
  // → the channels that could not be checked (a transient error): the caller retries those.
  async function reconcileTerm(channels) {
    const failed = [];
    for (const ch of channels) {
      const s = seen[ch];
      const cur = cursors[ch] ?? 0;
      if (!cur) continue;
      const oldest = s && s.size ? Math.min(...s.keys()) : 0;
      let res;
      try { res = await j(`/api/messages/${encodeURIComponent(ch)}?after_id=${Math.max(0, oldest - 1)}`); } catch { failed.push(ch); continue; }
      let msgs = res.messages.sort((a, b) => a.id - b.id);
      const known = (m) => s?.get(m.id) === sigOf(m);
      if (msgs.some((m) => m.id === cur && known(m)) && msgs.every((m) => m.id > cur || known(m))) continue;   // intact
      // The rewind went below everything we remember (or we remember nothing): ids under `oldest`
      // may have been re-issued too. Look at the whole channel, but only at messages written after
      // the newest one we ever saw — a new term's messages are, by construction, later than that.
      // The cursor goes to the channel's REAL tip — never to the tip of a filtered list: with
      // nothing new written yet that list is empty, and a cursor of 0 made the ordinary backfill
      // replay the whole surviving channel to every receiver at once (reviewer repro: 90 old
      // messages re-delivered).
      let tip = msgs.length ? msgs[msgs.length - 1].id : null;
      if (!msgs.some(known)) {
        const newestSeen = s && s.size ? [...s.values()].map((v) => v.split('|')[1]).sort().pop() : '';
        try { res = await j(`/api/messages/${encodeURIComponent(ch)}?after_id=0`); } catch { failed.push(ch); continue; }
        const all = res.messages.sort((a, b) => a.id - b.id);
        tip = all.length ? all[all.length - 1].id : 0;
        // STRICTLY later: surviving old messages written in the same second as the newest one we
        // saw must not pass as new (a failover takes seconds, so a new term's messages are later).
        msgs = all.filter((m) => String(m.created_at) > newestSeen);
      }
      const fresh = msgs.filter((m) => !known(m));
      const newTip = tip ?? 0;
      log(`[history REWOUND on #${ch} by the new term (epoch ${leaderEpoch}): cursor ${cur} → ${newTip}; ${fresh.length} message(s) new to this receiver]`);
      if (s) for (const id of [...s.keys()]) if (id > newTip) s.delete(id);   // ids of the lost tail mean nothing now
      cursors[ch] = newTip;
      for (const m of fresh) admit(m);
    }
    return failed;
  }

  // REST backfill: on the FIRST pass seed cursors to the tip and skip backlog (a fresh listener
  // isn't flooded); on later passes (reconnect) replay the gap through consider().
  async function backfill() {
    if (!BASE) { await ensureBase(true); if (!BASE) return; }
    if (termChanged) {
      // Until every channel has been checked the term stays "changed": one transient error from a
      // freshly promoted leader must not leave a channel on its stale cursor for good.
      const seq = termSeq;
      let failed = pendingReconcile ?? Object.keys(cursors);
      try { failed = await reconcileTerm(failed); } catch { /* retry everything still pending */ }
      // ANOTHER term began while we were checking: everything must be checked again against it.
      if (seq !== termSeq) failed = Object.keys(cursors);
      pendingReconcile = failed.length ? failed : null;
      if (!pendingReconcile) termChanged = false;
      else if (!retryTimerR) {   // ONE retry chain, however many polls/pushes enter this block meanwhile
        retryTimerR = setTimeout(() => { retryTimerR = null; backfill().catch(() => {}); }, 2000); retryTimerR.unref?.();
      }
      if (!pendingReconcile) { reconciling = false; for (const m of held.splice(0)) consider(m); }
    }
    let channels;
    try { channels = only ? [{ name: only }] : (await j('/api/channels')).channels; }
    catch { await ensureBase(true); return; }
    const isSeed = !seeded;
    for (const c of channels) {
      const after = cursors[c.name] ?? 0;
      let res;
      try { res = await j(`/api/messages/${encodeURIComponent(c.name)}?after_id=${after}`); }
      catch { continue; }
      if (isSeed && !fromStart && cursors[c.name] === undefined) {
        cursors[c.name] = res.last_id || 0;
        for (const m of res.messages.slice(-SEEN_CAP)) remember(m);   // skipped, but KNOWN — a later rewind check needs them
        continue;
      }
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
    if (retryTimerR) { clearTimeout(retryTimerR); retryTimerR = null; }
    try { ws && ws.close(); } catch {}
    ws = null;
  }

  return { start, stop, backfill, register, beat, consider, cursors, get pending() { return retryQ.size; }, get base() { return BASE; }, beaconFile: LIVE_FILE };
}
