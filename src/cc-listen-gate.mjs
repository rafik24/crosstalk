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
import { readFileSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { configPath } from './cc-paths.mjs';

const FRESH_MS = 45000;                       // cc-poll heartbeats every 20s → 45s window
function done(code, msg) { if (msg) process.stderr.write(msg + '\n'); process.exit(code); }

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
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) done(0);

  const ti = payload.tool_input || {};
  const file = ti.file_path || ti.notebook_path || '';
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const estate = cfg.CC_ESTATE ? norm(cfg.CC_ESTATE) : '';
  if (estate && file && !norm(file).includes(estate)) done(0);   // edit outside the estate → not gated

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
  done(2, [
    `⛔ CHAT BUS — this session (${id}) is NOT listening; blocked before editing ${file || 'an estate file'}.`,
    `On an enrolled machine every session must be on the live bus before it edits code. Arm receive, then retry:`,
    `  Monitor({ command: 'node ${recvHint} ${id}', description: 'crosstalk bus (${id})', persistent: true })`,
    `(The SessionStart join hook prints this exact line. One-off bypass: set CC_LISTEN_BYPASS=1.)`,
  ].join('\n'));
} catch {
  done(0);   // fail-open: a gate that errors must never block work
}
