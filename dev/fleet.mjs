#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dev/fleet.mjs — fleet-in-a-box: N real cc-bus supervisors on ONE machine,
// fully isolated from the production estate. Every multi-node behaviour
// (election, failover, stepdown, replication, the same-host guard, version
// handover) becomes reproducible on a laptop / in CI instead of needing two
// physical boxes and a live operator.
//
//   node dev/fleet.mjs up [N] [--slot S]       start an N-node fleet (default 2, slot 0)
//   node dev/fleet.mjs status [--slot S]       roles/epochs/pids/ports of every node
//   node dev/fleet.mjs kill-leader [--slot S]  UNCLEAN leader death (crash simulation)
//   node dev/fleet.mjs stepdown [--slot S]     graceful stepdown of the current leader
//   node dev/fleet.mjs down [--slot S]         kill everything, keep the slot dir for inspection
//
// Isolation (the same recipe the hermetic tests use, packaged):
//   - every node gets its own CC_DATA_DIR, CC_BUS_CONFIG, CC_CACHE_DIR under the slot dir;
//   - CC_PORT is per-node (8850 + slot*20 + i) so no probe ever reaches the real estate's
//     :8787 — discovery between nodes rides an explicit CC_PEERS list plus a per-fleet
//     scratch beacon port (never the estate's 8788);
//   - CC_HOST is per-node ("nodeN") so same-host logic behaves as if each were a machine —
//     pass hostOverrides / dataDirOverrides to deliberately collide them (the #35 guard);
//   - every CC_* / server variable an operator shell might export is blanked or pinned, so
//     an enrolled box can never leak its token, pin or peers into a fleet.
//
// TRUTH RULE for anything built on this: role/epoch are judged by /cc/whoami + pid liveness.
// supervisor.json is a 10s heartbeat — it lags a promotion and SURVIVES an unclean kill, so it
// is reported (status().supervisor) but must never be the sole evidence for an assertion.
//
// Importable: tests use `new Fleet({...})` directly; the CLI below is for humans.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BASE_PORT = 8850;
export const PORTS_PER_SLOT = 20;
export const MAX_NODES = 15;        // node i → base+i; base+16 is the slot's beacon port

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Kill a supervisor AND its server child. clean=true asks the supervisor to shut down
// (SIGTERM → its handler kills the child and removes supervisor.json); clean=false is a
// crash simulation — no shutdown handler may run. On Windows there are no signal handlers
// to run either way, so taskkill /T /F (tree, forced) is the only reliable form of both.
export function killTree(pid, { clean = false } = {}) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else if (clean) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  } else {
    spawnSync('pkill', ['-9', '-P', String(pid)], { stdio: 'ignore' });   // the server child first
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// The pid LISTENING on a TCP port, or null. Evidence for "no orphan server": a supervisor can be
// gone while its server child still holds the port + messages.db (the #37/Windows residual).
export function listenerPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = parseInt((lsof.stdout || '').trim().split(/\s+/)[0]);
    if (pid) return pid;
    const ss = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }).stdout || '';
    const m = ss.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

export class Fleet {
  // srcRoots: { i: '/path/to/another/checkout' } runs node i from a DIFFERENT copy of the repo
  //           (the version-handover scenarios run two package.json versions side by side).
  // dataDirOverrides / hostOverrides: deliberately collide nodes (the same-host #35 guard).
  constructor({ size = 2, slot = 0, dir = null, token = 'fleet-tt', hostOverrides = {}, dataDirOverrides = {},
    srcRoots = {}, replicateMs = 2000, extraEnv = {} } = {}) {
    if (size < 1 || size > MAX_NODES) throw new Error(`fleet size must be 1..${MAX_NODES}`);
    this.size = size;
    this.slot = slot;
    this.token = token;
    this.replicateMs = replicateMs;
    this.hostOverrides = hostOverrides;
    this.dataDirOverrides = dataDirOverrides;
    this.srcRoots = srcRoots;
    this.extraEnv = extraEnv;
    this.base = BASE_PORT + slot * PORTS_PER_SLOT;
    this.beaconPort = this.base + 16;
    // tmpdir, never the real home: a fleet must leave nothing behind in an operator's profile.
    this.dir = dir || join(tmpdir(), 'crosstalk-fleet', `slot-${slot}`);
    this.stateFile = join(this.dir, 'fleet.json');
    this.nodes = [];                              // { i, port, host, dir, dataDir, pid }
  }

