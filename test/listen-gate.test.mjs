// cc-listen-gate test (3.2.0) — the gate must BLOCK and ALLOW for BOTH agent classes. node:assert only.
//   node test/listen-gate.test.mjs
//
// Runs the gate as the REAL hook process (stdin JSON → exit code), with HOME redirected so the
// beacon dir is scratch and CC_BUS_CONFIG pointing at a scratch enrolled config. Watched-failing:
//   1. Claude `Edit` on an estate path, no beacon      → exit 2 (BLOCK)
//   2. same with a fresh beacon                        → exit 0
//   3. Codex `apply_patch` on an estate path, no beacon → exit 2 (BLOCK)   ← the 0.154 shape: no file_path
//   4. Codex `apply_patch` outside the estate           → exit 0
//   5. Codex `apply_patch` with a fresh beacon          → exit 0
//   6. patchPaths() parses Update/Add/Delete/Move headers of a multi-file patch
//   8. a discovery enrolment (CC_TOKEN, NO CC_BASE) is gated too (#59); no config / no token → allowed
//   9. no CC_ESTATE → only git-work-tree files are gated (never ~/.claude / temp), runnable hint
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = join(__dirname, '..', 'src', 'cc-listen-gate.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'ccgate-home-'));
const CFG = join(HOME, 'crosstalk.cfg');
writeFileSync(CFG, 'CC_TOKEN=tt\nCC_BASE=http://127.0.0.1:1\nCC_ESTATE=D:/estate/app\n');
const SID = 'bbbbbbbb-1111-4222-8333-444444444444';
const ID = 'testbox/codex-lane-bbbbbbbb';
const listenDir = join(HOME, '.claude', '.cc-listen');
mkdirSync(listenDir, { recursive: true });
writeFileSync(join(listenDir, SID + '.id'), ID);
const beacon = join(listenDir, ID.replace(/[^A-Za-z0-9._-]/g, '_'));

function gate(payload) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, CC_BUS_CONFIG: CFG, CC_LISTEN_BYPASS: '' } });
  return { code: r.status, err: r.stderr };
}
const patch = (p) => `*** Begin Patch\n*** Update File: ${p}\n@@\n-old\n+new\n*** End Patch\n`;

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

let r = gate({ session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'D:\\estate\\app\\core\\x.py' } });
ok(r.code === 2 && /NOT listening/.test(r.err), '1: Claude Edit on estate path, no beacon → BLOCKED (exit 2)');

writeFileSync(beacon, String(Date.now()));
r = gate({ session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'D:\\estate\\app\\core\\x.py' } });
ok(r.code === 0, '2: same with a fresh beacon → allowed');

// stale the beacon (older than FRESH_MS) rather than deleting: proves freshness, not existence
const { utimesSync } = await import('node:fs');
const old = new Date(Date.now() - 120000); utimesSync(beacon, old, old);
r = gate({ session_id: SID, tool_name: 'apply_patch', tool_input: { command: patch('D:/estate/app/api/app.py') } });
ok(r.code === 2 && /NOT listening/.test(r.err), '3: Codex apply_patch on estate path, stale beacon → BLOCKED (exit 2)');

r = gate({ session_id: SID, tool_name: 'apply_patch', tool_input: { command: patch('C:/scratch/notes.md') } });
ok(r.code === 0, '4: Codex apply_patch outside the estate → allowed');

// 3b/3c: the REAL Codex shape — headers RELATIVE to the session cwd. Resolved against payload.cwd:
// inside the estate → BLOCKED; a relative path from a cwd OUTSIDE the estate → allowed.
r = gate({ session_id: SID, cwd: 'D:\\estate\\app', tool_name: 'apply_patch', tool_input: { command: patch('core/x.py') } });
ok(r.code === 2 && /NOT listening/.test(r.err), '3b: Codex apply_patch with a RELATIVE estate path (cwd inside estate), stale beacon → BLOCKED');
ok(/cc-codex-bridge\.mjs ensure/.test(r.err) && !/Monitor\(/.test(r.err), '3b: block hint is Codex-aware (bridge ensure, not Monitor)');
r = gate({ session_id: SID, cwd: 'C:\\scratch', tool_name: 'apply_patch', tool_input: { command: patch('notes/todo.md') } });
ok(r.code === 0, '3c: relative path from a cwd outside the estate → allowed');
r = gate({ session_id: SID, cwd: 'D:\\estate\\app', tool_name: 'apply_patch', tool_input: { command: patch('../../scratch/a.md') + patch('api/app.py') } });
ok(r.code === 2, '3d: mixed patch — one path escapes the estate, one is inside → BLOCKED');

writeFileSync(beacon, String(Date.now()));
r = gate({ session_id: SID, tool_name: 'apply_patch', tool_input: { command: patch('D:/estate/app/api/app.py') } });
ok(r.code === 0, '5: Codex apply_patch on estate path with a fresh beacon → allowed');

// 7: the gate reached THROUGH A JUNCTION/SYMLINK to src/ must still run (Node realpaths the main
//    module; a URL comparison made isMain false and the gate silently allowed everything).
{
  const { symlinkSync } = await import('node:fs');
  const linkDir = join(HOME, 'src-link');
  symlinkSync(dirname(GATE), linkDir, 'junction');   // 'junction' = no privilege on Windows; a symlink elsewhere
  const viaLink = join(linkDir, 'cc-listen-gate.mjs');
  const old2 = new Date(Date.now() - 120000); utimesSync(beacon, old2, old2);
  const rr = spawnSync(process.execPath, [viaLink], { input: JSON.stringify({ session_id: SID, cwd: 'D:\\estate\\app', tool_name: 'apply_patch', tool_input: { command: patch('core/x.py') } }), encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, CC_BUS_CONFIG: CFG, CC_LISTEN_BYPASS: '' } });
  ok(rr.status === 2 && /NOT listening/.test(rr.stderr), '7: gate invoked through a junction to src/ still BLOCKS (realpath main-module check)');
  writeFileSync(beacon, String(Date.now()));
}

