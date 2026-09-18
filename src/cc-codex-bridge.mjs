#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-codex-bridge.mjs — the Codex CLI equivalent of `Monitor(cc-ws)`.
//
// A Codex session has no Monitor tool, but Codex ≥0.154 has `codex queue --thread <id>
// --message <text>`, which starts a new turn IMMEDIATELY on an idle loaded session (FIFO if a
// turn is running). So this long-lived bridge — one per Codex session, spawned detached by
// codex-join.sh — runs the shared receive engine (cc-receive.mjs: discovery, presence + the
// liveness beacon, cursors, backfill, WS push + poll fallback, version gate) with the sink
//   emit = spawn(codex, ['queue', '--thread', <session_id>, '--message', <rendered line>])
//
// The sink is a SUBPROCESS and can fail or hang. A failed/timed-out emit keeps the message on the
// engine's direct retry queue (bounded attempts, then PARKED with a log line) — the cursor is never
// rolled back, so nothing is duplicated or flooded (reviewer, 2026-09-17).
//
// Lifetime: tied to the Codex process WHEN IT CAN BE FOUND. `ensure` (run by the join hook, so
// its own parent chain is bash → codex) walks the OS process tree up to the first `codex` image
// and passes it as --parent; the bridge exits when that pid is gone (backstop for a Codex that
// dies without SessionEnd — no ghost peer registering every 20 s and queueing into a dead thread).
// Done here, in node, because under Git Bash `$PPID`/`$$` are MSYS pids, not Windows pids
// (reviewer, 2026-09-17). If no codex is found the watch stays off and the lifetime is
// SessionEnd → `stop` only; `ensure` prints which.
//
//   node cc-codex-bridge.mjs run    <instance_id> --session <sid> [--parent <pid>] [--base URL] [--token TOK] [--channel ch] [--all] [--from-start]
//   node cc-codex-bridge.mjs ensure <instance_id> --session <sid> [--parent <pid>|none]   # idempotent detached spawn; resolves --parent itself
//   node cc-codex-bridge.mjs stop   --session <sid>                                       # from the SessionEnd hook
//   env: CODEX_BIN (default `codex`; a *.mjs/*.js path is run with node — used by tests),
//        CC_RETRY_MS, CC_RETRY_MAX_ATTEMPTS, CC_PARENT_CHECK_MS, CC_QUEUE_TIMEOUT_MS
//
// Files (next to the beacon the listen-gate reads): ~/.claude/.cc-listen/<sid>.bridge.pid + .bridge.log
// Zero deps.
// ---------------------------------------------------------------------------
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './cc-discover.mjs';
import { createReceiver, LIVE_DIR, beaconPath } from './cc-receive.mjs';

const PARENT_CHECK_MS = Number(process.env.CC_PARENT_CHECK_MS || 20000);
const QUEUE_TIMEOUT_MS = Number(process.env.CC_QUEUE_TIMEOUT_MS || 30000);
const REPLACE_WAIT_MS = Number(process.env.CC_REPLACE_WAIT_MS || 3000);   // #27: bounded wait for a stale bridge to die before replacing it
// The exact CLI image only: `codex` / `codex.exe`. A substring match also hit the helper images
// present on a dev box (codex-code-mode-host.exe, codex-computer-use-swift.exe) — if one of those
// ever ran the hook, the bridge would follow the helper's lifetime (reviewer, 2026-09-17).
const CODEX_IMAGE = /^codex(\.exe)?$/i;

export function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// #27: poll a pid until it exits or the timeout elapses. Returns true iff it is gone. Cross-platform
// (process.kill(pid,0) is the liveness probe pidAlive already uses); bounded so a wedged process can
// never block the caller forever. Exported for the unit test.
export async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return !pidAlive(pid);
}
function fresh(file, ms) { try { return (Date.now() - statSync(file).mtimeMs) < ms; } catch { return false; } }

