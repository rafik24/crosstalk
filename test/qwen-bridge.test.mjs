// cc-qwen-bridge integration test (PROTOTYPE, QA #42 A5) — the Qwen receive path, REAL spawn. node:assert-free.
//   node test/qwen-bridge.test.mjs
//
// Boots the vendored server on a scratch port and an in-process FAKE `qwen serve` (an http server
// that records every POST /session/:id/prompt and can be told to answer 503 prompt_queue_full or
// 404 session_not_found), then spawns the bridge as the join hook would (`ensure` → detached `run`).
// Asserts:
//   A. a DM to the bridge's identity reaches POST /session/<sid>/prompt in <2s, exactly once, as a
//      JSON text prompt that starts "CHAT #";
//   B. FORCED FAILURE: while the fake answers 503, the message is attempted but NOT lost — once it
//      recovers, the engine's retry queue redelivers it exactly once;
//   C. ambient traffic is not queued;
//   D. ORDER: a burst of 5 DMs arrives in bus order (serialized sink);
//   E. LIFETIME: when the serve session disappears (404 on /status), the bridge exits on its own
//      and clears its pid file; `ensure` on a live bridge is idempotent; `stop` kills it;
//   F. SAFETY: a non-loopback --serve target without QWEN_SERVER_TOKEN is refused;
//   G. FAIL-CLOSED PROFILE (reviewer B1): `ensure` refuses (exit 3, nothing spawned) when the Qwen profile allows "*" /
//      an unscoped shell rule / yolo, when a PROJECT .qwen/settings.json widens it, or when the shell gate is not wired;
//   H. a configured QWEN_SERVER_TOKEN reaches the daemon as a bearer;  L. the #27 stale-beacon REPLACE path (one bridge, new pid).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami } from '../src/cc-discover.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';
import { pidAlive, serveTarget, laneProfileProblems } from '../src/cc-qwen-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const BRIDGE = join(__dirname, '..', 'src', 'cc-qwen-bridge.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.CC_TEST_PORT || 8795);
const HOME = mkdtempSync(join(tmpdir(), 'ccqwen-home-'));
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-qwen-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ccqwen-cache-'));
process.env.CC_BEACON_PORT = String(process.env.CC_TEST_BEACON_PORT || 8897);
process.env.CC_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'tt';
const DATA = mkdtempSync(join(tmpdir(), 'ccqwen-data-'));
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };
const SID = 'bbbbbbbb-1111-4222-8333-444444444444';
const ID = 'testbox/qwen-lane-bbbbbbbb';

// --- the fake `qwen serve` ------------------------------------------------------------------
const fake = { prompts: [], attempts: [], mode: 'ok', sessionAlive: true };
const fakeServer = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const m = req.url.match(/^\/session\/([^/]+)\/(prompt|status)$/);
    if (!m) return json(404, { error: 'no route' });
    if (decodeURIComponent(m[1]) !== SID || !fake.sessionAlive) return json(404, { error: 'No session', code: 'session_not_found' });
    if (m[2] === 'status') return json(200, { sessionId: SID, hasActivePrompt: false });
    let text = ''; try { text = JSON.parse(body).prompt?.[0]?.text || ''; } catch {}
    fake.attempts.push(text);
    if (fake.mode === 'full') { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' }); return res.end(JSON.stringify({ code: 'prompt_queue_full' })); }
    fake.prompts.push({ text, contentType: req.headers['content-type'], auth: req.headers.authorization || '' });
    json(200, { promptId: 'p' + fake.prompts.length });
  });
});
await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
const SERVE = `http://127.0.0.1:${fakeServer.address().port}`;
const QH = join(HOME, 'qwen-home'); mkdirSync(QH, { recursive: true });
const GATE_HOOK = { PreToolUse: [{ matcher: '^run_shell_command$', hooks: [{ type: 'command', command: 'node "/x/src/cc-qwen-shell-gate.mjs"' }] }] };
const profile = (obj) => writeFileSync(join(QH, 'settings.json'), JSON.stringify(obj));
profile({ hooks: GATE_HOOK });
const env = { ...process.env, HOME, USERPROFILE: HOME, QWEN_HOME: QH, CC_QWEN_UNSAFE_PROFILE: '', QWEN_SERVE_URL: SERVE, QWEN_SERVER_TOKEN: '', CC_RETRY_MS: '800', CC_RETRY_MAX_ATTEMPTS: '5', CC_SESSION_CHECK_MS: '400', CC_BASE: BASE, CC_TOKEN: TOKEN };