  port(i) { return this.base + i; }
  baseUrl(i) { return `http://127.0.0.1:${this.port(i)}`; }
  nodeDir(i) { return join(this.dir, `node${i}`); }
  dataDir(i) { return this.dataDirOverrides[i] || join(this.nodeDir(i), 'data'); }
  hostOf(i) { return this.hostOverrides[i] || `node${i}`; }
  srcRoot(i) { return this.srcRoots[i] || REPO_ROOT; }
  dbPath(i) { return join(this.dataDir(i), 'messages.db'); }
  replicaPath(i) { return join(this.dataDir(i), 'messages.db.replica'); }
  logPath(i) { return join(this.nodeDir(i), 'node.log'); }
  log(i) { try { return readFileSync(this.logPath(i), 'utf8'); } catch { return ''; } }
  supervisor(i) { try { return JSON.parse(readFileSync(join(this.dataDir(i), 'supervisor.json'), 'utf8')); } catch { return null; } }

  // The env every fleet process runs under. Exposed so a test can spawn OTHER repo entrypoints
  // (cc-bus ensure, cc-join, a fake lane…) against node i with the identical isolation.
  nodeEnv(i) {
    const peers = [];
    for (let j = 0; j < this.size; j++) if (j !== i) peers.push(`127.0.0.1:${this.port(j)}`);
    return {
      ...process.env,
      // never inherit a pin/token/bind/epoch from the operator's shell — hermeticity is the point
      CC_BASE: '', CC_PIN: '', CC_ADMIN_KEY: '', CC_BIND: '', CC_ALLOW_FILE_ORIGIN: '', CC_VERSION_GATE_BYPASS: '',
      CC_EPOCH: '', PORT: '', MCP_API_KEY: '', CC_AUTO_SUPERVISOR: '',
      ...this.extraEnv,
      CC_BUS_CONFIG: join(this.nodeDir(i), 'bus-config'),
      CC_DATA_DIR: this.dataDir(i),
      CC_CACHE_DIR: join(this.nodeDir(i), 'cache'),
      CC_HOST: this.hostOf(i),
      CC_TOKEN: this.token,
      CC_PORT: String(this.port(i)),
      CC_BEACON_PORT: String(this.beaconPort),
      CC_PEERS: peers.join(','),
      CC_REPLICATE_MS: String(this.replicateMs),
    };
  }

