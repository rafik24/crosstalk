// Discovery regression test — no external test framework, just node:assert.
//   node test/discovery.test.mjs
// Boots two vendored servers at different epochs and asserts discovery selects the
// HIGHEST epoch, that a dead base probes to null, and that resolveFast is epoch-aware
// (a warm cache pointing at a higher epoch beats a lower-epoch pin — the zombie-leader fix).
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami, resolveFull, resolveFast, cacheLeader, outranks } from '../src/cc-discover.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';   // x-cc-version — the /api plane is version-gated
import { createServer as createNetServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserve an ephemeral port and immediately free it — a "dead base" nothing is listening on,
// without hardcoding a fixed port a tester might happen to run their own instance on (F2).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function boot(port, epoch, host) {
  const dir = mkdtempSync(join(tmpdir(), 'ccdisc-'));
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CC_EPOCH: String(epoch), CC_HOST: host, CC_DATA_DIR: dir, MCP_API_KEY: 'tt' },
    stdio: 'ignore',
  });
}

// Poll until a base answers /cc/whoami, or give up. The server can take a few seconds to bind
// on a cold host, so a fixed sleep would be flaky.
async function waitUp(base, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const w = await whoami(base, 1500);
    if (w) return w;
    await sleep(500);
  }
  return null;
}

// Keep discovery HERMETIC from the real estate: point the config at a nonexistent file (so no
// real CC_BASE pin / token leaks in) and the leader cache at a scratch dir. Otherwise the live
// estate leader (reachable via the real pin/cache) outranks the epoch-9 test server and the
// "highest epoch wins" assertion flakes depending on whether the estate is up.
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cccache-'));
// Also isolate the LAN beacon port — otherwise this test's UDP solicit on the default 8788
// hits the real estate leader's beacon and its epoch leaks into the scan.
process.env.CC_BEACON_PORT = '8899';

