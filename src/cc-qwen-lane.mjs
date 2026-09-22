#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-qwen-lane.mjs — launcher for a LOCKED-DOWN Qwen bus lane. PROTOTYPE v2 (QA #42, A5).
//
// A Qwen lane is NOT "an interactive Qwen session that joined through a hook" (v1): Qwen hooks fail
// OPEN (measured + stated in its source), its default approval is an LLM classifier, and there is no
// "only these tools exist" setting. A lane is a process THIS launcher owns end to end:
//
//   1. mint the identity  host/qwen-<topic>-<rand8>            (pinned; the model never sees a way to change it)
//   2. write a LOCKDOWN settings file and hand it to Qwen as the HIGHEST-precedence layer
//      (QWEN_CODE_SYSTEM_SETTINGS_PATH): every built-in tool in tools.disabled (= not registered at
//      all; union-merged, so a project file / extension cannot re-enable) + mirrored permissions.deny,
//      ONE MCP server (`crosstalk` = src/cc-qwen-mcp.mjs, identity in its env), mcp.allowed = [crosstalk],
//      permissions.allow = [mcp__crosstalk], approvalMode default, hooks disabled. The operator's own
//      ~/.qwen is untouched and only supplies model providers.
//   3. start `qwen serve` on a RANDOM loopback port with --require-auth and a minted bearer (QWEN_SERVER_TOKEN,
//      env not argv), verify the responder is OUR child (exitCode null, /health 200 with the bearer AND 401 without),
//      create ONE session
//   4. VERIFY THE EFFECTIVE TOOL INVENTORY of the live daemon (GET /workspace/tools for built-ins, GET /workspace/mcp
//      for servers + their tools): any built-in, any MCP server but `crosstalk`, any tool that is not
//      mcp__crosstalk__bus_* → tear everything down, exit 3. This is what keeps a future
//      Qwen release that adds a built-in from silently widening the lane (the deny list is per-release).
//   5. register on the bus, write the session→id map, start cc-qwen-bridge (sink = this serve session)
//
//   node cc-qwen-lane.mjs start  --topic <name> [--workspace DIR] [--port 4170] [--model ID]
//   node cc-qwen-lane.mjs stop   --lane <identity>
//   node cc-qwen-lane.mjs profile --id <identity> [--model ID]        # print the lockdown settings (no side effects)
//   node cc-qwen-lane.mjs inventory --serve URL                        # exit 0 / 3 + the offending tools
//   env: QWEN_BIN (default `qwen`; a *.mjs path is run with node — tests). There is NO override of step 4.
// Zero deps.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, openSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANES_DIR = join(homedir(), '.claude', '.cc-listen', 'qwen-lanes');
export const ALLOWED_TOOL = /^mcp__crosstalk__bus_(send|ack|done|peers)$/;

// Every built-in Qwen Code 0.24.x registers (recon of the 0.24.3 bundle: ToolNames + TOOL_NAME_ALIASES).
// RE-AUDIT ON EVERY QWEN UPGRADE — and because that will be forgotten, step 4 verifies the live inventory.
export const BUILTIN_TOOLS = [
  'run_shell_command', 'monitor', 'exec', 'write_file', 'edit', 'replace', 'notebook_edit',
  'read_file', 'zoom_image', 'grep_search', 'search_file_content', 'glob', 'list_directory', 'read_mcp_resource',
  'web_fetch', 'web_search', 'image_gen',
  'agent', 'task', 'list_agents', 'send_message', 'task_stop', 'task_create', 'task_update', 'task_list',
  'team_create', 'team_delete', 'team_plan_approval', 'request_shutdown', 'create_sub_session',
  'skill', 'save_memory', 'todo_write', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question',
  'tool_search', 'tool_call', 'structured_output', 'cron_create', 'cron_list', 'cron_delete', 'loop_wakeup',
  'enter_worktree', 'exit_worktree', 'workflow', 'artifact', 'record_artifact', 'record_source', 'report_findings', 'display_image',
  'get_goal', 'update_goal', 'propose_goal', 'lsp',
  'omni_downsample_image', 'omni_downscale_video', 'omni_downsample_audio', 'omni_extract_keyframes', 'omni_extract_audio',
  'omni_clip_video', 'omni_convert_image', 'omni_transcribe_audio', 'omni_clip_image', 'omni_clip_audio', 'omni_caption_image',
  'omni_caption_audio', 'omni_ocr_image', 'omni_understand_video_segments', 'omni_recall_media_memory',
];