  #prepareNode(i) {
    mkdirSync(this.dataDir(i), { recursive: true });
    mkdirSync(join(this.nodeDir(i), 'cache'), { recursive: true });
    const env = this.nodeEnv(i);
    // The config FILE mirrors the env so an entrypoint that reads only the file agrees.
    writeFileSync(env.CC_BUS_CONFIG, ['CC_TOKEN', 'CC_PORT', 'CC_BEACON_PORT', 'CC_PEERS'].map((k) => `${k}=${env[k]}`).join('\n') + '\n');
    return env;
  }

  startNode(i) {
    const env = this.#prepareNode(i);
    const logFd = openSync(this.logPath(i), 'a');
    const child = spawn(process.execPath, [join(this.srcRoot(i), 'src', 'cc-bus.mjs'), 'start'], {
      env, stdio: ['ignore', logFd, logFd], detached: false, windowsHide: true,
    });
    closeSync(logFd);   // the child holds its own handle; ours would pin node.log against destroy() on Windows
    child.unref();
    const node = { i, port: this.port(i), host: this.hostOf(i), dir: this.nodeDir(i), dataDir: this.dataDir(i), pid: child.pid };
    this.nodes[i] = node;
    this.#save();
    return node;
  }

  // UNCLEAN (default) or clean death of ONE node's supervisor tree.
  killNode(i, { clean = false } = {}) { killTree(this.nodes[i]?.pid, { clean }); }

  async whoami(i, timeoutMs = 1500) {
    try {
      const r = await fetch(this.baseUrl(i) + '/cc/whoami', { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  // EVERY node currently answering as leader (length > 1 ⇒ split brain, right now).
  async leaders() {
    const ws = await Promise.all(Array.from({ length: this.size }, (_, i) => this.whoami(i)));
    return ws.map((w, i) => (w && w.role === 'leader' ? { i, ...w } : null)).filter(Boolean);
  }
  // The single node answering as leader, or null when there is none OR more than one.
  async leader() {
    const ls = await this.leaders();
    return ls.length === 1 ? ls[0] : null;
  }

  async waitFor(predicate, timeoutMs = 30000, everyMs = 250) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await predicate();
      if (v) return v;
      await sleep(everyMs);
    }
    return null;
  }

  // Exactly one leader, held for `stableMs` (a leader that flaps inside the window does not count).
  async waitSingleLeader({ timeoutMs = 45000, stableMs = 0, minEpoch = 0, not = null } = {}) {
    let since = 0, key = null;
    return this.waitFor(async () => {
      const l = await this.leader();
      if (!l || l.epoch < minEpoch || l.i === not) { since = 0; key = null; return null; }
      const k = `${l.i}@${l.epoch}`;
      if (k !== key) { key = k; since = Date.now(); }   // a different leader/term restarts the window
      return Date.now() - since >= stableMs ? l : null;
    }, timeoutMs);
  }

  // A node is SETTLED when its supervisor process is alive and it is either serving as leader or
  // its heartbeat says client at a real term. ("starting@0" is NOT settled — it has not elected.)
  async settled(i) {
    if (!pidAlive(this.nodes[i]?.pid)) return false;
    const w = await this.whoami(i);
    if (w && w.role === 'leader') return true;
    const s = this.supervisor(i);
    return !!(s && s.pid === this.nodes[i].pid && s.role === 'client' && s.epoch > 0);
  }
  async waitSettled(timeoutMs = 45000) {
    return this.waitFor(async () => {
      for (let i = 0; i < this.size; i++) if (!(await this.settled(i))) return null;
      return true;
    }, timeoutMs);
  }

  // Default: node 0 first (it bootstraps the bus), then the rest join as clients — deterministic.
  // simultaneous: start them ALL at once — the cold-start election race (X1's one-box analogue).
  async up({ simultaneous = false, timeoutMs = 45000 } = {}) {
    mkdirSync(this.dir, { recursive: true });
    if (simultaneous) {
      for (let i = 0; i < this.size; i++) this.startNode(i);
    } else {
      this.startNode(0);
      const l0 = await this.waitFor(async () => { const w = await this.whoami(0); return w && w.role === 'leader' ? w : null; }, timeoutMs);
      if (!l0) throw new Error('node0 never became leader — see ' + this.logPath(0));
      for (let i = 1; i < this.size; i++) this.startNode(i);
    }
    if (!(await this.waitSettled(timeoutMs))) throw new Error('fleet did not settle — see ' + this.dir);
    const l = await this.waitSingleLeader({ timeoutMs });
    if (!l) throw new Error('fleet settled without exactly one leader — see ' + this.dir);
    return l;
  }

  async status() {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const w = await this.whoami(i);
      const sup = this.supervisor(i);
      const pid = this.nodes[i]?.pid;
      out.push({
        node: i, port: this.port(i), host: this.hostOf(i),
        pid: pid ? `${pid}${pidAlive(pid) ? '' : ' (dead)'}` : '-',
        serving: w ? `${w.role}@${w.epoch}` : '-',
        listener: listenerPid(this.port(i)) ?? '-',
        heartbeat: sup ? `${sup.role}@${sup.epoch} pid=${sup.pid} v=${sup.version || '?'}` : '-',
      });
    }
    return out;
  }

  pkgVersion(i = 0) {
    try { return JSON.parse(readFileSync(join(this.srcRoot(i), 'package.json'), 'utf8')).version; } catch { return ''; }
  }
  headers(version = this.pkgVersion()) { return { Authorization: 'Bearer ' + this.token, 'content-type': 'application/json', 'x-cc-version': version }; }

  async send(channel, content, { sender = 'fleet-harness', type = 'message' } = {}) {
    const l = await this.leader();
    if (!l) throw new Error('no single leader to send to');
    const r = await fetch(this.baseUrl(l.i) + '/api/messages', {
      method: 'POST', headers: this.headers(l.version),
      body: JSON.stringify({ channel, sender, content, message_type: type }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`send failed ${r.status}: ${JSON.stringify(j)}`);
    return j;
  }

  async messages(channel, limit = 50) {
    const l = await this.leader();
    if (!l) return [];
    const r = await fetch(this.baseUrl(l.i) + `/api/messages/${channel}?limit=${limit}`, { headers: this.headers(l.version) });
    return r.ok ? (await r.json()).messages || [] : [];
  }

  async killLeader({ clean = false } = {}) {
    const l = await this.leader();
    if (!l) return null;
    this.killNode(l.i, { clean });
    return l;
  }

  async stepdownLeader() {
    const l = await this.leader();
    if (!l) return null;
    await fetch(this.baseUrl(l.i) + '/cc/stepdown', { method: 'POST', headers: this.headers(l.version) }).catch(() => {});
    return l;
  }

  // Kill every supervisor tree, THEN sweep the ports: a supervisor that died uncleanly earlier may
  // have orphaned its server child (Windows: always, unless tree-killed), and that orphan would
  // outlive the fleet holding a port and a DB handle.
  async down() {
    for (const n of this.nodes) if (n) killTree(n.pid, { clean: false });
    for (let i = 0; i < this.size; i++) { const p = listenerPid(this.port(i)); if (p) killTree(p, { clean: false }); }
    await this.waitFor(() => { for (let i = 0; i < this.size; i++) if (listenerPid(this.port(i))) return null; return true; }, 10000);
    this.#save();
  }

  async destroy() {   // down + remove the slot dir (tests). Windows releases handles lazily → retry.
    await this.down();
    for (let k = 0; k < 20; k++) {
      try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
      if (!existsSync(this.dir)) return true;
      await sleep(250);
    }
    return false;
  }

  #save() {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ size: this.size, slot: this.slot, token: this.token, nodes: this.nodes.map((n) => n && { i: n.i, pid: n.pid, port: n.port, host: n.host }) }, null, 2));
    } catch {}
  }

  static load(slot = 0, dir = null) {
    const f = new Fleet({ slot, dir });
    try {
      const s = JSON.parse(readFileSync(f.stateFile, 'utf8'));
      f.size = s.size; f.token = s.token || f.token;
      f.nodes = (s.nodes || []).map((n) => n && { ...n, dir: f.nodeDir(n.i), dataDir: f.dataDir(n.i) });
    } catch {}
    return f;
  }
}

