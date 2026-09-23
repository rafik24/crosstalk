#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-bus.mjs — Crosstalk bus supervisor + control CLI.
//
//   cc-bus start                     Elect: if a bus is already present anywhere
//                                     (loopback / LAN / tailnet) → run CLIENT-ONLY
//                                     (start no server). If none → become LEADER
//                                     (start the server at epoch+1 + LAN beacon).
//                                     Stays up; fails over if the leader vanishes.
//   cc-bus status                    Print the discovered authoritative leader.
//   cc-bus receive [--port N]        STANDBY on a migration target: hold the port,
//                                     accept one /cc/import, then promote to leader.
//   cc-bus migrate --to <host> --confirm
//                                     Move the live bus to <host> (must be in
//                                     `receive`). Exports the DB, starts the target
//                                     at epoch+1 (authoritative), verifies it, THEN
//                                     steps the old leader down.
//
// One clone of this repo on any node can host the bus or connect to whoever hosts.
// Config (token, optional pin/peers) comes from ~/.claude/.crosstalk (legacy name still honoured).
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, statSync, openSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import {
  loadConfig, resolveFull, whoami, cacheLeader, readCache, readTrustedCache, outranks, highestUnprovenEpoch, DEFAULT_PORT,
} from './cc-discover.mjs';
import { startBeacon } from './cc-beacon.mjs';
import { whoamiProof } from './cc-proof.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';
import { canonicalShort } from './cc-render.mjs';
import { dataDir } from './cc-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives in src/, but the server is at repo-root server/server.mjs — hop up out of src/.
// (The src/ reorg moved this file without updating this self-locating path; a wrong entry makes
// spawnLeader spawn a missing module → supervisor crash-loop → total bus blackout.)
const SERVER_ENTRY = join(__dirname, '..', 'server', 'server.mjs');
// Host identity is CANONICALIZED once (lowercase slug, issue #39): the OS hostname's casing used
// to leak into the advertised leader host while instance ids were lowercased, so the same box
// compared unequal to itself (defeating the same-host guard) and the election tie-break depended
// on casing/locale. canonicalShort is the same filter cc-name applies to instance ids.
const HOST = canonicalShort(process.env.CC_HOST || hostname()) || 'unknown-host';
const DATA_DIR = dataDir();   // ~/.crosstalk (migrated from ~/.cross-claude-mcp once); CC_DATA_DIR overrides
const EPOCH_FILE = join(DATA_DIR, 'epoch');
const DB_FILE = join(DATA_DIR, 'messages.db');
// A client replicates into THIS file, never over messages.db (issue #35): renaming over the live
// DB while a same-host leader had it open unlinked the leader's inode, silently forfeiting every
// write since the last snapshot on the next leader restart. The replica is adopted (swapped in)
// only at promotion time, when no local server has the DB open.
const REPLICA_FILE = join(DATA_DIR, 'messages.db.replica');

// --- singleton supervisor bookkeeping (#6) ---
// A per-machine heartbeat file so `cc-bus ensure` can tell whether a supervisor is already
// running here WITHOUT a fragile cross-platform pid check in bash: liveness is process.kill(pid,0)
// (works on Windows + POSIX in Node) AND a fresh timestamp. The bus-visible presence id below
// makes the same standby count observable estate-wide via `cc-bus status` (#6 coverage / C).
const SUPERVISOR_FILE = join(DATA_DIR, 'supervisor.json');
const SPAWN_LOCK = join(DATA_DIR, '.supervisor.spawn.lock');
const HEARTBEAT_MS = 10000;        // supervisor rewrites its heartbeat this often
const SUPERVISOR_STALE_MS = 30000; // a heartbeat older than this (3 missed beats) ⇒ presumed dead
const SPAWN_LOCK_STALE_MS = 15000; // an abandoned spawn lock older than this is cleared
const SUPERVISOR_PREFIX = 'cc-bus-supervisor/';   // presence-id prefix for coverage visibility
const CLIENT_TICK_MAX_MS = 15000;   // a client's failover-check tick at the default cadence
const CLIENT_TICK_MIN_MS = 5000;    // …and its floor: a full discovery scan (tailnet exec + LAN solicit + probes)
                                    // every second per node is a storm, and a 1-2s failure detector promotes
                                    // on a stall (a busy box, a suspend/resume). The PULL has its own timer.
const CONFIRM_RESCANS = 2, CONFIRM_GAP_MS = 2000;   // a missed leader is re-scanned this often before we elect
const HANDOVER_WAIT_MS = 26000;     // version handover: how long to wait for a draining old leader to leave
                                    // (> the server's CC_DRAIN_MS default of 20s) before killing its supervisor
const STEPDOWN_HOLDOFF_MS = CLIENT_TICK_MAX_MS + 10000;   // an ex-leader may JOIN but not ELECT for this long
const GUARD_MAX_MS = Math.max(15000, parseInt(process.env.CC_PROMOTE_GUARD_MS) || 90000);   // cap the "unproven responder present, hold off promoting" wait (issue 55) so a forger can't freeze failover
const DRAIN_FOLLOW_MAX_MS = 30000;  // > the server's drain deadline (20s): never follow a drain forever

// Is `pid` a live process? signal 0 tests existence cross-platform: it throws ESRCH when the
// process is gone and EPERM when it exists but we can't signal it (still alive → true).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readSupervisor() {
  try { return JSON.parse(readFileSync(SUPERVISOR_FILE, 'utf8')); } catch { return null; }
}
function writeSupervisor(rec) {
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SUPERVISOR_FILE, JSON.stringify(rec)); } catch {}
}
// True when a supervisor is CURRENTLY running on this box (heartbeat fresh AND its pid alive).
// Residual (accepted): if a supervisor is OOM/SIGKILLed (no clean shutdown → the file lingers) and
// the OS recycles its exact pid to an unrelated live process within SUPERVISOR_STALE_MS, this can
// briefly report a false "live". The window is ≤30s and self-heals when the ts goes stale; a clean
// shutdown removes the file at once, and a crashed SPAWNED child is caught by the dead-pid check.
function supervisorLive() {
  const s = readSupervisor();
  if (!s || !s.ts) return null;
  if (Date.now() - s.ts > SUPERVISOR_STALE_MS) return null;
  if (!pidAlive(s.pid)) return null;
  return s;
}

// A SEPARATE admin secret (shared across the estate, like CC_TOKEN) that gates the dangerous
// admin routes — /cc/export (full-DB download), /cc/stepdown (remote kill) and /cc/import
// (DB overwrite). When set it is what the internal callers present and what /cc/import checks;
// when unset, /cc/import (like the server's export/stepdown) is loopback-only, so cross-host
// replication/migration then REQUIRE CC_ADMIN_KEY on every node.
const _bootCfg = loadConfig();
const ADMIN_KEY = process.env.CC_ADMIN_KEY || _bootCfg.admin || '';
// Interface the spawned server binds. From env or the config file; empty ⇒ server default (loopback).
const BIND = process.env.CC_BIND || _bootCfg.bind || '';
// file:// console grant for the spawned server (see server.mjs allowFileOrigin). From env or the
// config file; only '1' enables it.
const ALLOW_FILE_ORIGIN = process.env.CC_ALLOW_FILE_ORIGIN || _bootCfg.allowFileOrigin || '';
if (ALLOW_FILE_ORIGIN && ALLOW_FILE_ORIGIN !== '1') console.warn(`[cc-bus] CC_ALLOW_FILE_ORIGIN=${ALLOW_FILE_ORIGIN} is not '1' — the server treats it as OFF (file:// consoles stay blocked)`);
// Cap the /cc/import body so a runaway/abusive upload can't accumulate unboundedly in memory.
const MAX_IMPORT_BYTES = (parseInt(process.env.CC_MAX_IMPORT_MB) || 256) * 1024 * 1024;

