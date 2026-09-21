// ---------------------------------------------------------------------------
// handover.test.mjs — VERSION HANDOVER (issue 37), both directions, with real supervisors from
// two real copies of this repo at different versions (dev/fleet.mjs srcRoots).
//   node test/handover.test.mjs
//
// A plugin upgrade leaves the OLD install's supervisor running old code; when it leads it
// version-gates the whole upgraded fleet out. `cc-bus ensure` from the NEW install must hand
// over — and an OLDER install's ensure must NEVER kill a newer supervisor (bidirectional thrash,
// with the older code winning the last round). Until now only the pure decision function
// (needsVersionHandover) was tested; nothing ever ran the handover.
//
//   H1  LEADER case: old leader + `ensure` from the NEW copy → old supervisor AND its server are
//       gone (no orphan), a NEW-version supervisor owns the node, exactly one leader, history
//       intact (same box ⇒ same messages.db ⇒ nothing lost), epoch moved on
//   H2  DIRECTIONAL: `ensure` from the OLD copy against the NEW supervisor → "already running",
//       same pid, still alive after the old kill window
//   H3  CLIENT case: old client + `ensure` from the NEW copy → new supervisor, still one leader
//   H4  the hook-started supervisor leaves a log (issue 36): cc-bus.log has its role line
//
// MEASURED, not assumed (mutation run, Windows 11 / node 24): removing the /cc/stepdown that
// `ensure` sends before the kill does NOT orphan the server — libuv puts non-detached children in
// a kill-on-close job object, so terminating the supervisor takes its server with it. So H1's
// pid-level no-orphan assertion guards the spawn shape (a `detached` server WOULD be orphaned),
// not the stepdown-then-kill order. The mutant this suite is proven RED against is the
// DIRECTIONAL rule: `!==` instead of "strictly newer" makes H2 fail (the old install kills the
// newer supervisor).
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { Fleet, listeners, listenerPid, pidAlive, cleanupOnSignal } = await import(pathToFileURL(join(ROOT, 'dev', 'fleet.mjs')).href);

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 10;
const OLD_V = '9.9.1', NEW_V = '9.9.2';
// The copies live INSIDE the repo (git-ignored) so their `import 'express'` resolves by walking
// up to this checkout's node_modules — no symlink/junction to tear down, nothing to install.
const COPIES = join(ROOT, '.qa-scratch', `handover-${process.pid}`);
const SCRATCH = join(tmpdir(), `cchandover-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };

function makeCopy(name, version) {
  const dir = join(COPIES, name);
  mkdirSync(dir, { recursive: true });
  for (const d of ['src', 'server', '.claude-plugin']) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  pkg.version = version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  const plugPath = join(dir, '.claude-plugin', 'plugin.json');
  const plug = JSON.parse(readFileSync(plugPath, 'utf8'));
  plug.version = version;
  writeFileSync(plugPath, JSON.stringify(plug, null, 2));
  return dir;
}
// `cc-bus ensure` exactly as the SessionStart hook runs it: a blocking child of the install in use.
function ensure(copy, env) {
  const r = spawnSync(process.execPath, [join(copy, 'src', 'cc-bus.mjs'), 'ensure'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  return (r.stdout || '') + (r.stderr || '');
}

const fleets = [];
cleanupOnSignal(() => fleets);

try {
  const OLD = makeCopy('old', OLD_V), NEW = makeCopy('new', NEW_V);
  const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, 'fleet'), srcRoots: { 0: OLD, 1: OLD } });
  fleets.push(f);
  // Adopt a supervisor the HARNESS did not spawn (ensure's detached child) so down() sweeps it.
  const adopt = (i) => { const s = f.supervisor(i); if (s?.pid) { f.spawned.push(s.pid); f.nodes[i] = { ...f.nodes[i], pid: s.pid }; } return s; };

  const l0 = await f.up();
  ok(l0.i === 0 && l0.version === OLD_V, `fleet up on the OLD install: node0 leads, serving version ${l0.version}`);
  const m = await f.send('handover', 'written under the old version');

  // --- H1 ---------------------------------------------------------------------------------------
  console.log('H1 leader case: ensure from the NEW install');
  const oldSup = f.nodes[0].pid, oldSrv = listenerPid(f.port(0));
  ok(oldSrv > 0 && oldSrv !== oldSup && pidAlive(oldSrv), `pre: old supervisor pid ${oldSup}, old server pid ${oldSrv}`);
  const out1 = ensure(NEW, f.nodeEnv(0));
  ok(/version handover/.test(out1) && out1.includes(OLD_V) && out1.includes(NEW_V), `ensure announced the handover (${out1.trim().split('\n')[0]})`);
  const sup1 = await f.waitFor(() => { const s = f.supervisor(0); return s && s.version === NEW_V && s.pid !== oldSup && pidAlive(s.pid) && s.role !== 'starting' ? s : null; }, 60000, 250);
  ok(!!sup1, `a NEW-version supervisor owns node0 (pid ${sup1?.pid}, v${sup1?.version}, ${sup1?.role})`);
  adopt(0);
  ok(!pidAlive(oldSup) && !pidAlive(oldSrv), `no orphan: old supervisor pid ${oldSup} AND old server pid ${oldSrv} are dead`);
  const l1 = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2, stableMs: 8000 });
  ok(!!l1, `exactly one leader after the handover, stable 8s (${l1 ? `node${l1.i}@${l1.epoch} v${l1.version}` : 'none / split'})`);
  ok((await f.messages('handover')).some((x) => x.id === m.id), `message id ${m.id} survived the handover`);
  ok(listeners(f.port(0)).every((l) => l.addr === '127.0.0.1'), 'the respawned server is still loopback-only');

  // --- H4 ---------------------------------------------------------------------------------------
  const logPath = join(f.dataDir(0), 'cc-bus.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  ok(/becoming LEADER|CLIENT mode/.test(log), `H4 the ensure-started supervisor logs its role to cc-bus.log (${log ? log.trim().split('\n').length + ' lines' : 'no file'})`);

  // --- H2 ---------------------------------------------------------------------------------------
  console.log('H2 directional: ensure from the OLD install must not touch the newer supervisor');
  const out2 = ensure(OLD, f.nodeEnv(0));
  ok(/already running/.test(out2) && !/version handover/.test(out2), `old ensure stood down (${out2.trim().split('\n')[0]})`);
  await sleep(7000);   // past the 2.5s kill + 5s SIGKILL window a handover would have used
  const sup2 = f.supervisor(0);
  ok(sup2?.pid === sup1?.pid && pidAlive(sup2.pid) && sup2.version === NEW_V, `the NEW supervisor pid ${sup1?.pid} is untouched and alive`);

  // --- H3 ---------------------------------------------------------------------------------------
  console.log('H3 client case: ensure from the NEW install on a node that is a client');
  const ci = l1 && l1.i === 0 ? 1 : 0;
  if (f.supervisor(ci)?.version === NEW_V) {
    ok(true, `node${ci} already runs the new version — client case not applicable this run`);
  } else {
    const oldClient = f.nodes[ci].pid;
    const out3 = ensure(NEW, f.nodeEnv(ci));
    ok(/version handover/.test(out3), `ensure announced the client handover (${out3.trim().split('\n')[0]})`);
    const sup3 = await f.waitFor(() => { const s = f.supervisor(ci); return s && s.version === NEW_V && s.pid !== oldClient && pidAlive(s.pid) && s.role !== 'starting' ? s : null; }, 60000, 250);
    ok(!!sup3 && !pidAlive(oldClient), `node${ci}: old client supervisor pid ${oldClient} gone, new pid ${sup3?.pid} v${sup3?.version} (${sup3?.role})`);
    adopt(ci);
    const l3 = await f.waitSingleLeader({ timeoutMs: 45000, stableMs: 8000 });
    ok(!!l3, `still exactly one leader, stable 8s (${l3 ? `node${l3.i}@${l3.epoch}` : 'none / split'})`);
    ok((await f.messages('handover')).some((x) => x.id === m.id), 'history still intact');
  }

  { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }

  if (failed) console.error('❌ handover.test FAILED');
  else console.log('✅ handover.test: all assertions passed (leader + client handover to a newer install, no orphan, history intact, older install never kills newer, supervisor log)');
} catch (e) {
  failed = true;
  console.error('❌ handover.test ERROR:', e.stack || e.message);
} finally {
  for (const x of fleets) { try { await x.down(); } catch {} }
  for (let k = 0; k < 10 && existsSync(COPIES); k++) { try { rmSync(COPIES, { recursive: true, force: true }); } catch {} await sleep(200); }
  if (failed) console.error(`(scratch kept for inspection: ${SCRATCH})`);
  else { for (let k = 0; k < 10 && existsSync(SCRATCH); k++) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} await sleep(200); } }
}
process.exit(failed ? 1 : 0);
