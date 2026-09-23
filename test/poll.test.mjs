// cc-poll addressing test (issue #57). No test framework — node:assert.
//   node test/poll.test.mjs
//
// cc-poll kept its OWN copy of the "addressed to me" filter, built from the RAW short name
// (`host/Foo_Bar` → `Foo_Bar`). The server stores a DM channel normalized (`dm-foo-bar`), so an
// underscore/uppercase-named cc-poll session silently missed its DMs and `@foo-bar` mentions —
// issue #5, still live on this path while cc-ws (shared addressedTo) was fixed. Boots the real
// server on a scratch port + data dir, runs a real cc-poll against it, and asserts:
//   A. a DM on the canonical `dm-foo-bar` channel wakes `host/Foo_Bar`
//   B. an `@foo-bar` mention in #general wakes it
//   C. `@all` wakes it
//   D. ambient chatter and another lane's DM do NOT
//   E. a `--all` (firehose) cc-poll DOES print that ambient traffic — the filter gates only the
//      default addressed-only mode (RED against a `!addressed` mutant that drops `!FIREHOSE &&`)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Hermetic from the real estate: DELETE (not blank) every operator CC_* first, then pin our own.
for (const k of Object.keys(process.env)) if (k.startsWith('CC_')) delete process.env[k];
for (const k of ['MCP_API_KEY', 'PORT']) delete process.env[k];
const PORT = 8791;
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-poll-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ccpoll-cache-'));
process.env.CC_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccpoll-data-'));
process.env.CC_BEACON_PORT = '8891';
process.env.CC_PORT = String(PORT);
process.env.CC_HOST = 'pollhost';
process.env.CC_DISCOVERY = 'peers';
process.env.CC_BIND = '127.0.0.1';

const { whoami } = await import('../src/cc-discover.mjs');
const { pkgVersion } = await import('../src/cc-rev.mjs');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const POLL = join(__dirname, '..', 'src', 'cc-poll.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'tt';
const HOME = mkdtempSync(join(tmpdir(), 'ccpoll-home-'));   // cc-poll writes its liveness beacon under ~/.claude
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };
async function send(channel, content, sender = 'tester') {
  const r = await fetch(BASE + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender, content }) });
  return r.json();
}

const srv = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), CC_EPOCH: '5', MCP_API_KEY: TOKEN }, stdio: 'ignore',
});
const polls = [];
try {
  let up = false;
  for (let end = Date.now() + 30000; Date.now() < end && !up; await sleep(300)) up = !!(await whoami(BASE, 1500));
  ok(up, 'server up on the scratch port');

  const start = (id, extra = []) => {
    const p = { out: '', err: '' };
    p.child = spawn(process.execPath, [POLL, id, '--base', BASE, '--token', TOKEN, ...extra], {
      env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    p.child.stdout.on('data', (d) => { p.out += d; });
    p.child.stderr.on('data', (d) => { p.err += d; });
    return p;
  };
  const me = start('otherbox/Foo_Bar');
  // E: a FIREHOSE receiver (--all) must still print traffic addressed to nobody — the filter only
  // applies to the default addressed-only mode.
  const fh = start('otherbox/watcher', ['--all']);
  polls.push(me.child, fh.child);
  for (let end = Date.now() + 20000; Date.now() < end && !(/\[listening as/.test(me.err) && /\[listening as/.test(fh.err)); ) await sleep(100);
  ok(/\[listening as/.test(me.err) && /\[listening as/.test(fh.err), 'both cc-polls are listening (cursors seeded)');

  await send('dm-foo-bar', 'A dm to the canonical channel');
  await send('general', 'B hey @foo-bar look at this');
  await send('general', 'C @all heads up');
  await send('general', 'D1 ambient chatter between others');
  await send('dm-someone-else', 'D2 another lane dm');
  for (let end = Date.now() + 15000; Date.now() < end && !(/A dm/.test(me.out) && /B hey/.test(me.out) && /C @all/.test(me.out) && /D2 another/.test(fh.out)); ) await sleep(200);
  await sleep(2500);   // one more poll tick, so a wrongly-woken D would have printed too

  const out = me.out;
  ok(/CHAT #dm-foo-bar tester \[message\] »TO YOU«: A dm to the canonical channel/.test(out), 'A: a DM on dm-foo-bar wakes otherbox/Foo_Bar');
  ok(/CHAT #general tester \[message\] »TO YOU«: B hey @foo-bar/.test(out), 'B: an @foo-bar mention wakes it');
  ok(/»@ALL«: C @all heads up/.test(out), 'C: @all wakes it');
  ok(!/D1 ambient/.test(out), 'D: ambient #general chatter does NOT wake it');
  ok(!/D2 another lane/.test(out), "D: another lane's DM does NOT wake it");
  ok(/CHAT #general tester \[message\]: D1 ambient chatter/.test(fh.out), 'E: a --all (firehose) cc-poll prints ambient #general chatter, untagged');
  ok(/CHAT #dm-someone-else tester \[message\]: D2 another lane dm/.test(fh.out), "E: …and another lane's DM");
} catch (e) {
  failed = true;
  console.error('❌ poll.test ERROR:', e.stack || e.message);
} finally {
  for (const p of polls) { try { p.kill(); } catch {} }
  try { srv.kill(); } catch {}
  await sleep(300);   // Windows: let the child handles close before exit (libuv UV_HANDLE_CLOSING)
  for (const d of [process.env.CC_CACHE_DIR, process.env.CC_DATA_DIR, HOME]) {
    for (let k = 0; k < 10; k++) { try { rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(200); } }   // a Windows handle may lag the kill
  }
}
if (failed) { console.error('❌ poll.test FAILED'); process.exit(1); }
console.log('✅ poll.test: cc-poll addressing matches addressedTo (canonical dm-/@short, @all, ambient suppressed)');
process.exit(0);
