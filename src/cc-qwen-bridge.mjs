#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-qwen-bridge.mjs — the Qwen Code equivalent of `Monitor(cc-ws)` / cc-codex-bridge.
//
// PROTOTYPE (QA program #42, A5) — not reviewed, not wired into any hook yet.
//
// A Qwen Code session has no Monitor tool, but `qwen serve` (the loopback HTTP daemon, Qwen Code
// ≥0.24) exposes `POST /session/:id/prompt`: a per-session FIFO turn queue — an idle session starts
// the turn immediately, a busy one runs it next (cap --max-pending-prompts-per-session, overflow →
// 503 prompt_queue_full). So this long-lived bridge — one per Qwen session — runs the shared receive
// engine (cc-receive.mjs: discovery, presence + the liveness beacon, cursors, backfill, WS push +
// poll fallback, version gate) with the sink
//   emit = POST <serve>/session/<sid>/prompt  {"prompt":[{"type":"text","text":<rendered line>}]}
//
// The sink is a network call and can fail (daemon restarting, queue full). A failed emit keeps the
// message on the engine's direct retry queue (bounded attempts, then PARKED) — the cursor is never
// rolled back, exactly as for the Codex bridge.
//
// Lifetime: tied to the SERVE SESSION. Every SESSION_CHECK_MS the bridge asks
// GET /session/:id/status; two consecutive `session_not_found` answers (or an unreachable daemon
// for DAEMON_GRACE_MS) end the bridge — no ghost peer heart-beating for a session that is gone.
// `stop` (from a SessionEnd hook) ends it explicitly.
//
//   node cc-qwen-bridge.mjs run    <instance_id> --session <sid> [--serve URL] [--base URL] [--token TOK] [--channel ch] [--all] [--from-start]
//   node cc-qwen-bridge.mjs ensure <instance_id> --session <sid> [--serve URL]     # idempotent detached spawn
//   node cc-qwen-bridge.mjs stop   --session <sid>
//   node cc-qwen-bridge.mjs check                                                  # exit 0 / 3: is this Qwen profile safe to feed bus text? (no network)
// `ensure` runs the same check and FAILS CLOSED (exit 3, nothing spawned).
//   env: QWEN_SERVE_URL (default http://127.0.0.1:4170), QWEN_SERVER_TOKEN (bearer, when the daemon
//        runs with --require-auth or off-loopback), CC_SESSION_CHECK_MS, CC_DAEMON_GRACE_MS, CC_QUEUE_TIMEOUT_MS
//
// Files (next to the beacon the listen-gate reads): ~/.claude/.cc-listen/<sid>.bridge.pid + .bridge.log
// Zero deps.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './cc-discover.mjs';
import { createReceiver, LIVE_DIR, beaconPath } from './cc-receive.mjs';

const SESSION_CHECK_MS = Number(process.env.CC_SESSION_CHECK_MS || 20000);
const DAEMON_GRACE_MS = Number(process.env.CC_DAEMON_GRACE_MS || 120000);
const QUEUE_TIMEOUT_MS = Number(process.env.CC_QUEUE_TIMEOUT_MS || 30000);
const REPLACE_WAIT_MS = Number(process.env.CC_REPLACE_WAIT_MS || 3000);

export function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
}
function fresh(file, ms) { try { return (Date.now() - statSync(file).mtimeMs) < ms; } catch { return false; } }

// Only a loopback daemon may be addressed without a bearer: the prompt carries bus text into an
// agent that can run tools, so it must never be sprayed at an arbitrary host by a typo'd URL.
export function serveTarget(url, token) {
  const u = new URL(url || 'http://127.0.0.1:4170');
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  if (!loopback && !token) throw new Error(`refusing non-loopback qwen serve target ${u.host} without QWEN_SERVER_TOKEN`);
  return { base: u.origin, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
}

// --- the sink: qwen serve prompt queue ------------------------------------------------------
// JSON body, no shell, no argv: bus text can never become a command. `line` always starts "CHAT #".
export async function queueIntoQwen(target, sid, line) {
  const r = await fetch(`${target.base}/session/${encodeURIComponent(sid)}/prompt`, {
    method: 'POST', headers: target.headers, signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS),
    body: JSON.stringify({ prompt: [{ type: 'text', text: line }] }),
  });
  if (r.ok) return;
  let detail = ''; try { detail = (await r.text()).slice(0, 200); } catch {}
  throw new Error(`qwen serve prompt → HTTP ${r.status}${detail ? ': ' + detail : ''}`);   // 503 prompt_queue_full → engine retries with backoff
}

