// ---------------------------------------------------------------------------
// server.test.mjs — HTTP/WS server wiring, auth, discovery, and a work round-trip.
//
// The authoritative pass boots server.mjs against a minimal in-memory db + REST
// router (matching the spec interface) so it validates OUR wiring — public vs. authed
// routes, the bearer gate, the discovery beacon, and 409 propagation — deterministically,
// without depending on the sibling db.mjs / rest-api.mjs modules landing first.
//
// After that, a FATAL pass runs the REAL db.mjs + rest-api.mjs as an integration test.
// Both modules are landed, so their real REST<->db wiring (auth gate, work round-trip
// incl. 409, and the message post->notify path server.mjs decorates) is a hard suite
// requirement — a break here turns the suite red rather than logging and moving on.
//
// Run: node test/server.test.mjs   (exits non-zero on failure)
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

import { startServer } from '../server/server.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';   // WS upgrades must carry &v= (the fleet version gate)

// This suite exercises auth / origin / wiring, NOT the fleet version gate (test/version-gate.test.mjs
// owns that). Bypass the gate here so the many REST calls that don't carry x-cc-version aren't 426'd.
// Own process, so this env never leaks to the other suites.
process.env.CC_VERSION_GATE_BYPASS = '1';

const PORT = 8822;              // spec-mandated port for the authoritative pass
const SMOKE_PORT = 8843;        // separate origin for the real-module smoke, so the
                               // global fetch (undici) connection pool from pass 1
                               // is never reused against pass 2's fresh server
const TOKEN = 'test-secret-token-abc123';

// --- minimal in-memory db matching the spec surface server.mjs touches ---------------
function createStubDB() {
  const instances = new Map();
  const work = new Map();
  const messages = new Map();
  let nextWork = 0;
  let nextMsg = 0;
  const now = () => new Date().toISOString();

  return {
    async registerInstance(id, description = null, rev = null) {
      instances.set(id, { instance_id: id, description, rev, status: 'online', last_seen: now() });
    },
    async listInstances() {
      return [...instances.values()];
    },
    async markStaleOffline() {
      return 0;
    },
    async createWorkItem(o = {}) {
      const id = ++nextWork;
      const owner = o.owner ?? null;
      const row = {
        id,
        project: o.project || 'default',
        title: o.title,
        external_ref: o.external_ref ?? null,
        parent_id: o.parent_id ?? null,
        kind: o.kind || 'task',
        domain: o.domain ?? null,
        owner,
        state: owner ? 'claimed' : (o.state || 'queued'),
        created_by: o.created_by ?? null,
        claimed_at: owner ? now() : null,
        created_at: now(),
        updated_at: now(),
      };
      work.set(id, row);
      return row;
    },
    async getWorkItem(id) {
      return work.get(Number(id));
    },
    async claimWorkItem(id, owner) {
      const row = work.get(Number(id));
      if (!row) return { claimed: false, item: undefined };
      if (row.owner && row.owner !== owner) return { claimed: false, item: row };
      row.owner = owner;
      if (row.state === 'queued') row.state = 'claimed';
      row.claimed_at = now();
      row.updated_at = now();
      return { claimed: true, item: row };
    },
    async sendMessage(channel, sender, content, message_type = 'message', in_reply_to = null) {
      const id = ++nextMsg;
      messages.set(id, { id, channel, sender, content, message_type, in_reply_to, created_at: now() });
      return id;
    },
    async getMessage(id) {
      return messages.get(Number(id));
    },
    async cleanup() {
      return { messages: 0, instances: 0, shared_data: 0, read_cursors: 0 };
    },
    async snapshot() {
      throw new Error('stub db has no snapshot');
    },
  };
}

// --- minimal REST router covering the endpoints this test exercises ------------------
function createStubRouter(db) {
  const r = express.Router();

  r.get('/instances', async (_req, res, next) => {
    try {
      await db.markStaleOffline(90);
      res.json({ instances: await db.listInstances() });
    } catch (e) { next(e); }
  });

  r.post('/work', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.title) return res.status(400).json({ error: 'title is required' });
      res.json({ ok: true, item: await db.createWorkItem(body) });
    } catch (e) { next(e); }
  });

  r.get('/work/:id', async (req, res, next) => {
    try {
      const item = await db.getWorkItem(req.params.id);
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ item });
    } catch (e) { next(e); }
  });

  r.post('/work/:id/claim', async (req, res, next) => {
    try {
      const owner = (req.body || {}).owner;
      if (!owner) return res.status(400).json({ error: 'owner is required' });
      if (!(await db.getWorkItem(req.params.id))) return res.status(404).json({ error: 'not found' });
      const { claimed, item } = await db.claimWorkItem(req.params.id, owner);
      if (!claimed) return res.status(409).json({ error: 'already claimed', owner: item.owner, item });
      res.json({ ok: true, item });
    } catch (e) { next(e); }
  });

  r.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.message ?? 'internal error' });
  });
  return r;
}

