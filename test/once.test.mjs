// cc-ws --once (wake-on-message) integration test. No test framework — node:assert style.
//   node test/once.test.mjs
//
// --once replaces the 30-min-capped Monitor with a background task that EXITS only when a
// message addressed to it arrives. That is only safe if nothing is lost or doubled across the
// exit → re-arm gap, so this asserts:
//   A. idle: the receiver stays up (no exit, nothing on stdout), heartbeats the beacon, owns the pidfile;
//   B. an addressed DM → exit 0 with the message on stdout, once; ambient traffic does NOT end it;
//   C. GAP: DMs sent while NO receiver runs are delivered by the next --once (persisted cursors),
//      and the already-delivered DM is not re-shown;
//   D. a DM channel CREATED during the gap is delivered too;
//   E. a burst lands as ONE wake (settle window);
//   F. a re-arm supersedes a running receiver: the old one exits 3 with nothing on stdout;
//   G. a stale cursor file is ignored (seed at the tip — no replay of an old session's backlog).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami } from '../src/cc-discover.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const BRIDGE = join(__dirname, '..', 'src', 'cc-ws.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic: own port, own discovery cache, and an own HOME so beacons/cursors/pidfiles never
// touch the real ~/.claude/.cc-listen (homedir() reads USERPROFILE on Windows, HOME elsewhere).
const PORT = 8797;
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-once-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cconce-cache-'));
process.env.CC_BEACON_PORT = '8896';
process.env.CC_PORT = String(PORT);
const HOME = mkdtempSync(join(tmpdir(), 'cconce-home-'));
const LIVE = join(HOME, '.claude', '.cc-listen');
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'tt';
const DATA = mkdtempSync(join(tmpdir(), 'cconce-data-'));
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

const srv = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), CC_EPOCH: '5', CC_HOST: 'oncehost', CC_DATA_DIR: DATA, MCP_API_KEY: TOKEN },
  stdio: 'ignore',
});
async function waitUp(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await whoami(BASE, 1500)) return true; await sleep(500); }
  return false;
}
async function send(channel, content, sender = 'tester') {
  const r = await fetch(BASE + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender, content, message_type: 'message' }) });
  return r.json();
}
const count = (hay, needle) => hay.split(needle).length - 1;