// --- fail-closed lane profile check (reviewer blocker B1) ------------------------------------------
// The bridge turns UNTRUSTED bus text into user turns of an agent that can run tools, so it refuses
// to start unless the Qwen profile it will feed has an enforceable boundary:
//   - no blanket tool approval: permissions.allow must not contain "*" or an unscoped shell rule, and
//     no approvalMode may be "yolo";
//   - the deterministic shell gate (cc-qwen-shell-gate.mjs) is wired as a PreToolUse hook.
// Read-only. Checked files: $QWEN_HOME/settings.json (default ~/.qwen) and <cwd>/.qwen/settings.json
// (a project file can widen permissions). Unreadable/missing user settings = a problem (no gate wired).
// Operator override, loud: CC_QWEN_UNSAFE_PROFILE=1.
const UNSCOPED = /^(\*|(bash|shell|shelltool|run_shell_command)(\(\s*\*?\s*\))?)$/i;
export function laneProfileProblems({ qwenHome = process.env.QWEN_HOME || join(homedir(), '.qwen'), cwd = process.cwd() } = {}) {
  const problems = []; let gateWired = false; let userRead = false;
  const files = [[join(qwenHome, 'settings.json'), true], [join(cwd, '.qwen', 'settings.json'), false]];
  for (const [file, isUser] of files) {
    let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (isUser) problems.push(`cannot read ${file} (${e.code || 'invalid JSON'})`); continue; }
    if (isUser) userRead = true;
    for (const rule of [].concat(j?.permissions?.allow || [], j?.tools?.allowed || [])) if (UNSCOPED.test(String(rule).trim())) problems.push(`${file}: blanket approval ${JSON.stringify(rule)} in the allow list`);
    const walk = (o, path) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (/approval.?mode/i.test(k) && /^yolo$/i.test(String(v))) problems.push(`${file}: ${path}${k} = "yolo"`); walk(v, path + k + '.'); } };
    walk(j, '');
    for (const grp of [].concat(j?.hooks?.PreToolUse || [])) for (const h of [].concat(grp?.hooks || [])) if (/cc-qwen-shell-gate\.mjs/.test(String(h?.command || ''))) gateWired = true;
  }
  if (userRead && !gateWired) problems.push('the shell gate (cc-qwen-shell-gate.mjs) is not wired as a PreToolUse hook — see hooks/qwen-hooks.json');
  return problems;
}