// --- find the codex process above us -------------------------------------------------------
// `chain(pid)` → { pid, ppid, name } | null. Exported pure walker + platform readers so the walk
// is unit-testable with a fake chain and the readers are one function each.
// 12 hops: the real Windows chain is ensure-node ← bash ← bash ← bash ← bash ← node ← pwsh ← codex
// (Codex runs hooks via pwsh; the join script's $(…) + node one-liner add bash layers) — a 6-hop
// limit stopped one short and left the watch off (seen live 2026-09-17).
export function findCodexInChain(startPid, chain, maxHops = 12) {
  let pid = startPid;
  for (let i = 0; i < maxHops && pid && pid > 1; i++) {
    const p = chain(pid);
    if (!p) return null;
    if (CODEX_IMAGE.test(p.name || '')) return p.pid;
    pid = p.ppid;
  }
  return null;
}
export function readChainWindows(startPid = process.ppid) {
  // One PowerShell call returns the whole ancestry as `pid|ppid|name` lines (avoids N round-trips).
  // Passed as -EncodedCommand: a -Command string goes through Windows argv re-quoting, which
  // stripped the inner quotes and made the CIM filter a syntax error → empty chain → watch off.
  const script = `$p=${Number(startPid)}; for($i=0;$i -lt 14 -and $p -gt 0;$i++){ $w=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p) -ErrorAction SilentlyContinue; if(-not $w){break}; Write-Output ('{0}|{1}|{2}' -f $w.ProcessId,$w.ParentProcessId,$w.Name); $p=[int]$w.ParentProcessId }`;
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const map = new Map();
  for (const line of out.split(/\r?\n/)) { const [pid, ppid, name] = line.split('|'); if (pid) map.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), name: name || '' }); }
  return (pid) => map.get(pid) || null;
}
function readChainPosix() {
  return (pid) => {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!out) return null;
      const m = out.match(/^\s*(\d+)\s+(.*)$/);
      return m ? { pid, ppid: Number(m[1]), name: m[2] } : null;
    } catch { return null; }
  };
}
export function resolveCodexParent() {
  try {
    const chain = process.platform === 'win32' ? readChainWindows() : readChainPosix();
    const found = findCodexInChain(process.ppid, chain);
    if (found) return { pid: found, seen: '' };
    // Not found: report what WAS above us, so a mis-walk is diagnosable from the join line.
    const seen = []; let p = process.ppid;
    for (let i = 0; i < 14 && p && p > 1; i++) { const r = chain(p); if (!r) { seen.push(`${p}:?`); break; } seen.push(`${r.pid}:${r.name}`); p = r.ppid; }
    return { pid: null, seen: seen.join(' ← ') };
  } catch (e) { return { pid: null, seen: `walk failed: ${e.message}` }; }
}

