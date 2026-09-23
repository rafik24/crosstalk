// ---------------------------------------------------------------------------
// enrol-web.test.mjs — the /crosstalk:enrol browser page's one-shot server (issue 55).
//                                                           node test/enrol-web.test.mjs
// Drives the REAL server (`cc-enrol-web.mjs --serve`, a child process) over HTTP. Hermetic:
// scratch config/cache/data, non-estate ports, CC_DISCOVERY=peers, operator CC_* deleted.
//
//   W1  listens on 127.0.0.1 only — unreachable on this machine's LAN address and on ::1
//   W2  the one-time URL token gates EVERY request; a POST without it writes nothing
//   W3  a foreign Host header is refused (DNS rebinding)
//   W4  a POST from another Origin / with no Origin / not JSON is refused, nothing written
//   W5  the default form follows machine state: nothing answers → setup · an estate answers → join
//       · already enrolled → enrolled
//   W6  Set up refuses <16 chars and a mismatched confirm, nothing written
//   W7  Join with a WRONG password (a real proving leader is up) → nothing written
//   W8  Join with the RIGHT password → config with deriveKeys()' keys (600 on POSIX), server exits
//   W9  set-password rewrites only the keys (other lines kept) and exits
//   W9b re-enrol verifies against the leader: wrong password → file untouched; right → new keys
//   W10 the server exits after the idle timeout, and on Cancel
//   W11 the launcher returns at once and leaves the server running (detached), which then exits
//   W12 no response body ever carried a password or a derived key
// ---------------------------------------------------------------------------
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, networkInterfaces } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..', 'src', 'cc-enrol-web.mjs');
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const SCRATCH = mkdtempSync(join(tmpdir(), 'ccenrolweb-'));
const LEADER = Number(process.env.CC_TEST_PORT || 8851), DEAD = LEADER + 2, LOOP = LEADER + 4;
for (const k of Object.keys(process.env)) if (k.startsWith('CC_') || k === 'MCP_API_KEY') delete process.env[k];
Object.assign(process.env, { CC_CACHE_DIR: join(SCRATCH, 'cache'), CC_DATA_DIR: join(SCRATCH, 'data'), CC_PORT: String(LOOP), CC_BEACON_PORT: String(LEADER + 5), CC_DISCOVERY: 'peers', CC_BIND: '127.0.0.1', CC_HOST: 'testbox' });

const { deriveKeys } = await import('../src/cc-enrol.mjs');
const PW = 'the estate password for this test';
const KEYS = deriveKeys(PW);
const WRONG = 'a completely different passphrase';
const SECRETS = [PW, WRONG, KEYS.token, KEYS.admin, ...Object.values(deriveKeys(WRONG))];
const bodies = [];   // every response body seen, for W12

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗', m); } else console.log('  ✓', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTP request with full header control (fetch forbids setting Host). agent:false — no
// keep-alive socket is ever parked, so nothing is left open at exit (Windows libuv exit-127 trap).
function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request(url, { method, headers, agent: false }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { bodies.push(b); let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json, headers: res.headers }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const post = (s, route, body, extra = {}) => req(s.url + route, { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json', ...extra }, body });

// Start `--serve` with its own config path; resolves with the ready line + an exit promise.
async function start(name, env = {}) {
  const config = join(SCRATCH, name);
  const child = spawn(process.execPath, [WEB, '--serve'], { env: { ...process.env, CC_BUS_CONFIG: config, CC_PEERS: `127.0.0.1:${DEAD}`, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const ready = await new Promise((resolve) => {
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))); } catch { resolve(null); } } });
    child.on('exit', () => resolve(null));
  });
  if (!ready) throw new Error('enrol server did not start');
  return { ...ready, child, exited, config, origin: `http://127.0.0.1:${ready.port}` };
}
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);
async function stop(s) { if (s.child.exitCode === null) { await post(s, 'cancel', {}); await within(s.exited, 3000); } if (s.child.exitCode === null) s.child.kill(); }

// A real leader keyed with the password-derived token, so Join can be verified end to end.
const leader = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(LEADER), CC_EPOCH: '2', CC_HOST: 'leaderhost', CC_DATA_DIR: join(SCRATCH, 'leader-data'), MCP_API_KEY: KEYS.token }, stdio: 'ignore' });

