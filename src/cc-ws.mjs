#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-ws.mjs — real-time PUSH receiver for the Cross-Claude bus (issue #3).
//
// Supersedes cc-poll.mjs's 2-second poll loop: this holds a WebSocket open to the
// leader and is woken the instant a message addressed to it is sent — no counter,
// no interval. It is a Monitor `command:` source (NOT the native `ws:` source),
// because two things must happen locally that a bare socket cannot do:
//
//   • CURSOR BACKFILL on (re)connect. Sockets drop (sleep, migration, flaky link).
//     On every connect the bridge replays GET /api/messages?after_id=<last-seen>
//     over the REST API, so anything sent while the socket was down arrives exactly
//     once, then push resumes. Push for immediacy, cursor for gap-repair.
//   • the LIVENESS BEACON the listen-gate reads (~/.claude/.cc-listen/<id>), so a
//     session on push satisfies "this session is receiving" just like a poller did.
//
// It also DEGRADES: if the leader is too old to speak WS (no /cc/ws), or this Node
// has no WebSocket client, the bridge falls back to the same 2s poll cc-poll used —
// and keeps retrying the socket, so it upgrades itself to push the moment the leader
// does. Either way the DM-truncation fix (wrap long bodies, cc-render.mjs) applies.
//
//   node cc-ws.mjs <instance_id> [--channel ch] [--all] [--base URL] [--token TOK] [--from-start]
//   env: CC_BASE, CC_TOKEN, CC_DESC
// Zero deps (Node's built-in global WebSocket client; hand-rolled framing on the server).
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveFast, resolveFull, loadConfig } from './cc-discover.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';
import { addressedTo, renderLine, wrapForNotification } from './cc-render.mjs';

const args = process.argv.slice(2);
const instance = args[0];
if (!instance || instance.startsWith('--')) {
  console.error('usage: cc-ws.mjs <instance_id> [--channel ch] [--all] [--base URL] [--token TOK] [--from-start]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig();
const PIN = opt('--base', process.env.CC_BASE) || cfg.pin;
const TOKEN = opt('--token', process.env.CC_TOKEN) || cfg.token;
const ONLY = opt('--channel', null);
const fromStart = args.includes('--from-start');
// Firehose (emit ambient too) when explicitly asked (--all) or scoped to ONE channel.
const FIREHOSE = args.includes('--all') || ONLY !== null;
// x-cc-version on EVERY /api call (register, poll-receive, …) — the data-plane version gate refuses a
// mismatch, so a stale host is blocked from coordinating, not just from registering. See version-gate.mjs.
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };
const shortId = instance.split('/').pop();

let BASE = null;
async function ensureBase(full = false) {
  const leader = full ? await resolveFull({ pin: PIN, token: TOKEN }) : await resolveFast({ pin: PIN, token: TOKEN });
  // Lifecycle chatter → stderr, NEVER stdout. A Monitor(cc-ws) beacon treats every stdout
  // line as a wake event; only rendered messages (the emit() below) should wake the session.
  // Connection churn (leader change / reconnect / startup) on stdout re-invoked idle sessions
  // every reconnect for nothing. stderr is still captured to the output file + shown when run
  // by hand, but does not trigger a notification.
  if (leader && leader.base !== BASE) { BASE = leader.base; console.error(`[bus leader → ${leader.host} epoch=${leader.epoch} @ ${BASE}]`); }
  return BASE;
}

// --- liveness beacon (identical contract to cc-poll: the listen-gate reads this mtime) ---
const LIVE_DIR = join(homedir(), '.claude', '.cc-listen');
const LIVE_FILE = join(LIVE_DIR, instance.replace(/[^A-Za-z0-9._-]/g, '_'));
function beat() { try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(LIVE_FILE, String(Date.now())); } catch {} }

async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  // A version-gate 426 on ANY /api call (not just register) is fatal — surface it now rather than
  // let the poll loop spin silently until the next register() tick notices. See version-gate.mjs.
  if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} failVersionGate(info); }
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}
// The bus refused us for running the wrong version. This is a fatal, actionable terminal state
// (not routine lifecycle chatter), so print it to STDOUT — that surfaces it as a Monitor event the
// operator sees — then drop the beacon so the listen-gate blocks edits at once, and exit.
function failVersionGate(info) {
  try { rmSync(LIVE_FILE, { force: true }); } catch {}
  const req = info.required || '?';
  const mine = info.yours || pkgVersion() || 'unknown';
  console.log([
    '',
    `⛔ CHAT BUS — VERSION GATE: this host runs ${mine} but the bus requires ${req}.`,
    info.how_to_update || `Update the crosstalk plugin on this host to ${req}, then re-arm receive.`,
    `Every host must run the same latest version. (Operator override: CC_VERSION_GATE_BYPASS=1 on the bus leader.)`,
    '',
  ].join('\n'));
  process.exit(1);
}

async function register() {
  beat();
  try {
    const r = await fetch(BASE + '/api/register', {
      method: 'POST', headers: { ...H },
      body: JSON.stringify({ instance_id: instance, description: process.env.CC_DESC || '', rev: revString(), version: pkgVersion() }),
    });
    if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} failVersionGate(info); }
  } catch {}
}