// --- the sink: codex queue ---------------------------------------------------------------
// CODEX_BIN may be a *.mjs/*.js file (run under this node) so tests can substitute a shim
// without a shell. Windows: `codex` resolves to codex.exe on PATH; a .cmd shim needs a shell —
// point CODEX_BIN at the .exe (Codex's own config knows it as CODEX_CLI_PATH) if spawn ENOENTs.
function codexCommand(extra) {
  const bin = process.env.CODEX_BIN || 'codex';
  if (/\.(mjs|cjs|js)$/i.test(bin)) return [process.execPath, [bin, ...extra]];
  return [bin, extra];
}
function queueIntoCodex(sid, line) {
  return new Promise((resolvePromise, reject) => {
    // One argv element, no shell: bus text can never become a command. Always starts "CHAT #".
    const [file, a] = codexCommand(['queue', '--thread', sid, '--message', line]);
    let child;
    try { child = spawn(file, a, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
    catch (e) { return reject(e); }
    let err = '', done = false;
    // A hung `codex queue` would leave this promise pending forever — the engine would never see a
    // rejection, so the message would be lost and children would pile up. Bound it: kill + reject
    // (the engine then retries from its queue).
    const timer = setTimeout(() => { if (done) return; done = true; try { child.kill(); } catch {} reject(new Error(`codex queue timed out after ${QUEUE_TIMEOUT_MS}ms`)); }, QUEUE_TIMEOUT_MS);
    timer.unref?.();
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { if (done) return; done = true; clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(`codex queue exit ${code}${err ? ': ' + err.trim().slice(0, 200) : ''}`)); });
  });
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  // Session ids are UUIDs; anything else is sanitised before it becomes a file name.
  const SID = String(opt('--session', '')).replace(/[^A-Za-z0-9._-]/g, '_');
  const usage = () => { console.error('usage: cc-codex-bridge.mjs run|ensure <instance_id> --session <sid> [--parent <pid>|none] | stop --session <sid>'); process.exit(2); };
  if (!cmd || !SID) usage();
  const pidFile = join(LIVE_DIR, `${SID}.bridge.pid`);
  const logFile = join(LIVE_DIR, `${SID}.bridge.log`);
  const readPid = () => { try { return Number(readFileSync(pidFile, 'utf8').trim()); } catch { return 0; } };

  async function run() {
    const instance = args[1];
    if (!instance || instance.startsWith('--')) usage();
    const PARENT = Number(opt('--parent', 0)) || 0;
    const cfg = loadConfig();
    const ONLY = opt('--channel', null);
    try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(pidFile, String(process.pid)); } catch {}
    // #26: serialize the codex-queue sink. cc-receive's deliver() fires emit() per message as it
    // arrives; for the stdout sink (cc-ws) that is instant + ordered, but `codex queue` is a
    // subprocess, so a burst — a reconnect backfill replaying a gap, or rapid DMs — would spawn N at
    // once: unordered into the Codex thread and a process spike. Chain them FIFO, at most one in
    // flight, exactly like cc-ws.mjs's emitChain. The engine's retry queue needs THIS message's real
    // outcome, so the caller gets the true promise while the chain tail swallows failures (a failed
    // emit must not stall the order for the next message — the retry queue re-drives the failed one).
    let emitTail = Promise.resolve();
    const emit = (rendered) => {
      const running = emitTail.then(() => queueIntoCodex(SID, rendered), () => queueIntoCodex(SID, rendered));
      emitTail = running.catch(() => {});
      return running;
    };
    const rx = createReceiver({
      instance,
      emit,
      pin: opt('--base', process.env.CC_BASE) || cfg.pin,
      token: opt('--token', process.env.CC_TOKEN) || cfg.token,
      only: ONLY,
      firehose: args.includes('--all') || ONLY !== null,
      fromStart: args.includes('--from-start'),
      desc: process.env.CC_DESC || 'codex',
      // Version gate (terminal, fires once): tell the Codex session, then exit like cc-ws.
      onVersionGate: (text) => { queueIntoCodex(SID, text.trim()).catch(() => {}).finally(() => process.exit(1)); },
    });
    const bye = (why) => { console.error(`[bridge exiting: ${why}]`); rx.stop(); try { if (readPid() === process.pid) rmSync(pidFile, { force: true }); } catch {} process.exit(0); };
    process.on('SIGTERM', () => bye('SIGTERM')); process.on('SIGINT', () => bye('SIGINT'));
    if (PARENT) {
      // Two consecutive misses (not one) so a momentary EPERM/ESRCH glitch can't kill a healthy bridge.
      let misses = 0;
      setInterval(() => { misses = pidAlive(PARENT) ? 0 : misses + 1; if (misses >= 2) bye(`codex parent pid ${PARENT} is gone`); }, PARENT_CHECK_MS).unref?.();
      console.error(`[parent watch: codex pid ${PARENT}, every ${PARENT_CHECK_MS}ms]`);
    } else {
      console.error('[parent watch: off — lifetime is SessionEnd → stop only]');
    }
    await rx.start();
  }

  async function ensure() {
    const instance = args[1];
    if (!instance || instance.startsWith('--')) usage();
    // "Already running" needs BOTH a live pid AND a recent sign of life (a fresh beacon, or a pid
    // file written in the last 30 s for a bridge still starting up). A live pid with a STALE
    // beacon (sleep/resume, or a wedged bridge) is killed before respawning — a second bridge on
    // the same session would queue every DM twice.
    const live = readPid();
    if (live && pidAlive(live)) {
      if (fresh(beaconPath(instance), 60000) || fresh(pidFile, 30000)) { console.log(`bridge already running for session ${SID} (pid ${live})`); return; }
      try { process.kill(live, 'SIGTERM'); } catch {}
      // #27: AWAIT the old bridge's death before spawning the replacement. Between the SIGTERM and the
      // old bridge actually closing its WebSocket, a push can still land and be queued — so without
      // this wait a DM that arrives in that window is DOUBLE-queued (old bridge + new bridge). Bounded:
      // replace anyway on timeout, because a wedged bridge must never block the respawn forever.
      const gone = await waitForExit(live, REPLACE_WAIT_MS);
      console.log(gone
        ? `bridge pid ${live} alive but its beacon is stale — replaced (old pid ${live} exited first)`
        : `bridge pid ${live} alive but its beacon is stale — SIGTERM sent but pid ${live} still up after ${REPLACE_WAIT_MS}ms; replacing anyway`);
    }
    // --parent: explicit pid, `none` to disable, or (default) resolve the codex above us.
    let parent = opt('--parent', null), seen = '';
    if (parent === null) { const r = resolveCodexParent(); parent = r.pid; seen = r.seen; }
    else if (parent === 'none') parent = null;
    else parent = Number(parent) || null;
    try { mkdirSync(LIVE_DIR, { recursive: true }); } catch {}
    const out = openSync(logFile, 'a');
    const self = fileURLToPath(import.meta.url);
    const passthrough = args.slice(2).filter((x, i, arr) => !(['--session', '--parent'].includes(x) || ['--session', '--parent'].includes(arr[i - 1])));
    const child = spawn(process.execPath, [self, 'run', instance, '--session', SID, ...(parent ? ['--parent', String(parent)] : []), ...passthrough], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: dirname(self), env: process.env,
    });
    child.unref();
    try { writeFileSync(pidFile, String(child.pid)); } catch {}
    console.log(`bridge started for session ${SID} as ${instance} (pid ${child.pid}, log ${logFile}); lifetime: ${parent ? `tied to codex pid ${parent}` : `SessionEnd only (no codex process found above the hook; saw ${seen || 'nothing'})`}`);
  }

  function stop() {
    const pid = readPid();
    if (pid && pidAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    try { rmSync(pidFile, { force: true }); } catch {}
    console.log(pid ? `bridge stopped (pid ${pid})` : 'no bridge running for this session');
  }

  if (cmd === 'run') run().catch((e) => { console.error('bridge error:', e.message); process.exit(1); });
  else if (cmd === 'ensure') ensure().catch((e) => { console.error('ensure error:', e && e.message ? e.message : e); process.exit(1); });
  else if (cmd === 'stop') stop();
  else usage();
}

// Run only when executed as the script (realpath-compared, so a junction/symlink path still counts);
// an `import` (tests) gets the exported helpers only.
const isMain = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main();
