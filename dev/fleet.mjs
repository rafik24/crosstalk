#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dev/fleet.mjs — fleet-in-a-box: N real cc-bus supervisors on ONE machine,
// fully isolated from the production estate. The generic dev harness this
// project was missing: every multi-node behaviour (election, failover,
// stepdown, replication, the same-host guard, version handover) becomes
// reproducible on a laptop / in CI instead of needing two physical boxes and
// a live operator.
//
//   node dev/fleet.mjs up [N] [--slot S]     start an N-node fleet (default 2, slot 0)
//   node dev/fleet.mjs status [--slot S]     roles/epochs/ports of every node
//   node dev/fleet.mjs kill-leader [--slot S]  UNCLEAN leader death (crash simulation)
//   node dev/fleet.mjs stepdown [--slot S]   graceful stepdown of the current leader
//   node dev/fleet.mjs down [--slot S]       kill everything, keep the slot dir for inspection
//
// Isolation (the same recipe the hermetic tests use, packaged):
//   - every node gets its own CC_DATA_DIR, CC_BUS_CONFIG, CC_CACHE_DIR under the slot dir;
//   - CC_PORT is per-node (base 8850 + slot*20 + i) so no probe ever reaches the real
//     estate's :8787 — discovery between nodes rides an explicit CC_PEERS list plus a
//     per-fleet scratch beacon port;
//   - CC_HOST is per-node ("nodeN") so same-host logic behaves as if each were a machine —
//     pass hostOverrides to deliberately collide hosts (the #35 same-host guard test).
//
// Importable: tests use `new Fleet({...})` directly; the CLI below is for humans.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, openSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CC_BUS = join(__dirname, '..', 'src', 'cc-bus.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kill a supervisor AND its server child. clean=true asks the supervisor to shut down
// (SIGTERM → its handler kills the child and removes supervisor.json); clean=false is a
// crash simulation — nothing may run shutdown handlers. On Windows taskkill /T /F is the
// only reliable tree kill either way (Stop-Process never runs signal handlers anyway).
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

export class Fleet {
  constructor({ size = 2, slot = 0, dir = null, token = 'fleet-tt', hostOverrides = {}, replicateMs = 2000 } = {}) {
    this.size = size;
    this.slot = slot;
    this.token = token;
    this.replicateMs = replicateMs;
    this.hostOverrides = hostOverrides;
    this.base = 8850 + slot * 20;                 // node i → port base+i (max 15 nodes/slot)
    this.beaconPort = this.base + 16;             // shared per fleet, never the estate's 8788
    this.dir = dir || join(homedir(), '.crosstalk-dev', `fleet-${slot}`);
    this.stateFile = join(this.dir, 'fleet.json');
    this.nodes = [];                              // { i, port, host, dir, pid }
  }

  port(i) { return this.base + i; }
  baseUrl(i) { return `http://127.0.0.1:${this.port(i)}`; }
  nodeDir(i) { return join(this.dir, `node${i}`); }