// --- cursors + dedup + spaced emit (shared by push and poll/backfill) ---
const cursors = {};
let seeded = false;

// Serialize + space multi-block (long) messages so the harness delivers each block whole
// (a burst within ~200ms is batched and re-truncated at the ~3 KB event cap).
let emitChain = Promise.resolve();
function emit(rendered) {
  emitChain = emitChain.then(async () => {
    const blocks = wrapForNotification(rendered);
    for (let i = 0; i < blocks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300));
      console.log(blocks[i]);
    }
  }).catch(() => {});
}

// Decide-and-maybe-emit one message. Idempotent via the per-channel cursor, so a message
// that arrives on BOTH the push and a backfill (a race on reconnect) is shown exactly once.
function consider(msg) {
  const ch = msg.channel;
  const cur = cursors[ch] ?? 0;
  if (msg.id <= cur) return;                 // already seen (dedup) or below the seed floor
  cursors[ch] = Math.max(cur, msg.id);       // advance for ALL msgs so reconnect won't replay them
  if (msg.sender === instance) return;       // never echo my own
  const addressed = addressedTo(msg, instance);
  if (!FIREHOSE && !addressed) return;       // ambient, not for me → don't wake
  emit(renderLine(msg, instance, addressed));
}

// REST backfill: on the FIRST pass we seed cursors to the tip and skip backlog (a fresh
// listener isn't flooded); on later passes (reconnect) we replay the gap through consider().
async function backfill() {
  if (!BASE) { await ensureBase(true); if (!BASE) return; }
  let channels;
  try { channels = ONLY ? [{ name: ONLY }] : (await j('/api/channels')).channels; }
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

// --- poll fallback: the pre-#3 behaviour, used only until/unless a WS connects ---
let pollIv = null;
function startPoll() {
  if (pollIv) return;
  pollIv = setInterval(() => backfill().catch(() => {}), 2000);
}
function stopPoll() { if (pollIv) { clearInterval(pollIv); pollIv = null; } }

// --- WebSocket push ---
let ws = null;
let wsLive = false;
let backoff = 1000;
const MAX_BACKOFF = 15000;

function wsUrl() {
  // leader base is http://host:port → ws://host:port/cc/ws. The token is sent in the
  // Authorization header (below), NOT the URL, so it never lands in a log/proxy line (H1).
  const b = BASE.replace(/^http/, 'ws').replace(/\/$/, '');
  // &v carries our release version so the upgrade is version-gated too (belt-and-braces to /register).
  return `${b}/cc/ws?identity=${encodeURIComponent(instance)}&v=${encodeURIComponent(pkgVersion() || '')}`;
}

async function connectWS() {
  if (typeof WebSocket === 'undefined') return false;   // Node too old for a built-in WS client → poll only
  if (!BASE) { await ensureBase(true); if (!BASE) return false; }
  try {
    // Node's built-in WebSocket transmits this header on the handshake (verified on Node 24);
    // the leader accepts it and keeps the token out of the URL. Browsers fall back to ?token=.
    ws = new WebSocket(wsUrl(), { headers: { Authorization: 'Bearer ' + TOKEN } });
  } catch { return false; }

  ws.addEventListener('open', async () => {
    wsLive = true;
    backoff = 1000;
    console.error(`[push connected → ${BASE} as ${instance}]`);   // lifecycle → stderr (see ensureBase)
    stopPoll();                 // push takes over; no more polling
    await backfill();           // replay anything missed while the socket was down (or seed on first)
  });

  ws.addEventListener('message', (ev) => {
    let frame;
    try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (frame && frame.type === 'msg' && frame.message) consider(frame.message);
    // 'hello' and any future control frames are ignored.
  });

  const onDown = () => {
    if (!wsLive && ws == null) return;
    wsLive = false;
    try { ws && ws.close(); } catch {}
    ws = null;
    startPoll();                // never go deaf — poll covers the gap until push is back
    setTimeout(reconnect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };
  ws.addEventListener('close', onDown);
  ws.addEventListener('error', onDown);
  return true;
}

async function reconnect() {
  if (wsLive) return;
  // A repeated failure may mean the leader moved (migration) — re-discover before retrying.
  await ensureBase(true);
  const ok = await connectWS();
  if (!ok) { startPoll(); setTimeout(reconnect, backoff); backoff = Math.min(backoff * 2, MAX_BACKOFF); }
}

(async () => {
  await ensureBase(true);
  await register();
  await backfill();             // seed cursors (skips backlog unless --from-start)
  startPoll();                  // baseline receive until the socket is up (then it's stopped)
  await connectWS();            // attempt push; degrades to the poll already running
  console.error(`[listening as ${instance} on ${ONLY ? '#' + ONLY : 'all channels'} @ ${BASE || 'discovering…'} (push+backfill)]`);   // lifecycle → stderr (see ensureBase)
  setInterval(register, 20000); // presence + beacon heartbeat, independent of transport
})();