// --- assertions shared by the stub pass and the real-module smoke -------------------
async function runAssertions(base, { full }) {
  const BASE = base;
  // /health — public, no auth.
  let res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200, '/health should be 200 without auth');
  let body = await res.json();
  assert.equal(body.status, 'ok', '/health status ok');
  assert.ok(typeof body.uptime === 'number', '/health reports uptime');

  // /cc/whoami — public discovery beacon, advertises identity, never the token.
  res = await fetch(`${BASE}/cc/whoami`);
  assert.equal(res.status, 200, '/cc/whoami should be 200 without auth');
  const raw = await res.text();
  assert.ok(!raw.includes(TOKEN), '/cc/whoami must never leak the token');
  body = JSON.parse(raw);
  assert.equal(body.role, 'leader', 'whoami role=leader');
  assert.ok('host' in body && 'epoch' in body && 'base' in body, 'whoami advertises host/epoch/base');
  assert.ok(!('token' in body) && !('api_key' in body), 'whoami has no token field');

  // /api/* rejected without the token ...
  res = await fetch(`${BASE}/api/instances`);
  assert.equal(res.status, 401, '/api without token should be 401');
  body = await res.json();
  assert.equal(body.error, 'invalid_token', '401 body is invalid_token');

  // ... and accepted with it.
  res = await fetch(`${BASE}/api/instances`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200, '/api/instances with token should be 200');
  body = await res.json();
  assert.ok(Array.isArray(body.instances), '/api/instances returns an array');

  // Query-param token is also accepted.
  res = await fetch(`${BASE}/api/instances?api_key=${TOKEN}`);
  assert.equal(res.status, 200, '/api with ?api_key should be 200');

  // Work-board round-trip over HTTP, including the 409 double-claim.
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  res = await fetch(`${BASE}/api/work`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'wire the hub', created_by: 'cx-server' }),
  });
  assert.equal(res.status, 200, 'POST /api/work should be 200');
  const created = (await res.json()).item;
  assert.ok(created && created.id, 'created work item has an id');
  assert.equal(created.state, 'queued', 'new work item starts queued');

  // First claim wins.
  res = await fetch(`${BASE}/api/work/${created.id}/claim`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ owner: 'sessionA' }),
  });
  assert.equal(res.status, 200, 'first claim should be 200');
  assert.equal((await res.json()).item.owner, 'sessionA', 'owner is sessionA after claim');

  // Second, competing claim loses with 409.
  res = await fetch(`${BASE}/api/work/${created.id}/claim`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ owner: 'sessionB' }),
  });
  assert.equal(res.status, 409, 'double-claim should be 409');
  body = await res.json();
  assert.equal(body.error, 'already claimed', '409 body says already claimed');
  assert.equal(body.owner, 'sessionA', 'the winning owner is still sessionA');

  if (full) {
    // Real modules: verify the message path (drives the notify decoration) too.
    res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ channel: 'general', sender: 'cx-server', content: 'hello bus' }),
    });
    assert.equal(res.status, 200, 'POST /api/messages should be 200 on real backend');
    assert.ok((await res.json()).id, 'message insert returns an id');
  }
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-server-test-'));
}

