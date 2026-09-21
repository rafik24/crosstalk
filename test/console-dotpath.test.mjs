// ---------------------------------------------------------------------------
// console-dotpath.test.mjs — issue #41: /console and /openapi.json must serve from an
// install whose path contains a DOT segment (~/.claude/plugins/cache/…), which is where
// every plugin install lives. express/send's default dotfiles:'ignore' 404s a bare
// absolute sendFile path with any dot segment, so /console was broken on every
// plugin-run leader while every checkout-run test stayed green — the exact class of
// gap this test closes: it copies the tree under a '.dotseg' directory and boots the
// server FROM THERE.
//   node test/console-dotpath.test.mjs
// Watch-fail verified: with the pre-#41 bare-absolute sendFile calls this test is RED.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

// Hermetic from the real estate (same guards as ws.test): scratch config/cache, pinned port.
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-dot-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ccdot-cache-'));
process.env.CC_PORT = String(PORT);
process.env.CC_BEACON_PORT = '8898';

// Build the dot-segment install: <tmp>/.dotseg/app/{server,src,package.json,node_modules→REPO's}
const ROOT = mkdtempSync(join(tmpdir(), 'ccdot-'));
const APP = join(ROOT, '.dotseg', 'app');
mkdirSync(APP, { recursive: true });
cpSync(join(REPO, 'server'), join(APP, 'server'), { recursive: true });
cpSync(join(REPO, 'src'), join(APP, 'src'), { recursive: true });
cpSync(join(REPO, 'package.json'), join(APP, 'package.json'));
// junction (dir link) so express resolves without a second npm install; 'junction' needs no
// elevation on Windows and degrades to a symlink on POSIX.
symlinkSync(join(REPO, 'node_modules'), join(APP, 'node_modules'), 'junction');

const DATA = mkdtempSync(join(tmpdir(), 'ccdot-data-'));
const srv = spawn(process.execPath, [join(APP, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), CC_EPOCH: '2', CC_HOST: 'dothost', CC_DATA_DIR: DATA, MCP_API_KEY: 'tt' },
  stdio: 'ignore',
});

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗', m); } else console.log('  ✓', m); };

try {
  // wait for the server
  let up = false;
  for (const end = Date.now() + 20000; Date.now() < end && !up;) {
    try { const r = await fetch(BASE + '/health'); up = r.ok; } catch {}
    if (!up) await sleep(300);
  }
  ok(up, 'server booted from the dot-segment install');

  const con = await fetch(BASE + '/console');
  const body = await con.text();
  ok(con.status === 200, `/console serves 200 from a ~/.claude-style path (got ${con.status})`);
  ok(/<html/i.test(body), '/console body is the console HTML, not an error JSON');

  const spec = await fetch(BASE + '/openapi.json');
  ok(spec.status === 200, `/openapi.json serves 200 from a dot-segment path (got ${spec.status})`);
  ok((await spec.text()).includes('openapi'), '/openapi.json body is the spec');
} catch (e) {
  failed = true;
  console.error('  ✗ threw:', e.stack || e.message);
} finally {
  try { srv.kill(); } catch {}
  await sleep(300);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
}
if (failed) { console.error('❌ console-dotpath.test FAILED'); process.exit(1); }
console.log('✅ console-dotpath.test: /console + /openapi.json serve from a dot-segment (plugin-cache-style) install');
process.exit(0);
