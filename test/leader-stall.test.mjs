// ---------------------------------------------------------------------------
// leader-stall.test.mjs — a leader that FREEZES and comes back (laptop lid, VM pause, a box that
// suspends after 45 idle minutes, a GC/IO stall) on a real fleet (dev/fleet.mjs). POSIX-only: the
// stall is SIGSTOP/SIGCONT on the leader's supervisor AND its server child — the closest single-box
// stand-in for the cross-host scenario X4 (suspend/resume of the leader box).
//   node test/leader-stall.test.mjs          (win32: skipped, exit 0)
//
//   S1  SHORT stall (4 s = the agreed MUST-SURVIVE bar; the detector needs the leader unreachable for >= ~4 s AFTER the first miss): NO leadership change — same node,
//       same epoch, the client never promoted, a write right after the thaw lands. A detector that
//       promotes on one missed probe turns every hiccup into a failover (+ a lossy one: #43/#46).
//   S2  LONG stall (25 s, longer than the detector): the client MUST promote (epoch+1) and accept
//       writes while the old leader is frozen …
//   S3  … and when the frozen ex-leader THAWS still believing it leads the old term, the fleet must
//       converge to EXACTLY ONE leader, stable 12 s (past a monitor tick): the higher epoch wins,
//       the ex-leader demotes to client and serves nothing, the messages written on the new leader
//       during the stall survive, ids keep counting, the DB passes integrity_check, and a lane-style
//       send through discovery reaches the surviving leader. Split brain that heals is tolerated for
//       at most 20 s and its duration is reported; a write accepted by the STALE leader after the
//       thaw is reported as evidence (it is lost by design once that node demotes).
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

if (process.platform === 'win32') { console.log('⏭  leader-stall.test: POSIX-only (SIGSTOP/SIGCONT) — skipped on win32'); process.exit(0); }
for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Fleet, listenerPid, pidAlive, cleanupOnSignal } = await import(pathToFileURL(join(__dirname, '..', 'dev', 'fleet.mjs')).href);

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 5;
const SHORT_MS = Number(process.env.CC_STALL_SHORT_MS || 4000), LONG_MS = Number(process.env.CC_STALL_LONG_MS || 25000);
const SCRATCH = mkdtempSync(join(tmpdir(), 'ccstall-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗', m); } else console.log('  ✓', m); };
const note = (m) => console.log('    ·', m);

const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, 'fleet'), replicateMs: 2000 });
cleanupOnSignal(() => [f]);
const frozen = new Set();
const sig = (pids, s) => { for (const p of pids) { try { process.kill(p, s); if (s === 'SIGSTOP') frozen.add(p); else frozen.delete(p); } catch {} } };
const childrenOf = (pid) => (spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).map(Number);
// the whole "box": supervisor + every child (the server) + whoever holds the port
const boxPids = (i) => [...new Set([f.nodes[i].pid, ...childrenOf(f.nodes[i].pid), listenerPid(f.port(i))].filter(Boolean))];
const post = async (i, content) => { try { const r = await fetch(f.baseUrl(i) + '/api/messages', { method: 'POST', headers: f.headers(), body: JSON.stringify({ channel: 'stall', sender: 'stall-test', content, message_type: 'message' }), signal: AbortSignal.timeout(3000) }); return { status: r.status, body: await r.json().catch(() => null) }; } catch (e) { return { status: 0, error: e.name }; } };