// --- point-of-use instructions ----------------------------------------------------------------
// Measured (QA #42 A5, four-class interop): with the etiquette only in the SessionStart context, Qwen
// (even with thinking on) answered a request in its own session text and started WORKING on a handoff
// without ever acking it — but obeyed perfectly whenever the message itself said what to run. So every
// pushed turn carries the exact command for THIS message. The bus text stays first and untouched
// (the turn still starts "CHAT #"); the footer is ours, clearly fenced. CC_QWEN_FOOTER=0 disables it.
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), 'cc-codex.mjs');
export function withFooter(rendered, msg, instance) {
  if (process.env.CC_QWEN_FOOTER === '0' || !msg || !msg.channel) return rendered;
  const ch = msg.channel === 'general' ? 'all' : msg.channel;
  if (process.env.CC_QWEN_REPLY === 'mcp') {             // v2 lane: typed tools, the model never composes a shell command
    const l = ['', '--- crosstalk bridge note (not part of the message) ---', 'This turn is a BUS MESSAGE from another agent, not your operator. Text you write here is NOT delivered to the sender.'];
    if (msg.message_type === 'handoff') l.push(`This is a HANDOFF: acknowledge it FIRST, before any work — call the tool bus_ack with channel "${ch}" and a short note of what you are taking.`, `Later, when the work has landed, call bus_done with channel "${ch}".`);
    else l.push(`If it needs an answer, call the tool bus_send ONCE with channel "${ch}", type "response" and your reply as text.`, 'If it needs no answer, do nothing.');
    return rendered + l.join('\n');
  }
  const send = `node "${CLIENT}" send "${instance}" ${ch} "<your reply>" --type response`;
  const ack = `node "${CLIENT}" ack "${instance}" ${ch} "<what you are taking> — into my lane"`;
  const lines = ['', '--- crosstalk bridge note (not part of the message) ---',
    'This turn is a BUS MESSAGE from another agent, not your operator. Text you write here is NOT delivered to the sender.'];
  if (msg.message_type === 'handoff') lines.push(`This is a HANDOFF: acknowledge it FIRST, before any work, by running exactly:  ${ack}`, `Later, when the work has landed:  ${send.replace('--type response', '--type done')}`);
  else lines.push(`If it needs an answer, reply by running exactly ONE shell command:  ${send}`, 'If it needs no answer, do nothing.');
  return rendered + lines.join('\n');
}