// 8: a DISCOVERY/password enrolment has no CC_BASE (cc-enrol never writes one) — it is still
//    enrolled and must be gated (#59: the gate keyed on CC_BASE and allowed everything there).
{
  const run = (cfgPath) => spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'D:\\estate\\app\\core\\x.py' } }), encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, CC_BUS_CONFIG: cfgPath, CC_LISTEN_BYPASS: '' } });
  const old3 = new Date(Date.now() - 120000); utimesSync(beacon, old3, old3);
  const discCfg = join(HOME, 'discovery.cfg');
  writeFileSync(discCfg, 'CC_TOKEN=tt\nCC_ESTATE=D:/estate/app\nCC_AUTO_SUPERVISOR=1\n');
  const d = run(discCfg);
  ok(d.status === 2 && /NOT listening/.test(d.stderr), '8: enrolled by discovery (CC_TOKEN + CC_ESTATE, NO CC_BASE), no fresh beacon, Edit in the estate → BLOCKED');
  ok(run(join(HOME, 'no-such-config')).status === 0, '8b: no config at all (not enrolled) → allowed');
  const noTok = join(HOME, 'notoken.cfg');
  writeFileSync(noTok, 'CC_ESTATE=D:/estate/app\n');
  ok(run(noTok).status === 0, '8c: a config with no CC_TOKEN is not an enrolment → allowed');
  writeFileSync(beacon, String(Date.now()));
}

// 9: NO CC_ESTATE (what every cc-enrol enrolment writes) — the gate covers code (a git work tree)
//    only, never the harness's own files or scratch; and its hint is a runnable line, not a
//    '<cc-ws.mjs>' placeholder (crosstalk-reviewer 2026-10-08: it blocked EVERY write on the box).
{
  const bare = join(HOME, 'bare.cfg');
  writeFileSync(bare, 'CC_TOKEN=tt\nCC_AUTO_SUPERVISOR=1\nCC_BIND=0.0.0.0\n');
  const run = (file, cfgPath = bare, env = {}) => spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: SID, tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, CC_BUS_CONFIG: cfgPath, CC_LISTEN_BYPASS: '', CC_TOKEN: '', ...env } });
  const old4 = new Date(Date.now() - 120000); utimesSync(beacon, old4, old4);
  const inRepo = join(__dirname, '..', 'src', 'some-new-file.mjs');   // this checkout is a git work tree
  const blocked = run(inRepo);
  ok(blocked.status === 2 && /NOT listening/.test(blocked.stderr), '9a: no CC_ESTATE, a file in a git work tree, no beacon → BLOCKED');
  // a CLAUDE session (the shared SID above is a Codex id, whose hint is the bridge)
  const CSID = 'cccccccc-1111-4222-8333-444444444444';
  writeFileSync(join(listenDir, CSID + '.id'), 'testbox/claude-lane-cccccccc');
  const ch = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: CSID, tool_name: 'Write', tool_input: { file_path: inRepo } }), encoding: 'utf8', env: { ...process.env, HOME, USERPROFILE: HOME, CC_BUS_CONFIG: bare, CC_LISTEN_BYPASS: '', CC_TOKEN: '' } });
  ok(ch.status === 2 && /node [^ ]*cc-ws\.mjs [^ ]+ --once/.test(ch.stderr) && !/<cc-ws\.mjs>/.test(ch.stderr), '9b: a Claude session hint names the real cc-ws.mjs path with --once (no <placeholder>)');
  ok(run(join(HOME, '.claude', 'projects', 'x', 'memory', 'note.md')).status === 0, '9c: no CC_ESTATE, ~/.claude (session memory) → allowed');
  ok(run(join(tmpdir(), 'scratch.txt')).status === 0, '9d: no CC_ESTATE, the temp dir → allowed');
  ok(run(process.platform === 'win32' ? 'Z:\\no-such-dir\\notes.md' : '/no-such-dir/notes.md').status === 0, '9e: no CC_ESTATE, outside any git work tree → allowed');
  // 9f: a pinned CC_BASE config whose token comes only from the ENVIRONMENT is enrolled too
  const pinned = join(HOME, 'pinned.cfg');
  writeFileSync(pinned, 'CC_BASE=http://127.0.0.1:1\n');
  ok(run(inRepo, pinned, { CC_TOKEN: 'from-env' }).status === 2, '9f: CC_BASE in the file + CC_TOKEN only in the env → still gated');
  writeFileSync(beacon, String(Date.now()));
}

const { patchPaths } = await import('../src/cc-listen-gate.mjs');
const multi = '*** Begin Patch\n*** Update File: core/a.py\n@@\n-x\n+y\n*** Add File: docs/NEW.md\n+hello\n*** Delete File: old.txt\n*** Update File: src/b.ts\n*** Move to: src/c.ts\n@@\n*** End Patch\n';
assert.deepStrictEqual(patchPaths(multi), ['core/a.py', 'docs/NEW.md', 'old.txt', 'src/b.ts', 'src/c.ts']);
ok(true, '6: patchPaths parses Update/Add/Delete/Move headers');

if (failed) { console.error('❌ listen-gate.test FAILED'); process.exit(1); }
console.log('✅ listen-gate.test: all assertions passed (blocks + allows for Claude Edit AND Codex apply_patch)');
