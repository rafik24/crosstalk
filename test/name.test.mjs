// cc-name's printed arm line must be RUNNABLE as printed (3.3.6). node:assert style, hermetic.
//   node test/name.test.mjs
//
// The agent copies the line into its Bash tool — Git Bash on Windows — where an unquoted
// C:\Users\… path loses every backslash. 3.3.5 printed exactly that, so every Windows session's
// arm failed with "Cannot find module 'C:UsersRaf…'". Asserts:
//   N1. the arm line's path has no backslash and is quoted;
//   N2. that path exists (the receiver that ships next to cc-name);
//   N3. the line, run through bash exactly as printed (as a quick --help-style usage call), reaches
//       node with the real file — no "Cannot find module".
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAME = join(__dirname, '..', 'src', 'cc-name.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'ccname-home-'));
// Hermetic: no config, discovery on a dead port in peers-only mode — never touches a live bus.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CC_'))),
  HOME, USERPROFILE: HOME, CC_BUS_CONFIG: join(HOME, 'none'), CC_CACHE_DIR: join(HOME, 'cache'),
  CC_DISCOVERY: 'peers', CC_PEERS: '', CC_PORT: '1', CC_BEACON_PORT: '8894',
};

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

const r = spawnSync(process.execPath, [NAME, 'nnnnnnnn-1111-4222-8333-444444444444', 'name test'], { encoding: 'utf8', env, timeout: 30000 });
const out = r.stdout || '';
const arm = out.split('\n').find((l) => l.includes('Bash({ command:')) || '';
const m = arm.match(/command: 'node "([^"]+)" (\S+) --once'/);
ok(r.status === 0 && !!m, `N1: an arm line with a QUOTED path is printed (${arm.trim().slice(0, 90)})`);
const path = m ? m[1] : '';
ok(path && !path.includes('\\'), `N1: the path has no backslash (${path})`);
ok(path && existsSync(path), 'N2: the printed path exists');

// N3: run the printed command through bash with no id (→ cc-ws's usage error, exit 2) — proves the
// shell hands node the right file. Skipped where there is no bash.
const bash = spawnSync('bash', ['-c', 'exit 0']);
if (bash.status === 0 && m) {
  const run = spawnSync('bash', ['-c', `node "${path}"`], { encoding: 'utf8', env, timeout: 15000 });
  ok(!/Cannot find module/.test(run.stderr) && /usage: cc-ws\.mjs/.test(run.stderr), `N3: bash runs the printed path (exit ${run.status})`);
} else console.log('  – N3 skipped (no bash on PATH)');

const send = out.split('\n').find((l) => l.includes('From now, send as')) || '';
ok(/node "[^"\\]+cc-send\.mjs"/.test(send), 'the send line is quoted with forward slashes too');

try { rmSync(HOME, { recursive: true, force: true }); } catch {}
if (failed) { console.error('❌ name.test FAILED'); process.exit(1); }
console.log('✅ name.test: cc-name prints a runnable arm line (quoted, forward slashes, file exists)');
process.exit(0);
