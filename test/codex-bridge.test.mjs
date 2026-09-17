// cc-codex-bridge integration test (3.2.0) — the Codex receive path, REAL spawn. node:assert only.
//   node test/codex-bridge.test.mjs
//
// Boots the vendored server on a scratch port, spawns the bridge as the join hook would
// (`ensure` → detached `run`), with CODEX_BIN pointed at a shim that logs every `codex queue`
// call and can be told to FAIL. Asserts:
//   A. a DM to the bridge's identity reaches `codex queue --thread <sid> --message …` in <2s, exactly once;
//   B. FORCED FAILURE: with the shim failing, the message is attempted but NOT lost — once the shim
//      recovers, the engine's direct retry queue (the failed message object is held and re-emitted;
//      the cursor is never rolled back) redelivers it exactly once (the authority's
//      cursor-advance-vs-emit-failure flag);
//   C. ambient traffic is not queued; D. `stop --session` kills the bridge and clears the pid file;
//   E. no `fatal: not a git repository` leak on stderr from cc-rev (codeRev stdio guard).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami } from '../src/cc-discover.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const BRIDGE = join(__dirname, '..', 'src', 'cc-codex-bridge.mjs');
const SHIM = join(__dirname, 'fixtures', 'codex-shim.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ports are env-overridable: two agents running suites on one box collided on the fixed ones
// (reviewer, 2026-09-17). `CC_TEST_PORT=… node test/codex-bridge.test.mjs` to run beside another suite.
const PORT = Number(process.env.CC_TEST_PORT || 8796);
const HOME = mkdtempSync(join(tmpdir(), 'cccodex-home-'));   // isolates ~/.claude/.cc-listen (pid/beacon/log)
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-codex-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cccodex-cache-'));
process.env.CC_BEACON_PORT = String(process.env.CC_TEST_BEACON_PORT || 8898);
process.env.CC_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'tt';
const DATA = mkdtempSync(join(tmpdir(), 'cccodex-data-'));
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };
const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const ID = 'testbox/codex-lane-aaaaaaaa';
const LOG = join(HOME, 'shim.log');
const FAIL = join(HOME, 'shim.fail');
writeFileSync(LOG, '');
const env = { ...process.env, HOME, USERPROFILE: HOME, CODEX_BIN: SHIM, CODEX_SHIM_LOG: LOG, CODEX_SHIM_FAIL: FAIL, CC_RETRY_MS: '800', CC_RETRY_MAX_ATTEMPTS: '3', CC_PARENT_CHECK_MS: '500', CC_QUEUE_TIMEOUT_MS: '1500' };

function boot(epoch) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), CC_EPOCH: String(epoch), CC_HOST: 'codexhost', CC_DATA_DIR: DATA, MCP_API_KEY: TOKEN },
    stdio: 'ignore',
  });
}
async function waitUp(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await whoami(BASE, 1500)) return true; await sleep(500); }
  return false;
}
async function send(channel, content, sender = 'tester', type = 'message') {
  const r = await fetch(BASE + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender, content, message_type: type }) });
  return r.json();
}
const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const queued = (needle) => calls().filter((c) => c.ok && c.argv[0] === 'queue' && c.argv.includes('--thread') && c.argv[c.argv.indexOf('--thread') + 1] === SID && c.argv.join(' ').includes(needle));
const attempted = (needle) => calls().filter((c) => c.argv.join(' ').includes(needle));
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); }

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };
const pidFile = join(HOME, '.claude', '.cc-listen', `${SID}.bridge.pid`);
const bridgeLog = join(HOME, '.claude', '.cc-listen', `${SID}.bridge.log`);

