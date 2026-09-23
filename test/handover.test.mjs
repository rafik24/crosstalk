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
//   H5  the handover DRAINS (issue 53 — these branches used to run unasserted): the helper asked
//       for a drain, the old leader left on a replica's FINAL pull (not its 20s deadline), the
//       respawned supervisor got the start-holdoff, and a real cc-send fired INTO the read-only
//       window met the 503 and landed exactly once on the successor. Mutation-verified RED for
//       each of: no `?drain=1` in cmdHandover · no CC_START_HOLDOFF_MS · no finishDrain on the
//       final pull.
//
// MEASURED (Windows 11 / node 24): with the /cc/stepdown that `ensure` sends before the kill
// REMOVED, this suite stays GREEN. Explanation, verified separately on Windows: libuv places
// non-detached children in a kill-on-close job object, so terminating the supervisor also
// terminates its server. On POSIX the same mutant is expected green for a different reason
// (SIGTERM runs the supervisor's shutdown handler, which kills the child); only a SIGKILL
// escalation would orphan it. H1's no-orphan assertion therefore guards the spawn SHAPE (a
// `detached` server would be orphaned), not the stepdown-then-kill order, on either OS.
// The mutant this suite IS proven RED against is the DIRECTIONAL rule: `!==` instead of
// "strictly newer" makes H2 fail (the old install kills the newer supervisor).
//
// THREE nodes, so H3 always has something to do: whoever leads after H1, at least one node is
// still an OLD-version non-leader (with two nodes a replica whose failover tick landed inside
// the handover gap could take the term, and the "client" left over was the node just upgraded).
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { Fleet, fileId, listeners, listenerPid, pidAlive, cleanupOnSignal } = await import(pathToFileURL(join(ROOT, 'dev', 'fleet.mjs')).href);

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 10;
const OLD_V = '9.9.1', NEW_V = '9.9.2';
// The copies live INSIDE the repo (git-ignored) so their `import 'express'` resolves by walking
// up to this checkout's node_modules — no symlink/junction to tear down, nothing to install.
const COPIES = join(ROOT, '.qa-scratch', `handover-${process.pid}`);
const SCRATCH = mkdtempSync(join(tmpdir(), 'cchandover-'));
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
cleanupOnSignal(() => fleets);   // (down() adopts ensure-spawned supervisors itself)

// A run killed by SIGINT never reaches its finally: sweep copies left by DEAD runs. Only ever
// `.qa-scratch/handover-<pid>` directories this suite's naming produced, and only when that pid is
// no longer alive — plain directories, no links are ever created here.
let staleCopies = [];
try { staleCopies = readdirSync(join(ROOT, '.qa-scratch')); } catch {}
for (const d of staleCopies) {
  const m = d.match(/^handover-(\d+)$/);
  if (m && !pidAlive(Number(m[1]))) { try { rmSync(join(ROOT, '.qa-scratch', d), { recursive: true, force: true }); } catch {} }   // one busy dir must not stop the sweep
}