function boot(epoch) {
  return spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), CC_EPOCH: String(epoch), CC_HOST: 'qwenhost', CC_DATA_DIR: DATA, MCP_API_KEY: TOKEN }, stdio: 'ignore' });
}
async function waitUp(timeoutMs = 30000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await whoami(BASE, 1500)) return true; await sleep(300); } return false; }
async function send(channel, content, sender = 'tester', type = 'message') {
  return (await fetch(BASE + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender, content, message_type: type }) })).json();
}
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); }
const got = (needle) => fake.prompts.filter((p) => p.text.includes(needle));

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };
const pidFile = join(HOME, '.claude', '.cc-listen', `${SID}.bridge.pid`);
const bridgeLog = join(HOME, '.claude', '.cc-listen', `${SID}.bridge.log`);
const readPid = () => { try { return Number(readFileSync(pidFile, 'utf8').trim()); } catch { return 0; } };
const ensure = () => spawnSync(process.execPath, [BRIDGE, 'ensure', ID, '--session', SID], { env, encoding: 'utf8', timeout: 20000 });

// --- F: target safety (pure) ---
console.log('F serve-target safety');
{
  let threw = false; try { serveTarget('http://10.1.2.3:4170', ''); } catch { threw = true; }
  ok(threw, 'a non-loopback serve target without a bearer is refused');
  ok(serveTarget('http://10.1.2.3:4170', 'tok').headers.Authorization === 'Bearer tok', 'a non-loopback target WITH a bearer is accepted and carries it');
  ok(!serveTarget('http://127.0.0.1:4170', '').headers.Authorization, 'loopback needs no bearer');
}

console.log('G fail-closed profile');
{
  const cwd = mkdtempSync(join(tmpdir(), 'ccqwen-proj-'));
  const tryEnsure = (extra = {}) => spawnSync(process.execPath, [BRIDGE, 'ensure', ID, '--session', SID], { env: { ...env, ...extra }, cwd, encoding: 'utf8', timeout: 20000 });
  const refused = (r) => r.status === 3 && /NOT started/.test(r.stdout) && !existsSync(join(HOME, '.claude', '.cc-listen', `${SID}.bridge.pid`));
  profile({ permissions: { allow: ['*', 'Bash(ls *)'] }, hooks: GATE_HOOK });
  ok(refused(tryEnsure()), 'permissions.allow contains "*" → ensure refuses, nothing spawned');
  profile({ permissions: { allow: ['run_shell_command'] }, hooks: GATE_HOOK });
  ok(refused(tryEnsure()), 'an unscoped shell rule → refused');
  profile({ tools: { approvalMode: 'yolo' }, hooks: GATE_HOOK });
  ok(refused(tryEnsure()), 'approvalMode yolo → refused');
  profile({ permissions: { allow: ['Bash(ls *)'] } });
  ok(refused(tryEnsure()) && /shell gate/.test(tryEnsure().stdout), 'shell gate not wired → refused, and says so');
  rmSync(join(QH, 'settings.json'));
  ok(refused(tryEnsure()), 'unreadable user settings → refused (fail closed)');
  profile({ hooks: GATE_HOOK });
  mkdirSync(join(cwd, '.qwen'), { recursive: true }); writeFileSync(join(cwd, '.qwen', 'settings.json'), JSON.stringify({ permissions: { allow: ['*'] } }));
  ok(refused(tryEnsure()), 'a PROJECT .qwen/settings.json that widens to "*" → refused');
  rmSync(join(cwd, '.qwen'), { recursive: true, force: true });
  ok(laneProfileProblems({ qwenHome: QH, cwd }).length === 0, 'a scoped allow list + wired shell gate is accepted');
  const chk = spawnSync(process.execPath, [BRIDGE, 'check'], { env, cwd, encoding: 'utf8' });
  ok(chk.status === 0 && /profile ok/.test(chk.stdout), '`check` agrees (exit 0, no network)');
  rmSync(cwd, { recursive: true, force: true });
}

