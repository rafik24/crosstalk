#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dev/fake-lane.mjs — a scripted bus participant: everything a real agent session does on the
// bus (register, hold the WebSocket, receive addressed messages, send / ack / done, work-board
// calls) with NO model and NO human behind it. Multi-agent turn-play (dispatch → affinity →
// claim → handoff → ack → done) becomes a deterministic test instead of "launch three sessions
// and watch".
//
// A lane is a REAL CHILD PROCESS running the REAL receive engine (src/cc-receive.mjs — the same
// one cc-ws and the Codex bridge use), so discovery, cursor backfill, WS push, re-discovery after
// a failover and the version gate are all exercised exactly as in a live session. The parent
// drives it over NDJSON on stdio — a transport, not a framework, so ANY driver (a test, a
// scenario script, a model-backed agent loop in another language) can sit on it:
//
//   parent → child (stdin, one JSON per line)
//     { id, op: 'send', channel, content, type? }      post a message (channel 'all' → general)
//     { id, op: 'ack',  channel, note }                the cc-ack contract: response "ACK — …"
//     { id, op: 'done', channel, content }             type=done
//     { id, op: 'rest', method, path, body? }          any /api call as this lane (work board…)
//     { id, op: 'stop' }
//   child → parent (stdout, one JSON per line)
//     { ev: 'ready', identity, base }                  receiver started (registered + listening)
//     { ev: 'msg', msg, addressed, handoff, rendered } one per message the engine delivers
//     { ev: 'result', id, ok, status, body }           reply to a command
//     { ev: 'log', line }                              engine lifecycle (leader changes, push up/down)
//     { ev: 'gate', text, info }                       the bus refused this lane's version (426)
//
// Isolation: spawn it with Fleet.nodeEnv(i) (or any hermetic env) — FakeLane also redirects
// HOME/USERPROFILE so the liveness beacon lands in the scratch dir, never the real ~/.claude.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ===========================================================================
// Parent side
// ===========================================================================
export class FakeLane {
  // env: a hermetic env (Fleet.nodeEnv(i)). home: scratch dir that becomes HOME for the child.
  // srcRoot: run the lane from ANOTHER checkout (a lane on a different release → version gate).
  constructor(identity, { env, home, firehose = false, fromStart = false, srcRoot = null } = {}) {
    if (!identity || !env || !home) throw new Error('FakeLane: identity, env and home are required');
    this.identity = identity;
    this.inbox = [];          // every delivered message event, in order
    this.logs = [];
    this.gate = null;
    this.base = null;
    this.exit = null;         // { code, signal } once the child is gone
    this.#seq = 0;
    mkdirSync(home, { recursive: true });
    const args = [SELF, '--child', identity];
    if (firehose) args.push('--all');
    if (fromStart) args.push('--from-start');
    if (srcRoot) args.push('--src-root', srcRoot);
    this.child = spawn(process.execPath, args, {
      env: { ...env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; this.#wake(); });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.ev === 'msg') this.inbox.push(e);
      else if (e.ev === 'log') this.logs.push(e.line);
      else if (e.ev === 'ready') this.base = e.base;
      else if (e.ev === 'gate') this.gate = e;
      else if (e.ev === 'result') { const p = this.#pending.get(e.id); if (p) { this.#pending.delete(e.id); p(e); } }
      this.#wake();
    });
  }
  #seq; #pending = new Map(); #waiters = new Set();
  #wake() { for (const w of [...this.#waiters]) w(); }

  // Resolve with predicate()'s first truthy value, re-checked on every event; null on timeout.
  until(predicate, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const check = () => { const v = predicate(); if (v) { cleanup(); resolve(v); } };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.#waiters.delete(check); };
      this.#waiters.add(check);
      check();
    });
  }
  ready(timeoutMs = 20000) { return this.until(() => this.base || this.gate || this.exit, timeoutMs).then(() => !!this.base); }
  // First inbox message matching `match` (a predicate over the raw bus message), or null.
  waitMsg(match, timeoutMs = 15000) { return this.until(() => this.inbox.find((e) => match(e.msg, e)) || null, timeoutMs); }