try {
  const OLD = makeCopy('old', OLD_V), NEW = makeCopy('new', NEW_V);
  // The DEFAULT cadence (30s pulls, 15s checks — what the live fleet runs, as replication.test R6):
  // the drain then stays open until a replica's failover check notices it, which leaves H5 a window
  // a real sender can be fired into. At a 2s cadence it closes before a spawned sender can start.
  const f = new Fleet({ slot: SLOT, size: 3, dir: join(SCRATCH, 'fleet'), srcRoots: { 0: OLD, 1: OLD, 2: OLD }, replicateMs: 30000 });
  fleets.push(f);
  // ensure's DETACHED supervisor is not the harness's child: adopt it so nodes[i] tracks it
  // (down() adopts too, so an exception or a signal before this line still cannot orphan it).
  const adopt = (i) => { f.adoptAll(); const s = f.supervisor(i); if (s?.pid) f.nodes[i] = { ...f.nodes[i], pid: s.pid }; return s; };

  const l0 = await f.up();
  ok(l0.i === 0 && l0.version === OLD_V, `fleet up on the OLD install: node0 leads, serving version ${l0.version}`);
  // A leader only drains for a replica that has pulled recently — otherwise it just steps down.
  ok(await f.waitFor(() => !!fileId(f.replicaPath(1)) || !!fileId(f.replicaPath(2)), 40000, 100), 'a replica holds its first snapshot (so the handover has someone to drain for)');
  const m = await f.send('handover', 'written under the old version');

  // --- H1 ---------------------------------------------------------------------------------------
  console.log('H1 leader case: ensure from the NEW install');
  const oldSup = f.nodes[0].pid, oldSrv = listenerPid(f.port(0));
  ok(oldSrv > 0 && oldSrv !== oldSup && pidAlive(oldSrv), `pre: old supervisor pid ${oldSup}, old server pid ${oldSrv}`);
  const out1 = ensure(NEW, f.nodeEnv(0));
  ok(/version handover/.test(out1) && out1.includes(OLD_V) && out1.includes(NEW_V), `ensure announced the handover (${out1.trim().split('\n')[0]})`);
  // H5 (part): ensure returns at once and its detached helper drains the old leader. Catch the
  // read-only window and fire a REAL one-shot sender into it, exactly as replication.test R7 does
  // (the OLD copy's cc-send: every node that can take the term runs the old version).
  const drainSeen = await f.waitFor(async () => (await f.whoami(0))?.draining === true, 20000, 50);
  ok(!!drainSeen, 'H5 the old leader went into a DRAIN (whoami.draining) — the helper asked for ?drain=1');
  let sendOut = '', sendErr = '', sendExit = Promise.resolve(null);
  if (drainSeen) {
    const send = spawn(process.execPath, [join(OLD, 'src', 'cc-send.mjs'), 'node1/sender', 'handover', 'H5 rode the drain'], {
      env: { ...f.nodeEnv(1), HOME: join(SCRATCH, 'home-h5'), USERPROFILE: join(SCRATCH, 'home-h5') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    send.stdout.on('data', (d) => { sendOut += d; }); send.stderr.on('data', (d) => { sendErr += d; });
    sendExit = new Promise((res) => send.on('exit', (code) => res(code)));
  }
  const sup1 = await f.waitFor(() => { const s = f.supervisor(0); return s && s.version === NEW_V && s.pid !== oldSup && pidAlive(s.pid) && s.role !== 'starting' ? s : null; }, 60000, 250);
  ok(!!sup1, `a NEW-version supervisor owns node0 (pid ${sup1?.pid}, v${sup1?.version}, ${sup1?.role})`);
  adopt(0);
  ok(!pidAlive(oldSup) && !pidAlive(oldSrv), `no orphan: old supervisor pid ${oldSup} AND old server pid ${oldSrv} are dead`);
  const l1 = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2, stableMs: 8000 });
  ok(!!l1, `exactly one leader after the handover, stable 8s (${l1 ? `node${l1.i}@${l1.epoch} v${l1.version}` : 'none / split'})`);
  ok((await f.messages('handover')).some((x) => x.id === m.id), `message id ${m.id} survived the handover`);
  {
    const code = await sendExit;
    ok(code === 0 && /sent →/.test(sendOut), `H5 cc-send exited 0 (${(sendOut || sendErr).trim().split('\n').pop()})`);
    ok(/handing over \(draining\)/.test(sendErr), 'H5 it met the 503 draining and waited (not a lucky send before/after the window)');
    ok((await f.messages('handover')).filter((x) => /H5 rode the drain/.test(x.content)).length === 1, 'H5 the message sent into the drain is on the successor exactly once');
    // The old server wrote to node0's fleet log (the fleet started that supervisor); the helper
    // and the supervisor it respawned write cc-bus.log.
    ok(/a replica pulled the final snapshot/.test(f.log(0)) && !/deadline reached/.test(f.log(0)), "H5 the old leader left on a replica's FINAL pull, not on its 20s drain deadline");
    let busLog = ''; try { busLog = readFileSync(join(f.dataDir(0), 'cc-bus.log'), 'utf8'); } catch {}
    ok(/handover: asking the local leader \(epoch \d+\) to DRAIN/.test(busLog), 'H5 the helper asked the local leader to DRAIN');
    ok(!/STILL up after the drain window/.test(busLog), "H5 the old server left inside the helper's wait (no forced kill)");
    const hold = busLog.match(/started after a drained handover[^\n]*/);
    ok(!!hold, `H5 the respawned supervisor got the start-holdoff (${hold ? hold[0] : 'no holdoff line in cc-bus.log'})`);
  }
  ok(listeners(f.port(0)).every((l) => l.addr === '127.0.0.1'), 'the respawned server is still loopback-only');

  // --- H4 ---------------------------------------------------------------------------------------
  const logPath = join(f.dataDir(0), 'cc-bus.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  ok(/becoming LEADER|CLIENT mode/.test(log), `H4 the ensure-started supervisor logs its role to cc-bus.log (${log ? log.trim().split('\n').length + ' lines' : 'no file'})`);

  // --- H2 ---------------------------------------------------------------------------------------
  console.log('H2 directional: ensure from the OLD install must not touch the newer supervisor');
  const out2 = ensure(OLD, f.nodeEnv(0));
  ok(/already running/.test(out2) && !/version handover/.test(out2), `old ensure stood down (${out2.trim().split('\n')[0]})`);
  // (No wait needed: an ensure that DID hand over cannot return before its own kill timers fired,
  // and one that stood down never scheduled a kill.)
  const sup2 = f.supervisor(0);
  ok(sup2?.pid === sup1?.pid && pidAlive(sup2.pid) && sup2.version === NEW_V, `the NEW supervisor pid ${sup1?.pid} is untouched and alive`);

  // --- H3 ---------------------------------------------------------------------------------------
  console.log('H3 client case: ensure from the NEW install on a node that is a client');
  // An OLD-version node that is NOT the leader — with three nodes there always is one.
  const leadNow = (await f.leader())?.i;
  const ci = [1, 2, 0].find((i) => i !== leadNow && f.supervisor(i)?.version === OLD_V);
  ok(ci !== undefined, `an OLD-version non-leader exists to hand over (leader node${leadNow}; versions ${[0, 1, 2].map((i) => f.supervisor(i)?.version).join(' / ')})`);
  if (ci !== undefined) {
    const oldClient = f.nodes[ci].pid;
    const out3 = ensure(NEW, f.nodeEnv(ci));
    ok(/version handover/.test(out3), `ensure announced the client handover (${out3.trim().split('\n')[0]})`);
    const sup3 = await f.waitFor(() => { const s = f.supervisor(ci); return s && s.version === NEW_V && s.pid !== oldClient && pidAlive(s.pid) && s.role !== 'starting' ? s : null; }, 60000, 250);
    ok(sup3?.role === 'client', `it really was the CLIENT path: the new supervisor on node${ci} joined as a client (${sup3?.role})`);
    ok(!!sup3 && !pidAlive(oldClient), `node${ci}: old client supervisor pid ${oldClient} gone, new pid ${sup3?.pid} v${sup3?.version} (${sup3?.role})`);
    adopt(ci);
    const l3 = await f.waitSingleLeader({ timeoutMs: 45000, stableMs: 8000 });
    ok(!!l3, `still exactly one leader, stable 8s (${l3 ? `node${l3.i}@${l3.epoch}` : 'none / split'})`);
    ok((await f.messages('handover')).some((x) => x.id === m.id), 'history still intact');
  }

  // On failure keep the fleet dir (logs, DBs) for inspection: stop the processes but do not delete.
  { const left = failed ? await f.down() : await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }

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
