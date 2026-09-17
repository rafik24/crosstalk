// ---------------------------------------------------------------------------
// version-gate.test.mjs — the fleet version gate (PO ruling 2026-09-16): every host on the bus
// must run the SAME version as the leader; a mismatch is refused (426) on BOTH the REST /register
// path and the WS upgrade, forcing a stale host to update before it can coordinate.
//
// Pass 1 (pure): versionGateReject — admit on exact match, admit on bypass, admit when the leader
//   can't self-identify (fail-open), REFUSE on mismatch AND on a missing client version.
// Pass 2 (wiring): a REAL server (rest-api.mjs router) pinned to serverVersion 9.9.9 —
//   REST /register 426/200, WS upgrade 426/101, and the CC_VERSION_GATE_BYPASS admit-all path.
//
// Run: node test/version-gate.test.mjs   (exits non-zero on failure)
// ---------------------------------------------------------------------------
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/server.mjs';
import { versionGateReject } from '../server/version-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

// ---- Pass 1: the pure rule -------------------------------------------------------------------
{
  ok(versionGateReject('3.1.0', '3.1.0') === null, 'admit: exact match');
  ok(versionGateReject('3.0.0', '3.1.0') !== null, 'REFUSE: client behind');
  ok(versionGateReject('3.2.0', '3.1.0') !== null, 'REFUSE: client ahead (exact-match, not >=)');
  ok(versionGateReject('', '3.1.0') !== null, 'REFUSE: client sent no version (old client)');
  ok(versionGateReject(undefined, '3.1.0') !== null, 'REFUSE: client version undefined');
  ok(versionGateReject('0.0.0', '3.1.0', { bypass: true }) === null, 'admit: bypass overrides a mismatch');
  ok(versionGateReject('0.0.0', null) === null, 'admit: leader cannot self-identify → fail OPEN');
  const r = versionGateReject('3.0.0', '3.1.0');
  ok(r && r.required === '3.1.0' && r.yours === '3.0.0' && typeof r.how_to_update === 'string',
    'refusal carries {required, yours, how_to_update} for the 426 body');
}

// ---- Lockstep pins (finding 4): the gate keys on package.json, but the plugin ships plugin.json —
// a silent divergence would gate out a host that is actually current. Assert they never drift. -------
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const plug = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  ok(pkg === plug, `version pins in lockstep: package.json (${pkg}) === plugin.json (${plug})`);
}

// ---- Source guard: every first-party /api caller must send its version -------------------------
// The server tests all dutifully send x-cc-version, so they cannot catch a *client that forgets it*
// (which, under whole-plane enforcement, is 426'd on every call). This grep-guard would have caught
// the join hook + the two cc-bus fetches that shipped without it. Each listed client must carry the
// header (or, for the register-only shell hook, the header + a version body field).
{
  const CALLERS = ['cc-ws.mjs', 'cc-poll.mjs', 'cc-send.mjs', 'cc-ack.mjs', 'cc-work.mjs',
                   'cc-name.mjs', 'cc-bus.mjs', 'cc-console.html', 'cc-join.sh'];
  for (const f of CALLERS) {
    const src = readFileSync(join(ROOT, 'src', f), 'utf8');
    ok(/x-cc-version/i.test(src), `${f} sends its version (x-cc-version) on bus requests`);
  }
}

// ---- Pass 2: real server wiring --------------------------------------------------------------
const TOKEN = 'test-secret-token-vg';
const PINNED = '9.9.9';

// Minimal stub db: the real rest-api /register calls registerInstance; startServer probes
// maxMessageId; /instances (unused here) needs the two list/sweep methods.
function stubDB() {
  const instances = new Map();
  return {
    async registerInstance(id, description = null, rev = null) { instances.set(id, { id, description, rev }); },
    async listInstances() { return [...instances.values()]; },
    async markStaleOffline() { return 0; },
    async maxMessageId() { return 0; },
    async sendMessage() { return 0; },   // server.mjs decorates this for the push fan-out
  };
}

// Raw HTTP upgrade so we can read a 426 status the WebSocket client would swallow.
function rawUpgrade(port, search) {
  return new Promise((resolve) => {
    const req = http.request({
      port, host: '127.0.0.1', path: `/cc/ws?${search}`, method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
        Authorization: 'Bearer ' + TOKEN,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });   // 101 handed back as 'upgrade'
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });    // a refusal comes back as a normal response
    req.on('error', () => resolve(0));
    req.end();
  });
}

