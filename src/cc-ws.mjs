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
//   node cc-ws.mjs <instance_id> [--channel ch] [--all] [--base URL] [--token TOK] [--from-start]
//   env: CC_BASE, CC_TOKEN, CC_DESC
// Zero deps (Node's built-in global WebSocket client; hand-rolled framing on the server).
// ---------------------------------------------------------------------------
import { loadConfig } from './cc-discover.mjs';
import { wrapForNotification } from './cc-render.mjs';
import { createReceiver } from './cc-receive.mjs';

const args = process.argv.slice(2);
const instance = args[0];
if (!instance || instance.startsWith('--')) {
  console.error('usage: cc-ws.mjs <instance_id> [--channel ch] [--all] [--base URL] [--token TOK] [--from-start]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const cfg = loadConfig();
const ONLY = opt('--channel', null);

// Serialize + space multi-block (long) messages so the harness delivers each block whole
// (a burst within ~200ms is batched and re-truncated at the ~3 KB event cap). stdout cannot
// fail, so this sink never triggers the engine's rollback path — behaviour is as before 3.2.0.
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

const rx = createReceiver({
  instance,
  emit,
  pin: opt('--base', process.env.CC_BASE) || cfg.pin,
  token: opt('--token', process.env.CC_TOKEN) || cfg.token,
  only: ONLY,
  firehose: args.includes('--all') || ONLY !== null,   // firehose when asked, or when scoped to ONE channel
  fromStart: args.includes('--from-start'),
});
rx.start();
