// ---------------------------------------------------------------------------
// supervisor.test.mjs — the #6 idempotent per-machine supervisor singleton logic.
//   node test/supervisor.test.mjs
//
// Covers the decision that keeps EXACTLY ONE `cc-bus start` supervisor per box:
//   - pidAlive(pid): true for a live pid, false for a dead one (cross-platform, signal 0).
//   - supervisorLive(): the record only when the heartbeat is FRESH *and* its pid is alive;
//     null for no file / a stale timestamp / a dead pid — the three states that must let
//     `cc-bus ensure` start a replacement.
//   - `cc-bus ensure` end-to-end: when a live+fresh supervisor is already registered it prints
//     "already running" and spawns NOTHING (the supervisor.json pid is left untouched).
//
// Deliberately isolated: CC_DATA_DIR is a scratch dir set BEFORE importing cc-bus.mjs, so the
// heartbeat file this test writes/reads never touches the real ~/.cross-claude-mcp.
//
// NOT tested here (by design): actually spawning a real supervisor. `cc-bus start` runs the full
// election, which on an ENROLLED box scans the tailnet and would reach the live estate — it cannot
// be made hermetic from CI. The positive "ensure starts one when none is live" direction is
// covered by supervisorLive() returning null in the no-file/stale/dead states (the exact gate
// ensure spawns on), and the isolated 2-node failover run the tester already validated end-to-end.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CC_BUS = join(__dirname, '..', 'src', 'cc-bus.mjs');

// Scratch data dir — set before importing cc-bus so SUPERVISOR_FILE resolves under it.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ccsup-'));
process.env.CC_DATA_DIR = DATA_DIR;

const { pidAlive, supervisorLive, SUPERVISOR_FILE, failoverCoverage, SERVER_ENTRY } = await import('../src/cc-bus.mjs');
const { existsSync } = await import('node:fs');

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };

function writeSup(rec) { writeFileSync(SUPERVISOR_FILE, JSON.stringify(rec)); }
function clearSup() { try { rmSync(SUPERVISOR_FILE); } catch {} }

