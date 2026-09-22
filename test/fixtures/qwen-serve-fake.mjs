// Fake `qwen serve` for test/qwen-lane.test.mjs. FAKE_MODE (or the live FAKE_MODE_FILE, re-read per request)
// decides what the "live inventory" looks like. Enforces --require-auth + QWEN_SERVER_TOKEN like the real daemon
// (401 on every route incl. /health without the bearer) unless mode `tokenless` (a foreign, unauthenticated daemon).
// Records its argv + whether a token was in its env (never the value) to FAKE_ENV_OUT.
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2); const port = Number(a[a.indexOf('--port') + 1]);
const mode = () => { try { return readFileSync(process.env.FAKE_MODE_FILE, 'utf8').trim(); } catch { return process.env.FAKE_MODE || 'clean'; } };
if (mode() === 'die') process.exit(1);
if (process.env.FAKE_ENV_OUT) writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ argv: a, settingsPath: process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || null, hadToken: !!process.env.QWEN_SERVER_TOKEN, pid: process.pid }));
const requireAuth = a.includes('--require-auth') && !!process.env.QWEN_SERVER_TOKEN;
const BUS = ['bus_send', 'bus_ack', 'bus_done', 'bus_peers'].map((n) => ({ name: 'mcp__crosstalk__' + n, serverToolName: n }));
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
createServer((req, res) => {
  const u = req.url; const m = mode();
  if (requireAuth && m !== 'tokenless' && req.headers.authorization !== 'Bearer ' + process.env.QWEN_SERVER_TOKEN) return json(res, 401, { error: 'unauthorized' });
  if (u === '/health') return json(res, 200, { status: 'ok' });
  if (u === '/session' && req.method === 'POST') return m === 'no-session' ? json(res, 500, { error: 'boom' }) : json(res, 200, { sessionId: 'dddddddd-1111-4222-8333-444444444444' });
  if (u === '/workspace/tools') return m === 'unreadable' ? json(res, 200, { nope: true }) : m === 'tools-500' ? json(res, 500, {}) : json(res, 200, { v: 1, initialized: m !== 'uninitialized', tools: m === 'builtin' ? [{ name: 'run_shell_command' }, { name: 'brand_new_tool_from_a_future_release' }] : [] });
  if (u === '/workspace/mcp') return json(res, 200, { v: 1, servers: m === 'no-mcp' ? [] : [{ name: 'crosstalk', mcpStatus: 'connected' }, ...(m === 'extra-server' ? [{ name: 'searxng', mcpStatus: 'connected' }] : [])] });
  if (u === '/workspace/mcp/crosstalk/tools') return json(res, 200, { v: 1, tools: [...BUS, ...(m === 'extra-mcp-tool' ? [{ name: 'mcp__crosstalk__bus_exec' }] : [])] });
  if (/^\/session\/[^/]+\/status$/.test(u)) return json(res, 200, { sessionId: 'x', hasActivePrompt: false });
  if (/^\/session\/[^/]+\/prompt$/.test(u)) return json(res, 200, { promptId: 'p1' });
  json(res, 404, { error: 'no route' });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
