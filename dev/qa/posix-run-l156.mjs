#!/usr/bin/env node
// ---------------------------------------------------------------------------
// POSIX live evidence run for rafik24/crosstalk#42 — scenarios L1 (#34), L5 (#38/#32), L6 (#41/#36).
//
//   node run-l156.mjs <crosstalk-root> [--keep]
//
// <crosstalk-root> is the code under test (a plugin-cache install or a checkout). ISOLATION: a
// scratch HOME, scratch CC_DATA_DIR / CC_BUS_CONFIG / CC_CACHE_DIR, throwaway token + admin key,
// ports 8797 (node A) / 8796 (node B), beacon udp 8798. The production bus (8787 / udp 8788,
// ~/.crosstalk, ~/.claude/.crosstalk) is never read, written or contacted; the run records prod's
// /cc/whoami before and after as proof it did not move.
//
// Output: one JSON evidence line per check on stdout + a PASS/FAIL table; exit 1 on any FAIL.
// ---------------------------------------------------------------------------
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(process.argv[2] || '.');
const KEEP = process.argv.includes('--keep');
const PORT_A = 8797, PORT_B = 8796, BEACON = 8798, PROD = 'http://127.0.0.1:8787';
const TOKEN = 'qa-' + randomBytes(12).toString('hex');
const ADMIN = 'qa-admin-' + randomBytes(12).toString('hex');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const RUN = mkdtempSync(join(tmpdir(), 'ct-qa-l156-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const kids = [];

function record(id, name, pass, evidence) {
  results.push({ id, name, pass });
  console.log(JSON.stringify({ check: id, name, result: pass ? 'PASS' : 'FAIL', ...evidence }));
}
async function getJson(url, headers = {}, timeoutMs = 1500) {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); return { status: r.status, body: r.ok ? await r.json() : null }; }
  catch { return { status: 0, body: null }; }
}
const whoami = async (port) => (await getJson(`http://127.0.0.1:${port}/cc/whoami`)).body;
async function waitFor(fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(everyMs); }
  return null;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childrenOf = (pid) => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': VERSION };