  #cmd(op, fields = {}, timeoutMs = 15000) {
    const id = ++this.#seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#pending.delete(id); resolve({ ok: false, status: 0, body: { error: 'fake-lane command timeout' } }); }, timeoutMs);
      this.#pending.set(id, (e) => { clearTimeout(timer); resolve(e); });
      try { this.child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n'); } catch { clearTimeout(timer); this.#pending.delete(id); resolve({ ok: false, status: 0, body: { error: 'lane is gone' } }); }
    });
  }
  send(channel, content, type = 'message') { return this.#cmd('send', { channel, content, type }); }
  ack(channel, note) { return this.#cmd('ack', { channel, note }); }
  done(channel, content) { return this.#cmd('done', { channel, content }); }
  rest(method, path, body) { return this.#cmd('rest', { method, path, body }); }

  async stop() {
    if (this.exit) return;
    this.#cmd('stop', {}, 2000).catch(() => {});
    if (!(await this.until(() => this.exit, 3000))) { try { this.child.kill('SIGKILL'); } catch {} await this.until(() => this.exit, 3000); }
  }
}

// ===========================================================================
// Child side
// ===========================================================================
async function child(argv) {
  const identity = argv[0];
  const flag = (n) => argv.includes(n);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const src = join(opt('--src-root') || join(__dirname, '..'), 'src');
  const imp = (f) => import(pathToFileURL(join(src, f)).href);
  const { createReceiver } = await imp('cc-receive.mjs');
  const { resolveFast, loadConfig } = await imp('cc-discover.mjs');
  const { pkgVersion } = await imp('cc-rev.mjs');

  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const cfg = loadConfig();
  const H = { Authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

  const rx = createReceiver({
    instance: identity, token: cfg.token, pin: cfg.pin,
    firehose: flag('--all'), fromStart: flag('--from-start'), desc: 'fake-lane',
    emit: (rendered, msg) => out({ ev: 'msg', msg, rendered, addressed: / »(TO YOU|HANDOFF|@ALL)/.test(rendered), handoff: rendered.includes('»HANDOFF — ACK REQUIRED«') }),
    log: (line) => out({ ev: 'log', line }),
    onVersionGate: (text, info) => { out({ ev: 'gate', text, info }); setTimeout(() => process.exit(3), 50); },
  });

  // Commands resolve the leader per call, exactly as cc-send / cc-ack do — so a lane keeps
  // working across a failover without being told the new address.
  async function api(method, path, body) {
    const leader = await resolveFast({ pin: cfg.pin, token: cfg.token });
    if (!leader) return { ok: false, status: 0, body: { error: 'no bus leader found' } };
    const r = await fetch(leader.base + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed = null; try { parsed = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body: parsed };
  }
  const post = (channel, content, message_type) =>
    api('POST', '/api/messages', { channel: channel === 'all' ? 'general' : channel, sender: identity, content, message_type });

  createInterface({ input: process.stdin }).on('line', async (line) => {
    let c; try { c = JSON.parse(line); } catch { return; }
    let res;
    try {
      if (c.op === 'send') res = await post(c.channel, c.content, c.type || 'message');
      else if (c.op === 'ack') res = await post(c.channel, `ACK — ${c.note} · taken into lane ${identity}`, 'response');
      else if (c.op === 'done') res = await post(c.channel, c.content, 'done');
      else if (c.op === 'rest') res = await api(c.method || 'GET', c.path, c.body);
      else if (c.op === 'stop') { out({ ev: 'result', id: c.id, ok: true, status: 0, body: null }); rx.stop(); setTimeout(() => process.exit(0), 50); return; }
      else res = { ok: false, status: 0, body: { error: 'unknown op ' + c.op } };
    } catch (e) { res = { ok: false, status: 0, body: { error: String(e && e.message || e) } }; }
    out({ ev: 'result', id: c.id, ...res });
  });
  process.stdin.on('end', () => { rx.stop(); process.exit(0); });   // parent died → never linger

  await rx.start();
  if (rx.base) out({ ev: 'ready', identity, base: rx.base });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child' && argv[1]) await child(argv.slice(1));
  else { console.log('dev/fake-lane.mjs is driven by a parent (see FakeLane in this file); usage: --child <identity> [--all] [--from-start] [--src-root DIR]'); process.exit(argv.length ? 1 : 0); }
}
