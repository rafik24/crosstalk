// cc-qwen-lane test (PROTOTYPE v2, QA #42 A5) — the launcher's FAIL-CLOSED live-inventory check, with a fake
// `qwen serve` (test/fixtures/qwen-serve-fake.mjs via QWEN_BIN) and a real bus server. Platform-independent.
//   node test/qwen-lane.test.mjs
//
//   P. PROFILE (pure): the lockdown layer disables + denies every known built-in, allows ONLY the crosstalk MCP
//      server, pins the identity in the MCP server's env, keeps hooks off, approvalMode default; no "*" anywhere
//   V. inventoryViolations (pure): built-ins, unknown future tools, unnamed entries, unreadable bodies → violations;
//      disabled entries and the four bus tools → none
//   C. CLEAN daemon → lane starts (exit 0): lane.json written, daemon got the lockdown layer through
//      QWEN_CODE_SYSTEM_SETTINGS_PATH, bridge attaches and beats the beacon, `stop` takes both processes down
//   R. REFUSALS (exit 3, daemon KILLED, no bridge, no session→id file): a built-in present · a tool from a future
//      release · a second MCP server · an extra tool on the crosstalk server · unreadable / failing / uninitialized
//      inventory · crosstalk MCP server missing;  O. the loud CC_QWEN_UNSAFE_PROFILE=1 override is the only way past
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { whoami } from '../src/cc-discover.mjs';
import { pkgVersion } from '../src/cc-rev.mjs';
import { lockdownSettings, inventoryViolations, BUILTIN_TOOLS } from '../src/cc-qwen-lane.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const LANE = join(__dirname, '..', 'src', 'cc-qwen-lane.mjs');
const FAKE = join(__dirname, 'fixtures', 'qwen-serve-fake.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.CC_TEST_PORT || 8792), SERVE_PORT = Number(process.env.CC_TEST_SERVE_PORT || 4169);
const HOME = mkdtempSync(join(tmpdir(), 'ccqlane-home-')), DATA = mkdtempSync(join(tmpdir(), 'ccqlane-data-')), CACHE = mkdtempSync(join(tmpdir(), 'ccqlane-cache-'));
const BASE = `http://127.0.0.1:${PORT}`, TOKEN = 'tt';
mkdirSync(join(HOME, '.claude'), { recursive: true });
const CFG = join(HOME, '.claude', '.crosstalk'); writeFileSync(CFG, `CC_TOKEN=${TOKEN}\nCC_BASE=${BASE}\nCC_PORT=${PORT}\n`);
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', HOME, USERPROFILE: HOME, CC_BUS_CONFIG: CFG, CC_CACHE_DIR: CACHE, CC_PORT: String(PORT),
  CC_BEACON_PORT: String(process.env.CC_TEST_BEACON_PORT || 8894), QWEN_BIN: FAKE, CC_SESSION_CHECK_MS: '60000' };
let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };
const pidAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return fn(); };
const LISTEN = join(HOME, '.claude', '.cc-listen');
const start = (mode, extra = {}) => { const envOut = join(HOME, `fake-env-${mode}.json`); const r = spawnSync(process.execPath, [LANE, 'start', '--topic', 'unit test', '--port', String(SERVE_PORT)], { env: { ...env, FAKE_MODE: mode, FAKE_ENV_OUT: envOut, ...extra }, encoding: 'utf8', timeout: 90000 }); let fake = {}; try { fake = JSON.parse(readFileSync(envOut, 'utf8')); } catch {} return { ...r, fake }; };

console.log('P profile (pure)');
{
  const s = lockdownSettings({ id: 'box/qwen-x-1', model: 'm', laneEnv: { CC_BUS_CONFIG: '/c' } });
  ok(BUILTIN_TOOLS.length >= 60 && ['run_shell_command', 'write_file', 'edit', 'read_file', 'web_fetch', 'agent', 'skill', 'exec', 'tool_search', 'tool_call', 'monitor'].every((t) => s.tools.disabled.includes(t) && s.permissions.deny.includes(t)), `every dangerous built-in is both disabled (unregistered) and denied (${BUILTIN_TOOLS.length} names)`);
  ok(JSON.stringify(s.permissions.allow) === '["mcp__crosstalk"]' && JSON.stringify(s.mcp.allowed) === '["crosstalk"]' && Object.keys(s.mcpServers).join() === 'crosstalk', 'the ONLY pre-approved / admitted thing is the crosstalk MCP server');
  ok(!JSON.stringify(s).includes('"*"') && s.tools.approvalMode === 'default' && s.disableAllHooks === true, 'no "*" anywhere, approvalMode default, hooks off');
  ok(s.mcpServers.crosstalk.env.CC_LANE_ID === 'box/qwen-x-1' && s.mcpServers.crosstalk.alwaysLoadTools === true && s.mcpServers.crosstalk.includeTools.length === 4, 'identity pinned in the MCP server env; its 4 tools always loaded (no tool_search bridge needed)');
}
console.log('V inventoryViolations (pure)');
ok(inventoryViolations({ tools: [] }).length === 0 && inventoryViolations({ tools: [{ name: 'mcp__crosstalk__bus_send' }, { name: 'read_file', enabled: false }] }).length === 0, 'empty / bus tools / explicitly-disabled entries → clean');
ok(inventoryViolations({ tools: [{ name: 'run_shell_command' }, { name: 'shiny_new_tool' }, {}, 'glob'] }).join() === 'run_shell_command,shiny_new_tool,<unnamed tool>,glob', 'built-in, unknown future tool, unnamed entry, bare string → all violations');
ok(inventoryViolations({ nope: 1 }).length === 1 && inventoryViolations(null).length === 1, 'an unreadable body is a violation (fail closed)');
ok(inventoryViolations({ tools: [{ name: 'mcp__crosstalk__bus_send_evil' }, { name: 'mcp__other__bus_send' }] }).length === 2, 'look-alike tool names are violations (anchored match)');