// --- I: the parent walk (pure; the platform readers are one function each) ---
{
  const { findCodexInChain } = await import('../src/cc-codex-bridge.mjs');
  const mk = (rows) => (pid) => rows[pid] || null;
  // bash(500) ← codex.exe(400) ← pwsh(300): found at hop 1
  ok(findCodexInChain(500, mk({ 500: { pid: 500, ppid: 400, name: 'bash.exe' }, 400: { pid: 400, ppid: 300, name: 'codex.exe' }, 300: { pid: 300, ppid: 1, name: 'pwsh.exe' } })) === 400, 'I: finds codex.exe one hop up');
  // node(600) ← bash(500) ← cmd(450) ← conhost(440) ← codex(400): found through wrappers
  ok(findCodexInChain(600, mk({ 600: { pid: 600, ppid: 500, name: 'node.exe' }, 500: { pid: 500, ppid: 450, name: 'bash.exe' }, 450: { pid: 450, ppid: 440, name: 'cmd.exe' }, 440: { pid: 440, ppid: 400, name: 'conhost.exe' }, 400: { pid: 400, ppid: 1, name: 'codex.exe' } })) === 400, 'I: walks through cmd/conhost wrappers');
  // no codex anywhere → null (watch stays off, no self-kill)
  ok(findCodexInChain(500, mk({ 500: { pid: 500, ppid: 300, name: 'bash.exe' }, 300: { pid: 300, ppid: 1, name: 'pwsh.exe' } })) === null, 'I: no codex above → null');
  // an unreadable ancestor → null, never a bogus pid; pid 1 stops the walk
  ok(findCodexInChain(500, mk({ 500: { pid: 500, ppid: 77, name: 'bash.exe' } })) === null, 'I: broken chain → null');
  ok(findCodexInChain(1, mk({})) === null, 'I: pid 1 → null');
  // helper images that merely CONTAIN "codex" must not be mistaken for the CLI (both exist on a dev box)
  ok(findCodexInChain(500, mk({ 500: { pid: 500, ppid: 400, name: 'bash.exe' }, 400: { pid: 400, ppid: 300, name: 'codex-code-mode-host.exe' }, 300: { pid: 300, ppid: 200, name: 'codex-computer-use-swift.exe' }, 200: { pid: 200, ppid: 1, name: 'pwsh.exe' } })) === null, 'I: codex-* helper images are NOT the CLI');
  ok(findCodexInChain(500, mk({ 500: { pid: 500, ppid: 400, name: 'bash.exe' }, 400: { pid: 400, ppid: 300, name: 'codex-code-mode-host.exe' }, 300: { pid: 300, ppid: 1, name: 'codex' } })) === 300, 'I: bare `codex` (POSIX image) matches, the helper above it does not');
}

