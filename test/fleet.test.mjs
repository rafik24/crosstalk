// ---------------------------------------------------------------------------
// fleet.test.mjs — REAL multi-supervisor scenarios on one box (dev/fleet.mjs).
//   node test/fleet.test.mjs
//
// Every other suite in this repo is in-process; none ever spawned `cc-bus start`, because on an
// enrolled box the election would reach the live estate. The fleet harness packages the isolation
// recipe (scratch config/cache/data per node, pinned non-estate ports, scratch beacon, operator
// env deleted), so these are the first tests where real supervisors elect, replicate, die and
// promote. Scenario ids are the QA-program ids (tracking issue 42):
//
//   F0  importing the harness from a script named *fleet.mjs does NOT run its CLI
//   F1  2-node boot → exactly one leader, the other a settled client, message round trip;
//       HERMETIC: every fleet listener is bound to 127.0.0.1 only and no node cached a leader
//       outside the fleet (an all-interfaces bind once let two boxes' fleets elect each other)
//   L2a client replication lands in messages.db.replica over 3 cycles, never in a messages.db
//   L3  UNCLEAN leader kill → survivor adopts the replica and promotes at epoch+1; a message
//       written a full cycle before the kill is present; integrity_check ok; no orphan listener
//   L3r the dead ex-leader restarts → rejoins as CLIENT, the promoted leader keeps the term
//   L2b SAME-HOST second supervisor sharing the leader's data dir (issue 35): never replicates —
//       no replica file, leader DB inode stable, history intact
//
// Judged by /cc/whoami + pid liveness, never supervisor.json alone (it lags and survives a kill).
// Slow by nature: a client's failover check AND its replication pull both ride one fixed 15s tick
// (cc-bus runClient), so a promotion costs ~15–20s and the effective replication period is
// CC_REPLICATE_MS rounded UP to a whole number of ticks — below 15s it only means "every tick"
// (issue 43).
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// An operator shell exporting these would pin a test to PROD — drop them before anything loads.
for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLEET_MJS = join(__dirname, '..', 'dev', 'fleet.mjs');
const { Fleet, fileId, listeners, listenerPid, pidAlive, cleanupOnSignal } = await import(pathToFileURL(FLEET_MJS).href);

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 7;
const SCRATCH = mkdtempSync(join(tmpdir(), 'ccfleet-'));
const REPLICATE_MS = 2000;
const CLIENT_TICK_MS = 15000;   // cc-bus runClient's fixed interval — the real replication cadence here
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };
const fleets = [];
cleanupOnSignal(() => fleets);   // Ctrl-C / CI cancel must not leave supervisors holding the slot
const mkFleet = (name, opts = {}) => { const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, name), replicateMs: REPLICATE_MS, ...opts }); fleets.push(f); return f; };

// Wait until `path`'s mtime has advanced `n` times (n completed replication writes).
async function waitCycles(f, path, n, timeoutMs = (n + 1) * CLIENT_TICK_MS) {
  let seen = 0, last = fileId(path)?.mtimeMs ?? 0;
  return f.waitFor(() => { const m = fileId(path)?.mtimeMs ?? 0; if (m > last) { last = m; seen++; } return seen >= n; }, timeoutMs, 100);
}