function nodeEnv(name, port, peerPort) {
  const dir = join(RUN, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const cfg = join(dir, 'bus-config');
  writeFileSync(cfg, [`CC_TOKEN=${TOKEN}`, `CC_ADMIN_KEY=${ADMIN}`, `CC_PORT=${port}`, `CC_BEACON_PORT=${BEACON}`, `CC_PEERS=127.0.0.1:${peerPort}`, ''].join('\n'), { mode: 0o600 });
  return {
    dir, cfg,
    env: { PATH: process.env.PATH, HOME: join(dir, 'home'), CC_BUS_CONFIG: cfg, CC_DATA_DIR: join(dir, 'data'), CC_CACHE_DIR: join(dir, 'cache'),
      CC_HOST: name, CC_PORT: String(port), CC_BEACON_PORT: String(BEACON), CC_REPLICATE_MS: '2000' },
  };
}
function startSupervisor(n) {
  const fd = openSync(join(n.dir, 'stdio.log'), 'a');
  const c = spawn(process.execPath, [join(ROOT, 'src', 'cc-bus.mjs'), 'start'], { env: n.env, stdio: ['ignore', fd, fd] });
  kids.push(c); n.pid = c.pid; return c;
}
// `ensure` is how the SessionStart hook starts the bus: detached supervisor, stdio → <data>/cc-bus.log (#36).
function ensureSupervisor(n) {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cc-bus.mjs'), 'ensure'], { env: n.env, encoding: 'utf8', timeout: 20000 });
  try { n.pid = JSON.parse(readFileSync(join(n.dir, 'data', 'supervisor.json'), 'utf8')).pid; } catch {}
  if (n.pid) kids.push({ pid: n.pid });
  return (r.stdout || '') + (r.stderr || '');
}
function cleanup() {
  for (const c of kids) { for (const k of childrenOf(c.pid)) { try { process.kill(k, 'SIGKILL'); } catch {} } try { process.kill(c.pid, 'SIGKILL'); } catch {} }
}

const prodBefore = await whoami(8787);
let rc = 0;
try {
  // ---- L5a (#38): fresh HOME, no config → one-line enrol hint, exit 0 --------------------
  {
    const home = join(RUN, 'l5a-home'); mkdirSync(home, { recursive: true });
    const r = spawnSync('bash', [join(ROOT, 'src', 'cc-join.sh')], { env: { PATH: process.env.PATH, HOME: home }, input: JSON.stringify({ session_id: 'qa-l5a' }), encoding: 'utf8', cwd: ROOT, timeout: 20000 });
    const out = (r.stdout || '').trim();
    record('L5a', 'fresh HOME → enrol hint (#38)', r.status === 0 && /not enrolled/.test(out) && out.split('\n').length === 1, { exit: r.status, stdout: out.replace(home, '<scratch-home>') });
  }

  // ---- boot the isolated 2-node bus ------------------------------------------------------
  const A = nodeEnv('qa-node-a', PORT_A, PORT_B), B = nodeEnv('qa-node-b', PORT_B, PORT_A);
  startSupervisor(A);
  const la = await waitFor(async () => { const w = await whoami(PORT_A); return w?.role === 'leader' ? w : null; }, 30000);
  if (!la) throw new Error('node A never became leader — see ' + join(A.dir, 'stdio.log'));
  // pre-seed an oversized log so the ensure-spawn rotation (~1 MB cap) is observable
  writeFileSync(join(B.dir, 'data', 'cc-bus.log'), 'x'.repeat(1024 * 1024 + 10) + '\n');
  const ensureOut = ensureSupervisor(B);
  const supB = () => { try { return JSON.parse(readFileSync(join(B.dir, 'data', 'supervisor.json'), 'utf8')); } catch { return null; } };
  const supA = () => { try { return JSON.parse(readFileSync(join(A.dir, 'data', 'supervisor.json'), 'utf8')); } catch { return null; } };
  const bc = await waitFor(() => (supB()?.role === 'client' ? supB() : null), 30000);
  console.log(JSON.stringify({ setup: 'bus up', version: VERSION, A: `leader@${la.epoch} sup=${A.pid}`, B: bc ? `client@${bc.epoch} sup=${B.pid}` : 'NOT CLIENT', run_dir: RUN }));
  if (!bc) throw new Error('node B never became client');

  // ---- L6 (#41/#36): console + openapi from the install path; log has role lines ---------
  {
    const dotSeg = ROOT.split('/').some((s) => s.startsWith('.') && s.length > 1);
    const c = await fetch(`http://127.0.0.1:${PORT_A}/console`); const cb = await c.text();
    const o = await fetch(`http://127.0.0.1:${PORT_A}/openapi.json`); const ob = await o.text();
    record('L6a', '/console + /openapi.json 200 (#41)', c.status === 200 && /<html/i.test(cb) && o.status === 200 && ob.trim().startsWith('{'),
      { console: c.status, console_bytes: cb.length, openapi: o.status, openapi_bytes: ob.length, root_has_dot_segment: dotSeg });
    const logPath = join(B.dir, 'data', 'cc-bus.log');
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const roleLines = log.split('\n').filter((l) => /LEADER|CLIENT|epoch/.test(l));
    const rotated = existsSync(logPath + '.old') && statSync(logPath + '.old').size > 1024 * 1024;
    record('L6b', 'ensure-started supervisor logs role lines to cc-bus.log; >1 MB log rotated at spawn (#36)', roleLines.length > 0 && rotated && log.length < 1024 * 1024,
      { ensure_stdout: ensureOut.trim().split('\n').slice(-1)[0], log_bytes: log.length, rotated_old_bytes: rotated ? statSync(logPath + '.old').size : 0, role_lines: roleLines.length, sample: roleLines.slice(0, 2) });
  }

  // ---- L5b (#32): enrolled + git cwd → advertised rev is NOT the cwd SHA -----------------
  {
    const home = join(RUN, 'l5b-home'); mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.crosstalk'), readFileSync(A.cfg, 'utf8').replace(/^CC_PEERS=.*$/m, `CC_BASE=http://127.0.0.1:${PORT_A}`), { mode: 0o600 });
    const repo = join(RUN, 'l5b-repo'); mkdirSync(repo);
    const g = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.invalid' } }).trim();
    g(['init', '-q', '-b', 'l5b-branch']); writeFileSync(join(repo, 'f'), 'x'); g(['add', 'f']); g(['commit', '-q', '-m', 'x']);
    const cwdSha = g(['rev-parse', '--short', 'HEAD']);
    const r = spawnSync('bash', [join(ROOT, 'src', 'cc-join.sh')], { env: { PATH: process.env.PATH, HOME: home, CC_CACHE_DIR: join(RUN, 'l5b-cache') }, input: JSON.stringify({ session_id: 'qa-l5b-0000' }), encoding: 'utf8', cwd: repo, timeout: 30000 });
    const inst = (await getJson(`http://127.0.0.1:${PORT_A}/api/instances`, H)).body;
    const mine = (inst?.instances || inst || []).find((i) => /l5b-branch/.test(i.instance_id));
    let codeSha = ''; try { codeSha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    record('L5b', 'advertised rev ≠ cwd SHA (#32)', !!mine && mine.rev !== cwdSha && !String(mine.rev || '').startsWith(cwdSha),
      { exit: r.status, registered_as: mine?.instance_id || null, advertised_rev: mine?.rev ?? null, cwd_sha: cwdSha, code_under_test_sha: codeSha || '(not a checkout)' });
  }

  // ---- L1 (#34): stepdown with a LIVE WS client → server exits <5 s, A → CLIENT, no orphan
  {
    const serverPidsBefore = childrenOf(A.pid);
    let wsOpen = false, wsClosedAt = 0, wsCloseCode = null;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT_A}/cc/ws?identity=${encodeURIComponent('qa/l1-ws-client')}&v=${VERSION}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    ws.addEventListener('open', () => { wsOpen = true; });
    ws.addEventListener('close', (e) => { wsClosedAt = Date.now(); wsCloseCode = e.code; });
    ws.addEventListener('error', () => {});
    await waitFor(() => wsOpen, 5000, 50);
    const sent = await (await fetch(`http://127.0.0.1:${PORT_A}/api/messages`, { method: 'POST', headers: H, body: JSON.stringify({ channel: 'qa-l1', sender: 'qa/l1', content: 'pre-stepdown ' + Date.now(), message_type: 'message' }) })).json();
    // REPL: how long until B's replica is refreshed AFTER the send? Configured CC_REPLICATE_MS=2000.
    const replica = join(B.dir, 'data', 'messages.db.replica');
    const sentAt = Date.now();
    const refreshed = await waitFor(() => { try { return statSync(replica).mtimeMs > sentAt ? statSync(replica) : null; } catch { return null; } }, 40000, 100);
    const lagMs = refreshed ? Math.round(refreshed.mtimeMs - sentAt) : null;
    record('REPL', 'client honours CC_REPLICATE_MS=2000 (replica refreshed ≤ 2×interval+1 s after a write)', lagMs !== null && lagMs <= 5000,
      { configured_ms: 2000, replica_refreshed_after_ms: lagMs, note: 'runClient() ticks on a fixed setInterval(…, 15000), so any CC_REPLICATE_MS < 15000 is ineffective while the log claims "every 2s"' });
    const t0 = Date.now();
    const sd = await fetch(`http://127.0.0.1:${PORT_A}/cc/stepdown`, { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN } });
    const gone = await waitFor(() => serverPidsBefore.every((p) => !alive(p)), 12000, 50);
    const exitMs = gone ? Date.now() - t0 : null;
    const newLeader = await waitFor(async () => { const w = await whoami(PORT_B); return w?.role === 'leader' ? w : null; }, 45000);
    const aClient = await waitFor(() => (supA()?.role === 'client' ? supA() : null), 45000);
    await sleep(3000);                                               // settle, then count leaders
    const wa = await whoami(PORT_A), wb = await whoami(PORT_B);
    const leaders = [wa, wb].filter((w) => w?.role === 'leader').length;
    const orphans = serverPidsBefore.filter(alive);
    const msgs = newLeader ? (await getJson(`http://127.0.0.1:${PORT_B}/api/messages/qa-l1?limit=10`, H)).body?.messages || [] : [];
    record('L1', 'stepdown w/ live WS → exit <5 s, A→CLIENT, no orphan (#34)',
      wsOpen && sd.status === 200 && exitMs !== null && exitMs < 5000 && alive(A.pid) && !!aClient && leaders === 1 && orphans.length === 0,
      { ws_attached: wsOpen, stepdown_http: sd.status, server_pids: serverPidsBefore, server_exit_ms: exitMs, ws_close_code: wsCloseCode, ws_closed_after_ms: wsClosedAt ? wsClosedAt - t0 : null,
        supervisor_A: { pid: A.pid, alive: alive(A.pid), role: supA()?.role, epoch: supA()?.epoch }, serving_A: wa ? `${wa.role}@${wa.epoch}` : '-', serving_B: wb ? `${wb.role}@${wb.epoch}` : '-',
        leaders, orphans, epoch_before: la.epoch, epoch_after: newLeader?.epoch ?? null, pre_stepdown_msg_id: sent.id, present_on_new_leader: msgs.some((m) => m.id === sent.id) });
    try { ws.close(); } catch {}
  }
} catch (e) {
  console.log(JSON.stringify({ error: e.message })); rc = 1;
} finally {
  cleanup();
}
const prodAfter = await whoami(8787);
const prodSame = JSON.stringify([prodBefore?.role, prodBefore?.epoch, prodBefore?.host]) === JSON.stringify([prodAfter?.role, prodAfter?.epoch, prodAfter?.host]);
record('ISO', 'production bus untouched', prodSame, { before: prodBefore && `${prodBefore.role}@${prodBefore.epoch}`, after: prodAfter && `${prodAfter.role}@${prodAfter.epoch}`, watermark_delta: (prodAfter?.watermark ?? 0) - (prodBefore?.watermark ?? 0) });
await sleep(500);
const supLeft = kids.map((c) => c.pid).filter(alive);
const stillServing = [await whoami(PORT_A), await whoami(PORT_B)].filter(Boolean).length;
record('CLEAN', 'no leftover processes / listeners', supLeft.length === 0 && stillServing === 0, { supervisors_alive: supLeft, ports_still_serving: stillServing });
console.table(results);
if (!KEEP) { try { rmSync(RUN, { recursive: true, force: true }); } catch {} } else console.log('kept: ' + RUN);
process.exit(rc || (results.every((r) => r.pass) ? 0 : 1));
