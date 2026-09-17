// WebSocket push + backfill integration test (issue #3). No test framework — node:assert.
//   node test/ws.test.mjs
//
// Boots the vendored server on a scratch port + data dir and asserts the issue's
// acceptance criteria:
//   A. a message ADDRESSED to a WS-connected identity is pushed in <1s;
//   B. a NON-addressed message is NOT pushed to it (the addressed-only filter is server-side);
//   C. the cc-ws bridge shows a pushed DM exactly once (dedup vs. its on-connect backfill);
//   D. kill the socket (restart the leader), send 3 messages, reconnect → all 3 arrive
//      exactly once via cursor backfill.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami } from '../src/cc-discover.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';   // raw WS clients must send &v= (the fleet version gate)

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const BRIDGE = join(__dirname, '..', 'src', 'cc-ws.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic from the real estate (same guarding as discovery.test) — PLUS pin CC_PORT to our
// scratch port so EVERY discovery probe (loopback, tailnet peer scan, cache) targets 8795. The
// real estate leader lives on :8787, so pinning the port makes it invisible here; otherwise the
// live higher-epoch leader wins the "highest epoch" election and the bridge roams off-test.
const PORT = 8795;
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-ws-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ccws-cache-'));
process.env.CC_BEACON_PORT = '8897';
process.env.CC_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'tt';
const DATA = mkdtempSync(join(tmpdir(), 'ccws-data-'));
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

function boot(epoch) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), CC_EPOCH: String(epoch), CC_HOST: 'wshost', CC_DATA_DIR: DATA, MCP_API_KEY: TOKEN },
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
const count = (hay, needle) => hay.split(needle).length - 1;

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

let srv = boot(5);
let bridge = null;
try {
  ok(await waitUp(), 'server booted');

  // --- A + B: raw WS client, addressed vs. not ---
  if (typeof WebSocket === 'undefined') { console.error('❌ Node lacks a built-in WebSocket client — cannot run WS test'); process.exit(1); }
  const frames = [];
  const cli = new WebSocket(`ws://127.0.0.1:${PORT}/cc/ws?identity=alice&token=${TOKEN}&v=${pkgVersion()}`);
  await new Promise((res, rej) => { cli.addEventListener('open', res); cli.addEventListener('error', rej); setTimeout(rej, 8000); });
  cli.addEventListener('message', (ev) => { try { const f = JSON.parse(ev.data); if (f.type === 'msg') frames.push(f.message); } catch {} });

  const t0 = Date.now();
  await send('general', 'PUSH_TO_ALICE @alice please', 'tester');
  // wait up to 1.5s for the addressed push
  while (Date.now() - t0 < 1500 && !frames.some((m) => m.content.includes('PUSH_TO_ALICE'))) await sleep(20);
  const addressed = frames.find((m) => m.content.includes('PUSH_TO_ALICE'));
  ok(addressed, 'A: addressed @alice message pushed over WS');
  ok(addressed && (Date.now() - t0) < 1000, 'A: push latency < 1s');

  const before = frames.length;
  await send('general', 'AMBIENT_CHATTER between others', 'tester');
  await sleep(600);
  ok(frames.length === before, 'B: non-addressed ambient message is NOT pushed to alice');

  // --- E: a firehose subscriber (the operator console, ?firehose=1) DOES get ambient traffic ---
  const fh = []; let hello = null;
  const cli2 = new WebSocket(`ws://127.0.0.1:${PORT}/cc/ws?identity=console&token=${TOKEN}&firehose=1&v=${pkgVersion()}`);
  cli2.addEventListener('message', (ev) => { try { const f = JSON.parse(ev.data); if (f.type === 'hello') hello = f; if (f.type === 'msg') fh.push(f.message); } catch {} });
  await new Promise((res, rej) => { cli2.addEventListener('open', res); cli2.addEventListener('error', rej); setTimeout(rej, 8000); });
  await sleep(200);
  ok(hello && hello.firehose === true, 'E: hello frame acknowledges firehose');
  const b2 = frames.length;
  await send('general', 'AMBIENT_FOR_FIREHOSE only the console should see this', 'tester');
  await sleep(600);
  ok(fh.some((m) => m.content.includes('AMBIENT_FOR_FIREHOSE')), 'E: firehose socket receives a non-addressed message');
  ok(frames.length === b2, 'E: the plain (addressed-only) socket still does not');
  try { cli2.close(); } catch {}
  try { cli.close(); } catch {}

  // --- C + D: the cc-ws bridge, exactly-once across a socket drop ---
  let out = '', err = '';
  bridge = spawn(process.execPath, [BRIDGE, 'bob', '--base', BASE, '--token', TOKEN], {
    env: { ...process.env, CC_DESC: 'ws test bob' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (d) => { out += d.toString(); });
  bridge.stderr.on('data', (d) => { err += d.toString(); });
  // wait for seed/listening — lifecycle chatter now goes to STDERR so it never wakes a Monitor beacon
  { const end = Date.now() + 15000; while (Date.now() < end && !/listening as bob/.test(err)) await sleep(100); }
  ok(/listening as bob/.test(err), 'bridge seeded and listening (lifecycle on stderr)');
  // The fix: lifecycle chatter must be kept OFF stdout (the Monitor event stream), so an idle
  // session is not re-invoked on every connect/reconnect. Only rendered messages belong on stdout.
  ok(!/listening as bob|push connected|bus leader/.test(out), 'lifecycle chatter kept off stdout');

  // C: a pushed DM shows exactly once (not doubled by the on-connect backfill)
  await send('dm-bob', 'DM_ONE hello bob', 'tester');
  { const end = Date.now() + 3000; while (Date.now() < end && count(out, 'DM_ONE') < 1) await sleep(50); }
  await sleep(400);
  ok(count(out, 'DM_ONE') === 1, 'C: pushed DM shown exactly once');

  // D: drop the socket (kill+restart leader same port/dir), send 3 while it reconnects
  srv.kill();
  await sleep(1500);
  srv = boot(6);
  ok(await waitUp(), 'server restarted (socket dropped under the bridge)');
  await send('dm-bob', 'GAP_A one', 'tester');
  await send('dm-bob', 'GAP_B two', 'tester');
  await send('dm-bob', 'GAP_C three', 'tester');
  // the bridge must reconnect (re-discover via --base pin) and backfill the gap
  { const end = Date.now() + 20000; while (Date.now() < end && !(count(out, 'GAP_A') && count(out, 'GAP_B') && count(out, 'GAP_C'))) await sleep(200); }
  ok(count(out, 'GAP_A') === 1, 'D: GAP_A delivered exactly once via backfill');
  ok(count(out, 'GAP_B') === 1, 'D: GAP_B delivered exactly once via backfill');
  ok(count(out, 'GAP_C') === 1, 'D: GAP_C delivered exactly once via backfill');
  ok(count(out, 'DM_ONE') === 1, 'D: the earlier DM was not re-shown after reconnect');
} catch (e) {
  failed = true;
  console.error('❌ ws.test threw:', e.stack || e.message);
} finally {
  try { bridge && bridge.kill(); } catch {}
  try { srv && srv.kill(); } catch {}
}
if (failed) { console.error('❌ ws.test FAILED'); process.exit(1); }
console.log('✅ ws.test: all assertions passed (addressed push <1s, ambient suppressed, firehose opt-in, exactly-once dedup + backfill)');
process.exit(0);