// Constant-time comparison of the presented Authorization header against the expected
// value. Length is guarded first (timingSafeEqual throws on unequal-length buffers);
// behaviour is identical to === for valid/invalid tokens.
function authMatches(presented, expected) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// The bearer the internal admin callers present: the admin key when set, else the chat token
// (which the server accepts only over loopback — the no-admin-key default).
function adminBearer(token) { return 'Bearer ' + (ADMIN_KEY || token); }

function isLoopbackAddr(ip) {
  const s = String(ip ?? '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('127.');
}

// Authorize an inbound /cc/import (H2, mirrored from the server's requireAdmin): the admin key
// when set (chat token alone is refused), else loopback peers only.
function importAuthorized(req) {
  if (ADMIN_KEY) {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    return authMatches(bearer, ADMIN_KEY);
  }
  return isLoopbackAddr(req.socket?.remoteAddress || '');
}

// --- epoch sidecar (travels with the DB; monotonic authority) ---
function readEpoch() {
  try { return parseInt(readFileSync(EPOCH_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function writeEpoch(n) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(EPOCH_FILE, String(n));
}

const log = (...a) => console.log(`[cc-bus ${HOST}]`, ...a);

// --- spawn the vendored server as leader at a given epoch ---
function spawnLeader(epoch, port, token) {
  // `--disable-warning=ExperimentalWarning` silences the one-time "SQLite is an experimental
  // feature" line that node:sqlite (server/db.mjs) prints on load, so it never spams the bus
  // logs — while leaving every other warning intact. Only THIS type is disabled.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      MCP_API_KEY: token || process.env.MCP_API_KEY || '',
      CC_EPOCH: String(epoch),
      CC_HOST: HOST,
      CC_DATA_DIR: DATA_DIR,
      // Pass the admin key through explicitly so the server honours it even when it came from the
      // config FILE (loadConfig) rather than the ambient env — otherwise /cc/export etc. stay
      // loopback-only and cross-host replication/failover breaks.
      CC_ADMIN_KEY: ADMIN_KEY,
      // Same for the bind interface: honour a config-file CC_BIND so a host (or a failover-promoted
      // supervisor) serves off-box instead of silently binding loopback. Only set it when non-empty
      // so an unset value leaves the server's own loopback default intact.
      ...(BIND ? { CC_BIND: BIND } : {}),
      // And the file:// console grant, so `CC_ALLOW_FILE_ORIGIN=1` in ~/.claude/.crosstalk survives a
      // supervisor started by the join hook's `ensure` (which carries no env of its own).
      ...(ALLOW_FILE_ORIGIN ? { CC_ALLOW_FILE_ORIGIN: ALLOW_FILE_ORIGIN } : {}),
    },
    stdio: 'inherit',
    // Never pop a console window on Windows when a console-less/detached supervisor spawns the
    // server child (each such spawn would otherwise flash a window; a crash-loop flashes many).
    // No-op on POSIX.
    windowsHide: true,
  });
  return child;
}

// wait until base answers /cc/whoami with predicate(w) true, or timeout
async function waitFor(base, predicate, timeoutMs = 20000, everyMs = 400) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const w = await whoami(base, 1200);
    if (w && predicate(w)) return w;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

// --- DB replication (Finding 3): a client pulls the leader's DB snapshot so an automatic
// failover promotes THIS node on a RECENT copy — bounding message loss to the replication
// interval instead of the unbounded loss of promoting on a stale/empty local DB. Also carries
// the leader's epoch so the failover-promote is authoritative (epoch+1 > the leader's). A
// client runs no server, so DB_FILE is not open here; we clear stale WAL/SHM and swap the fresh
// image in atomically. Best-effort: any failure returns false and never disturbs the client.
async function replicateSnapshot(leader, token) { return (await pullSnapshot(leader, token)).ok; }
const PULL_TIMEOUT_MS = 60000;   // a stalled leader must not hold a pull open for ever
// → { ok, draining }: `draining` = the leader answered with x-cc-draining (it is in a drain
// stepdown — read-only and leaving as soon as a replica holds the final snapshot; issue 43).
async function pullSnapshot(leader, token, stillWanted = () => true) {
  const miss = { ok: false, draining: false };
  try {
    // Issue #35: NEVER replicate when the leader is this very host — the pull would target the
    // same DATA_DIR the live leader has open. The old guard matched only a loopback-resolved
    // base URL (defeated by CC_BIND=0.0.0.0, where discovery returns the LAN address) and a
    // case-sensitive host compare (defeated by OS-vs-config casing, issue #39). Canonical host
    // equality catches both. A same-host client still watches for failover; it just never pulls.
    if (canonicalShort(String(leader.host || '')) === HOST) return miss;
    const r = await fetch(leader.base + '/cc/export', { headers: { Authorization: adminBearer(token) }, signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
    if (!r.ok) return miss;
    const draining = r.headers.get('x-cc-draining') === '1';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return miss;
    // A pull can outlive the role that started it (a STALLED leader answers its export long after
    // we gave up on it and promoted). Writing then would plant a replica newer than our live DB —
    // adopted, -wal deleted, on the next re-elect — and drag the epoch file BACKWARDS, so the next
    // promotion re-uses a term. Re-check right before touching the disk.
    if (!stillWanted()) return miss;
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = REPLICA_FILE + '.tmp';
    writeFileSync(tmp, buf);
    renameSync(tmp, REPLICA_FILE);   // atomic on both POSIX and Windows; live DB untouched (#35)
    if (typeof leader.epoch === 'number') writeEpoch(Math.max(readEpoch(), leader.epoch));   // the epoch file is MONOTONIC
    return { ok: true, draining };
  } catch { return miss; }
}

// Adopt the replicated snapshot as the working DB at PROMOTION time — the only moment we know no
// local server has messages.db open. The replica wins when the live DB is absent or the replica
// is at least as fresh (mtime); stale WAL/SHM from a previous term are cleared with it. Returns
// what happened for the log. Exported for the test suite.
export function adoptReplicaIfFresher() {
  try {
    if (!existsSync(REPLICA_FILE)) return 'no-replica';
    let adopt = true;
    if (existsSync(DB_FILE)) {
      try { adopt = statSync(REPLICA_FILE).mtimeMs >= statSync(DB_FILE).mtimeMs; } catch { adopt = false; }
    }
    if (!adopt) { try { rmSync(REPLICA_FILE); } catch {} return 'db-fresher'; }
    for (const suf of ['-wal', '-shm']) { try { rmSync(DB_FILE + suf); } catch {} }
    renameSync(REPLICA_FILE, DB_FILE);
    return 'adopted';
  } catch (e) { return 'error:' + (e?.message || e); }
}

// Advertise this supervisor on the bus so `cc-bus status` can count failover capacity across the
// estate (#6 coverage / C). Reuses the existing presence table — a distinct instance_id per host,
// heartbeated. Best-effort/fail-soft: a registration miss never disturbs the supervisor.
async function registerSupervisor(id, role, epoch, token, port) {
  let base = null;
  if (role === 'leader') base = `http://127.0.0.1:${port}`;   // I am the server → register to myself
  else { const c = readTrustedCache(); base = c?.proven === true ? c.base : null; }   // client → the discovered leader, and ONLY one that PROVED itself: this POST carries the token
  if (!base) return;
  try {
    await fetch(base + '/api/register', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' },
      body: JSON.stringify({
        instance_id: id,
        description: `supervisor ${role || 'starting'} epoch ${epoch}`,
        rev: revString(),
        version: pkgVersion(),
      }),
    });
  } catch {}
}

// ===========================================================================
// cc-bus start — election + supervise + failover
// ===========================================================================
async function cmdStart() {
  const cfg = loadConfig();
  const port = cfg.port;
  const token = cfg.token;

  let child = null;
  let stopBeacon = null;
  let steppingDown = false;
  let role = null;
  let monitorIv = null;
  let currentEpoch = 0;   // the term we currently believe in (for the heartbeat/registration)
  let guardBlockedSince = 0;   // when the promote-guard (issue 55) first held off; 0 = not holding

  const STEPDOWN_MARKER = join(DATA_DIR, '.stepdown');

  // --- singleton heartbeat + estate-visible presence (#6) -------------------------------------
  // Prove this box has a live supervisor (so `cc-bus ensure` won't start a second one) and make
  // that failover capacity observable estate-wide (so `cc-bus status` can show the SPOF state).
  const supervisorId = SUPERVISOR_PREFIX + HOST;
  const beat = () => {
    // version + path let `ensure` detect a supervisor left running from a superseded plugin
    // install (issue #37) and hand over instead of treating the stale one as healthy.
    writeSupervisor({ pid: process.pid, ts: Date.now(), host: HOST, role: role || 'starting', epoch: currentEpoch, version: pkgVersion() || null, path: fileURLToPath(import.meta.url) });
    registerSupervisor(supervisorId, role, currentEpoch, token, port).catch(() => {});
  };
  beat();
  const heartbeatIv = setInterval(beat, HEARTBEAT_MS);
  heartbeatIv.unref?.();

  async function becomeLeader() {
    // Rollout guard (issue 55): strict discovery IGNORES a leader that cannot prove the token —
    // during the 3.3.5 rollout that is the pre-3.3.5 leader still serving, and during a password
    // change it is every box not yet re-enrolled. Promoting beside it would split the estate or
    // steal its term. If such a responder was seen at an epoch ≥ ours: HOLD OFF, say why, scan
    // again — but only for GUARD_MAX_MS. Unbounded, one unauthenticated responder (a forger, or a
    // stray old-token box) would freeze this box's failover forever, and a brand-new estate's very
    // first box (readEpoch()===0, so ANY responder is epoch≥ours) could never bootstrap. After the
    // bound we proceed loudly: a forger cannot hold us hostage, and a genuine mis-ordered upgrade
    // (which the docs tell you to avoid — upgrade the LEADER box first) degrades to a brief,
    // logged split instead of a permanent outage. The real fix for a planned rollout is
    // CC_DISCOVERY_PROOF=legacy in the config for the sitting, which never trips this at all.
    const u = highestUnprovenEpoch();
    if (u && u.epoch >= readEpoch()) {
      if (!guardBlockedSince) guardBlockedSince = Date.now();
      const waited = Date.now() - guardBlockedSince;
      if (waited < GUARD_MAX_MS) {
        log(`⚠️  NOT promoting (${Math.round(waited / 1000)}s so far): ${u.base} answers at epoch ${u.epoch} but cannot prove the estate token (a pre-3.3.5 leader, a different token, or a forger). Upgrade the LEADER box first / re-enrol that box, or set CC_DISCOVERY_PROOF=legacy in ~/.claude/.crosstalk for this sitting. Retrying in 15s; giving up after ${Math.round(GUARD_MAX_MS / 1000)}s.`);
        setTimeout(electAndRun, 15000);
        return;
      }
      log(`⚠️  proceeding after ${Math.round(waited / 1000)}s despite ${u.base} (unprovable, epoch ${u.epoch}) — it is most likely a forger or a stray old-token box. If it was a REAL pre-3.3.5 leader you may briefly split: stop it, upgrade the leader box first, and use CC_DISCOVERY_PROOF=legacy for the rollout sitting.`);
    }
    guardBlockedSince = 0;
    // Swap in the replicated snapshot now, before any server opens the DB (#35): promotion is
    // the one safe moment for the replica → messages.db rename.
    const adoption = adoptReplicaIfFresher();
    if (adoption === 'adopted') log('adopted the replicated snapshot as messages.db for this promotion');
    // Review finding 2: an adoption ERROR (EBUSY — e.g. an orphaned old server still holding
    // messages.db) means we are about to promote on a possibly-STALE local DB. Say so loudly;
    // silence here is how the #35 loss class comes back.
    else if (String(adoption).startsWith('error')) log(`⚠️  replica adoption FAILED (${adoption}) — promoting on the LOCAL DB, which may be stale. If an old server process still holds messages.db on this box, kill it.`);
    // #7 empty-snapshot guard: never blank the bus. If this node has NO local DB at all (never
    // led, never replicated), do one final full scan before promoting — a just-joined node must
    // not promote an empty store over a leader that discovery merely hadn't found yet. A node that
    // is genuinely alone still bootstraps a fresh (empty) bus, but says so loudly.
    if (!existsSync(DB_FILE)) {
      const other = await resolveFull({ token, skipLoopback: true, skipSelf: true });
      if (other) {
        log(`local DB is empty and a live leader ${other.host} (epoch ${other.epoch}) exists → joining as CLIENT rather than blanking the bus`);
        return runClient();
      }
      log('⚠️  local DB is empty and no leader was found anywhere → bootstrapping a FRESH bus (there is no history to preserve)');
    }
    try { rmSync(STEPDOWN_MARKER); } catch {}   // clear any stale marker before we lead
    const epoch = readEpoch() + 1;      // strictly higher than the last term this DB served
    writeEpoch(epoch);
    currentEpoch = epoch;
    role = 'leader';
    log(`no bus present → becoming LEADER at epoch ${epoch} (port ${port})`);
    child = spawnLeader(epoch, port, token);
    // CC_DISCOVERY=peers: a confined bus neither scans nor ADVERTISES itself on the LAN.
    stopBeacon = cfg.discovery === 'peers' ? null : startBeacon({ host: HOST, epoch, port, beaconPort: cfg.beaconPort, token });

    child.on('exit', (code) => {
      if (stopBeacon) { stopBeacon(); stopBeacon = null; }
      if (monitorIv) { clearInterval(monitorIv); monitorIv = null; }
      // An intentional stepdown (local flag OR the server's marker written by /cc/stepdown)
      // means "become CLIENT" — NOT re-elect. Re-electing on stepdown was the migration flap:
      // the old leader would re-take the term at an epoch TIE with the freshly-migrated host.
      const wasStepdown = steppingDown || existsSync(STEPDOWN_MARKER);
      try { if (existsSync(STEPDOWN_MARKER)) rmSync(STEPDOWN_MARKER); } catch {}
      if (wasStepdown) { log('stepped down → switching to CLIENT'); steppingDown = false; role = null; runClient({ holdoffMs: STEPDOWN_HOLDOFF_MS }); return; }
      log(`server exited (code ${code}) → re-electing in 1s`);
      role = null;
      setTimeout(electAndRun, 1000);
    });

    // Continuous leadership monitor: while we lead, keep scanning for a peer that OUTRANKS us
    // (higher epoch; or equal epoch with a FRESHER snapshot — higher watermark — else a
    // lexicographically-lower host) and step down to it. Using the shared outranks() ordering
    // means the monitor and discovery can never disagree, so a stale co-leader always yields to
    // the freshest one (#7). A repeating check (not one-shot) so any tie/race self-corrects.
    monitorIv = setInterval(async () => {
      if (role !== 'leader') { clearInterval(monitorIv); monitorIv = null; return; }
      const peer = await resolveFull({ token, skipLoopback: true, skipSelf: true });
      if (!peer) return;
      // Read our OWN watermark from loopback for the equal-epoch tiebreak. If our server can't be
      // read right now, SKIP this tick rather than compare against a phantom watermark of 0 — a
      // transient loopback miss must never cause a false step-down that would forfeit our newer
      // writes to a same-epoch peer. Next tick retries.
      const self = await whoami(`http://127.0.0.1:${port}`, 1000);
      if (!self) return;
      const me = { epoch, watermark: self.watermark ?? 0, host: HOST };
      if (outranks(peer, me)) {
        log(`peer ${peer.host} (epoch ${peer.epoch}, watermark ${peer.watermark ?? 0}) outranks me ` +
            `(${HOST} epoch ${epoch}, watermark ${me.watermark}) → stepping down to CLIENT`);
        clearInterval(monitorIv); monitorIv = null;
        steppingDown = true;
        // Watchdog (#34): the stepdown REQUEST is not the stepdown. If the child has not exited
        // shortly after the POST (a wedged close, a hung event loop), escalate: kill, then SIGKILL.
        // Without this, a stepdown that never completed left the supervisor 'leader' forever with
        // no listener — the exact wedge of the 3.3.2 rollout. child.on('exit') clears the flags.
        const c = child;
        const watchdog = setTimeout(() => {
          if (c.exitCode === null && c.signalCode === null) { log('stepdown watchdog: server still alive 5s after /cc/stepdown → kill()'); try { c.kill(); } catch {} }
          setTimeout(() => {
            if (c.exitCode === null && c.signalCode === null) { log('stepdown watchdog: still alive → SIGKILL'); try { c.kill('SIGKILL'); } catch {} }
          }, 5000).unref?.();
        }, 5000);
        watchdog.unref?.();
        try { await fetch(`http://127.0.0.1:${port}/cc/stepdown`, { method: 'POST', headers: { Authorization: adminBearer(token) } }); } catch { try { child.kill(); } catch {} }
      }
    }, 5000);
  }

  // Client cadence (issue 43). Failover detection and the replica pull used to share ONE fixed 15s
  // interval, so CC_REPLICATE_MS below 15s was silently ignored while the log claimed it as the
  // loss bound. Now they are two timers:
  //   PULL      every CC_REPLICATE_MS (floor 1s) — cheap: it re-uses the leader the failover loop
  //             last confirmed, no discovery scan. This IS the unclean-failover loss bound.
  //   FAILOVER  every clamp(CC_REPLICATE_MS, 5s, 15s) — a full scan; a miss is CONFIRMED by two
  //             more scans 2s apart before we call the leader gone (one stalled probe, a long
  //             GC or a suspend/resume blip must not split the bus).
  // At the default (30s) this is exactly the old behaviour: 15s checks, 30s pulls.
  let clientGen = 0;   // every runClient() supersedes the previous loop (no two client loops, ever)
  async function runClient({ holdoffMs = 0 } = {}) {
    role = 'client';
    const gen = ++clientGen;
    const live = () => role === 'client' && gen === clientGen;
    const REPLICATE_MS = Math.max(1000, parseInt(process.env.CC_REPLICATE_MS) || 30000);
    const TICK_MS = Math.min(CLIENT_TICK_MAX_MS, Math.max(CLIENT_TICK_MIN_MS, REPLICATE_MS));
    // A node that just STEPPED DOWN must not win the term straight back: for one tick (+ margin)
    // it may join a new leader but not start an election, so the replicas get to promote first.
    const holdoffUntil = holdoffMs ? Date.now() + holdoffMs : 0;
    log(`CLIENT mode — a bus is present; not starting a server. Failover check every ${TICK_MS / 1000}s, DB pull every ${REPLICATE_MS / 1000}s (= the unclean-failover loss bound).`);
    let leaderNow = null;       // the leader the failover loop last confirmed — what the pull loop targets
    let lastReplicateOk = 0;    // when a pull last SUCCEEDED (snapshot recency, for the log)
    let pulling = false, scanning = false;
    let pullIv = null, scanIv = null;
    const stop = () => { clearInterval(pullIv); clearInterval(scanIv); };

    async function pull() {
      if (pulling || !leaderNow) return;
      pulling = true;
      try {
        const r = await pullSnapshot(leaderNow, token, live);
        if (!live()) return;
        if (r.ok) lastReplicateOk = Date.now();
        if (r.draining) { stop(); followDrain(leaderNow); }
      } finally { pulling = false; }
    }

    // Immediate first snapshot so a just-joined client can already fail over safely.
    leaderNow = await resolveFull({ token });
    if (!live()) return;
    if (leaderNow) { cacheLeader(leaderNow); await pull(); if (!live()) return; }

    pullIv = setInterval(() => { if (!live()) return stop(); pull().catch(() => {}); }, REPLICATE_MS);
    scanIv = setInterval(async () => {
      if (!live()) return stop();
      if (scanning) return;       // a slow scan must not stack on the next tick
      scanning = true;
      try {
        let leader = await resolveFull({ token });
        // CONFIRM a miss twice, 2s apart, before calling the leader gone: it must stay unreachable
        // for ~4s+ AFTER the first miss. A stalled probe, a long GC or a suspended-then-resumed box
        // must not cost a lossy failover (the promoted node serves its last snapshot) or a split.
        for (let k = 0; k < CONFIRM_RESCANS && !leader; k++) {
          await new Promise((r) => setTimeout(r, CONFIRM_GAP_MS));
          if (!live()) return;
          leader = await resolveFull({ token });
        }
        if (!live()) return;
        if (!leader) {
          if (Date.now() < holdoffUntil) return;   // just stepped down: let a replica take the term
          stop();
          // Finding 3: auto-failover promotes on the most recent replicated snapshot, so loss is
          // BOUNDED by the pull interval (not the unbounded stale-DB loss).
          const age = lastReplicateOk ? `~${Math.round((Date.now() - lastReplicateOk) / 1000)}s old` : 'NONE pulled — local DB may be stale/empty';
          log(`leader vanished (confirmed by ${CONFIRM_RESCANS} re-scans) → re-electing on the last replicated snapshot (${age}).`);
          electAndRun();
          return;
        }
        leaderNow = leader;
        cacheLeader(leader);
        // A DRAINING leader is read-only and leaves the moment a replica holds its final snapshot:
        // pull NOW (whatever the pull timer says) and follow it closely instead of waiting a tick.
        // At the default cadence THIS is what beats the server's 20s drain deadline.
        if (leader.draining) { stop(); followDrain(leader); }
      } finally { scanning = false; }
    }, TICK_MS);
  }

  // The leader told us it is leaving (drain stepdown). Keep pulling until it is gone — each pull
  // taken while it is read-only is a complete copy, and the first such pull releases it — then
  // elect at once rather than a tick later. "Gone" needs TWO consecutive misses: a draining leader
  // is busy (every follower pulls a full VACUUM INTO image), and one slow whoami must not make us
  // promote beside it. Bounded: a leader that never leaves hands us back to the ordinary loop.
  async function followDrain(leader) {
    const gen = clientGen;
    const live = () => role === 'client' && gen === clientGen;
    log(`leader ${leader.host} is DRAINING for a stepdown → pulling its final snapshot and standing by to take the term`);
    const end = Date.now() + DRAIN_FOLLOW_MAX_MS;
    let misses = 0;
    while (live() && Date.now() < end) {
      const w = await whoami(leader.base, 1500);
      if (!live()) return;
      misses = w ? 0 : misses + 1;
      if (misses >= 2) { log('draining leader is gone → electing now'); return electAndRun(); }
      if (w) await pullSnapshot(leader, token, live);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (live()) runClient();
  }

  // Started by the version-handover helper right after the old leader DRAINED: a remote replica is
  // taking the term on the final snapshot at this very moment. Electing now would tie with it at
  // the same epoch — and the loser's writes are dropped with no epoch change for receivers to
  // notice. Behave like the ex-leader we replace: join, but do not elect, for the holdoff.
  let startHoldoffMs = Math.max(0, parseInt(process.env.CC_START_HOLDOFF_MS) || 0);
  async function electAndRun() {
    const leader = await resolveFull({ token });   // any live bus, incl. this box's loopback
    if (!leader && startHoldoffMs) { const h = startHoldoffMs; startHoldoffMs = 0; log(`started after a drained handover → holding off elections for ${Math.round(h / 1000)}s`); return runClient({ holdoffMs: h }); }
    // (The replica usually wins that race and already leads: say so, so the log always shows the
    // handover's holdoff arrived — handover.test asserts one of these two lines, issue 53.)
    if (leader && startHoldoffMs) log(`started after a drained handover → ${leader.host} already leads, joining it (no holdoff needed)`);
    startHoldoffMs = 0;
    if (leader) {
      cacheLeader(leader);
      currentEpoch = leader.epoch ?? currentEpoch;
      if (canonicalShort(String(leader.host || '')) === HOST) {
        // A server is already running on THIS host (previous cc-bus). Don't double-start.
        // Canonical compare (#39) — the old `leader.host === HOST && loopback-base` pair missed a
        // CC_BIND leader (discovery returns the LAN address) and any casing difference (#35).
        log(`a server is already running here (epoch ${leader.epoch}) → CLIENT mode`);
      } else {
        log(`bus present: leader ${leader.host} epoch ${leader.epoch} @ ${leader.base}`);
      }
      runClient();
    } else {
      await becomeLeader();
    }
  }

  // On a clean shutdown, drop the singleton heartbeat file so the next `cc-bus ensure` sees the
  // slot as free at once (instead of waiting out the staleness window) and re-starts a supervisor.
  const shutdown = () => {
    steppingDown = true;
    try { clearInterval(heartbeatIv); } catch {}
    try { const s = readSupervisor(); if (s && s.pid === process.pid) rmSync(SUPERVISOR_FILE); } catch {}
    try { child?.kill(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await electAndRun();
}

// ===========================================================================
// cc-bus ensure — idempotent per-machine supervisor (#6, approach B)
//
// The SessionStart hook calls this so that any box with an active Claude session has failover
// capacity by construction. It starts a `cc-bus start` supervisor ONLY if one is not already
// running here. Liveness is a fresh heartbeat + a live pid (process.kill(pid,0), cross-platform),
// NOT a fragile bash pid check. An atomic lock serializes concurrent session-starts so exactly
// one supervisor runs per machine. Fast (no network) and fail-soft — it must never wedge a start.
// ===========================================================================
// Does the live supervisor need replacing because it runs a superseded install (#37)? True ONLY
// when its heartbeat POSITIVELY carries a different version than ours. A heartbeat without a
// `version` (pre-#37 format, or a foreign/corrupt file) deliberately does NOT trigger the kill
// path — the handover terminates whatever pid the file names, and that escalation must never
// run on the strength of a record we can't attribute to a versioned supervisor. (A legacy
// supervisor therefore needs one last manual kill; every one written by this code is covered.)
// And the handover is DIRECTIONAL (review finding 1): only a strictly NEWER install may replace
// a running supervisor. On `!==` alone, a lingering older install (a pinned dev checkout, a
// stale cache) would kill the newer supervisor right back — bidirectional thrash, with the
// OLDER code winning the last round and version-gating the whole upgraded fleet out: the exact
// failure #37 exists to fix, reintroduced by the fix. Exported for the test suite.
function semverNewer(a, b) {   // true ⇔ a > b (numeric x.y.z compare; missing parts = 0)
  const pa = String(a).split('.').map((n) => parseInt(n) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
export function needsVersionHandover(live, myVersion = pkgVersion()) {
  if (!live || !myVersion || !live.version) return false;
  return semverNewer(myVersion, live.version);
}

// The log sink for a hook-started supervisor (#36): stdio used to be 'ignore', so a wedged or
// crash-looping bus left no trace at all. One rolling file in the data dir, rotated at ~1MB.
function ensureLogFd() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const logPath = join(DATA_DIR, 'cc-bus.log');
    try { if (statSync(logPath).size > 1024 * 1024) renameSync(logPath, logPath + '.old'); } catch {}
    return openSync(logPath, 'a');
  } catch { return 'ignore'; }
}

function cmdEnsure(afterHandover = false, startEnv = {}) {
  const live = supervisorLive();
  if (live && needsVersionHandover(live)) {
    if (afterHandover) {
      // One attempt only (review finding 5): a kill that failed (EPERM, respawn race) must not
      // loop the SessionStart hook's child forever. Say what a human must do and stop.
      log(`handover did not free the slot — supervisor pid ${live.pid} (v${live.version}) survived; kill it manually, then start a session`);
      return;
    }
    // Issue #37: a supervisor from a superseded plugin install keeps running old code (and, when
    // it leads, version-gates the whole upgraded fleet out) until killed by hand. Hand over — in a
    // DETACHED helper, because doing it properly takes longer than a SessionStart hook may block:
    // the old leader is asked to DRAIN (issue 43), so whichever node takes the term — a replica on
    // another box, or the new supervisor here on the same messages.db — has every acknowledged
    // message. (Before: a plain stepdown + a 6s respawn gap, during which a remote replica's tick
    // could promote it on a snapshot up to one pull interval old; the fuller local DB then joined
    // as a client and its tail was lost.)
    log(`supervisor here runs ${live.version || 'an unversioned install'} but the plugin is ${pkgVersion()} → version handover (pid ${live.pid}) — running in the background, see ${join(DATA_DIR, 'cc-bus.log')}`);
    try {
      const fd = ensureLogFd();
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'handover', String(live.pid)], {
        detached: true, stdio: fd === 'ignore' ? 'ignore' : ['ignore', fd, fd], windowsHide: true,
      }).unref();
    } catch (e) { log(`handover helper could not start (${e.message}) — kill pid ${live.pid} manually, then start a session`); }
    return;
  }
  if (live) { log(`supervisor already running here (pid ${live.pid}, role ${live.role || '?'}, v${live.version || '?'}) — nothing to do`); return; }

  // Serialize the check-and-spawn so two near-simultaneous ensures don't both start a supervisor.
  mkdirSync(DATA_DIR, { recursive: true });
  let locked = false;
  try { mkdirSync(SPAWN_LOCK); locked = true; }
  catch (e) {
    if (e.code !== 'EEXIST') { log(`ensure: could not take spawn lock (${e.message}) — skipping`); return; }
    // Lock held: clear it only if it's abandoned (older than the stale window), else another
    // ensure is mid-spawn right now → let it win and exit quietly.
    let age = Infinity;
    try { age = Date.now() - statSync(SPAWN_LOCK).mtimeMs; } catch {}
    if (age > SPAWN_LOCK_STALE_MS) {
      try { rmSync(SPAWN_LOCK, { recursive: true, force: true }); mkdirSync(SPAWN_LOCK); locked = true; } catch { return; }
    } else { return; }   // a concurrent ensure is starting the supervisor
  }

  try {
    // Re-check under the lock — another ensure may have started one between our first check and
    // taking the lock.
    if (supervisorLive()) { log('supervisor came up concurrently — nothing to do'); return; }
    // Supervisor + server output goes to ~/.crosstalk/cc-bus.log (#36) — 'ignore' left zero
    // trace of a wedged or crash-looping bus. spawnLeader uses stdio:'inherit', so the server
    // child writes to the same file. Role transitions are already log()-ed lines.
    const fd = ensureLogFd();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start'], {
      env: { ...process.env, ...startEnv },
      detached: true, stdio: fd === 'ignore' ? 'ignore' : ['ignore', fd, fd], windowsHide: true,   // no flashing console window on Windows
    });
    child.unref();
    // Record the child pid immediately so a follow-on ensure sees the slot as claimed before the
    // spawned `start` has finished booting and written its own first heartbeat.
    writeSupervisor({ pid: child.pid, ts: Date.now(), host: HOST, role: 'starting', epoch: 0 });
    log(`started local supervisor (pid ${child.pid}) — this box now has failover capacity`);
  } finally {
    if (locked) { try { rmSync(SPAWN_LOCK, { recursive: true, force: true }); } catch {} }
  }
}

// ===========================================================================
// cc-bus handover <old-supervisor-pid>   (internal — spawned detached by `ensure`)
// ===========================================================================
async function cmdHandover(args) {
  const oldPid = parseInt(args[0]);
  const live = supervisorLive();
  // Re-check under our own eyes: only ever touch the pid `ensure` named, only while the record
  // still names it, and only if we are strictly newer (the directional rule).
  if (!live || live.pid !== oldPid || !needsVersionHandover(live)) { log(`handover: nothing to do for pid ${oldPid}`); return; }
  const cfg = loadConfig();
  const loop = `http://127.0.0.1:${cfg.port}`;
  // Own box, loopback: a pre-3.3.5 server here cannot prove itself, and it is exactly the one we
  // are replacing — probe without the token (plain answer) so the drain still runs.
  const before = await whoami(loop, 1500, '');
  let drained = false;
  if (before && canonicalShort(String(before.host || '')) === HOST) {
    log(`handover: asking the local leader (epoch ${before.epoch}) to DRAIN and step down`);
    try {
      const r = await fetch(loop + '/cc/stepdown?drain=1', { method: 'POST', headers: { Authorization: adminBearer(cfg.token) }, signal: AbortSignal.timeout(3000) });
      drained = !!(await r.json().catch(() => ({}))).draining;   // false: a pre-3.3.4 server (ignores ?drain) or nobody to drain for
    } catch {}
    const end = Date.now() + HANDOVER_WAIT_MS;
    while (Date.now() < end && await whoami(loop, 1500)) await new Promise((r) => setTimeout(r, 500));
    if (await whoami(loop, 1500)) log('handover: ⚠️  the old server is STILL up after the drain window — killing its supervisor anyway');
  }
  try { process.kill(oldPid); } catch {}
  for (let i = 0; i < 10 && pidAlive(oldPid); i++) await new Promise((r) => setTimeout(r, 250));
  try { if (pidAlive(oldPid)) process.kill(oldPid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 10 && pidAlive(oldPid); i++) await new Promise((r) => setTimeout(r, 250));
  // The stale heartbeat would block the respawn for up to SUPERVISOR_STALE_MS; drop it (if it is
  // still the old one — a concurrent ensure may already have replaced it).
  if (pidAlive(oldPid)) { log(`handover: pid ${oldPid} would not die — leaving its heartbeat in place; kill it manually, then start a session`); return; }
  try { const s = readSupervisor(); if (s && s.pid === oldPid) rmSync(SUPERVISOR_FILE); } catch {}
  cmdEnsure(true, drained ? { CC_START_HOLDOFF_MS: String(STEPDOWN_HOLDOFF_MS) } : {});
}

// ===========================================================================
// cc-bus status
// ===========================================================================
async function cmdStatus() {
  const cfg = loadConfig();
  const leader = await resolveFull({ token: cfg.token });
  if (leader) {
    const mine = revString();
    const leaderRev = leader.rev || 'unknown';
    const myVer = pkgVersion() || 'unknown';
    const leaderVer = leader.version || 'unknown';
    console.log(`LEADER: ${leader.host}  epoch=${leader.epoch}  watermark=${leader.watermark ?? 0}  base=${leader.base}  rev=${leaderRev}  version=${leaderVer}`);
    console.log(`THIS NODE: ${HOST}  rev=${mine}  version=${myVer}  local-supervisor=${supervisorLive() ? 'running' : 'none'}  log=${join(DATA_DIR, 'cc-bus.log')}`);
    // Version mismatch is now ENFORCED (the bus refuses a non-matching client, see version-gate.mjs),
    // so surface it prominently — a stale host here is one that would be blocked from joining.
    if (leader.version && myVer !== 'unknown' && myVer !== leaderVer) {
      console.log(`⛔ VERSION MISMATCH — this host (${myVer}) ≠ the bus (${leaderVer}); this host is BLOCKED from the bus until it updates. Reinstall the plugin (or git pull && restart), then re-arm.`);
    } else if (leader.rev && mine !== 'unknown' && mine !== leader.rev) {
      console.log(`⚠️  CODE DRIFT — same version (${myVer}) but this checkout (${mine}) differs from the leader (${leader.rev}). git pull && restart the bus to sync.`);
    }
    await reportCoverage(leader, cfg.token);
  } else {
    console.log('no bus leader found (loopback / LAN / tailnet all silent)');
    const local = supervisorLive();
    console.log(`THIS NODE: ${hostname()}  local-supervisor=${local ? `running (pid ${local.pid})` : 'none'}`);
    process.exitCode = 1;
  }
}

// Compute failover coverage from the bus roster (pure, so it is unit-testable). Returns the
// online supervisor hosts and the `backups` — supervisor hosts OTHER than the leader's, i.e. the
// boxes that could take over if the leader died (the leader's own supervisor is not its backup).
// CRITICAL: the server canonicalizes the short segment of a registered id (lowercases, slug), so a
// stored supervisor host is `canonicalShort(HOST)` while `leaderHost` from /cc/whoami is the RAW
// os.hostname(). Both sides MUST be canonicalized before comparing, or a leader on an uppercase /
// underscore host (e.g. DESKTOP-7ODO6OU) never matches its own supervisor and gets falsely counted
// as a backup — a "capacity OK" all-clear on the exact SPOF this feature exists to warn about.
export function failoverCoverage(instances, leaderHost) {
  const supers = (instances || []).filter(
    (i) => i.status === 'online' && String(i.instance_id).startsWith(SUPERVISOR_PREFIX),
  );
  const hosts = [...new Set(supers.map((i) => String(i.instance_id).slice(SUPERVISOR_PREFIX.length)))].sort();
  const leaderShort = canonicalShort(String(leaderHost ?? ''));
  const backups = hosts.filter((h) => h !== leaderShort);
  return { hosts, backups };
}

// #6 coverage visibility: read the bus roster, count the supervisors that provide failover
// capacity, and call out the SPOF state so it is observable BEFORE a 2am outage — not during one.
async function reportCoverage(leader, token) {
  let instances = [];
  try {
    const r = await fetch(leader.base + '/api/instances', { headers: { Authorization: 'Bearer ' + token, 'x-cc-version': pkgVersion() || '' } });
    if (r.ok) instances = (await r.json()).instances || [];
  } catch { /* fail-soft: coverage is advisory */ }

  const { hosts, backups } = failoverCoverage(instances, leader.host);

  if (!hosts.length) {
    console.log('SUPERVISORS: none registered — coverage unknown (no supervisor has reported in). ' +
      'Run `cc-bus ensure` on your boxes, or set CC_AUTO_SUPERVISOR=1 to auto-start one per session.');
    return;
  }
  console.log(`SUPERVISORS: ${hosts.length} online — ${hosts.join(', ')}`);
  if (backups.length >= 1) {
    console.log(`FAILOVER CAPACITY: OK — ${backups.length} standby host(s) can take over: ${backups.join(', ')}`);
  } else {
    console.log('⚠️  SINGLE POINT OF FAILURE — only the leader host runs a supervisor. If it dies the bus ' +
      'goes leaderless. Start a supervisor on a SECOND box (`cc-bus ensure`).');
  }
}

// ===========================================================================
// cc-bus receive — standby on a migration target
// ===========================================================================
async function cmdReceive(args) {
  const cfg = loadConfig();
  const port = parseInt(argOf(args, '--port')) || cfg.port;
  const token = cfg.token;
  const standbyEpoch = readEpoch();

  // Refuse if a bus is already leading on this port (don't clobber a live host).
  const existing = await whoami(`http://127.0.0.1:${port}`, 1000);
  if (existing && existing.role === 'leader') {
    console.error(`refusing: a leader (epoch ${existing.epoch}) is already running on :${port} here`);
    process.exit(1);
  }

  log(`STANDBY on :${port} (epoch ${standbyEpoch}) — awaiting /cc/import. Ctrl-C to cancel.`);

  const srv = createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/cc/whoami') {
      // A standby answers the discovery challenge too (issue 55) — `migrate` probes it strictly.
      const n = new URL(req.url, 'http://x').searchParams.get('nonce');
      const proof = n && /^[0-9a-f]{16,64}$/.test(n) && token ? { proof: whoamiProof(token, n, HOST, standbyEpoch, 0, req.socket.localAddress, req.socket.localPort) } : {};
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ role: 'standby', host: HOST, epoch: standbyEpoch, port, ...proof }));
      return;
    }
    if (req.method === 'POST' && req.url === '/cc/import') {
      // Admin-scoped (H2): CC_ADMIN_KEY when set, else loopback-only. A leaked chat token can
      // no longer overwrite the whole bus DB from across the network.
      if (!importAuthorized(req)) {
        res.statusCode = ADMIN_KEY ? 401 : 403;
        res.end(ADMIN_KEY ? 'unauthorized' : 'admin ops require loopback or CC_ADMIN_KEY');
        return;
      }
      const newEpoch = parseInt(req.headers['x-cc-epoch']) || (standbyEpoch + 1);
      const chunks = [];
      let total = 0, tooLarge = false;
      req.on('data', (c) => {
        if (tooLarge) return;
        total += c.length;
        if (total > MAX_IMPORT_BYTES) {   // bound the read — never accumulate an unbounded body
          tooLarge = true;
          res.statusCode = 413;
          res.setHeader('connection', 'close');
          res.end(JSON.stringify({ error: 'import too large', max_bytes: MAX_IMPORT_BYTES }));
          try { req.destroy(); } catch {}
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const buf = Buffer.concat(chunks);
          mkdirSync(DATA_DIR, { recursive: true });
          // Clear any stale WAL/SHM so the imported image is authoritative.
          for (const suf of ['', '-wal', '-shm']) { try { rmSync(DB_FILE + suf); } catch {} }
          writeFileSync(DB_FILE, buf);
          writeEpoch(newEpoch);
          res.setHeader('content-type', 'application/json');
          res.setHeader('connection', 'close');   // no keep-alive → the bootstrap can free :8787 at once
          res.end(JSON.stringify({ ok: true, host: HOST, epoch: newEpoch, bytes: buf.length }));
          log(`imported ${buf.length} bytes → promoting to LEADER at epoch ${newEpoch}`);

          // Hand the port from the bootstrap listener to the full server. srv.close() only
          // fires once every connection is gone, and the migrate client's keep-alive socket
          // would otherwise hold it open — so force-drop lingering sockets first, THEN spawn
          // the full server in the close callback (guaranteeing :8787 is actually free, no
          // EADDRINUSE). A one-shot guard prevents a double-spawn.
          let promoted = false;
          const promote = () => {
            if (promoted) return; promoted = true;
            const child = spawnLeader(newEpoch, port, token);
            const stop = startBeacon({ host: HOST, epoch: newEpoch, port, beaconPort: cfg.beaconPort, token });
            child.on('exit', (code) => {
              stop();
              // A migrate-promoted leader must NOT just die on its server's exit — that left the
              // 2026-08 "zombie"/no-failover gap (review Findings 1 & 5). Re-join via `cc-bus start`
              // so the node re-elects (leader if truly alone) or drops to CLIENT (if the server
              // self-demoted to a higher-epoch peer — the .stepdown marker path). This gives a
              // migrate-born leader the same resilience as a `start`-elected one.
              log(`server exited (code ${code}) — re-joining the bus via 'cc-bus start'`);
              try {
                spawn(process.execPath, [fileURLToPath(import.meta.url), 'start'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
              } catch {}
              process.exit(code || 0);
            });
          };
          try { srv.closeAllConnections?.(); } catch {}
          srv.close(promote);
          // last-resort net in case the close callback never fires (should not happen once
          // connections are force-dropped); long enough that the normal close path always wins.
          setTimeout(promote, 8000);
        } catch (e) {
          res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  srv.listen(port, '0.0.0.0');
}

// ===========================================================================
// cc-bus migrate --to <host> --confirm
// ===========================================================================
async function cmdMigrate(args) {
  const cfg = loadConfig();
  const token = cfg.token;
  const port = cfg.port;
  const to = argOf(args, '--to');
  const confirm = args.includes('--confirm');
  if (!to) { console.error('usage: cc-bus migrate --to <host|ip|host:port> --confirm'); process.exit(2); }

  // 1. current leader to export FROM
  const leader = await resolveFull({ token });
  if (!leader) { console.error('abort: no current bus leader found to migrate from'); process.exit(1); }
  log(`current leader: ${leader.host} epoch=${leader.epoch} @ ${leader.base}`);

  // 2. resolve target address
  const targetBase = await resolveTarget(to, port);
  if (!targetBase) { console.error(`abort: cannot resolve target "${to}" to an address (try --to <ip>:${port} or add CC_PEERS)`); process.exit(1); }

  // 3. precheck: target must be a standby, and --confirm required
  const tw = await whoami(targetBase, 3000);
  if (!tw) { console.error(`abort: target ${targetBase} is not answering. Run \`cc-bus receive\` on ${to} first.`); process.exit(1); }
  if (tw.role !== 'standby') { console.error(`abort: target ${targetBase} is role="${tw.role}", expected "standby". Run \`cc-bus receive\` on ${to}.`); process.exit(1); }
  if (!confirm) {
    console.error(`\nAbout to MIGRATE the live bus:\n  from  ${leader.host}  epoch ${leader.epoch}  ${leader.base}\n  to    ${tw.host}  ${targetBase}  (new epoch ${leader.epoch + 1})\nThis moves the message DB and steps the old leader down.\nRe-run with --confirm to proceed.`);
    process.exit(1);
  }

  const newEpoch = leader.epoch + 1;

  // 4. export consistent snapshot from current leader
  log('exporting DB snapshot from current leader…');
  const exp = await fetch(leader.base + '/cc/export', { headers: { Authorization: adminBearer(token) } });
  if (!exp.ok) { console.error(`abort: export failed ${exp.status} ${await exp.text().catch(() => '')}`); process.exit(1); }
  const dbBytes = Buffer.from(await exp.arrayBuffer());
  log(`snapshot ${dbBytes.length} bytes`);

  // 5. push to target /cc/import with the new epoch
  log(`importing into ${tw.host} at epoch ${newEpoch}…`);
  const imp = await fetch(targetBase + '/cc/import', {
    method: 'POST',
    headers: { Authorization: adminBearer(token), 'content-type': 'application/octet-stream', 'x-cc-epoch': String(newEpoch) },
    body: dbBytes,
  });
  if (!imp.ok) { console.error(`abort: import failed ${imp.status} ${await imp.text().catch(() => '')}`); process.exit(1); }

  // 6. verify target promoted to leader@newEpoch BEFORE stepping the old one down
  log('verifying new leader…');
  const promoted = await waitFor(targetBase, (w) => w.role === 'leader' && w.epoch === newEpoch, 60000);
  if (!promoted) { console.error('abort: target did not promote to leader in time — OLD LEADER LEFT RUNNING (safe). Investigate before retrying.'); process.exit(1); }
  log(`✅ new leader live: ${promoted.host} epoch=${promoted.epoch} @ ${targetBase}`);

  // 7. step the old leader down (only now that the new one is confirmed)
  log('stepping old leader down…');
  try {
    await fetch(leader.base + '/cc/stepdown', { method: 'POST', headers: { Authorization: adminBearer(token) } });
  } catch (e) { log(`warning: stepdown call errored (${e.message}); the new higher-epoch leader wins regardless`); }

  cacheLeader(promoted);

  // 8. announce on the bus
  try {
    await fetch(targetBase + '/api/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' },
      body: JSON.stringify({ channel: 'general', sender: `cc-bus/${HOST}`, message_type: 'status', content: `@all bus MIGRATED: leader is now ${promoted.host} (epoch ${newEpoch}) @ ${targetBase}. Old leader ${leader.host} stepped down. Re-discovery is automatic.` }),
    });
  } catch {}

  log(`done. Bus now led by ${promoted.host} at epoch ${newEpoch}.`);
}

// --- resolve a --to target to a base URL ---
async function resolveTarget(to, port) {
  // ip:port or host:port
  if (/^https?:\/\//.test(to)) return to.replace(/\/$/, '');
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(to)) return `http://${to.includes(':') ? to : to + ':' + port}`;
  if (to.includes(':')) return `http://${to}`;                 // host:port
  // bare hostname → try tailscale map first
  const ip = await tailscaleIpForHost(to);
  if (ip) return `http://${ip}:${port}`;
  // fall back to static peers whose host matches
  const cfg = loadConfig();
  for (const p of cfg.peers) {
    const h = p.split(':')[0];
    if (h.toLowerCase() === to.toLowerCase()) return `http://${p.includes(':') ? p : p + ':' + port}`;
  }
  // last resort: DNS/MagicDNS name as-is
  return `http://${to}:${port}`;
}

function tailscaleIpForHost(host) {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 2500, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const nodes = [j.Self, ...Object.values(j.Peer || {})];
        for (const n of nodes) {
          if (n && String(n.HostName).toLowerCase() === host.toLowerCase()) {
            const ip = (n.TailscaleIPs || []).find((x) => x.includes('.'));
            return resolve(ip || null);
          }
        }
        resolve(null);
      } catch { resolve(null); }
    });
  });
}