try {
  const { whoami } = await import('../src/cc-discover.mjs');
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { up = await whoami(`http://127.0.0.1:${LEADER}`, 800, KEYS.token); if (!up) await sleep(250); }
  if (!up?.proven) throw new Error('the scratch leader never proved itself');

  console.log('W1 binds 127.0.0.1 only');
  {
    const s = await start('w1');
    ok(s.address === '127.0.0.1', `reports its bind address as 127.0.0.1 (${s.address})`);
    const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
    const tryConnect = (host) => new Promise((r) => { const c = net.connect({ host, port: s.port, timeout: 1500 }); c.on('connect', () => { c.destroy(); r('connected'); }); c.on('error', (e) => r(e.code)); c.on('timeout', () => { c.destroy(); r('timeout'); }); });
    if (lan) { const got = await tryConnect(lan); ok(got !== 'connected', `unreachable on this machine's LAN address ${lan}:${s.port} (${got})`); }
    else console.log('  – no non-loopback IPv4 on this machine; LAN-address probe skipped');
    const v6 = await tryConnect('::1');
    ok(v6 !== 'connected', `unreachable on [::1] (${v6})`);
    ok((await req(s.url + 'state')).status === 200, 'reachable on 127.0.0.1 with the token (control)');
    await stop(s);
  }

  console.log('W2 the one-time token gates every request');
  {
    const s = await start('w2');
    const bad = s.url.replace(/\/([0-9a-f]{32})\/$/, (_m, t) => `/${t.slice(0, -1)}${t.endsWith('0') ? '1' : '0'}/`);
    const good = { action: 'setup', password: PW, confirm: PW };
    ok((await req(s.origin + '/')).status === 403, 'GET / (no token) → 403');
    ok((await req(bad)).status === 403, 'the page with a wrong token → 403');
    ok((await req(bad + 'state')).status === 403, 'state with a wrong token → 403');
    ok((await req(s.origin + '/enrol', { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json' }, body: good })).status === 403, 'POST /enrol with NO token → 403');
    ok((await req(bad + 'enrol', { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json' }, body: good })).status === 403, 'POST enrol with a wrong token → 403');
    ok((await req(bad + 'cancel', { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json' }, body: {} })).status === 403 && s.child.exitCode === null, 'Cancel with a wrong token → 403, server still up');
    ok(!existsSync(s.config), 'nothing was written by any token-less request');
    ok((await req(s.url)).status === 200, 'the page with the right token → 200 (control)');
    await stop(s);
  }

  console.log('W3 a foreign Host header is refused (DNS rebinding)');
  {
    const s = await start('w3');
    ok((await req(s.url + 'state', { headers: { host: `evil.example:${s.port}` } })).status === 403, 'Host: evil.example → 403');
    ok((await req(s.url + 'state', { headers: { host: `127.0.0.1:${s.port + 1}` } })).status === 403, 'Host with the wrong port → 403');
    ok((await req(s.url + 'state', { headers: { host: `localhost:${s.port}` } })).status === 200, 'Host: localhost:<port> → 200 (control)');
    await stop(s);
  }

  console.log('W4 cross-origin / origin-less / non-JSON POSTs are refused');
  {
    const s = await start('w4');
    const good = { action: 'setup', password: PW, confirm: PW };
    ok((await post(s, 'enrol', good, { origin: 'http://evil.example' })).status === 403, 'Origin: http://evil.example → 403');
    ok((await post(s, 'enrol', good, { origin: `http://127.0.0.1:${s.port + 1}` })).status === 403, 'Origin with the wrong port → 403');
    ok((await req(s.url + 'enrol', { method: 'POST', headers: { 'content-type': 'application/json' }, body: good })).status === 403, 'no Origin at all → 403');
    ok((await post(s, 'enrol', good, { 'content-type': 'text/plain' })).status === 415, 'text/plain (a simple cross-site form) → 415');
    const pre = await req(s.url + 'enrol', { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
    ok(!pre.headers?.['access-control-allow-origin'], 'a CORS preflight is never approved');
    ok(!existsSync(s.config), 'nothing was written');
    await stop(s);
  }

  console.log('W5 the default form follows machine state');
  {
    const none = await start('w5-none');
    ok((await req(none.url + 'state')).json?.mode === 'setup', 'nothing answers → Set up a new estate');
    await stop(none);
    const some = await start('w5-some', { CC_PEERS: `127.0.0.1:${LEADER}` });
    const st = (await req(some.url + 'state')).json;
    ok(st?.mode === 'join' && st.estate?.host === 'leaderhost', `an estate answers → Join (${st?.mode}, ${st?.estate?.host})`);
    await stop(some);
    writeFileSync(join(SCRATCH, 'w5-enrolled'), 'CC_TOKEN=x\n');
    const en = await start('w5-enrolled');
    const se = (await req(en.url + 'state')).json;
    ok(se?.mode === 'enrolled' && se.host === 'testbox', `already enrolled → enrolled as testbox (${se?.mode}, ${se?.host})`);
    await stop(en);
  }

  console.log('W6 Set up refuses a short password and a mismatched confirm');
  {
    const s = await start('w6');
    const short = await post(s, 'enrol', { action: 'setup', password: 'fifteen chars!!', confirm: 'fifteen chars!!' });
    ok(short.status === 400 && /at least 16/.test(short.json?.error), `15 chars → 400 (${short.status})`);
    const mism = await post(s, 'enrol', { action: 'setup', password: PW, confirm: PW + 'x' });
    ok(mism.status === 400 && /match/.test(mism.json?.error), `mismatched confirm → 400 (${mism.status})`);
    ok(!existsSync(s.config) && s.child.exitCode === null, 'nothing written, server still up');
    await stop(s);
  }

  console.log('W7 Join with a WRONG password writes nothing');
  {
    const s = await start('w7', { CC_PEERS: `127.0.0.1:${LEADER}` });
    const r = await post(s, 'enrol', { action: 'join', password: WRONG });
    ok(r.status === 422 && /No estate answered this password — nothing was written/.test(r.json?.error), `422 "No estate answered this password" (${r.status})`);
    ok(!existsSync(s.config), 'no config file was created');
    ok(s.child.exitCode === null, 'the server stays up for another try');
    await stop(s);
  }

  console.log('W8 Join with the RIGHT password enrols and exits');
  {
    const s = await start('w8', { CC_PEERS: `127.0.0.1:${LEADER}` });
    const r = await post(s, 'enrol', { action: 'join', password: PW, autoSupervisor: true });
    ok(r.status === 200 && r.json?.ok && /Enrolled ✓ as testbox/.test(r.json.message) && r.json.leader?.host === 'leaderhost', `200 Enrolled ✓, verified by leaderhost (${r.status} ${r.json?.message?.slice(0, 40)})`);
    const written = existsSync(s.config) ? readFileSync(s.config, 'utf8') : '';
    ok(written.includes(`CC_TOKEN=${KEYS.token}\n`) && written.includes(`CC_ADMIN_KEY=${KEYS.admin}\n`) && written.includes('CC_AUTO_SUPERVISOR=1'), 'config holds exactly deriveKeys()’ token + admin key, + the auto-supervisor opt-in');
    ok(!written.includes(PW), 'the password itself is not in the file');
    if (process.platform !== 'win32') ok((statSync(s.config).mode & 0o777) === 0o600, 'config is mode 600');
    else console.log('  – mode 600 not checkable on Windows (POSIX permission bits)');
    ok((await within(s.exited, 3000)) === 0, 'the server exits (code 0) after the one successful enrolment');
  }

  console.log('W9 set-password rewrites only the keys and exits');
  {
    // Starts as a file cc-enrol itself wrote (header line included), as a real second rewrite would.
    writeFileSync(join(SCRATCH, 'w9'), '# Crosstalk bus — per-machine enrolment (written by cc-enrol; keys derived from the estate password, never the password itself)\nCC_TOKEN=old-raw-token\nCC_ADMIN_KEY=old-admin\nCC_BIND=100.64.0.9\n');
    const s = await start('w9');
    ok((await req(s.url + 'state')).json?.mode === 'enrolled', 'enrolled machine');
    const r = await post(s, 'enrol', { action: 'set-password', password: PW, confirm: PW });
    const written = readFileSync(s.config, 'utf8');
    ok(r.status === 200 && /SPLIT/.test(r.json?.message), `200 with the split warning (${r.status})`);
    ok(written.includes(`CC_TOKEN=${KEYS.token}`) && written.includes(`CC_ADMIN_KEY=${KEYS.admin}`) && written.includes('CC_BIND=100.64.0.9') && !written.includes('old-raw-token'), 'new derived keys, CC_BIND kept, old token gone');
    ok(written.split('# Crosstalk bus — per-machine enrolment').length === 2 && written.startsWith('# Crosstalk bus'), 'the enrolment header appears once, at the top (a rewrite used to stack a copy)');
    ok((await within(s.exited, 3000)) === 0, 'exits after success');
  }

  console.log('W9b re-enrol verifies too: a wrong password leaves the file untouched');
  {
    const before = 'CC_TOKEN=keep-me-token\nCC_BIND=100.64.0.9\n';
    writeFileSync(join(SCRATCH, 'w9b'), before);
    const s = await start('w9b', { CC_PEERS: `127.0.0.1:${LEADER}` });
    const bad = await post(s, 'enrol', { action: 're-enrol', password: WRONG });
    ok(bad.status === 422 && readFileSync(s.config, 'utf8') === before, `wrong password → 422, config byte-identical (${bad.status})`);
    const good = await post(s, 'enrol', { action: 're-enrol', password: PW });
    const after = readFileSync(s.config, 'utf8');
    ok(good.status === 200 && after.includes(`CC_TOKEN=${KEYS.token}`) && after.includes('CC_BIND=100.64.0.9') && !after.includes('keep-me-token'), `right password → 200, new keys, CC_BIND kept (${good.status})`);
    ok((await within(s.exited, 3000)) === 0, 'exits after success');
  }

  console.log('W10 idle timeout and Cancel');
  {
    const s = await start('w10', { CC_ENROL_WEB_IDLE_MS: '700' });
    const code = await within(s.exited, 4000);
    ok(code === 0, `exits by itself after the idle timeout (${code})`);
    ok((await req(s.url + 'state')).status === 0, 'and no longer answers');
    const c = await start('w10-cancel');
    ok((await post(c, 'cancel', {})).status === 200, 'Cancel → 200');
    ok((await within(c.exited, 3000)) === 0, 'exits on Cancel');
    ok(!existsSync(c.config), 'nothing written');
  }

  console.log('W11 the launcher returns at once; the detached server lives on, then exits');
  {
    const config = join(SCRATCH, 'w11');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [WEB, '--no-open'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CC_BUS_CONFIG: config, CC_PEERS: `127.0.0.1:${DEAD}` } });
    const url = (r.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//) || [])[0];
    const pid = Number((r.stdout.match(/pid (\d+)/) || [])[1]);
    ok(r.status === 0 && url && Date.now() - t0 < 10000, `launcher exits 0 with the URL (${Date.now() - t0} ms)`);
    ok(url && (await req(url + 'state')).status === 200, 'the server is still serving after the launcher returned');
    if (url) await req(url + 'cancel', { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/json' }, body: {} });
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) { await sleep(150); try { process.kill(pid, 0); } catch { alive = false; } }
    ok(pid && !alive, `the detached server process (${pid}) is gone after Cancel — no orphan`);
  }

  console.log('W13 the join hook points an unenrolled machine at /crosstalk:enrol (terminal fallback kept)');
  {
    const hook = spawnSync('bash', [join(__dirname, '..', 'src', 'cc-join.sh')], { encoding: 'utf8', input: '{}', timeout: 20000, env: { ...process.env, CC_BUS_CONFIG: join(SCRATCH, 'w13-absent') } });
    const out = (hook.stdout || '').trim();
    const fallback = (out.match(/node "([^"]+cc-enrol\.mjs)"/) || [])[1];
    ok(hook.status === 0 && /type \/crosstalk:enrol/.test(out) && out.split('\n').length === 1, `one line naming /crosstalk:enrol (${out.slice(0, 60)}…)`);
    ok(fallback && existsSync(fallback), `the Headless/SSH fallback path exists (${fallback})`);
  }

  console.log('W12 no response ever carried a secret');
  {
    const leaked = bodies.filter((b) => SECRETS.some((x) => b.includes(x)));
    ok(bodies.length > 20 && leaked.length === 0, `${bodies.length} response bodies, ${leaked.length} containing a password or derived key`);
  }

  if (failed) console.error('❌ enrol-web.test FAILED');
  else console.log('✅ enrol-web.test: loopback-only, token + Host + Origin gated, mode detection, verified Join, one-shot + idle exit, no secret in any response');
} catch (e) {
  failed = true;
  console.error('❌ enrol-web.test ERROR:', e.stack || e.message);
} finally {
  leader.kill();
  await sleep(300);
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