// version carried in the x-cc-version HEADER (how real clients send it — present on GETs too).
async function reg(base, { version, ...body }) {
  const headers = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
  if (version !== undefined) headers['x-cc-version'] = version;
  const r = await fetch(base + '/api/register', { method: 'POST', headers, body: JSON.stringify(body) });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// A data-plane GET (no body) — proves the gate covers the WHOLE /api plane, not just /register.
async function getInstances(base, version) {
  const headers = { Authorization: 'Bearer ' + TOKEN };
  if (version !== undefined) headers['x-cc-version'] = version;
  const r = await fetch(base + '/api/instances', { headers });
  return r.status;
}

async function bootAndCheck({ port, bypass }) {
  const app = await startServer({
    port, apiKey: TOKEN, host: 'vg-host', epoch: 1, baseUrl: `http://vg-host:${port}`,
    serverVersion: PINNED, versionGateBypass: bypass, createDB: stubDB, log: () => {},
  });
  try {
    const B = `http://127.0.0.1:${port}`;
    if (!bypass) {
      // REST /register
      ok((await reg(B, { instance_id: 'a/x', version: PINNED })).status === 200, 'REST register: matching version → 200');
      const bad = await reg(B, { instance_id: 'a/y', version: '0.0.1' });
      ok(bad.status === 426, 'REST register: mismatched version → 426');
      ok(bad.json.reason === 'version_mismatch' && bad.json.required === PINNED, 'REST 426 body names reason + required version');
      ok((await reg(B, { instance_id: 'a/z' })).status === 426, 'REST register: no version → 426 (old client blocked)');
      // DATA PLANE (finding 1): the gate covers the whole /api plane, not just /register — a GET too
      ok((await getInstances(B, PINNED)) === 200, 'REST data-plane GET: matching version → 200');
      ok((await getInstances(B, '0.0.1')) === 426, 'REST data-plane GET: mismatched version → 426');
      ok((await getInstances(B)) === 426, 'REST data-plane GET: no version → 426 (old client cannot poll/coordinate)');
      // WS — every upgrade, firehose INCLUDED (finding 2: firehose is no longer a bypass)
      ok((await rawUpgrade(port, `identity=a/x&token=${TOKEN}&v=${PINNED}`)) === 101, 'WS: matching version → 101 upgrade');
      ok((await rawUpgrade(port, `identity=a/x&token=${TOKEN}&v=0.0.1`)) === 426, 'WS: mismatched version → 426');
      ok((await rawUpgrade(port, `identity=a/x&token=${TOKEN}`)) === 426, 'WS: no version → 426');
      ok((await rawUpgrade(port, `identity=c&token=${TOKEN}&firehose=1&v=0.0.1`)) === 426, 'WS firehose: mismatched version → 426 (no longer a bypass)');
      ok((await rawUpgrade(port, `identity=c&token=${TOKEN}&firehose=1&v=${PINNED}`)) === 101, 'WS firehose: matching version → 101 (console echoes leader version)');
    } else {
      ok((await reg(B, { instance_id: 'a/x', version: '0.0.1' })).status === 200, 'BYPASS: mismatched version admitted (REST register 200)');
      ok((await getInstances(B, '0.0.1')) === 200, 'BYPASS: mismatched version admitted (REST data-plane 200)');
      ok((await rawUpgrade(port, `identity=a/x&token=${TOKEN}&v=0.0.1`)) === 101, 'BYPASS: mismatched version admitted (WS 101)');
    }
  } finally {
    await app.close();
  }
}

try {
  await bootAndCheck({ port: 8861, bypass: false });
  await bootAndCheck({ port: 8862, bypass: true });
} catch (e) {
  failed = true;
  console.error('❌ version-gate.test threw:', e.stack || e.message);
}

if (failed) { console.error('❌ version-gate.test FAILED'); process.exit(1); }
console.log('✅ version-gate.test: all assertions passed (pure rule + lockstep pins + REST register/data-plane 426/200 + WS 426/101 incl. firehose + bypass)');
