// ---------------------------------------------------------------------------
// proof.test.mjs — discovery AUTHENTICATION (issue 55).   node test/proof.test.mjs
//
// Before 3.3.5 any host answering /cc/whoami with a huge epoch was adopted as the leader and
// then received every client's bearer token. Now a responder must prove it holds the estate
// token, over HTTP (nonce → HMAC) and over the LAN beacon (ts → HMAC).
//
//   P1  pure: proofs verify, differ per nonce/host/epoch, fail on the wrong token, and a beacon
//       proof is rejected once stale
//   P2  a REAL server proves itself to a client with the right token; a client with the WRONG
//       token sees it as unproven (strict: ignored; legacy: accepted + warned); a caller with
//       NO token gets the plain (unproven) answer
//   P3  a FORGER (epoch 1e15, no proof) is IGNORED by resolveFull in strict mode — and adopted
//       in legacy mode (the control arm proves the assertion bites)
//   P4  cc-enrol: deriveKeys is deterministic + password-sensitive; a wrong password writes
//       NOTHING (exit 2, verify fails) and the right one writes a 600 config with derived keys
//       that a real leader accepts
//   P5  a MITM RELAY that forwards the challenge to the real leader is REJECTED — the proof is
//       bound to the server's own socket address, so it does not verify at the relay's address
//       (reviewer B1; mutation-verified: unbind the proof and the relay wins)
//   P6  a migrate STANDBY (`cc-bus receive`) answers the challenge and proves itself, so a 3.3.5
//       `migrate` can still find it under strict discovery (reviewer B2)
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), 'ccproof-'));
const PORT = Number(process.env.CC_TEST_PORT || 8797), FORGER = PORT + 1;
const TOKEN = 'the-real-estate-token';
for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_DISCOVERY_PROOF']) delete process.env[k];
Object.assign(process.env, { CC_BUS_CONFIG: join(SCRATCH, 'no-config'), CC_CACHE_DIR: join(SCRATCH, 'cache'), CC_PORT: String(PORT), CC_BEACON_PORT: '8898', CC_DISCOVERY: 'peers', CC_PEERS: `127.0.0.1:${FORGER}` });

const { whoamiProof, beaconProof, whoamiProven, beaconProven, nonce } = await import('../src/cc-proof.mjs');
const { whoami, resolveFull } = await import('../src/cc-discover.mjs');
const { deriveKeys } = await import('../src/cc-enrol.mjs');

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗', m); } else console.log('  ✓', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), CC_EPOCH: '3', CC_HOST: 'realhost', CC_DATA_DIR: join(SCRATCH, 'data'), MCP_API_KEY: TOKEN, CC_BIND: '127.0.0.1' }, stdio: 'ignore' });
// The forger: a plain HTTP stub advertising an absurd epoch with no proof.
const forger = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ role: 'leader', host: 'forger', epoch: 1e15, watermark: 0 })); });
await new Promise((r) => forger.listen(FORGER, '127.0.0.1', r));