  #writeNodeConfig(i) {
    const peers = [];
    for (let j = 0; j < this.size; j++) if (j !== i) peers.push(`127.0.0.1:${this.port(j)}`);
    const cfg = join(this.nodeDir(i), 'bus-config');
    writeFileSync(cfg, [
      `CC_TOKEN=${this.token}`,
      `CC_PORT=${this.port(i)}`,
      `CC_BEACON_PORT=${this.beaconPort}`,
      `CC_PEERS=${peers.join(',')}`,
      '',
    ].join('\n'));
    return cfg;
  }

  async startNode(i) {
    const dir = this.nodeDir(i);
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'cache'), { recursive: true });
    const cfg = this.#writeNodeConfig(i);
    const host = this.hostOverrides[i] || `node${i}`;
    const logFd = openSync(join(dir, 'node.log'), 'a');
    const child = spawn(process.execPath, [CC_BUS, 'start'], {
      env: {
        ...process.env,
        CC_BUS_CONFIG: cfg,
        CC_DATA_DIR: join(dir, 'data'),
        CC_CACHE_DIR: join(dir, 'cache'),
        CC_HOST: host,
        CC_PORT: String(this.port(i)),
        CC_BEACON_PORT: String(this.beaconPort),
        CC_REPLICATE_MS: String(this.replicateMs),
        // never inherit a pin/token from the operator's shell — hermeticity is the point
        CC_BASE: '', CC_TOKEN: '', CC_ADMIN_KEY: '', CC_BIND: '',
      },
      stdio: ['ignore', logFd, logFd],
      detached: false,
      windowsHide: true,
    });
    const node = { i, port: this.port(i), host, dir, pid: child.pid };
    this.nodes[i] = node;
    this.#save();
    return node;
  }

  async whoami(i, timeoutMs = 1500) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.baseUrl(i) + '/cc/whoami', { signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  // The node currently answering as leader, or null.
  async leader() {
    for (let i = 0; i < this.size; i++) {
      const w = await this.whoami(i);
      if (w && w.role === 'leader') return { i, ...w };
    }
    return null;
  }

  async waitFor(predicate, timeoutMs = 30000, everyMs = 500) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await predicate();
      if (v) return v;
      await sleep(everyMs);
    }
    return null;
  }

  // Start node 0 first (it bootstraps the bus), then the rest as clients.
  async up() {
    mkdirSync(this.dir, { recursive: true });
    await this.startNode(0);
    const l = await this.waitFor(async () => { const w = await this.whoami(0); return w && w.role === 'leader' ? w : null; });
    if (!l) throw new Error('node0 never became leader — see ' + join(this.nodeDir(0), 'node.log'));
    for (let i = 1; i < this.size; i++) await this.startNode(i);
    return l;
  }

  async status() {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const w = await this.whoami(i);
      let sup = null;
      try { sup = JSON.parse(readFileSync(join(this.nodeDir(i), 'data', 'supervisor.json'), 'utf8')); } catch {}
      out.push({ node: i, port: this.port(i), host: this.nodes[i]?.host, serving: w ? `${w.role}@${w.epoch}` : '-', supervisor: sup ? `${sup.role}@${sup.epoch} pid=${sup.pid} v=${sup.version || '?'}` : '-' });
    }
    return out;
  }

  headers() { return { Authorization: 'Bearer ' + this.token, 'content-type': 'application/json', 'x-cc-version': this.pkgVersion() }; }
  pkgVersion() {
    try { return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version; } catch { return ''; }
  }

  async send(channel, content, { sender = 'fleet-harness', type = 'message' } = {}) {
    const l = await this.leader();
    if (!l) throw new Error('no leader to send to');
    const r = await fetch(this.baseUrl(l.i) + '/api/messages', {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ channel, sender, content, message_type: type }),
    });
    return r.json();
  }

  async messages(channel, limit = 20) {
    const l = await this.leader();
    if (!l) return [];
    const r = await fetch(this.baseUrl(l.i) + `/api/messages/${channel}?limit=${limit}`, { headers: this.headers() });
    return r.ok ? (await r.json()).messages || [] : [];
  }

  async killLeader({ clean = false } = {}) {
    const l = await this.leader();
    if (!l) return null;
    killTree(this.nodes[l.i].pid, { clean });
    return l.i;
  }

  async stepdownLeader() {
    const l = await this.leader();
    if (!l) return null;
    await fetch(this.baseUrl(l.i) + '/cc/stepdown', { method: 'POST', headers: this.headers() }).catch(() => {});
    return l.i;
  }

  down() {
    for (const n of this.nodes) if (n) killTree(n.pid, { clean: false });
    this.#save();
  }

  destroy() {   // down + remove the slot dir (tests)
    this.down();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }

  #save() {
    try { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.stateFile, JSON.stringify({ size: this.size, slot: this.slot, base: this.base, nodes: this.nodes.map((n) => n && { i: n.i, pid: n.pid, port: n.port, host: n.host }) }, null, 2)); } catch {}
  }

  static load(slot = 0) {
    const f = new Fleet({ slot });
    try {
      const s = JSON.parse(readFileSync(f.stateFile, 'utf8'));
      f.size = s.size; f.base = s.base; f.nodes = s.nodes || [];
    } catch {}
    return f;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/\/\//g, '//');
async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const slot = parseInt(args[args.indexOf('--slot') + 1]) || 0;
  if (cmd === 'up') {
    const size = parseInt(args[1]) || 2;
    const f = new Fleet({ size, slot });
    const l = await f.up();
    console.log(`fleet slot ${slot}: ${size} nodes up, leader node0 epoch ${l.epoch} @ ${f.baseUrl(0)} (dir ${f.dir})`);
    console.table(await f.waitFor(async () => { const s = await f.status(); return s.every((n) => n.supervisor !== '-') ? s : null; }, 15000) || await f.status());
  } else if (cmd === 'status') {
    const f = Fleet.load(slot); console.table(await f.status());
  } else if (cmd === 'kill-leader') {
    const f = Fleet.load(slot); const i = await f.killLeader(); console.log(i === null ? 'no leader' : `killed node${i} (unclean) — watch a client promote with 'status'`);
  } else if (cmd === 'stepdown') {
    const f = Fleet.load(slot); const i = await f.stepdownLeader(); console.log(i === null ? 'no leader' : `stepdown requested on node${i}`);
  } else if (cmd === 'down') {
    const f = Fleet.load(slot); f.down(); console.log(`fleet slot ${slot} down (dir kept: ${f.dir})`);
  } else {
    console.log('usage: node dev/fleet.mjs <up [N]|status|kill-leader|stepdown|down> [--slot S]');
    process.exit(cmd ? 1 : 0);
  }
}
if (process.argv[1] && process.argv[1].endsWith('fleet.mjs')) await cli();
