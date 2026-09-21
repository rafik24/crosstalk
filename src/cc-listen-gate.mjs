#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-listen-gate.mjs — PreToolUse gate: on an ENROLLED machine, block Edit/Write on
// estate files until this session is CONFIRMED listening on the chat bus (cc-poll is
// heartbeating its liveness beacon). Enforces "all sessions MUST listen."
//
// Wire as a PreToolUse hook (matcher Edit|Write|MultiEdit|NotebookEdit):
//   { "type":"command", "command":"node \"<path>/cc-listen-gate.mjs\"" }
//
// Signals (Claude Code hook protocol): exit 0 = allow · exit 2 = BLOCK (stderr → model).
// FAIL-OPEN: any error, unreachable state, or not-enrolled → exit 0. Never brick editing.
// Bypass once (loud): CC_LISTEN_BYPASS=1.
// ---------------------------------------------------------------------------
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { configPath } from './cc-paths.mjs';

const FRESH_MS = 45000;                       // cc-poll heartbeats every 20s → 45s window
function done(code, msg) { if (msg) process.stderr.write(msg + '\n'); process.exit(code); }

// Paths named by a Codex `apply_patch` envelope. Pure; exported for the test suite.
export function patchPaths(text) {
  const out = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm;
  let m;
  while ((m = re.exec(String(text)))) out.push((m[1] || m[2]).trim());
  return out;
}
// Run the gate only when executed as the hook process; an `import` (the test suite) just gets
// patchPaths. Decided from the module path, not an env var — an env var set in a session would
// have silently disabled the gate for that whole session. REALPATH-compared: Node realpaths the
// main module, so a gate reached through a junction/symlink (how this estate installs things)
// has argv[1] = the link path and import.meta.url = the target — a URL comparison silently never
// ran the gate (reviewer, 2026-09-17; pinned by test/listen-gate.test.mjs case 7).
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) runGate();

function runGate() {

try {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {}

  // enrollment: only enrolled machines (bus config present) are gated
  const cfgPath = configPath();   // ~/.claude/.crosstalk, back-compat ~/.claude/.cross-claude-bus
  const cfg = {};
  try { for (const l of readFileSync(cfgPath, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*(?:export\s+)?(CC_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  if (!cfg.CC_BASE) done(0);
  if (process.env.CC_LISTEN_BYPASS) done(0, '[cc-listen-gate] BYPASS active — allowed without a listen check (logged).');

  const tool = payload.tool_name || '';
  // Claude Code edits carry tool_input.file_path. Codex CLI (≥0.154) edits are `apply_patch`
  // with NO path field — the paths live in the patch headers inside tool_input.command
  // (`*** Update File: x` / `*** Add File: x` / `*** Delete File: x` / `*** Move to: x`).
  // Qwen Code edits are `write_file` / `edit`, both with an absolute tool_input.file_path (probed live 2026-09-21).
  if (!/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|edit)$/.test(tool)) done(0);

  const ti = payload.tool_input || {};
  // Codex patch headers are RELATIVE to the session cwd (`*** Update File: core/x.py`), so every
  // path is resolved against payload.cwd before the estate check — a relative path can never
  // silently fall outside an absolute estate prefix (reviewer repro 2026-09-17: exit 0, ungated).
  const cwd = payload.cwd || process.cwd();
  const files = (tool === 'apply_patch'
    ? patchPaths(ti.command || ti.patch || ti.input || '')
    : [ti.file_path || ti.notebook_path || ''].filter(Boolean)).map((f) => resolve(cwd, f));
  const file = files[0] || '';
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const estate = cfg.CC_ESTATE ? norm(cfg.CC_ESTATE) : '';
  // Gated if ANY touched path is inside the estate. No path known (unparseable patch) → gated
  // (conservative: the same as an Edit with an empty file_path was before).
  if (estate && files.length && !files.some((f) => norm(f).includes(estate))) done(0);

  // identity: READ it from the session->id map that cc-join.sh / cc-name.mjs wrote, keyed by
  // session_id. This is authoritative — the gate no longer recomputes host/branch, so it always
  // agrees with the session's CURRENT name (default OR renamed via cc-name). Legacy fallback below
  // keeps older sessions (that predate the id-file) from being bricked.
  const listenDir = join(homedir(), '.claude', '.cc-listen');
  const sid = payload.session_id || '';
  let id = '';
  try { if (sid) id = readFileSync(join(listenDir, sid + '.id'), 'utf8').trim(); } catch {}
  if (!id) {
    // legacy fallback: recompute host/branch as cc-join.sh used to (pre id-file sessions)
    const cwd = payload.cwd || process.cwd();
    const machine = (hostname().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+$/, '')) || 'unknown';
    let topic = '';
    try { topic = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim(); } catch {}
    topic = (topic && topic !== 'HEAD') ? topic : basename(cwd);
    topic = topic.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+$/, '') || 'misc';
    id = `${machine}/${topic}`;
  }
  const beacon = join(listenDir, id.replace(/[^A-Za-z0-9._-]/g, '_'));

  let fresh = false;
  try { fresh = (Date.now() - statSync(beacon).mtimeMs) < FRESH_MS; } catch {}
  if (fresh) done(0);

  // Prefer the push receiver (cc-ws) in the hint; fall back to cc-poll for older enrolments.
  const recvHint = cfg.CC_WS || cfg.CC_POLL || '<cc-ws.mjs>';
  const isCodex = /\/codex-/.test(id);
  const isQwen = /\/qwen-/.test(id);     // a Qwen session has no Monitor either — bridge (serve) or `wait` (TUI)   // a Codex session has no Monitor — its receiver is the bridge
  const here = dirname(fileURLToPath(import.meta.url));
  done(2, [
    `⛔ CHAT BUS — this session (${id}) is NOT listening; blocked before editing ${file || 'an estate file'}.`,
    `On an enrolled machine every session must be on the live bus before it edits code. Arm receive, then retry:`,
    isQwen
      ? `  node ${join(here, 'cc-qwen-bridge.mjs')} ensure ${id} --session ${sid || '<session_id>'}   (needs a \`qwen serve\` session; log ~/.claude/.cc-listen/<sid>.bridge.log)\n  In a plain TUI / one-shot Qwen session there is no serve session to push into — receive with:  node ${join(here, 'cc-codex.mjs')} wait ${id} --timeout 90   (it heartbeats the beacon while it waits)`
      : isCodex
      ? `  node ${join(here, 'cc-codex-bridge.mjs')} ensure ${id} --session ${sid || '<session_id>'}   (the bridge heartbeats the beacon; check ~/.claude/.cc-listen/<sid>.bridge.log)`
      : `  Monitor({ command: 'node ${recvHint} ${id}', description: 'crosstalk bus (${id})', persistent: true })`,
    `(The SessionStart join hook prints this exact line. One-off bypass: set CC_LISTEN_BYPASS=1.)`,
  ].join('\n'));
} catch {
  done(0);   // fail-open: a gate that errors must never block work
}
}