try {
  // --- SERVER_ENTRY resolves to a real file --------------------------------------------------
  // spawnLeader spawns SERVER_ENTRY; if this self-locating path is wrong (e.g. the src/ reorg
  // left it pointing at src/server/server.mjs), every leader start crash-loops the bus. No
  // in-process test spawns a real server, so this existence check is the only guard.
  ok(existsSync(SERVER_ENTRY), `SERVER_ENTRY resolves to an existing server module (${SERVER_ENTRY})`);

  // --- pidAlive ------------------------------------------------------------------------------
  ok(pidAlive(process.pid) === true, 'pidAlive(self) is true');
  // A very high pid is almost certainly not a running process (and pidAlive must say so).
  ok(pidAlive(2147483646) === false, 'pidAlive(dead pid) is false');
  ok(pidAlive(0) === false && pidAlive(-1) === false, 'pidAlive rejects non-positive pids');

  // --- supervisorLive: the four states -------------------------------------------------------
  clearSup();
  ok(supervisorLive() === null, 'no supervisor file → null (a supervisor may start)');

  writeSup({ pid: process.pid, ts: Date.now(), host: 'h', role: 'leader' });
  ok(!!supervisorLive(), 'fresh heartbeat + live pid → live (ensure must NOT start a second)');

  writeSup({ pid: process.pid, ts: Date.now() - 60000, host: 'h', role: 'leader' }); // 60s > 30s stale window
  ok(supervisorLive() === null, 'STALE heartbeat (live pid) → null (presumed dead, may restart)');

  writeSup({ pid: 2147483646, ts: Date.now(), host: 'h', role: 'leader' });
  ok(supervisorLive() === null, 'fresh heartbeat but DEAD pid → null (may restart)');

  // --- ensure end-to-end: a live supervisor is registered → ensure spawns nothing -------------
  // Use THIS test process's pid as a stand-in for a live supervisor; ensure must see it as live
  // and leave the file untouched (no new process spawned).
  writeSup({ pid: process.pid, ts: Date.now(), host: 'h', role: 'leader' });
  const out = await new Promise((resolve) => {
    let s = '';
    const c = spawn(process.execPath, [CC_BUS, 'ensure'], {
      env: { ...process.env, CC_DATA_DIR: DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.on('data', (d) => (s += d));
    c.stderr.on('data', (d) => (s += d));
    c.on('exit', () => resolve(s));
  });
  ok(/already running/i.test(out), `ensure reports "already running" when a live supervisor exists (got: ${out.trim()})`);
  const after = JSON.parse(readFileSync(SUPERVISOR_FILE, 'utf8'));
  ok(after.pid === process.pid, 'ensure did NOT spawn/replace — supervisor.json pid unchanged');

  // --- failoverCoverage host-matching (regression for the canonicalization SPOF bug) ----------
  // The server canonicalizes the short segment of a registered id, so a supervisor on the RAW host
  // "DESKTOP-7ODO6OU" is STORED as "cc-bus-supervisor/desktop-7odo6ou". /cc/whoami reports the raw
  // host. If the leader's own supervisor is the only one, capacity MUST be 0 (a SPOF) — the compare
  // has to canonicalize both sides. Before the fix this returned a false backup = "capacity OK".
  const onlyLeader = failoverCoverage(
    [{ instance_id: 'cc-bus-supervisor/desktop-7odo6ou', status: 'online' }],
    'DESKTOP-7ODO6OU',
  );
  ok(onlyLeader.hosts.length === 1, 'coverage: one supervisor host seen');
  ok(onlyLeader.backups.length === 0,
    'coverage: leader-only supervisor on an UPPERCASE host → 0 backups (SPOF correctly detected, not a false OK)');

  // A second, distinct host is real failover capacity; offline + non-supervisor rows are excluded.
  const twoHosts = failoverCoverage(
    [
      { instance_id: 'cc-bus-supervisor/desktop-7odo6ou', status: 'online' },
      { instance_id: 'cc-bus-supervisor/raf-ms-7e59', status: 'online' },
      { instance_id: 'cc-bus-supervisor/old-box', status: 'offline' },   // stale → excluded
      { instance_id: 'desktop-7odo6ou/some-session', status: 'online' }, // not a supervisor
    ],
    'DESKTOP-7ODO6OU',
  );
  ok(twoHosts.backups.length === 1 && twoHosts.backups[0] === 'raf-ms-7e59',
    'coverage: a distinct online supervisor host is a real backup; offline + non-supervisor rows excluded');

  // --- issue #35: replica-file replication, never over the live DB -------------------------
  {
    const { adoptReplicaIfFresher, replicateSnapshot, REPLICA_FILE, DB_FILE, HOST } = await import('../src/cc-bus.mjs');
    const { existsSync: ex, utimesSync } = await import('node:fs');

    ok(adoptReplicaIfFresher() === 'no-replica', '#35: no replica → nothing to adopt');

    writeFileSync(REPLICA_FILE, 'snapshot-bytes');
    ok(adoptReplicaIfFresher() === 'adopted' && ex(DB_FILE) && !ex(REPLICA_FILE),
      '#35: replica adopted as messages.db at promotion (rename, replica consumed)');
    ok(readFileSync(DB_FILE, 'utf8') === 'snapshot-bytes', '#35: adopted DB carries the replica bytes');

    writeFileSync(REPLICA_FILE, 'older-snapshot');
    const old = (Date.now() - 60000) / 1000;
    utimesSync(REPLICA_FILE, old, old);   // replica strictly older than the DB
    ok(adoptReplicaIfFresher() === 'db-fresher' && !ex(REPLICA_FILE) && readFileSync(DB_FILE, 'utf8') === 'snapshot-bytes',
      '#35: a fresher local DB wins; the stale replica is discarded, DB untouched');

    // Same-host guard: a client must NEVER pull when the leader is this very machine — the pull
    // targets the DATA_DIR the live leader has open. Casing must not defeat the guard (#39).
    ok(await replicateSnapshot({ host: HOST.toUpperCase(), base: 'http://127.0.0.1:1', epoch: 1 }, 'tt') === false,
      '#35: replication refused when the leader host is this host (case-insensitive)');
    ok(!ex(REPLICA_FILE), '#35: the refused same-host pull wrote nothing');
  }

  // --- issue #37: version handover decision ------------------------------------------------
  {
    const { needsVersionHandover } = await import('../src/cc-bus.mjs');
    ok(needsVersionHandover({ version: '0.0.1' }, '9.9.9') === true, '#37: stale-version supervisor → handover');
    ok(needsVersionHandover({ version: '9.9.9' }, '9.9.9') === false, '#37: same version → healthy, no handover');
    ok(needsVersionHandover({ version: '9.9.9' }, '0.0.1') === false,
      '#37: an OLDER install never kills a newer supervisor (directional — no downgrade, no thrash)');
    ok(needsVersionHandover({ version: '3.3.10' }, '3.3.9') === false && needsVersionHandover({ version: '3.3.9' }, '3.3.10') === true,
      '#37: numeric semver compare, not string compare (3.3.10 > 3.3.9)');
    ok(needsVersionHandover({}, '9.9.9') === false,
      '#37: a version-less heartbeat NEVER triggers the kill path (unattributable pid — this exact test process was killed by the first draft)');
    ok(needsVersionHandover(null, '9.9.9') === false, '#37: no live supervisor → nothing to hand over');
    ok(needsVersionHandover({ version: '0.0.1' }, null) === false, '#37: own version unknown → fail-safe, no kill');
  }

  // --- issue #39: deterministic, casing-blind election tie-break ---------------------------
  {
    const { outranks } = await import('../src/cc-discover.mjs');
    const at = (host) => ({ epoch: 3, watermark: 7, host });
    ok(outranks(at('ABox'), at('z-box')) === true, '#39: tie-break is canonical (abox < z-box) regardless of casing');
    ok(outranks(at('z-box'), at('ABox')) === false, '#39: …and the ordering is antisymmetric');
    ok(outranks(at('RAF-MS-7E59'), at('raf-ms-7e59')) === false && outranks(at('raf-ms-7e59'), at('RAF-MS-7E59')) === false,
      '#39: the same host spelled two ways is a true tie — neither outranks the other');
  }

  if (failed) { console.error('❌ supervisor.test FAILED'); }
  else { console.log('✅ supervisor.test: all assertions passed (pidAlive, supervisorLive 4-state, ensure idempotent-skip, failoverCoverage canonicalization/SPOF)'); }
} catch (e) {
  failed = true;
  console.error('❌ supervisor.test ERROR:', e.stack || e.message);
} finally {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
