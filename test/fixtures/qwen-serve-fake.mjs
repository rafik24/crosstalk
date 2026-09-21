// Fake `qwen serve` for test/qwen-lane.test.mjs. FAKE_MODE decides what the "live inventory" looks like.
// Records the environment it was started with (FAKE_ENV_OUT) so the test can see the lockdown layer it was handed.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2); const port = Number(a[a.indexOf('--port') + 1]); const mode = process.env.FAKE_MODE || 'clean';
if (process.env.FAKE_ENV_OUT) writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ argv: a, settingsPath: process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || null, pid: process.pid }));
const BUS = ['bus_send', 'bus_ack', 'bus_done', 'bus_peers'].map((n) => ({ name: 'mcp__crosstalk__' + n, serverToolName: n }));
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
createServer((req, res) => {
  const u = req.url;
  if (u === '/health') return json(res, 200, { status: 'ok' });
  if (u === '/session' && req.method === 'POST') return mode === 'no-session' ? json(res, 500, { error: 'boom' }) : json(res, 200, { sessionId: 'dddddddd-1111-4222-8333-444444444444' });
  if (u === '/workspace/tools') return mode === 'unreadable' ? json(res, 200, { nope: true }) : mode === 'tools-500' ? json(res, 500, {}) : json(res, 200, { v: 1, initialized: mode !== 'uninitialized', tools: mode === 'builtin' ? [{ name: 'run_shell_command' }, { name: 'brand_new_tool_from_a_future_release' }] : [] });
  if (u === '/workspace/mcp') return json(res, 200, { v: 1, servers: mode === 'no-mcp' ? [] : [{ name: 'crosstalk', mcpStatus: 'connected' }, ...(mode === 'extra-server' ? [{ name: 'searxng', mcpStatus: 'connected' }] : [])] });
  if (u === '/workspace/mcp/crosstalk/tools') return json(res, 200, { v: 1, tools: [...BUS, ...(mode === 'extra-mcp-tool' ? [{ name: 'mcp__crosstalk__bus_exec' }] : [])] });
  if (/^\/session\/[^/]+\/status$/.test(u)) return json(res, 200, { sessionId: 'x', hasActivePrompt: false });
  json(res, 404, { error: 'no route' });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