const server = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), CC_EPOCH: '1', CC_HOST: 'lanehost', CC_DATA_DIR: DATA, MCP_API_KEY: TOKEN }, stdio: 'ignore' });
const toKill = [];
try {
  { const end = Date.now() + 30000; let up = false; while (Date.now() < end && !(up = !!(await whoami(BASE, 1500)))) await sleep(300); if (!up) throw new Error('bus server did not come up'); }

  console.log('R refusals');
  for (const [mode, expect] of [['builtin', /run_shell_command, brand_new_tool_from_a_future_release/], ['extra-server', /mcp server searxng/], ['extra-mcp-tool', /mcp__crosstalk__bus_exec/],
    ['unreadable', /unreadable/], ['tools-500', /inventory probe failed/], ['uninitialized', /not initialized/], ['no-mcp', /crosstalk MCP tools are not registered/]]) {
    const r = start(mode); if (r.fake.pid) toKill.push(r.fake.pid);
    const gone = await until(() => !r.fake.pid || !pidAlive(r.fake.pid), 5000);
    const idFiles = existsSync(LISTEN) ? readdirSync(LISTEN).filter((f) => f.endsWith('.id')) : [];
    ok(r.status === 3 && /lane NOT started/.test(r.stdout) && expect.test(r.stdout) && gone && idFiles.length === 0, `${mode}: exit 3, reason named, daemon killed, no session→id file, no bridge (${(r.stdout.match(/—.*$/m) || [''])[0].slice(2, 110)})`);
  }

  console.log('O override');
  let r = start('builtin', { CC_QWEN_UNSAFE_PROFILE: '1' }); if (r.fake.pid) toKill.push(r.fake.pid);
  ok(r.status === 0 && /UNSAFE lane accepted/.test(r.stdout), 'CC_QWEN_UNSAFE_PROFILE=1 starts the lane anyway — and says so loudly');
  let id = (r.stdout.match(/Qwen bus lane up: (\S+)/) || [])[1];
  spawnSync(process.execPath, [LANE, 'stop', '--lane', id], { env, encoding: 'utf8' }); await until(() => !pidAlive(r.fake.pid), 5000);
  for (const f of existsSync(LISTEN) ? readdirSync(LISTEN) : []) if (f.endsWith('.id')) rmSync(join(LISTEN, f));

  console.log('C clean start + stop');
  r = start('clean'); if (r.fake.pid) toKill.push(r.fake.pid);
  id = (r.stdout.match(/Qwen bus lane up: (\S+)/) || [])[1];
  ok(r.status === 0 && /^[a-z0-9.-]+\/qwen-unit-test-[0-9a-f]{8}$/.test(id || ''), `clean inventory → lane up as ${id}`);
  const laneDir = join(LISTEN, 'qwen-lanes', String(id).replace(/[^A-Za-z0-9._-]/g, '_'));
  const st = JSON.parse(readFileSync(join(laneDir, 'lane.json'), 'utf8')); toKill.push(st.bridgePid);
  ok(r.fake.settingsPath === join(laneDir, 'lockdown-settings.json') && JSON.parse(readFileSync(r.fake.settingsPath, 'utf8')).mcpServers.crosstalk.env.CC_LANE_ID === id, 'the daemon was handed the lockdown layer via QWEN_CODE_SYSTEM_SETTINGS_PATH, identity pinned inside it');
  ok(r.fake.argv.includes('--max-sessions') && r.fake.argv[r.fake.argv.indexOf('--hostname') + 1] === '127.0.0.1', 'daemon started loopback-only with --max-sessions 1');
  ok(readFileSync(join(LISTEN, st.sessionId + '.id'), 'utf8') === id, 'session→id map written for the listen gate');
  ok(await until(() => existsSync(join(LISTEN, id.replace(/[^A-Za-z0-9._-]/g, '_'))), 20000), 'bridge attached and beats the listen beacon');
  const roster = await (await fetch(BASE + '/api/instances', { headers: { Authorization: 'Bearer ' + TOKEN, 'x-cc-version': pkgVersion() || '' } })).json();
  ok((roster.instances || roster).some((i) => i.instance_id === id && i.status === 'online'), 'lane is online on the bus under the minted identity');
  spawnSync(process.execPath, [LANE, 'stop', '--lane', id], { env, encoding: 'utf8' });
  ok(await until(() => !pidAlive(st.servePid) && !pidAlive(st.bridgePid), 8000), '`stop` takes the daemon and the bridge down');
} catch (e) { failed = true; console.error('❌', e.message); }
finally {
  for (const p of toKill) if (p) { try { process.kill(p, 'SIGKILL'); } catch {} }
  try { server.kill('SIGKILL'); } catch {}
  for (const d of [HOME, DATA, CACHE]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(failed ? '❌ qwen-lane.test FAILED' : '✅ qwen-lane.test: all assertions passed (lockdown profile, inventory rules, 7 refusals fail closed, loud override, clean start/stop)');
process.exit(failed ? 1 : 0);