// File identity of a path — { ino, size, mtimeMs } — or null. `ino` is the evidence that a live DB
// was never replaced underneath its server (#35): same inode across replication cycles.
export function fileId(p) {
  try { const s = statSync(p, { bigint: true }); return { ino: String(s.ino), size: Number(s.size), mtimeMs: Number(s.mtimeMs) }; } catch { return null; }
}

// ---------------------------------------------------------------------------
// CLI — only when this file is the entrypoint. (An `argv[1].endsWith('fleet.mjs')` guard fires
// on IMPORT from any script that happens to be named *fleet.mjs, printing usage and exiting 0 —
// a silent false pass for that script.)
// ---------------------------------------------------------------------------
async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const si = args.indexOf('--slot');
  const slot = si >= 0 ? (parseInt(args[si + 1]) || 0) : 0;
  if (cmd === 'up') {
    const size = parseInt(args[1]) || 2;
    const f = new Fleet({ size, slot });
    const l = await f.up();
    console.log(`fleet slot ${slot}: ${size} nodes up, leader node${l.i} epoch ${l.epoch} @ ${f.baseUrl(l.i)} (dir ${f.dir})`);
    console.table(await f.status());
  } else if (cmd === 'status') {
    console.table(await Fleet.load(slot).status());
  } else if (cmd === 'kill-leader') {
    const l = await Fleet.load(slot).killLeader();
    console.log(l ? `killed node${l.i} (unclean) — watch a client promote with 'status' (the client failover tick is 15s)` : 'no single leader');
  } else if (cmd === 'stepdown') {
    const l = await Fleet.load(slot).stepdownLeader();
    console.log(l ? `stepdown requested on node${l.i}` : 'no single leader');
  } else if (cmd === 'down') {
    const f = Fleet.load(slot); await f.down(); console.log(`fleet slot ${slot} down (dir kept: ${f.dir})`);
  } else {
    console.log('usage: node dev/fleet.mjs <up [N]|status|kill-leader|stepdown|down> [--slot S]');
    process.exit(cmd ? 1 : 0);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