const a = boot(8792, 3, 'lowEpoch');
const b = boot(8793, 9, 'highEpoch');
let failed = false;
try {
  // Wait for both servers to actually bind (not a fixed sleep).
  assert.ok(await waitUp('http://127.0.0.1:8792'), 'server A came up');
  assert.ok(await waitUp('http://127.0.0.1:8793'), 'server B came up');

  // whoami hits each
  assert.equal((await whoami('http://127.0.0.1:8792')).epoch, 3, 'server A epoch');
  assert.equal((await whoami('http://127.0.0.1:8793')).epoch, 9, 'server B epoch');

  // dead base → null (an ephemeral, guaranteed-free port — not a fixed one a tester might occupy)
  const deadPort = await freePort();
  assert.equal(await whoami(`http://127.0.0.1:${deadPort}`, 800), null, 'dead base → null');

  // resolveFull with both as peers must pick the HIGHEST epoch
  process.env.CC_PORT = '8792';
  process.env.CC_PEERS = '127.0.0.1:8792,127.0.0.1:8793';
  process.env.CC_TOKEN = 'tt';
  const leader = await resolveFull({});
  assert.ok(leader, 'a leader is found');
  assert.equal(leader.epoch, 9, 'highest epoch wins');
  assert.equal(leader.host, 'highEpoch', 'winner is the high-epoch host');

  // resolveFast must be EPOCH-AWARE (regression for the zombie-leader fix): given a
  // low-epoch pin AND a warm cache pointing at the higher-epoch server, it must pick the
  // higher epoch — not the first (pin) responder. Prime the cache to the epoch-9 server,
  // pin the epoch-3 server, and assert 9 wins.
  cacheLeader({ base: 'http://127.0.0.1:8793', host: 'highEpoch', epoch: 9 });
  const fast = await resolveFast({ pin: 'http://127.0.0.1:8792' });
  assert.ok(fast, 'resolveFast found a leader');
  assert.equal(fast.epoch, 9, 'resolveFast picks the HIGHEST epoch (cache 9 > pin 3), not the first responder');

  // --- #7 election ordering: outranks() (epoch, then watermark, then host) --------------------
  // Higher epoch always wins, even with a LOWER watermark (epoch is the term authority).
  assert.equal(outranks({ epoch: 2, watermark: 0, host: 'z' }, { epoch: 1, watermark: 999, host: 'a' }), true,
    'higher epoch beats higher watermark');
  // Equal epoch: the FRESHER snapshot (higher watermark) wins — the #7 stale-DB fix. This is the
  // assertion that would go red if the watermark tiebreak were dropped back to hostname-only.
  assert.equal(outranks({ epoch: 5, watermark: 42, host: 'zzz' }, { epoch: 5, watermark: 41, host: 'aaa' }), true,
    'equal epoch → higher watermark wins (over a lexicographically-lower host)');
  assert.equal(outranks({ epoch: 5, watermark: 41, host: 'aaa' }, { epoch: 5, watermark: 42, host: 'zzz' }), false,
    'equal epoch → lower watermark loses even with a lower host');
  // Equal epoch AND watermark: fall back to the lexicographically-lowest host (deterministic).
  assert.equal(outranks({ epoch: 5, watermark: 7, host: 'aaa' }, { epoch: 5, watermark: 7, host: 'bbb' }), true,
    'equal epoch+watermark → lowest host wins');
  // A missing watermark is treated as 0 (back-compat with an older leader that omits it).
  assert.equal(outranks({ epoch: 5, host: 'aaa' }, { epoch: 5, watermark: 1, host: 'aaa' }), false,
    'absent watermark treated as 0 → loses to watermark 1');

  // --- watermark + rev carried on /cc/whoami (integration) ------------------------------------
  // A fresh leader reports watermark 0; after a message lands the watermark advances, so an
  // election can rank by real write-freshness. rev is present so drift detection still works.
  const w0 = await whoami('http://127.0.0.1:8792');
  assert.equal(w0.watermark, 0, 'fresh leader whoami reports watermark 0');
  assert.ok('rev' in w0, 'whoami carries a rev field (drift detection)');
  const post = await fetch('http://127.0.0.1:8792/api/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer tt', 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' },
    body: JSON.stringify({ channel: 'general', sender: 'disc-test', content: 'bump the watermark' }),
  });
  assert.equal(post.status, 200, 'message posted');
  const w1 = await whoami('http://127.0.0.1:8792');
  assert.ok(w1.watermark >= 1, `whoami watermark advances after a message (got ${w1.watermark})`);

  // --- a probe of a BLACK-HOLED peer must not outlive its deadline (issue 44) ------------------
  // Two peers that swallow SYNs (TEST-NET-1 + a non-routable 10/8): the scan answers in ~1.5s
  // either way — what regressed was the PROCESS, pinned ~9s more by the dangling connects. So
  // measure a real child's wall-clock exit, not the await.
  {
    const { spawnSync } = await import('node:child_process');
    const probe = "const { resolveFull } = await import(process.argv[1]); await resolveFull({});";
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe, new URL('../src/cc-discover.mjs', import.meta.url).href], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CC_DISCOVERY: 'peers', CC_PORT: '9', CC_PEERS: '192.0.2.1:8787,10.255.255.1:8787', CC_CACHE_DIR: mkdtempSync(join(tmpdir(), 'cccache-linger-')) },
    });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, `probe child exited cleanly (${r.stderr})`);
    assert.ok(ms < 5000, `a one-shot that probed black-holed peers exits at its own deadline, not undici's 10s connect timeout (took ${ms} ms)`);
    console.log(`  ✓ black-holed peers: one-shot discovery process exited in ${ms} ms`);
  }

  // --- CC_DISCOVERY=peers confines discovery to the explicit peer list ------------------------
  // A "stranger" bus: an all-interfaces whoami stub at epoch 99, advertised by a real LAN beacon
  // on this test's scratch UDP port. In the default mode the scan ADOPTS it (whoami needs no
  // token — that is how two dev fleets on one LAN once elected each other); in peers mode the
  // scan must never even look.
  {
    const http = await import('node:http');
    const { startBeacon } = await import('../src/cc-beacon.mjs');
    // The stranger holds the estate token here (it signs its answers — 3.3.5 discovery ignores
    // an UNSIGNED one regardless of mode, see proof.test): this test is about the peers-mode
    // confinement, so the stranger must be one that strict discovery would otherwise adopt.
    const { whoamiProof } = await import('../src/cc-proof.mjs');
    const stranger = http.createServer((req, res) => {
      const n = new URL(req.url, 'http://x').searchParams.get('nonce');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ role: 'leader', host: 'stranger', epoch: 99, watermark: 0, ...(n ? { proof: whoamiProof('tt', n, 'stranger', 99) } : {}) }));
    });
    await new Promise((r) => stranger.listen(8794, '0.0.0.0', r));
    const stopBeacon = startBeacon({ host: 'stranger', epoch: 99, port: 8794, beaconPort: 8899, announceMs: 60000, token: 'tt' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      delete process.env.CC_DISCOVERY;
      const auto = await resolveFull({ lanTimeoutMs: 800 });
      if (auto?.host !== 'stranger') {
        // Some hosts (CI runners, locked-down NICs) never deliver a UDP broadcast back to the box.
        // Then the control arm cannot show the stranger being adopted, and the confined arm would
        // pass vacuously — say so instead of claiming coverage.
        console.log('  (SKIP CC_DISCOVERY=peers: this host does not deliver LAN broadcasts, the control arm found ' + (auto?.host || 'nothing') + ')');
      } else {
        process.env.CC_DISCOVERY = 'peers';
        // The control arm just CACHED the stranger (leader.json) — deliberately left in place: a box
        // switched from auto to peers must not keep trusting (and re-caching, and sending its token
        // to) a leader it could never have found through its peer list.
        const confined = await resolveFull({ lanTimeoutMs: 800 });
        assert.equal(confined?.host, 'highEpoch', `CC_DISCOVERY=peers ignores a beaconed AND cached stranger at epoch 99 (got ${confined?.host}@${confined?.epoch})`);
        const fast = await resolveFast({});
        assert.equal(fast?.host, 'highEpoch', `resolveFast in peers mode ignores the poisoned cache too (got ${fast?.host})`);
        console.log('  ✓ control: default discovery adopted the beaconed stranger@99; CC_DISCOVERY=peers did not — not even from the poisoned cache');
      }
    } finally {
      delete process.env.CC_DISCOVERY;
      stopBeacon();
      await new Promise((r) => stranger.close(r));
    }
  }

  console.log('✅ discovery.test: all assertions passed (whoami, dead→null, resolveFull highest-epoch, resolveFast epoch-aware, outranks watermark-tiebreak, whoami watermark+rev, CC_DISCOVERY=peers)');
} catch (e) {
  failed = true;
  console.error('❌ discovery.test FAILED:', e.message);
} finally {
  a.kill(); b.kill();
}
process.exit(failed ? 1 : 0);
