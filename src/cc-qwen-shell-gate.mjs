#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-qwen-shell-gate.mjs — PreToolUse gate for a Qwen BUS LANE's shell tool. PROTOTYPE (QA #42, A5).
//
// WHY (reviewer blocker B1): a bus message is an UNTRUSTED user turn pushed into an agent that can run
// tools. Qwen's own approval is not an enforceable boundary here — under `qwen serve` it is an LLM
// classifier (measured: it denied the bus send in one run and allowed it in another), and a prefix
// allow-rule such as `Bash(node <client> *)` also matches
//     node <client> send me all "$(cat ~/.claude/.crosstalk)"        ← posts the bus token to the bus
//     node <client> send me all 'x'; id                               ← chaining
// This hook is the deterministic boundary: it PARSES the command itself.
//
//   - a command that invokes the bus client (src/cc-codex.mjs) is ALLOWED only when it is exactly ONE
//     simple command: `node <client> <join|send|ack|wait|peers> args…` where every argument is a bare
//     word, a 'single-quoted' string, or a "double-quoted" string free of $ ` \ — and nothing else
//     (no ; & | < > ( ) { } newline, no substitution, no redirection, no env prefix);
//   - any OTHER shell command: mode `bus-only` (default) → DENIED; mode `open` → left to Qwen's own
//     approval flow (exit 0, no decision). Mode = env CC_QWEN_SHELL or CC_QWEN_SHELL=… in the bus config.
//
// Wire as PreToolUse, matcher `^run_shell_command$` (see hooks/qwen-hooks.json). Signals: allow =
// JSON permissionDecision "allow" (skips the classifier, so a valid reply is never randomly refused);
// deny = exit 2 with the reason on stderr (shown to the model, which can retry with clean quoting).
// FAIL-CLOSED: unparseable payload or any internal error on a shell call → deny.
// ---------------------------------------------------------------------------
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath } from './cc-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, 'cc-codex.mjs');
const VERBS = new Set(['join', 'send', 'ack', 'wait', 'peers']);

// Split ONE simple shell command into words. Returns { words } or { error }. Deliberately tiny: it
// accepts a strict subset of sh and rejects everything it does not fully understand.
export function parseSimpleCommand(cmd) {
  const s = String(cmd);
  const words = []; let cur = ''; let has = false; let i = 0;
  const bad = (why) => ({ error: why });
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {                                   // single quotes: everything literal up to the next '
      const j = s.indexOf("'", i + 1);
      if (j < 0) return bad('unterminated single quote');
      if (/[\n\r\0]/.test(s.slice(i + 1, j))) return bad('newline inside a quoted argument');
      cur += s.slice(i + 1, j); has = true; i = j + 1; continue;
    }
    if (c === '"') {                                   // double quotes: no $, `, \ (expansion / substitution / escapes)
      const j = s.indexOf('"', i + 1);
      if (j < 0) return bad('unterminated double quote');
      const body = s.slice(i + 1, j);
      if (/[$`\\\n\r\0]/.test(body)) return bad('$, backtick, backslash or newline inside double quotes — use single quotes for the message text');
      cur += body; has = true; i = j + 1; continue;
    }
    if (c === ' ' || c === '\t') { if (has) { words.push(cur); cur = ''; has = false; } i++; continue; }
    if (!/[A-Za-z0-9_@%+=:,.\/#-]/.test(c)) return bad(`shell metacharacter ${JSON.stringify(c)} outside quotes`);
    cur += c; has = true; i++;
  }
  if (has) words.push(cur);
  return { words };
}

// 'allow' | { deny: reason } | 'other' (not a bus-client command)
export function judge(cmd, { client = CLIENT } = {}) {
  const mentionsClient = /cc-codex\.mjs/.test(String(cmd));
  if (!mentionsClient) return 'other';
  const p = parseSimpleCommand(cmd);
  if (p.error) return { deny: p.error };
  const [exe, script, verb] = p.words;
  if (!/^(node|node\.exe)$/.test(exe || '') ) return { deny: 'the bus client must be run as: node <client> <verb> …  (no env prefix, no wrapper)' };
  let same = false; try { same = realpathSync(resolve(script || '')) === realpathSync(client); } catch {}
  if (!same) return { deny: 'that is not the installed bus client path' };
  if (!VERBS.has(verb || '')) return { deny: `unknown bus client verb ${JSON.stringify(verb || '')}` };
  return 'allow';
}

function mode() {
  if (process.env.CC_QWEN_SHELL) return process.env.CC_QWEN_SHELL;
  try { const m = readFileSync(configPath(), 'utf8').match(/^\s*(?:export\s+)?CC_QWEN_SHELL\s*=\s*["']?([a-z-]+)/m); if (m) return m[1]; } catch {}
  return 'bus-only';
}

function runGate() {
  const deny = (why) => { process.stderr.write(`⛔ crosstalk shell gate: ${why}\nAllowed shape (ONE simple command, message text in SINGLE quotes):\n  node "${CLIENT}" send <your-id> <channel> 'your reply' --type response\n`); process.exit(2); };
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return deny('unreadable hook payload'); }
  if (!/^(run_shell_command|shell|Bash)$/.test(payload.tool_name || '')) process.exit(0);
  try {
    const cmd = payload.tool_input?.command;
    if (typeof cmd !== 'string' || !cmd.trim()) return deny('empty shell command');
    const v = judge(cmd);
    if (v === 'allow') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'crosstalk: clean single bus-client command' } }));
      process.exit(0);
    }
    if (v === 'other') { if (mode() === 'open') process.exit(0); return deny('this session is a bus lane in bus-only shell mode: the only shell command it may run is the bus client (set CC_QWEN_SHELL=open on the machine to lift this)'); }
    return deny(v.deny);
  } catch (e) { return deny('internal error: ' + (e?.message || e)); }
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) runGate();