try {
  // --- F0 ---------------------------------------------------------------------------------------
  console.log('F0 import guard');
  {
    const script = join(SCRATCH, 'smoke-fleet.mjs');   // the name that used to trip the CLI guard
    writeFileSync(script, `import { Fleet } from ${JSON.stringify(pathToFileURL(FLEET_MJS).href)};\nconsole.log('IMPORTED', typeof Fleet);\n`);
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    ok(r.status === 0 && /IMPORTED function/.test(r.stdout) && !/usage:/.test(r.stdout),
      'a script named *fleet.mjs can import the harness without the CLI hijacking it');
  }

  // --- F1 ---------------------------------------------------------------------------------------
  console.log('F1 boot');
  const f = mkFleet('main');
  const l0 = await f.up();
  {
    const ls = listeners(f.port(0));
    ok(ls.length >= 1, `the listener probe SEES the leader's socket on :${f.port(0)} (${ls.map((l) => `${l.addr} pid ${l.pid}`).join(', ') || 'nothing — the hermeticity checks below would be vacuous'})`);
    const bad = f.hermeticityViolations();
    ok(bad.length === 0, `hermetic: loopback-only listeners, no foreign leader cached${bad.length ? ' — ' + bad.join('; ') : ''}`);
    // Non-vacuity for the cache half: the client MUST have cached its leader, in the SCRATCH cache
    // dir — if CC_CACHE_DIR stopped being honoured the check above would read zero files and pass.
    let cached = null;
    try { cached = JSON.parse(readFileSync(join(f.nodeDir(1), 'cache', 'leader.json'), 'utf8')); } catch {}
    ok(cached?.base === f.baseUrl(0), `node1 cached its leader in the scratch cache dir (${cached?.base || 'no leader.json'})`);
    // CC_DISCOVERY=peers (set by the harness): a confined leader neither scans nor ADVERTISES.
    ok(/becoming LEADER/.test(f.log(0)) && !/\[beacon\] announcing/.test(f.log(0)), 'the confined leader runs NO LAN beacon');
  }
  ok(l0.i === 0 && l0.epoch === 1 && l0.host === 'node0', `node0 leads at epoch 1 (got node${l0.i}@${l0.epoch})`);
  ok((await f.leaders()).length === 1, 'exactly one node answers as leader');
  ok(await f.settled(1) && !(await f.whoami(1)), 'node1 is a settled CLIENT and serves nothing');
  const m1 = await f.send('fleet', 'pre-kill message');
  ok(m1.ok && m1.id >= 1, `message accepted by the leader (id ${m1.id})`);

  // --- L2a --------------------------------------------------------------------------------------
  console.log('L2a replication target + leader DB identity');
  ok(await waitCycles(f, f.replicaPath(1), 3), 'node1 completed 3 replication cycles into messages.db.replica');
  ok(!existsSync(f.dbPath(1)), 'the client never materialised a messages.db of its own (replica only)');

  // --- L3 ---------------------------------------------------------------------------------------
  console.log('L3 unclean leader kill → promotion on the replica');
  const oldServerPid = listenerPid(f.port(0));
  const oldSupPid = f.nodes[0].pid;
  ok(oldServerPid > 0 && oldServerPid !== oldSupPid && pidAlive(oldServerPid), `pre-kill: server child pid ${oldServerPid} is a live process distinct from supervisor pid ${oldSupPid}`);
  const tKill = Date.now();
  await f.killLeader({ clean: false });
  const l1 = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2 });
  const promoteMs = Date.now() - tKill;
  ok(l1 && l1.i === 1 && l1.epoch === 2, `node1 promoted to leader@2 (got ${l1 ? `node${l1.i}@${l1.epoch}` : 'none'}) in ${promoteMs} ms`);
  ok(!pidAlive(oldSupPid) && !pidAlive(oldServerPid) && listeners(f.port(0)).length === 0, `no orphan: old supervisor pid ${oldSupPid} AND old server pid ${oldServerPid} are dead, :${f.port(0)} closed`);
  ok(/adopted the replicated snapshot/.test(f.log(1)), 'node1 logged the replica adoption at promotion');
  ok(!/replica adoption FAILED/.test(f.log(1)), 'no adoption-failure warning');
  const after = await f.messages('fleet');
  ok(after.some((m) => m.id === m1.id && /pre-kill message/.test(m.content)), `pre-kill message id ${m1.id} is present on the promoted leader`);
  {
    const db = new DatabaseSync(f.dbPath(1), { readOnly: true });
    const res = db.prepare('PRAGMA integrity_check').get();
    db.close();
    ok(res && Object.values(res)[0] === 'ok', 'promoted DB passes PRAGMA integrity_check');
  }
  const m2 = await f.send('fleet', 'post-promotion message');
  ok(m2.ok && m2.id > m1.id, `the promoted leader accepts writes, ids continue (${m1.id} → ${m2.id})`);

  // --- L3r --------------------------------------------------------------------------------------
  console.log('L3r the dead ex-leader rejoins as CLIENT');
  f.startNode(0);
  ok(await f.waitFor(() => f.settled(0), 45000), 'restarted node0 settled');
  const l2 = await f.waitSingleLeader({ timeoutMs: 20000, stableMs: 8000 });   // > one leader-monitor tick
  ok(l2 && l2.i === 1 && l2.epoch === 2, `node1 still the single leader@2 after node0 came back (got ${l2 ? `node${l2.i}@${l2.epoch}` : 'none/split'})`);
  ok(!(await f.whoami(0)), 'node0 serves nothing — it rejoined as a client, it did not re-take the term');
  ok((await f.messages('fleet')).length === 2, 'history intact (2 messages) after the rejoin');
  { const bad = f.hermeticityViolations(); ok(bad.length === 0, `still hermetic after failover + rejoin${bad.length ? ' — ' + bad.join('; ') : ''}`); }
  { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }

  // --- L2b --------------------------------------------------------------------------------------
  console.log('L2b same-host second supervisor on the SAME data dir');
  const g = mkFleet('samehost', { hostOverrides: { 1: 'NODE0' } });   // casing differs on purpose (issue 39)
  g.dataDirOverrides[1] = g.dataDir(0);
  g.startNode(0);
  ok(await g.waitFor(async () => (await g.whoami(0))?.role === 'leader', 45000), 'same-host fleet: node0 leads');
  const s1 = await g.send('fleet', 'same-host history');
  const idBefore = fileId(g.dbPath(0));
  g.startNode(1);
  ok(await g.waitFor(() => /a server is already running here/.test(g.log(1)), 45000), 'second supervisor recognised its own host → CLIENT mode');
  // A client pulls once IMMEDIATELY on entering client mode, then on every tick: wait out both.
  await sleep(CLIENT_TICK_MS + 3000);
  ok(!existsSync(g.replicaPath(0)), 'same-host client never pulled a snapshot across its immediate pull + one tick (no messages.db.replica in the shared dir)');
  // (The inode check bites only where rename-over-an-open-file succeeds — POSIX, and only for the
  // pre-3.3.3 form of the bug. The replica-file assertion above is the portable issue-35 detector.)
  const idAfter = fileId(g.dbPath(0));
  ok(idBefore && idAfter && idBefore.ino === idAfter.ino, `shared messages.db inode untouched (${idBefore?.ino} → ${idAfter?.ino})`);
  const hist = await g.messages('fleet');
  ok(hist.some((m) => m.id === s1.id), 'leader history intact with the same-host client attached');
  { const left = await g.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }

  if (failed) console.error('❌ fleet.test FAILED');
  else console.log(`✅ fleet.test: all assertions passed (F0 import guard, F1 boot, L2a/L2b replication safety, L3 failover in ${promoteMs} ms, L3r rejoin)`);
} catch (e) {
  failed = true;
  console.error('❌ fleet.test ERROR:', e.stack || e.message);
} finally {
  for (const x of fleets) { try { await x.down(); } catch {} }
  if (failed) console.error(`(scratch kept for inspection: ${SCRATCH})`);
  else { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }
}
process.exit(failed ? 1 : 0);