let srv = boot(5);
try {
  ok(await waitUp(), 'server booted');

  // spawn exactly as codex-join.sh does: `ensure` detaches a `run`
  const ens = spawnSync(process.execPath, [BRIDGE, 'ensure', ID, '--session', SID, '--base', BASE, '--token', TOKEN], { env, encoding: 'utf8' });
  ok(/bridge started/.test(ens.stdout), 'ensure started a detached bridge: ' + ens.stdout.trim());
  ok(await until(() => existsSync(pidFile), 5000), 'pid file written');
  ok(await until(() => existsSync(bridgeLog) && /listening as/.test(readFileSync(bridgeLog, 'utf8')), 15000), 'bridge seeded and listening (log)');
  const ens2 = spawnSync(process.execPath, [BRIDGE, 'ensure', ID, '--session', SID], { env, encoding: 'utf8' });
  ok(/already running/.test(ens2.stdout), 'ensure is idempotent (second call is a no-op)');

  // A: addressed DM → codex queue, exactly once
  await send(`dm-codex-lane-aaaaaaaa`, 'DM_ONE hello codex');
  const t0 = Date.now();
  ok(await until(() => queued('DM_ONE').length >= 1, 2000), 'A: DM queued into the Codex session');
  ok(Date.now() - t0 < 2000, 'A: within 2s');
  await sleep(600);
  ok(queued('DM_ONE').length === 1, 'A: exactly once');
  const a = queued('DM_ONE')[0];
  ok(a && a.argv[0] === 'queue' && a.argv[a.argv.indexOf('--thread') + 1] === SID && /CHAT #dm-codex-lane-aaaaaaaa tester \[message\]/.test(a.argv[a.argv.indexOf('--message') + 1]), 'A: `codex queue --thread <sid> --message CHAT …` shape');

  // C: ambient is not queued
  const before = calls().length;
  await send('general', 'AMBIENT chatter between others');
  await sleep(700);
  ok(calls().length === before, 'C: ambient message not queued');

  // B: forced failure → attempted, not lost; recovers → redelivered exactly once
  writeFileSync(FAIL, '1');
  await send(`dm-codex-lane-aaaaaaaa`, 'DM_TWO must not be lost');
  // 5s not 2s: under the full-suite load the first attempt can ride the 2s poll fallback + a node spawn.
  ok(await until(() => attempted('DM_TWO').length >= 1, 5000), 'B: delivery attempted while codex is failing');
  await sleep(400);
  ok(queued('DM_TWO').length === 0, 'B: not delivered while failing (shim exit 1)');
  rmSync(FAIL, { force: true });
  ok(await until(() => queued('DM_TWO').length >= 1, 6000), 'B: REDELIVERED after recovery (direct retry queue, cursor never rolled back)');
  await sleep(1500);
  ok(queued('DM_TWO').length === 1, 'B: redelivered exactly once');
  ok(queued('DM_ONE').length === 1, 'B: the earlier DM was not replayed by the retry');

  // F: POISON — one message Codex permanently refuses must neither block nor duplicate the
  //    others, and must be PARKED after CC_RETRY_MAX_ATTEMPTS (the reviewer's flood/dup repro:
  //    a cursor rollback re-queued every later message forever).
  await send(`dm-codex-lane-aaaaaaaa`, 'DM_POISON codex will reject this one');
  await send(`dm-codex-lane-aaaaaaaa`, 'DM_FOUR must arrive once despite the poison before it');
  ok(await until(() => queued('DM_FOUR').length >= 1, 3000), 'F: the message AFTER the poison is delivered');
  ok(await until(() => attempted('DM_POISON').length >= 3, 8000), 'F: poison retried up to CC_RETRY_MAX_ATTEMPTS (3)');
  ok(await until(() => /PARKED #dm-codex-lane-aaaaaaaa/.test(readFileSync(bridgeLog, 'utf8')), 3000), 'F: poison PARKED with a log line');
  await sleep(2500);   // past the next retry window — nothing may move any more
  ok(attempted('DM_POISON').length === 3, 'F: poison not retried beyond the cap (no infinite flood)');
  ok(queued('DM_FOUR').length === 1, 'F: DM_FOUR exactly once (no duplicate from any retry)');
  ok(queued('DM_TWO').length === 1 && queued('DM_ONE').length === 1, 'F: earlier messages untouched by the poison cycle');

  // H: a HUNG `codex queue` is timed out (CC_QUEUE_TIMEOUT_MS), rejected into the retry queue, and
  //    the neighbours are unaffected — a pending-forever promise would have lost the message silently.
  await send(`dm-codex-lane-aaaaaaaa`, 'DM_HANG codex stalls on this one');
  await send(`dm-codex-lane-aaaaaaaa`, 'DM_FIVE after the hang');
  ok(await until(() => queued('DM_FIVE').length >= 1, 3000), 'H: the message after a hung one is delivered');
  ok(await until(() => /timed out after/.test(readFileSync(bridgeLog, 'utf8')), 5000), 'H: hung codex queue timed out and logged');
  ok(await until(() => attempted('DM_HANG').length >= 2, 6000), 'H: the hung message is retried from the queue');
  await sleep(1500);
  ok(queued('DM_FIVE').length === 1, 'H: DM_FIVE exactly once');

  // E: no git stderr leak (cc-rev stdio guard) — the bridge log is the bridge's stderr
  ok(!/fatal: not a git repository/.test(readFileSync(bridgeLog, 'utf8')), 'E: no `fatal: not a git repository` leak on stderr');

  // G: lifetime tied to the Codex process — a bridge whose --parent dies exits on its own
  //    (backstop for a Codex that dies without SessionEnd: no ghost peer, no queueing into a dead thread)
  const SID2 = 'cccccccc-1111-4222-8333-444444444444';
  const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const b2 = spawn(process.execPath, [BRIDGE, 'run', 'testbox/codex-lane-cccccccc', '--session', SID2, '--parent', String(dummy.pid), '--base', BASE, '--token', TOKEN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let b2err = ''; b2.stderr.on('data', (d) => { b2err += d.toString(); });
  let b2exit = null; b2.on('exit', (c) => { b2exit = c; });
  ok(await until(() => /listening as testbox\/codex-lane-cccccccc/.test(b2err), 15000), 'G: parent-watched bridge is listening');
  dummy.kill();
  ok(await until(() => b2exit !== null, 6000), 'G: bridge exited after its codex parent died');
  ok(/codex parent pid \d+ is gone/.test(b2err), 'G: exit reason logged');
  ok(!existsSync(join(HOME, '.claude', '.cc-listen', `${SID2}.bridge.pid`)), 'G: its pid file removed');

  // J: the two cc-ws behaviour fixes inherited from the engine, at the CLIENT level (ws.test.mjs
  //    covers the server side and stays unchanged): (1) `--all` asks for a firehose socket, so an
  //    AMBIENT message arrives over PUSH after the poll has stopped; (2) `--channel X` scopes push
  //    frames — an addressed message on another channel is NOT emitted.
  {
    const CCWS = join(__dirname, '..', 'src', 'cc-ws.mjs');
    const spawnWs = (id, extra) => { const c = spawn(process.execPath, [CCWS, id, '--base', BASE, '--token', TOKEN, ...extra], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: ['ignore', 'pipe', 'pipe'] }); c.out = ''; c.err = ''; c.stdout.on('data', (d) => { c.out += d; }); c.stderr.on('data', (d) => { c.err += d; }); return c; };
    const all = spawnWs('carol', ['--all']);
    const scoped = spawnWs('dave', ['--channel', 'reviews']);
    ok(await until(() => /push connected/.test(all.err) && /push connected/.test(scoped.err), 15000), 'J: both cc-ws receivers on push (poll stopped)');
    await sleep(300);
    await send('general', 'AMBIENT_J nobody addressed');
    ok(await until(() => /AMBIENT_J/.test(all.out), 3000), 'J1: --all receives an AMBIENT message over push (firehose=1 requested)');
    ok(!/AMBIENT_J/.test(scoped.out), 'J1: --channel receiver does not see it');
    await send('general', 'OFFSCOPE_J @dave you are mentioned but this is #general');
    await send('reviews', 'INSCOPE_J hello reviews channel');
    ok(await until(() => /INSCOPE_J/.test(scoped.out), 3000), 'J2: --channel reviews shows the in-scope message');
    await sleep(600);
    ok(!/OFFSCOPE_J/.test(scoped.out), 'J2: an @mention on another channel is NOT emitted to a --channel receiver');
    try { all.kill(); scoped.kill(); } catch {}
  }

  // D: stop
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const st = spawnSync(process.execPath, [BRIDGE, 'stop', '--session', SID], { env, encoding: 'utf8' });
  ok(/bridge stopped/.test(st.stdout), 'D: stop reported');
  ok(await until(() => !existsSync(pidFile), 3000), 'D: pid file removed');
  ok(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000), 'D: bridge process exited');
} catch (e) {
  failed = true;
  console.error('❌ codex-bridge.test threw:', e.stack || e.message);
} finally {
  try { const pid = Number(readFileSync(pidFile, 'utf8')); pid && process.kill(pid); } catch {}
  try { srv && srv.kill(); } catch {}
}
if (failed) { console.error('❌ codex-bridge.test FAILED'); process.exit(1); }
console.log('✅ codex-bridge.test: all assertions passed (real spawn via ensure, queue <2s exactly-once, ambient suppressed, forced-failure redelivery, stop)');
process.exit(0);