async function main() {
  delete process.env.DATABASE_URL; // force SQLite for the real-module smoke
  // Keep the security-posture assertions hermetic: these must come from opts, not a stray env.
  delete process.env.CC_ALLOW_NO_AUTH;
  delete process.env.CC_BIND;
  delete process.env.CC_ADMIN_KEY;
  delete process.env.MCP_API_KEY;

  // Raw WS handshake → resolves to the HTTP status (101 on success). Node's WebSocket client
  // hides the status of a refused upgrade; http.request surfaces it via 'response'.
  const upgrade = (port, { origin, token, identity = 'probe' } = {}) => new Promise((resolve) => {
    const q = `identity=${identity}${token ? '&token=' + encodeURIComponent(token) : ''}&v=${pkgVersion()}`;
    const req = http.request({
      host: '127.0.0.1', port, path: '/cc/ws?' + q,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { Origin: origin } : {}) },
    });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });

  // ---- Pass 1: authoritative, stub-backed --------------------------------------
  {
    const dir = tmpDataDir();
    process.env.CC_DATA_DIR = dir;
    const app = await startServer({
      port: PORT,
      apiKey: TOKEN,
      host: 'test-host',
      epoch: 7,
      baseUrl: 'http://test-host:8822',
      createDB: createStubDB,
      createRestRouter: createStubRouter,
      log: () => {},
    });
    try {
      await runAssertions(`http://127.0.0.1:${PORT}`, { full: false });
      console.log('server.test: PASS (stub-backed wiring)');
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- Browser origin policy: REST CORS + WS upgrade share one allowlist -------------------
  {
    const dir = tmpDataDir();
    process.env.CC_DATA_DIR = dir;
    // Own ports: pass 1 just closed PORT, and undici's pool would replay a dead keep-alive.
    const CORS_PORT = 8831, CORS_PORT2 = 8832;
    const app = await startServer({
      port: CORS_PORT, apiKey: TOKEN, host: 'test-host', epoch: 7,
      createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
      allowedOrigins: 'http://console.example', authFailMax: 3,
    });
    try {
      const B = `http://127.0.0.1:${CORS_PORT}`;
      const h = (r, n) => r.headers.get(n);
      // preflight from an allowlisted origin is granted, with the Authorization header allowed
      let r = await fetch(B + '/api/instances', { method: 'OPTIONS', headers: { origin: 'http://console.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
      assert.equal(r.status, 204, 'preflight answers 204');
      assert.equal(h(r, 'access-control-allow-origin'), 'http://console.example', 'allowlisted origin is reflected');
      assert.match(h(r, 'access-control-allow-headers') || '', /authorization/i, 'bearer header is allowed');
      assert.equal(h(r, 'access-control-allow-methods'), 'GET,POST,OPTIONS', 'methods advertised = what the API serves');
      assert.equal(h(r, 'access-control-allow-credentials'), null, 'no credentials flag: the bus has no cookies');
      // localhost origins (a dev proxy, a local serve) are granted without configuration
      r = await fetch(B + '/cc/whoami', { headers: { origin: 'http://localhost:8790' } });
      assert.equal(h(r, 'access-control-allow-origin'), 'http://localhost:8790', 'localhost origin reflected');
      // no grant → still Vary: Origin, so a shared cache never serves a grant-less body to an allowed origin
      r = await fetch(B + '/cc/whoami');
      assert.equal(h(r, 'access-control-allow-origin'), null, 'no Origin → no grant');
      assert.match(h(r, 'vary') || '', /origin/i, 'Vary: Origin even without a grant');
      // file:// (Origin: null) is NOT granted by default — any page can forge it from a sandboxed iframe
      r = await fetch(B + '/cc/whoami', { headers: { origin: 'null' } });
      assert.equal(h(r, 'access-control-allow-origin'), null, 'null origin denied by default');
      r = await fetch(B + '/cc/whoami', { headers: { origin: 'http://evil.example' } });
      assert.equal(h(r, 'access-control-allow-origin'), null, 'unknown origin gets no CORS grant');
      // preflights never count as auth failures: a run of OPTIONS, then a bad token is a plain 401
      for (let i = 0; i < 6; i++) await fetch(B + '/api/instances', { method: 'OPTIONS', headers: { origin: 'http://console.example', 'access-control-request-method': 'GET' } });
      r = await fetch(B + '/api/instances', { headers: { origin: 'http://evil.example', authorization: 'Bearer nope' } });
      assert.equal(r.status, 401, 'bad token after many preflights is 401, not 429 (preflights are not auth failures)');
      // the WS upgrade applies the same origin policy
      assert.equal(await upgrade(CORS_PORT, { token: TOKEN }), 101, 'no Origin (Node client) upgrades');
      assert.equal(await upgrade(CORS_PORT, { token: TOKEN, origin: 'http://console.example' }), 101, 'allowlisted origin upgrades');
      assert.equal(await upgrade(CORS_PORT, { token: TOKEN, origin: 'http://localhost:8790' }), 101, 'localhost origin upgrades');
      assert.equal(await upgrade(CORS_PORT, { token: TOKEN, origin: 'http://evil.example' }), 403, 'unknown origin refused before auth');
      assert.equal(await upgrade(CORS_PORT, { token: TOKEN, origin: 'null' }), 403, 'null origin refused by default');
      // a bad ?token= on the upgrade trips the SAME per-IP limiter as REST (max 3; one REST miss above)
      assert.equal(await upgrade(CORS_PORT, { token: 'bad' }), 401, 'bad WS token → 401');
      assert.equal(await upgrade(CORS_PORT, { token: 'bad' }), 401, 'bad WS token → 401');
      assert.equal(await upgrade(CORS_PORT, { token: 'bad' }), 429, 'over the limit → 429 on the upgrade path too');
      console.log('server.test: PASS (origin policy: CORS + WS share it, file:// off by default, WS auth-fail limiter)');
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // CC_ALLOW_FILE_ORIGIN=1 (opts.allowFileOrigin=true) grants the null origin on BOTH paths, nothing else
    const dir2 = tmpDataDir();
    process.env.CC_DATA_DIR = dir2;
    const app2 = await startServer({
      port: CORS_PORT2, apiKey: TOKEN, host: 'test-host', epoch: 7,
      createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
      allowFileOrigin: true,
    });
    try {
      const B = `http://127.0.0.1:${CORS_PORT2}`;
      const r = await fetch(B + '/cc/whoami', { headers: { origin: 'null' } });
      assert.equal(r.headers.get('access-control-allow-origin'), 'null', 'null origin granted when opted in');
      assert.equal(await upgrade(CORS_PORT2, { token: TOKEN, origin: 'null' }), 101, 'null origin upgrades when opted in');
      assert.equal(await upgrade(CORS_PORT2, { token: TOKEN, origin: 'http://evil.example' }), 403, 'opt-in does not widen to other origins');
      console.log('server.test: PASS (CC_ALLOW_FILE_ORIGIN=1 opt-in, REST + WS)');
    } finally {
      await app2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }

  // ---- Refuse-run-open (M1) ----------------------------------------------------
  {
    // No token + a non-loopback bind must REFUSE to start (no side effects — never binds).
    let threw = false;
    try {
      const bad = await startServer({
        port: 8824, apiKey: '', bind: '0.0.0.0', host: 'x', epoch: 1,
        createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
      });
      await bad.close();
    } catch { threw = true; }
    assert.ok(threw, 'no token + non-loopback bind should refuse to start');

    // But a tokenless LOOPBACK bind is allowed (dev ergonomics) and serves /health.
    const okApp = await startServer({
      port: 8824, apiKey: '', bind: '127.0.0.1', host: 'x', epoch: 1,
      createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
    });
    try {
      const r = await fetch('http://127.0.0.1:8824/health');
      assert.equal(r.status, 200, 'tokenless loopback server starts and serves /health');
    } finally { await okApp.close(); }
    console.log('server.test: PASS (refuse-run-open M1)');
  }

  // ---- Admin scope (H2): export/stepdown reject the chat token when CC_ADMIN_KEY set ----
  {
    const ADMIN = 'admin-secret-xyz';
    const app = await startServer({
      port: 8825, apiKey: TOKEN, adminKey: ADMIN, host: 'x', epoch: 1, backend: 'sqlite',
      createDB: () => { const d = createStubDB(); d.snapshot = async (tmp) => fs.writeFileSync(tmp, Buffer.from('STUBDB')); return d; },
      createRestRouter: createStubRouter, log: () => {},
    });
    const B = 'http://127.0.0.1:8825';
    try {
      // The chat token — sufficient for /api — must NOT reach the admin routes.
      let r = await fetch(`${B}/cc/export`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 401, 'export with the chat token is 401 when CC_ADMIN_KEY is set');
      assert.equal((await r.json()).error, 'invalid_admin_token', 'export chat-token body is invalid_admin_token');

      r = await fetch(`${B}/cc/stepdown`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 401, 'stepdown with the chat token is 401 when CC_ADMIN_KEY is set');

      // The admin key IS accepted (export streams the snapshot).
      r = await fetch(`${B}/cc/export`, { headers: { Authorization: `Bearer ${ADMIN}` } });
      assert.equal(r.status, 200, 'export with the admin key is 200');

      // (last — a successful stepdown tears the server down.)
      r = await fetch(`${B}/cc/stepdown`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` } });
      assert.equal(r.status, 200, 'stepdown with the admin key is 200');
      console.log('server.test: PASS (admin scope H2)');
    } finally { await app.close(); }
  }

  // ---- Body limit (M3): an oversized JSON body is a 413, not a 500 ----------------
  {
    const app = await startServer({
      port: 8826, apiKey: TOKEN, host: 'x', epoch: 1,
      createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
    });
    try {
      const big = 'x'.repeat(100 * 1024); // 100kb > the 64kb limit
      const r = await fetch('http://127.0.0.1:8826/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ title: big }),
      });
      assert.equal(r.status, 413, 'oversized JSON body should be 413');
      console.log('server.test: PASS (413 body limit M3)');
    } finally { await app.close(); }
  }

  // ---- Rate limiting (M2): repeated auth failures per-IP trip a 429 ---------------
  {
    const app = await startServer({
      port: 8827, apiKey: TOKEN, host: 'x', epoch: 1, authFailMax: 3, authFailWindowMs: 60000,
      createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
    });
    const B = 'http://127.0.0.1:8827';
    try {
      let last;
      for (let i = 0; i < 5; i++) last = await fetch(`${B}/api/instances`); // no token → auth failure
      assert.equal(last.status, 429, 'repeated auth failures trip a 429');
      assert.equal((await last.json()).error, 'too_many_auth_failures', '429 body is too_many_auth_failures');
    } finally { await app.close(); }
    console.log('server.test: PASS (429 auth-failure limit M2)');
  }

  // ---- Rate limiting (M2): message/claim churn per-IP+identity trips a 429 --------
  {
    const app = await startServer({
      port: 8828, apiKey: TOKEN, host: 'x', epoch: 1, writeMax: 2, writeWindowMs: 60000,
      createDB: createStubDB, createRestRouter: createStubRouter, log: () => {},
    });
    const B = 'http://127.0.0.1:8828';
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
    try {
      // Creating the item is NOT a throttled route; the claims that follow are.
      const created = (await (await fetch(`${B}/api/work`, {
        method: 'POST', headers: auth, body: JSON.stringify({ title: 'churn' }),
      })).json()).item;
      let last;
      for (let i = 0; i < 4; i++) {
        last = await fetch(`${B}/api/work/${created.id}/claim`, {
          method: 'POST', headers: auth, body: JSON.stringify({ owner: 'sess' }),
        });
      }
      assert.equal(last.status, 429, 'claim churn beyond the window cap trips a 429');
    } finally { await app.close(); }
    console.log('server.test: PASS (429 write-churn limit M2)');
  }

  // ---- Pass 2: real-module integration (FATAL) ---------------------------------
  // db.mjs + rest-api.mjs are landed, so their real wiring is a hard requirement of the
  // suite — not a best-effort smoke. If the real REST↔db path breaks (public vs. authed
  // routes, the bearer gate, the work round-trip incl. 409, OR the message post→notify
  // path the server decorates), these assertions must turn the suite RED. Any import
  // failure or broken export is likewise fatal, since the modules must exist.
  const { createDB: realDB } = await import('../server/db.mjs');
  const { createRestRouter: realRouter } = await import('../server/rest-api.mjs');
  if (typeof realDB !== 'function' || typeof realRouter !== 'function') {
    throw new Error('db.mjs/rest-api.mjs do not export the expected factories');
  }

  const dir = tmpDataDir();
  process.env.CC_DATA_DIR = dir;
  let app;
  try {
    app = await startServer({
      port: SMOKE_PORT,
      apiKey: TOKEN,
      host: 'test-host',
      epoch: 7,
      baseUrl: `http://test-host:${SMOKE_PORT}`,
      createDB: realDB,
      createRestRouter: realRouter,
      log: () => {},
    });
    await runAssertions(`http://127.0.0.1:${SMOKE_PORT}`, { full: true });
    console.log('server.test: PASS (real db.mjs + rest-api.mjs integration)');
  } finally {
    if (app) await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('server.test: FAIL');
  console.error(e);
  process.exit(1);
});