function argOf(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

// Exported for the test suite (the singleton decision logic + the coverage host-matching). The
// CLI runs only when this file is executed directly (below), so importing it for a test is inert.
export { supervisorLive, pidAlive, SUPERVISOR_FILE, SERVER_ENTRY, replicateSnapshot, pullSnapshot, readEpoch, writeEpoch, REPLICA_FILE, DB_FILE, HOST };
// (failoverCoverage is exported at its definition above.)
// SERVER_ENTRY is exported so a test can assert it resolves to a file that actually exists —
// a self-locating path that points at a missing module makes spawnLeader crash-loop the bus,
// which no in-process test catches (the supervisor test never spawns a real server).

// --- main (only when run directly, not when imported by a test) ---
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start': await cmdStart(); break;
    case 'ensure': cmdEnsure(); break;
    case 'handover': await cmdHandover(rest); break;   // internal: spawned detached by `ensure`
    case 'status': await cmdStatus(); break;
    case 'receive': await cmdReceive(rest); break;
    case 'migrate': await cmdMigrate(rest); break;
    default:
      console.log('usage: cc-bus <start|ensure|status|receive|migrate>\n' +
        '  start                        elect + supervise (leader if none present, else client)\n' +
        '  ensure                       start a supervisor here ONLY if one is not already running (idempotent)\n' +
        '  status                       print the current leader + estate failover coverage\n' +
        '  receive [--port N]           standby on a migration target\n' +
        '  migrate --to <host> --confirm  move the live bus to <host>');
      process.exit(cmd ? 1 : 0);
  }
}