// The lockdown layer. `laneEnv` is what the MCP server needs to find the bus (config path, cache dir…).
export function lockdownSettings({ id, model = null, laneEnv = {} }) {
  return {
    tools: { disabled: BUILTIN_TOOLS, approvalMode: 'default', sandbox: false, codeModeOnly: false },
    permissions: { deny: BUILTIN_TOOLS, allow: ['mcp__crosstalk'] },
    mcp: { allowed: ['crosstalk'] },
    mcpServers: { crosstalk: { command: process.execPath, args: [join(HERE, 'cc-qwen-mcp.mjs')], env: { ...laneEnv, CC_LANE_ID: id }, trust: true, alwaysLoadTools: true,
      includeTools: ['bus_send', 'bus_ack', 'bus_done', 'bus_peers'], timeout: 20000 } },
    disableAllHooks: true,                       // hooks fail open; a lane must not depend on (or run) any
    ...(model ? { model: { name: model } } : {}),
  };
}

// Names of tools the live daemon reports as usable that a lane must not have. Tolerant of the response
// shape (array | {tools:[…]}; name | id | toolName; enabled flags) — UNKNOWN shape counts as a violation.
export function inventoryViolations(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.tools) ? body.tools : null;
  if (!list) return ['<unreadable /workspace/tools response>'];
  const out = [];
  for (const t of list) {
    const name = typeof t === 'string' ? t : (t?.name ?? t?.id ?? t?.toolName);
    if (typeof name !== 'string') { out.push('<unnamed tool>'); continue; }
    const off = typeof t === 'object' && (t.enabled === false || t.disabled === true || t.status === 'disabled' || t.registered === false);
    if (!off && !ALLOWED_TOOL.test(name)) out.push(name);
  }
  return out;
}
// Built-ins come from GET /workspace/tools (validated: a default profile lists agent, run_shell_command, …; the
// lockdown lists none). MCP tools are NOT in that list — they hang off GET /workspace/mcp (+ /<server>/tools),
// so both are read, and the set of MCP SERVERS must be exactly [crosstalk].
export async function liveInventory(serve, headers = {}) {
  const get = async (p) => { const r = await fetch(serve + p, { headers, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`GET ${p} → HTTP ${r.status}`); return r.json(); };
  const violations = []; const names = [];
  try {
    const t = await get('/workspace/tools');
    if (t.initialized === false) violations.push('<workspace tools not initialized yet>');
    violations.push(...inventoryViolations(t));
    const m = await get('/workspace/mcp');
    if (!Array.isArray(m.servers)) violations.push('<unreadable /workspace/mcp response>');
    for (const srv of m.servers || []) {
      if (srv.name !== 'crosstalk') { violations.push(`mcp server ${srv.name}`); continue; }
      const mt = await get('/workspace/mcp/crosstalk/tools');
      violations.push(...inventoryViolations(mt));
      for (const x of mt.tools || []) names.push(x.name);
    }
  } catch (e) { violations.push(`<inventory probe failed: ${e.message}>`); }
  return { violations, names };
}

export const bearer = (t) => (t ? { Authorization: 'Bearer ' + t } : {});
export function freePort() { return new Promise((res, rej) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); srv.on('error', rej); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'misc';

async function main() {
  const args = process.argv.slice(2); const cmd = args[0];
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const usage = () => { console.error('usage: cc-qwen-lane.mjs start --topic <name> [--workspace DIR] [--port N] [--model ID] | stop --lane <id> | profile --id <id> | inventory --serve URL'); process.exit(2); };

  if (cmd === 'profile') { const id = opt('--id'); if (!id) usage(); console.log(JSON.stringify(lockdownSettings({ id, model: opt('--model', null) }), null, 2)); return; }
  if (cmd === 'inventory') { const s = opt('--serve'); if (!s) usage(); const inv = await liveInventory(s, bearer(process.env.QWEN_SERVER_TOKEN)); console.log(inv.violations.length ? `⛔ ${inv.violations.length} tool(s) a bus lane must not have: ${inv.violations.join(', ')}` : `inventory ok (${inv.names.join(', ') || 'no tools'})`); process.exit(inv.violations.length ? 3 : 0); }

  if (cmd === 'stop') {
    const id = opt('--lane'); if (!id) usage();
    const dir = join(LANES_DIR, id.replace(/[^A-Za-z0-9._-]/g, '_'));
    let st = {}; try { st = JSON.parse(readFileSync(join(dir, 'lane.json'), 'utf8')); } catch {}
    for (const pid of [st.bridgePid, st.servePid]) if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } }   // detached ⇒ own process group: take the --acp child + MCP server too
    console.log(`lane ${id} stopped (serve pid ${st.servePid || '?'}, bridge pid ${st.bridgePid || '?'})`);
    return;
  }
  if (cmd !== 'start') usage();

  const topic = slug(opt('--topic', 'lane'));
  const machine = slug(hostname()) || 'unknown';
  const id = `${machine}/qwen-${topic}-${randomBytes(4).toString('hex')}`;
  const port = Number(opt('--port', 0)) || await freePort(); const serve = `http://127.0.0.1:${port}`;
  const token = randomBytes(24).toString('hex'); const auth = bearer(token);
  const dir = join(LANES_DIR, id.replace(/[^A-Za-z0-9._-]/g, '_'));
  const workspace = resolve(opt('--workspace', join(dir, 'workspace')));
  mkdirSync(dir, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const laneEnv = {}; for (const k of ['CC_BUS_CONFIG', 'CC_CACHE_DIR', 'CC_DISCOVERY', 'CC_BEACON_PORT', 'CC_PORT', 'HOME', 'USERPROFILE', 'PATH', 'SystemRoot']) if (process.env[k]) laneEnv[k] = process.env[k];
  const settingsPath = join(dir, 'lockdown-settings.json');
  writeFileSync(settingsPath, JSON.stringify(lockdownSettings({ id, model: opt('--model', null), laneEnv }), null, 2), { mode: 0o600 });

  const log = openSync(join(dir, 'qwen-serve.log'), 'a');
  // QWEN_BIN may be a *.mjs/*.js file (run under this node) so tests can substitute a fake daemon without a shell.
  const qbin = process.env.QWEN_BIN || 'qwen';
  const [qfile, qpre] = /\.(mjs|cjs|js)$/i.test(qbin) ? [process.execPath, [qbin]] : [qbin, []];
  const child = spawn(qfile, [...qpre, 'serve', '--port', String(port), '--hostname', '127.0.0.1', '--workspace', workspace, '--max-sessions', '1', '--require-auth'],
    { cwd: workspace, env: { ...process.env, QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsPath, QWEN_SERVER_TOKEN: token }, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  const state = { id, servePid: child.pid, serve, workspace, settingsPath };   // the token is never written to disk
  const abort = (why, code = 3) => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { process.kill(child.pid, 'SIGTERM'); } catch {} } console.log(`⛔ lane NOT started — ${why}`); process.exit(code); };
  // The responder must be OUR child: alive, answering /health only WITH our minted bearer. A foreign daemon on the
  // port (tokenless, or someone else's token) fails one of the two probes; a child that died leaves nothing to trust.
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    if (child.exitCode !== null || child.signalCode !== null) abort(`qwen serve exited during startup (code ${child.exitCode}, signal ${child.signalCode}) — see ${join(dir, 'qwen-serve.log')}`, 1);
    try { up = (await fetch(serve + '/health', { headers: auth, signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (!up) await sleep(500);
  }
  if (!up) abort(`qwen serve did not come up on ${serve} (see ${join(dir, 'qwen-serve.log')})`, 1);
  let anon = 0; try { anon = (await fetch(serve + '/health', { signal: AbortSignal.timeout(2000) })).status; } catch {}
  if (anon !== 401 && anon !== 403) abort(`the daemon on ${serve} answers /health WITHOUT our bearer (HTTP ${anon}) — not our authenticated child; refusing to drive it`);
  const s = await (await fetch(serve + '/session', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ cwd: workspace }) })).json().catch(() => ({}));
  if (!s.sessionId) abort('qwen serve refused the session: ' + JSON.stringify(s).slice(0, 200), 1);

  // step 4 — the boundary check. A daemon that is still initializing is polled (bounded); it never passes by default.
  let inv = await liveInventory(serve, auth);
  for (let i = 0; i < 20 && inv.violations.some((v) => /not initialized/.test(v)); i++) { await sleep(750); inv = await liveInventory(serve, auth); }
  if (inv.violations.length) abort(`the live session exposes tools a bus lane must not have: ${inv.violations.join(', ')} (Qwen upgrade? re-audit BUILTIN_TOOLS)`);
  if (!inv.names.some((n) => ALLOWED_TOOL.test(n))) abort('the crosstalk MCP tools are not registered in the live session (MCP server failed to start?)');

  const listen = join(homedir(), '.claude', '.cc-listen'); mkdirSync(listen, { recursive: true });
  writeFileSync(join(listen, s.sessionId + '.id'), id);
  const blog = openSync(join(dir, 'bridge.log'), 'a');
  const bridge = spawn(process.execPath, [join(HERE, 'cc-qwen-bridge.mjs'), 'run', id, '--session', s.sessionId, '--serve', serve],
    { env: { ...process.env, CC_QWEN_REPLY: 'mcp', QWEN_SERVER_TOKEN: token, CC_DESC: `qwen lane: ${topic}` }, detached: true, stdio: ['ignore', blog, blog] });   // the bridge re-verifies the inventory itself
  bridge.unref();
  writeFileSync(join(dir, 'lane.json'), JSON.stringify({ ...state, sessionId: s.sessionId, bridgePid: bridge.pid, tools: inv.names }, null, 2));
  console.log(`✅ Qwen bus lane up: ${id}\n   serve ${serve} (pid ${child.pid}) · session ${s.sessionId} · bridge pid ${bridge.pid}\n   tools: ${inv.names.join(', ')}\n   dir ${dir}\n   stop: node ${fileURLToPath(import.meta.url)} stop --lane ${id}`);
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch((e) => { console.error('lane error:', e.message); process.exit(1); });