const server = boot(1);
let bridgePid = 0;
try {
  if (!await waitUp()) throw new Error('server did not come up on ' + BASE);

  console.log('A delivery');
  const e1 = ensure();
  ok(e1.status === 0 && /bridge started/.test(e1.stdout), `ensure started the bridge (${(e1.stdout || e1.stderr).trim().slice(0, 80)})`);
  bridgePid = readPid();
  ok(await until(() => existsSync(bridgeLog) && /push connected|listening as/.test(readFileSync(bridgeLog, 'utf8')), 15000), 'bridge is listening on the bus');
  const e2 = ensure();
  ok(/already running/.test(e2.stdout) && readPid() === bridgePid, 'a second ensure is idempotent (same pid)');
  const t0 = Date.now();
  await send('dm-qwen-lane-bbbbbbbb', 'hello-A');
  ok(await until(() => got('hello-A').length === 1, 2000), `DM reached POST /session/<sid>/prompt in ${Date.now() - t0} ms`);
  const p = got('hello-A')[0];
  ok(p && p.text.startsWith('CHAT #') && /application\/json/.test(p.contentType), 'delivered as a JSON text prompt that starts "CHAT #"');
  ok(p && /crosstalk bridge note/.test(p.text) && p.text.includes(` send "${ID}" dm-qwen-lane-bbbbbbbb `) && /--type response/.test(p.text), 'carries the point-of-use reply command for THIS channel and identity');
  await send('general', `@${ID} board handoff — work #7 is now yours`, 'tester', 'handoff');
  ok(await until(() => got('work #7').length === 1, 3000) && got('work #7')[0].text.includes(` ack "${ID}" all `) && /acknowledge it FIRST/.test(got('work #7')[0].text), 'a handoff carries the ACK command first (channel general → all)');

  console.log('B forced failure → retry, exactly once');
  fake.mode = 'full';
  await send('dm-qwen-lane-bbbbbbbb', 'hello-B');
  ok(await until(() => fake.attempts.filter((t) => t.includes('hello-B')).length >= 1, 3000), 'the message was attempted while the queue was full (503)');
  ok(got('hello-B').length === 0, 'and not recorded as delivered');
  fake.mode = 'ok';
  ok(await until(() => got('hello-B').length === 1, 8000), 'redelivered after the queue recovered');
  await sleep(1500);
  ok(got('hello-B').length === 1, 'exactly once (no duplicate from the retry queue)');

  console.log('C ambient traffic');
  await send('general', 'ambient-C chatter between other lanes');
  await sleep(1200);
  ok(got('ambient-C').length === 0, 'ambient #general traffic is not pushed into the session');

  console.log('D ordering');
  for (let i = 1; i <= 5; i++) await send('dm-qwen-lane-bbbbbbbb', `burst-D-${i}`);
  ok(await until(() => got('burst-D-').length === 5, 5000), 'all 5 burst messages delivered');
  ok(got('burst-D-').map((x) => x.text.match(/burst-D-(\d)/)[1]).join('') === '12345', 'in bus order');

  console.log('E lifetime');
  fake.sessionAlive = false;
  ok(await until(() => !pidAlive(bridgePid), 5000), 'bridge exited on its own after the serve session disappeared');
  ok(await until(() => !existsSync(pidFile), 2000), 'and cleared its pid file');
  ok(/no longer exists/.test(readFileSync(bridgeLog, 'utf8')), 'with the reason logged');
  fake.sessionAlive = true;
  ensure(); const pid2 = readPid();
  ok(pid2 && pid2 !== bridgePid && pidAlive(pid2), 'ensure starts a fresh bridge afterwards');
  spawnSync(process.execPath, [BRIDGE, 'stop', '--session', SID], { env, encoding: 'utf8' });
  ok(await until(() => !pidAlive(pid2), 3000) && !existsSync(pidFile), '`stop` kills the bridge and clears the pid file');

  console.log('L stale-beacon replace (#27) + H bearer');
  const envTok = { ...env, QWEN_SERVER_TOKEN: 'serve-secret' };
  const connects = () => (readFileSync(bridgeLog, 'utf8').match(/push connected/g) || []).length;
  const c3 = connects();
  spawnSync(process.execPath, [BRIDGE, 'stop', '--session', SID], { env, encoding: 'utf8' });   // (the E-section bridge, if any)
  spawnSync(process.execPath, [BRIDGE, 'ensure', ID, '--session', SID], { env: envTok, encoding: 'utf8', timeout: 20000 });
  const pid3 = readPid();
  const beacon = join(HOME, '.claude', '.cc-listen', ID.replace(/[^A-Za-z0-9._-]/g, '_'));
  ok(await until(() => existsSync(beacon) && connects() > c3, 15000), 'third bridge is attached (push connected) and beating its beacon');
  await send('dm-qwen-lane-bbbbbbbb', 'hello-H');
  ok(await until(() => got('hello-H').length === 1, 3000) && got('hello-H')[0].auth === 'Bearer serve-secret', 'QWEN_SERVER_TOKEN reaches the daemon as a bearer');
  if (process.platform === 'win32') console.log('  ⏭  L: the wedged-bridge (#27 stale-replace) case needs SIGSTOP — skipped on win32');
  else {
  process.kill(pid3, 'SIGSTOP');                                   // wedge it: alive pid, beacon goes stale
  const past = new Date(Date.now() - 300000); utimesSync(beacon, past, past); utimesSync(pidFile, past, past);
  const e4 = spawnSync(process.execPath, [BRIDGE, 'ensure', ID, '--session', SID], { env: { ...envTok, CC_REPLACE_WAIT_MS: '1500' }, encoding: 'utf8', timeout: 20000 });
  const pid4 = readPid();
  ok(/beacon is stale/.test(e4.stdout) && pid4 && pid4 !== pid3, 'live pid + stale beacon → ensure replaces it (new pid)');
  try { process.kill(pid3, 'SIGCONT'); } catch {}
  ok(await until(() => !pidAlive(pid3), 4000), 'the wedged old bridge is gone (it had been SIGTERMed) — one bridge per session');
  const c4 = connects(); await until(() => connects() > c4 || /push connected/.test(readFileSync(bridgeLog, 'utf8').split('beacon is stale').pop() || ''), 10000);
  await until(() => connects() >= c3 + 2, 10000);
  await send('dm-qwen-lane-bbbbbbbb', 'hello-L');
  await sleep(1500);
  ok(got('hello-L').length === 1, 'a DM after the replace is delivered exactly once (no double bridge)');
  }
  spawnSync(process.execPath, [BRIDGE, 'stop', '--session', SID], { env, encoding: 'utf8' });
} catch (e) { failed = true; console.error('❌', e.message); }
finally {
  for (const p of [bridgePid, readPid()]) { if (p) { try { process.kill(p, 'SIGKILL'); } catch {} } }
  try { server.kill('SIGKILL'); } catch {}
  fakeServer.close();
  for (const d of [HOME, DATA, process.env.CC_CACHE_DIR]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(failed ? '❌ qwen-bridge.test FAILED' : '✅ qwen-bridge.test: all assertions passed');
process.exit(failed ? 1 : 0);