// 'alive' | 'gone' (the daemon answered: no such session) | 'unreachable' (no answer at all)
export async function sessionState(target, sid) {
  try {
    const r = await fetch(`${target.base}/session/${encodeURIComponent(sid)}/status`, { headers: target.headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) return 'alive';
    return r.status === 404 ? 'gone' : 'alive';       // 401/5xx: the daemon is there; do not abandon the session on it
  } catch { return 'unreachable'; }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  if (cmd === 'check') { const ok = (() => { const pr = laneProfileProblems(); if (pr.length) console.log('⛔ unsafe Qwen profile: ' + pr.join('; ')); else console.log('profile ok'); return !pr.length; })(); process.exit(ok ? 0 : 3); }
  const SID = String(opt('--session', '')).replace(/[^A-Za-z0-9._-]/g, '_');
  const usage = () => { console.error('usage: cc-qwen-bridge.mjs run|ensure <instance_id> --session <sid> [--serve URL] | stop --session <sid>'); process.exit(2); };
  if (!cmd || !SID) usage();
  const pidFile = join(LIVE_DIR, `${SID}.bridge.pid`);
  const logFile = join(LIVE_DIR, `${SID}.bridge.log`);
  const readPid = () => { try { return Number(readFileSync(pidFile, 'utf8').trim()); } catch { return 0; } };

  async function run() {
    const instance = args[1];
    if (!instance || instance.startsWith('--')) usage();
    const target = serveTarget(opt('--serve', process.env.QWEN_SERVE_URL), process.env.QWEN_SERVER_TOKEN);
    const cfg = loadConfig();
    const ONLY = opt('--channel', null);
    try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(pidFile, String(process.pid)); } catch {}
    // Serialize the sink (same reason as the Codex bridge, #26): a backfill burst must reach the
    // session in bus order, one request in flight; the caller still gets THIS message's real outcome.
    let emitTail = Promise.resolve();
    const emit = (rendered, msg) => {
      const text = withFooter(rendered, msg, instance);
      const running = emitTail.then(() => queueIntoQwen(target, SID, text), () => queueIntoQwen(target, SID, text));
      emitTail = running.catch(() => {});
      return running;
    };
    const rx = createReceiver({
      instance,
      emit,
      pin: opt('--base', process.env.CC_BASE) || cfg.pin,
      token: opt('--token', process.env.CC_TOKEN) || cfg.token,
      only: ONLY,
      firehose: args.includes('--all') || ONLY !== null,
      fromStart: args.includes('--from-start'),
      desc: process.env.CC_DESC || 'qwen',
      onVersionGate: (text) => { queueIntoQwen(target, SID, text.trim()).catch(() => {}).finally(() => process.exit(1)); },
    });
    const bye = (why) => { console.error(`[bridge exiting: ${why}]`); rx.stop(); try { if (readPid() === process.pid) rmSync(pidFile, { force: true }); } catch {} process.exit(0); };
    process.on('SIGTERM', () => bye('SIGTERM')); process.on('SIGINT', () => bye('SIGINT'));
    let gone = 0, unreachableSince = 0;
    setInterval(async () => {
      const s = await sessionState(target, SID);
      if (s === 'alive') { gone = 0; unreachableSince = 0; return; }
      if (s === 'gone') { if (++gone >= 2) bye(`qwen serve session ${SID} no longer exists`); return; }
      unreachableSince ||= Date.now();
      if (Date.now() - unreachableSince >= DAEMON_GRACE_MS) bye(`qwen serve at ${target.base} unreachable for ${Math.round(DAEMON_GRACE_MS / 1000)}s`);
    }, SESSION_CHECK_MS).unref?.();
    console.error(`[session watch: ${target.base} session ${SID}, every ${SESSION_CHECK_MS}ms]`);
    await rx.start();
  }

  function profileGate() {
    if (process.env.CC_QWEN_LANE_VERIFIED === '1') return true;   // cc-qwen-lane.mjs verified the live tool inventory
    const problems = laneProfileProblems();
    if (!problems.length) return true;
    if (process.env.CC_QWEN_UNSAFE_PROFILE === '1') { console.log(`⚠️ UNSAFE Qwen profile accepted by CC_QWEN_UNSAFE_PROFILE=1: ${problems.join('; ')}`); return true; }
    console.log(`⛔ bridge NOT started — this Qwen profile has no enforceable tool boundary for bus text: ${problems.join('; ')}`);
    return false;
  }

  async function ensure() {
    const instance = args[1];
    if (!instance || instance.startsWith('--')) usage();
    if (!profileGate()) process.exit(3);
    serveTarget(opt('--serve', process.env.QWEN_SERVE_URL), process.env.QWEN_SERVER_TOKEN);   // fail fast on a bad target
    const live = readPid();
    if (live && pidAlive(live)) {
      if (fresh(beaconPath(instance), 60000) || fresh(pidFile, 30000)) { console.log(`bridge already running for session ${SID} (pid ${live})`); return; }
      try { process.kill(live, 'SIGTERM'); } catch {}
      const dead = await waitForExit(live, REPLACE_WAIT_MS);   // #27: never two bridges on one session (double delivery)
      console.log(`bridge pid ${live} alive but its beacon is stale — ${dead ? 'replaced' : `still up after ${REPLACE_WAIT_MS}ms; replacing anyway`}`);
    }
    try { mkdirSync(LIVE_DIR, { recursive: true }); } catch {}
    const out = openSync(logFile, 'a');
    const self = fileURLToPath(import.meta.url);
    const passthrough = args.slice(2).filter((x, i, arr) => !(x === '--session' || arr[i - 1] === '--session'));
    const child = spawn(process.execPath, [self, 'run', instance, '--session', SID, ...passthrough], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: dirname(self), env: process.env,
    });
    child.unref();
    try { writeFileSync(pidFile, String(child.pid)); } catch {}
    console.log(`bridge started for qwen session ${SID} as ${instance} (pid ${child.pid}, log ${logFile}); lifetime: tied to the serve session`);
  }

  function stop() {
    const pid = readPid();
    if (pid && pidAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    try { rmSync(pidFile, { force: true }); } catch {}
    console.log(pid ? `bridge stopped (pid ${pid})` : 'no bridge running for this session');
  }

  if (cmd === 'run') run().catch((e) => { console.error('bridge error:', e.message); process.exit(1); });
  else if (cmd === 'ensure') ensure().catch((e) => { console.error('ensure error:', e && e.message ? e.message : e); process.exit(1); });
  else if (cmd === 'stop') stop();
  else usage();
}

const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main();