try {
  console.log('P1 pure proofs');
  const n = nonce();
  const R = { address: '10.0.0.1', port: 8787 };   // the address the client reached — signed in
  const good = whoamiProof(TOKEN, n, 'h', 3, 5, R.address, R.port);
  const mk = (over = {}) => ({ host: 'h', epoch: 3, watermark: 5, proof: good, ...over });
  ok(whoamiProven(TOKEN, n, mk(), R) === true, 'a whoami proof verifies');
  ok(whoamiProven(TOKEN, n, mk({ epoch: 4 }), R) === false, '…and is bound to the epoch');
  ok(whoamiProven(TOKEN, n, mk({ watermark: 6 }), R) === false, '…and to the watermark (no in-flight rewrite of the tiebreak)');
  ok(whoamiProven(TOKEN, n, mk(), { address: '10.0.0.2', port: 8787 }) === false, '…and to the address reached (a relay signs its OWN address, not the client\'s)');
  ok(whoamiProven('other', n, mk(), R) === false, '…and to the token');
  ok(whoamiProven(TOKEN, nonce(), mk(), R) === false, '…and to the nonce (no replay)');
  ok(whoamiProven('', n, { host: 'h', epoch: 3 }, R) === null, 'no token → nothing to check (null, not false)');
  ok(whoamiProven(TOKEN, n, mk(), null) === false, 'a proof with no known reached-address cannot verify');
  ok(whoamiProof(TOKEN, n, 'h', 3, 5, '::ffff:10.0.0.1', 8787) === good, 'an IPv4-mapped IPv6 address matches its bare form');
  const ts = Date.now();
  ok(beaconProven(TOKEN, { host: 'h', epoch: 3, port: 8787, ts, proof: beaconProof(TOKEN, 'h', 3, 8787, ts) }) === true, 'a beacon proof verifies');
  ok(beaconProven(TOKEN, { host: 'h', epoch: 3, port: 8787, ts: ts - 120000, proof: beaconProof(TOKEN, 'h', 3, 8787, ts - 120000) }, ts) === false, 'a 2-minute-old beacon is stale (replay refused)');
  ok(beaconProven(TOKEN, { host: 'h', epoch: 3, port: 8787 }) === false, 'an unsigned beacon is unproven');

  console.log('P2 a real server proves itself');
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { up = await whoami(`http://127.0.0.1:${PORT}`, 800, TOKEN); if (!up) await sleep(250); }
  ok(up && up.proven === true && up.epoch === 3, `the real leader is PROVEN to a client with the right token (${up ? `proven=${up.proven}` : 'no answer'})`);
  ok((await whoami(`http://127.0.0.1:${PORT}`, 800, 'wrong-token')) === null, 'strict: with the WRONG token the same leader is ignored (null)');
  process.env.CC_DISCOVERY_PROOF = 'legacy';
  const leg = await whoami(`http://127.0.0.1:${PORT}`, 800, 'wrong-token');
  ok(leg && leg.proven === false, 'legacy: accepted but marked proven=false');
  delete process.env.CC_DISCOVERY_PROOF;
  const bare = await whoami(`http://127.0.0.1:${PORT}`, 800, '');
  ok(bare && bare.proven === false && bare.epoch === 3, 'a caller with no token gets the plain answer (unproven)');

  console.log('P3 a forger at epoch 1e15 is ignored');
  const strict = await resolveFull({ token: TOKEN, lanTimeoutMs: 100 });
  ok(strict && strict.host === 'realhost', `strict resolveFull picks the PROVEN leader (${strict?.host}@${strict?.epoch})`);
  process.env.CC_DISCOVERY_PROOF = 'legacy';
  rmSync(join(SCRATCH, 'cache'), { recursive: true, force: true });
  const legacy = await resolveFull({ token: TOKEN, lanTimeoutMs: 100 });
  ok(legacy && legacy.host === 'forger', `control: in legacy mode the forger WINS on epoch (${legacy?.host}@${legacy?.epoch}) — the strict assertion bites`);
  delete process.env.CC_DISCOVERY_PROOF;
  rmSync(join(SCRATCH, 'cache'), { recursive: true, force: true });

  console.log('P5 a MITM relay that forwards the challenge is defeated (issue 55, reviewer B1)');
  {
    // A relay: it forwards /cc/whoami?nonce to the REAL leader (so the proof is genuine) and even
    // bumps the watermark to look more authoritative — but the leader signed ITS OWN address, and
    // the client reaches the RELAY's address, so the proof does not verify at the relay.
    const RELAY = PORT + 3;
    const relay = http.createServer((rq, rs) => {
      const rn = new URL(rq.url, 'http://x').searchParams.get('nonce');
      http.get(`http://127.0.0.1:${PORT}/cc/whoami${rn ? `?nonce=${rn}` : ''}`, (up2) => {
        let b = ''; up2.on('data', (d) => { b += d; }); up2.on('end', () => {
          let j = {}; try { j = JSON.parse(b); } catch {}
          j.watermark = 1e9;   // try to win the equal-epoch tiebreak in flight
          rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify(j));
        });
      }).on('error', () => { rs.statusCode = 502; rs.end(); });
    });
    await new Promise((r) => relay.listen(RELAY, '127.0.0.1', r));
    try {
      const viaRelay = await whoami(`http://127.0.0.1:${RELAY}`, 800, TOKEN);
      ok(viaRelay === null, `a client that reaches the relay REJECTS it — the proof is bound to the leader's address, not the relay's (${viaRelay ? `adopted ${viaRelay.base}` : 'null'})`);
      // And discovery, offered both the direct leader and the relay, picks the leader.
      process.env.CC_PEERS = `127.0.0.1:${PORT},127.0.0.1:${RELAY}`;
      rmSync(join(SCRATCH, 'cache'), { recursive: true, force: true });
      const picked = await resolveFull({ token: TOKEN, lanTimeoutMs: 100 });
      ok(picked && picked.base === `http://127.0.0.1:${PORT}`, `resolveFull picks the direct leader, never the higher-watermark relay (${picked?.base})`);
      process.env.CC_PEERS = `127.0.0.1:${FORGER}`;
      rmSync(join(SCRATCH, 'cache'), { recursive: true, force: true });
    } finally { await new Promise((r) => relay.close(r)); }
  }

  console.log('P4 cc-enrol');
  const k1 = deriveKeys('correct horse battery staple'), k2 = deriveKeys('correct horse battery staple'), k3 = deriveKeys('correct horse battery stapl3');
  ok(k1.token === k2.token && k1.admin === k2.admin && k1.token !== k3.token && k1.token !== k1.admin && /^[0-9a-f]{64}$/.test(k1.token), 'deriveKeys: deterministic, password-sensitive, token ≠ admin, 32-byte hex');
  ok((() => { try { deriveKeys('short'); return false; } catch { return true; } })(), 'a short password is refused');
  // A leader whose token IS a derived key, so a password can be verified end to end.
  const PW = 'estate password for the test';
  const dk = deriveKeys(PW);
  const srv2 = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT + 2), CC_EPOCH: '1', CC_HOST: 'pwhost', CC_DATA_DIR: join(SCRATCH, 'data2'), MCP_API_KEY: dk.token, CC_BIND: '127.0.0.1' }, stdio: 'ignore' });
  try {
    let up2 = null;
    for (let i = 0; i < 60 && !up2; i++) { up2 = await whoami(`http://127.0.0.1:${PORT + 2}`, 800, dk.token); if (!up2) await sleep(250); }
    ok(up2?.proven === true, 'a leader keyed with the derived token proves the password');
    const cfg = join(SCRATCH, 'enrol-config');
    // cc-enrol needs a TTY for the prompt; drive it through a pty-less path: --token is the raw way,
    // so exercise the VERIFY logic by importing and calling with a fake prompt is not possible
    // without a TTY. Instead run the child with a password piped via CC_ENROL_PASSWORD_FOR_TESTS.
    const run = (pw, extra = []) => spawnSync(process.execPath, [join(__dirname, '..', 'src', 'cc-enrol.mjs'), '--config', cfg, ...extra], { encoding: 'utf8', env: { ...process.env, CC_PEERS: `127.0.0.1:${PORT + 2}`, CC_ENROL_PASSWORD_FOR_TESTS: pw } });
    const bad = run('definitely the wrong password');
    ok(bad.status === 2 && !existsSync(cfg) && /did NOT prove/.test(bad.stderr), `wrong password: exit 2, nothing written (${(bad.stderr || '').trim().split('\n')[0].slice(0, 90)})`);
    const good = run(PW, ['--auto-supervisor']);
    const written = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
    ok(good.status === 0 && written.includes(`CC_TOKEN=${dk.token}`) && written.includes(`CC_ADMIN_KEY=${dk.admin}`) && written.includes('CC_AUTO_SUPERVISOR=1') && !written.includes(PW), 'right password: verified against the live leader, config written with derived keys, password itself absent');
    const again = run(PW);
    ok(again.status === 1 && /already enrolled/.test(again.stderr), 'a second enrol refuses to overwrite');
  } finally { srv2.kill(); }

  console.log('P6 a migrate STANDBY answers the discovery challenge (reviewer B2 — migrate was broken under strict)');
  {
    // `cc-bus receive` binds a standby that must prove itself, or a 3.3.5 `migrate` cannot find it.
    const SPORT = PORT + 4;
    const scfg = join(SCRATCH, 'standby-config');
    (await import('node:fs')).writeFileSync(scfg, `CC_TOKEN=${TOKEN}\n`);
    const standby = spawn(process.execPath, [join(__dirname, '..', 'src', 'cc-bus.mjs'), 'receive', '--port', String(SPORT)], {
      env: { ...process.env, CC_BUS_CONFIG: scfg, CC_DATA_DIR: join(SCRATCH, 'standby-data'), CC_HOST: 'standbyhost', CC_PORT: String(SPORT) }, stdio: 'ignore',
    });
    try {
      let w = null;
      for (let i = 0; i < 60 && !w; i++) { w = await whoami(`http://127.0.0.1:${SPORT}`, 800, TOKEN); if (!w) await sleep(250); }
      ok(w && w.role === 'standby' && w.proven === true, `the standby answers /cc/whoami?nonce and PROVES itself (${w ? `role=${w.role} proven=${w.proven}` : 'no answer — migrate would abort here'})`);
      ok((await whoami(`http://127.0.0.1:${SPORT}`, 800, 'wrong')) === null, 'a wrong-token client ignores the standby too');
    } finally { standby.kill(); }
  }

  if (failed) console.error('❌ proof.test FAILED');
  else console.log('✅ proof.test: discovery authentication — whoami nonce/HMAC, signed fresh beacons, forger ignored (legacy control adopts it), cc-enrol verifies the password before writing');
} catch (e) {
  failed = true;
  console.error('❌ proof.test ERROR:', e.stack || e.message);
} finally {
  srv.kill();
  await new Promise((r) => forger.close(r));
  await sleep(300);
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