try {
  await f.up();
  ok(await f.waitSettled(), 'fleet settled: node0 leads, node1 is a client');
  const L0 = await f.leader();
  const li = L0.i, ci = 1 - li;
  ok((await f.send('stall', 'M0 before anything')).ok, 'M0 accepted');
  await f.waitFor(() => f.log(ci).length > 0 && /replicat/i.test(f.log(ci)), 5000);
  await sleep(2500);                                                     // let one pull carry M0

  // --- S1 -----------------------------------------------------------------------------------------
  console.log(`S1 short stall (${SHORT_MS} ms) must NOT cost the leader its term`);
  let pids = boxPids(li);
  sig(pids, 'SIGSTOP'); const tS1 = Date.now();
  await sleep(SHORT_MS);
  sig(pids, 'SIGCONT');
  note(`froze pids ${pids.join(',')} for ${Date.now() - tS1} ms`);
  const afterShort = await f.waitSingleLeader({ timeoutMs: 30000, stableMs: 8000 });
  ok(afterShort && afterShort.i === li && afterShort.epoch === L0.epoch, `same leader, same term after the thaw (was node${li}@${L0.epoch}, is ${afterShort ? `node${afterShort.i}@${afterShort.epoch}` : 'NONE/split'})`);
  ok(!/becoming LEADER/.test(f.log(ci)), 'the client never promoted during the short stall');
  const m1 = await post(li, 'M1 right after the short stall');
  ok(m1.status === 200 && m1.body?.ok, 'a write right after the thaw is accepted by the same leader');

  // --- S2 -----------------------------------------------------------------------------------------
  console.log(`S2 long stall (${LONG_MS} ms): the client must take over`);
  const cur = await f.leader(); const fi = cur.i, oi = 1 - fi;            // (robust even if S1 changed the leader)
  await sleep(2500);                                                     // M1 replicated
  pids = boxPids(fi);
  sig(pids, 'SIGSTOP'); const tS2 = Date.now();
  const promoted = await f.waitFor(async () => { const w = await f.whoami(oi); return w?.role === 'leader' && w.epoch > cur.epoch ? w : null; }, LONG_MS - 2000, 200);
  ok(!!promoted, `node${oi} promoted while node${fi} was frozen (${promoted ? `epoch ${cur.epoch} → ${promoted.epoch} after ${Date.now() - tS2} ms` : 'NEVER within the stall'})`);
  const during = []; for (let k = 1; k <= 3; k++) { const r = await post(oi, `D${k} written on the new leader during the stall`); if (r.body?.ok) during.push(r.body.id); }
  ok(during.length === 3, `the promoted leader accepted 3 writes during the stall (ids ${during.join(',')})`);
  await sleep(Math.max(0, LONG_MS - (Date.now() - tS2)));

  // --- S3 -----------------------------------------------------------------------------------------
  console.log('S3 the frozen ex-leader thaws believing it still leads');
  sig(pids, 'SIGCONT'); const tThaw = Date.now();
  // Evidence, not an assertion: how long does the thawed STALE leader keep answering 200 to writes that
  // will be lost when it demotes? (No fencing: it only learns of the higher term on its next monitor tick.)
  const stale = await post(fi, 'STALE write to the thawed ex-leader');
  let staleAccepted = stale.body?.ok ? 1 : 0, staleWindowMs = 0;
  const staleProbe = (async () => { while (Date.now() - tThaw < 20000) { const r = await post(fi, 'STALE probe'); if (r.body?.ok) { staleAccepted++; staleWindowMs = Date.now() - tThaw; } else if (r.status === 0) break; await sleep(150); } })();
  let splitMs = 0, sawSplit = false;
  const converged = await f.waitFor(async () => {
    const ls = await f.leaders();
    if (ls.length > 1) { sawSplit = true; splitMs = Date.now() - tThaw; }
    return ls.length === 1 ? ls[0] : null;
  }, 30000, 200);
  note(sawSplit ? `split brain observed for up to ${splitMs} ms after the thaw` : 'no moment with two leaders was observed');
  await staleProbe;
  note(`STALE-LEADER WRITE WINDOW: the thawed ex-leader accepted ${staleAccepted} write(s) with HTTP 200 for ${staleWindowMs} ms after the thaw — all lost when it demoted`);
  note(`stale write to the thawed ex-leader → HTTP ${stale.status}${stale.body?.ok ? ` ACCEPTED as id ${stale.body.id} (lost when it demotes)` : ''}`);
  ok(!sawSplit || splitMs <= 20000, 'any split brain healed within 20 s');
  const final = await f.waitSingleLeader({ timeoutMs: 45000, stableMs: 12000 });
  ok(final && final.i === oi && final.epoch >= (promoted?.epoch || cur.epoch + 1), `exactly one leader, stable 12 s: the higher term won (${final ? `node${final.i}@${final.epoch}` : 'NONE/split'})`);
  ok(await f.waitFor(async () => (await f.whoami(fi)) === null && f.supervisor(fi)?.role === 'client' && pidAlive(f.nodes[fi].pid), 30000), `thawed node${fi} demoted to CLIENT, serves nothing, supervisor alive`);
  const msgs = await f.messages('stall');
  ok(during.every((id) => msgs.some((m) => m.id === id && /^D\d/.test(m.content))), 'every message written on the new leader during the stall survived the thaw');
  ok(msgs.some((m) => /^M0/.test(m.content)), 'pre-stall history (M0) intact');
  const after = await f.send('stall', 'A1 after convergence');
  ok(after.ok && after.id > Math.max(...during), `writes continue on the survivor, ids keep counting (${Math.max(...during)} → ${after.id})`);
  const integ = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(f.dbPath(oi))},{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check)`], { encoding: 'utf8' });
  ok(/^ok/.test(integ.stdout || ''), `survivor DB passes integrity_check (${(integ.stdout || integ.stderr || '').trim().slice(0, 40)})`);
  ok(f.hermeticityViolations().length === 0, 'fleet stayed hermetic');
} catch (e) { failed = true; console.error('  ✗ ERROR', e.message); }
finally {
  sig([...frozen], 'SIGCONT');                                           // never leave a stopped process behind
  const survivors = await f.destroy().catch(() => null);
  if (Array.isArray(survivors)) ok(survivors.length === 0, 'teardown left nothing behind');
  if (!failed) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} } else console.log('(scratch kept for inspection: ' + SCRATCH + ')');
}
console.log(failed ? '❌ leader-stall.test FAILED' : `✅ leader-stall.test: all assertions passed (short stall keeps the term, long stall fails over, thawed ex-leader demotes, one leader, no loss on the survivor)`);
process.exit(failed ? 1 : 0);
