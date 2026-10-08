#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-ws.mjs — real-time PUSH receiver for the Crosstalk bus (issue #3).
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
// Since 3.2.0 the engine lives in cc-receive.mjs (shared with cc-codex-bridge.mjs);
// this file is the Claude Code sink: rendered messages → stdout, in Monitor-sized
// blocks. Its CLI, stdout and stderr contract are unchanged.
//
// --once (3.3.5): WAKE-ON-MESSAGE mode for a background Bash task instead of a Monitor. Claude
// Code caps every Monitor at 30 min, so a Monitor receiver wakes an idle session every 30 min
// just to be re-armed — terminal pollution on every listening session. A background Bash task
// has no such cap: with --once the receiver stays connected (beacon heartbeating as usual) and
// EXITS only when something addressed to it arrives, so the task's completion IS the wake.
//   • cursors persist (cursorPath) so the gap between exit and re-arm is replayed, not lost;
//   • after the first delivery it waits SETTLE_MS of quiet, so a burst lands as ONE wake;
//   • one owner per id (pidfile): a re-arm takes over, and the superseded receiver exits 3 with
//     nothing on stdout — the agent treats exit 3 as "another receiver is armed", a no-op.
// Exit codes: 0 = message(s) on stdout · 1 = version gate (text on stdout) · 3 = superseded.
//
//   node cc-ws.mjs <instance_id> [--once] [--channel ch] [--all] [--base URL] [--token TOK] [--from-start]
//   env: CC_BASE, CC_TOKEN, CC_DESC
// Zero deps (Node's built-in global WebSocket client; hand-rolled framing on the server).
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { loadConfig } from './cc-discover.mjs';
import { wrapForNotification } from './cc-render.mjs';
import { createReceiver, cursorPath, beaconPath, LIVE_DIR } from './cc-receive.mjs';

const args = process.argv.slice(2);
const instance = args[0];
if (!instance || instance.startsWith('--')) {
  console.error('usage: cc-ws.mjs <instance_id> [--once] [--channel ch] [--all] [--base URL] [--token TOK] [--from-start]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig();
const ONLY = opt('--channel', null);
const ONCE = args.includes('--once');
const SETTLE_MS = Number(process.env.CC_ONCE_SETTLE_MS || 1500);
const MAX_HOLD_MS = Number(process.env.CC_ONCE_MAX_HOLD_MS || 5000);   // a steady stream must not hold the wake back for ever
if (ONCE && /^\.+$/.test(instance)) {   // '.'/'..' would put the pid/cursor files outside the listen dir
  console.error(`cc-ws: refusing instance id "${instance}"`);
  process.exit(2);
}
const OWNER_POLL_MS = Number(process.env.CC_ONCE_OWNER_POLL_MS || 2000);

// Serialize + space multi-block (long) messages so the harness delivers each block whole
// (a burst within ~200ms is batched and re-truncated at the ~3 KB event cap). stdout cannot
// fail, so this sink never triggers the engine's rollback path — behaviour is as before 3.2.0.
let emitChain = Promise.resolve();
function emit(rendered) {
  if (ONCE) return emitOnce(rendered);
  emitChain = emitChain.then(async () => {
    const blocks = wrapForNotification(rendered);
    for (let i = 0; i < blocks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300));
      console.log(blocks[i]);
    }
  }).catch(() => {});
}

// --- --once: single owner + settle-then-exit ---
const OWNER_FILE = beaconPath(instance) + '.once.pid';
const owner = () => { try { return readFileSync(OWNER_FILE, 'utf8').trim(); } catch { return ''; } };
// Ownership is enforced only if we managed to CLAIM the pidfile: an unwritable listen dir must not
// make every arm think it was superseded and go deaf (fail open — at worst two receivers, both
// replay-safe through the shared cursors).
let owns = false;
const superseded = () => owns && owner() !== String(process.pid);
let settleTimer = null, holdTimer = null, exiting = false, emitted = false;
let started = Promise.resolve();
function finish(code) {
  if (exiting) return;
  // Exit 3 means "nothing for you, another receiver is armed" — the agent ignores it. A receiver
  // that already PRINTED a message must therefore exit 0, superseded or not, or that message is
  // lost: the new owner may have loaded a cursor that already covers it (reviewer F4).
  if (code === 3 && emitted) code = 0;
  exiting = true;
  // Flush the cursor file — unless ownership was lost (exit 3, or a printed-then-superseded exit 0):
  // the new owner's file must not be overwritten with this receiver's cursors.
  rx.stop({ save: code !== 3 && !superseded() });
  // Let the loop drain instead of a hard exit: process.exit() racing a just-closed WebSocket
  // crashed Node on Windows (0xC0000409) in testing. The unref'd timer is only the fallback for a
  // handle that refuses to close; a drained loop exits first, with this code.
  emitChain.then(() => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 1500).unref();
  });
}
function emitOnce(rendered) {
  // A superseded receiver must not deliver: the new owner will replay this from the shared cursor
  // (its save:false stop never persists the cursor this message advanced).
  if (exiting) return;
  if (superseded()) { finish(3); return; }
  // The output file is read whole (no Monitor event cap), so print the message unwrapped.
  emitted = true;
  emitChain = emitChain.then(() => { console.log(rendered); });
  // Settle: exit after SETTLE_MS of quiet so a burst is ONE wake — but never later than MAX_HOLD_MS
  // after the first message. Exit only once the initial backfill has finished (`started`), so the
  // exit never cuts a restored start's gap replay short.
  // The MAX_HOLD cap is absolute — it does not wait on `started` (a hung fetch must not hold a
  // printed message back); anything the cut-short backfill missed is replayed by the next arm.
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => started.then(() => finish(0)), SETTLE_MS);
  if (!holdTimer) holdTimer = setTimeout(() => finish(0), MAX_HOLD_MS);
}
if (ONCE) {
  try {
    mkdirSync(LIVE_DIR, { recursive: true });
    const tmp = `${OWNER_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, String(process.pid));
    renameSync(tmp, OWNER_FILE);              // atomic: two simultaneous arms can't interleave bytes
    owns = true;   // claimed. NOT a read-back: a rival renaming in between would leave us "unclaimed" and
                   // never superseded — two live receivers. A rival's later rename supersedes us as designed.
  } catch {}
  setInterval(() => { if (!exiting && superseded()) finish(3); }, OWNER_POLL_MS).unref();
}

const rx = createReceiver({
  instance,
  emit,
  cursorFile: ONCE ? cursorPath(instance, ONLY ? `channel-${ONLY}` : (args.includes('--all') ? 'all' : '')) : null,
  pin: opt('--base', process.env.CC_BASE) || cfg.pin,
  token: opt('--token', process.env.CC_TOKEN) || cfg.token,
  only: ONLY,
  firehose: args.includes('--all') || ONLY !== null,   // firehose when asked, or when scoped to ONE channel
  fromStart: args.includes('--from-start'),
});
started = rx.start().catch(() => {});