// Spawn one --once receiver; resolves its exit as { code, out, err }.
const live = new Set();
function arm(id, extraEnv = {}) {
  const p = spawn(process.execPath, [BRIDGE, id, '--once', '--base', BASE, '--token', TOKEN], {
    env: { ...process.env, HOME, USERPROFILE: HOME, CC_ONCE_OWNER_POLL_MS: '300', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(p);
  const r = { proc: p, out: '', err: '', code: null };
  p.stdout.on('data', (d) => { r.out += d.toString(); });
  p.stderr.on('data', (d) => { r.err += d.toString(); });
  r.exited = new Promise((res) => p.on('exit', (code) => { r.code = code; live.delete(p); res(code); }));
  return r;
}
async function listening(r, id, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !new RegExp(`listening as ${id}`).test(r.err) && r.code === null) await sleep(100);
  return new RegExp(`listening as ${id}`).test(r.err);
}
const within = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

try {
  ok(await waitUp(), 'server booted');

  // --- A: idle ---
  let r = arm('bob');
  ok(await listening(r, 'bob'), 'A: receiver seeded and listening');
  await send('general', 'AMBIENT between others', 'tester');
  await sleep(2500);
  ok(r.code === null && r.out === '', 'A: idle + ambient traffic → still running, nothing on stdout');
  const beacon = join(LIVE, 'bob');
  ok(existsSync(beacon) && Date.now() - statSync(beacon).mtimeMs < 45000, 'A: listen-gate beacon is fresh');
  ok(readFileSync(join(LIVE, 'bob.once.pid'), 'utf8').trim() === String(r.proc.pid), 'A: pidfile names this receiver');

  // --- B: addressed DM ends it ---
  await send('dm-bob', 'DM_ONE hello bob');
  ok(await within(r.exited, 6000), 'B: addressed DM → receiver exits');
  ok(r.code === 0, `B: exit code 0 (got ${r.code})`);
  ok(count(r.out, 'DM_ONE') === 1, 'B: the DM is on stdout exactly once');
  ok(!/listening as|push connected|bus leader/.test(r.out), 'B: lifecycle chatter kept off stdout');
  ok(existsSync(join(LIVE, 'bob.cursors.json')), 'B: cursors persisted on exit');

  // --- C + D: the exit → re-arm gap ---
  await send('dm-bob', 'GAP_A one');
  await send('dm-bob', 'GAP_B two');
  await send('dm-bob-x', 'NEWCH_DM @bob on a channel created during the gap');
  r = arm('bob');
  ok(await within(r.exited, 15000), 'C: re-armed receiver wakes at once for the gap');
  ok(r.code === 0, `C: exit code 0 (got ${r.code})`);
  ok(count(r.out, 'GAP_A') === 1 && count(r.out, 'GAP_B') === 1, 'C: both gap DMs delivered exactly once');
  ok(count(r.out, 'DM_ONE') === 0, 'C: the already-delivered DM is NOT re-shown');
  ok(count(r.out, 'NEWCH_DM') === 1, 'D: a DM on a channel created during the gap is delivered');
  ok(count(r.out, 'AMBIENT') === 0, 'C: ambient history is not replayed');

  // --- E: burst → one wake ---
  r = arm('bob');
  ok(await listening(r, 'bob'), 'E: re-armed and listening');
  await send('dm-bob', 'BURST_1');
  await sleep(200);
  await send('dm-bob', 'BURST_2');
  await sleep(200);
  await send('dm-bob', 'BURST_3');
  ok(await within(r.exited, 8000), 'E: receiver exits after the burst');
  ok(['BURST_1', 'BURST_2', 'BURST_3'].every((t) => count(r.out, t) === 1), 'E: all three burst DMs in ONE wake');

  // --- F: supersede ---
  const old = arm('bob');
  ok(await listening(old, 'bob'), 'F: first receiver listening');
  const nu = arm('bob');
  ok(await listening(nu, 'bob'), 'F: second receiver listening');
  ok(await within(old.exited, 5000), 'F: the superseded receiver exits');
  ok(old.code === 3 && old.out === '', `F: superseded exit is 3 with nothing on stdout (got ${old.code}, ${JSON.stringify(old.out)})`);
  ok(nu.code === null, 'F: the new owner keeps running');
  await send('dm-bob', 'AFTER_TAKEOVER');
  ok(await within(nu.exited, 6000) && nu.code === 0 && count(nu.out, 'AFTER_TAKEOVER') === 1, 'F: the new owner delivers the next DM');

  // --- H: superseded AFTER printing → exit 0, never 3 (the agent ignores exit 3; the message would be lost) ---
  const a = arm('bob', { CC_ONCE_SETTLE_MS: '6000' });
  ok(await listening(a, 'bob'), 'H: receiver listening (long settle window)');
  await send('dm-bob', 'PRINTED_THEN_SUPERSEDED');
  { const end = Date.now() + 4000; while (Date.now() < end && !a.out.includes('PRINTED_THEN_SUPERSEDED')) await sleep(50); }
  const b = arm('bob');
  ok(await within(a.exited, 5000), 'H: the superseded receiver exits inside its settle window');
  ok(a.code === 0 && count(a.out, 'PRINTED_THEN_SUPERSEDED') === 1, `H: it exits 0 with the message it printed (got ${a.code})`);
  // (Whether the new owner ALSO replays it depends on whether A's throttled save landed before B
  //  loaded — a possible duplicate, never a loss. Not asserted.)
  b.proc.kill(); await b.exited;

  // --- G: stale cursor file ---
  await send('dm-bob', 'STALE_GAP should not replay into a fresh session');
  await sleep(1200);   // the file must be older than the tiny max age below
  r = arm('bob', { CC_CURSOR_MAX_AGE_MS: '500' });
  ok(await listening(r, 'bob'), 'G: receiver with a stale cursor file listening');
  await sleep(1500);
  ok(r.code === null && count(r.out, 'STALE_GAP') === 0, 'G: stale cursors ignored — old backlog not replayed');
  await send('dm-bob', 'FRESH_AFTER_STALE');
  ok(await within(r.exited, 6000) && count(r.out, 'FRESH_AFTER_STALE') === 1, 'G: new DMs still delivered');
} catch (e) {
  failed = true;
  console.error('❌ once.test threw:', e.stack || e.message);
} finally {
  for (const p of live) { try { p.kill(); } catch {} }
  try { srv.kill(); } catch {}
}
if (failed) { console.error('❌ once.test FAILED'); process.exit(1); }
console.log('✅ once.test: all assertions passed (idle silent, wake-on-DM, gap replay, new-channel DM, burst, supersede, stale cursors)');
process.exit(0);
