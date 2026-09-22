// ---------------------------------------------------------------------------
// replication.test.mjs — the loss bound a failover actually delivers (issue 43), on a real
// fleet (dev/fleet.mjs).   node test/replication.test.mjs
//
//   R1  CC_REPLICATE_MS is HONOURED below the old fixed 15s tick: a message older than
//       REPLICATE_MS + margin survives an UNCLEAN leader kill
//   R2  a DRAIN stepdown (POST /cc/stepdown?drain=1) loses NOTHING — not even a message sent
//       the instant before it — and the successor promotes faster than a full client tick
//   R3  during the drain the leader is read-only: a write gets 503 {reason:'draining'}, never a
//       200 for a message that is about to vanish
//   R4  THREE nodes: both replicas see the drain and race for the term — exactly ONE ends up
//       leading (held stable past a leader-monitor tick), the other re-points as a client, the
//       ex-leader does not snatch the term back, nothing is lost
//   R5  a drain with NO replica attached does not hang: it degrades to an immediate stepdown
//   R6  the drain at the DEFAULT cadence (30s pulls, 15s checks — what the live fleet runs): the
//       replica's failover check notices `draining`, pulls at once, and the leader leaves on that
//       FINAL pull — not on its 20s deadline — with nothing lost
//   R7  a real `cc-send` issued INTO the drain window rides it out (503 → Retry-After → re-send
//       to the new leader) and the message lands exactly once
//   R8  the ex-leader HOLDOFF: after a PLAIN stepdown a fast ex-leader (5s checks) facing a slow
//       replica (15s checks) must NOT elect itself back — the replica gets the term
//
// All three were RED on 3.3.3 (replication + failover rode one fixed 15s interval; a graceful
// stepdown did no final pull).
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Fleet, fileId } = await import(pathToFileURL(join(__dirname, '..', 'dev', 'fleet.mjs')).href);

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 6;
const SCRATCH = mkdtempSync(join(tmpdir(), 'ccrepl-'));
const REPLICATE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };
const fleets = [];
const mkFleet = (name, opts = {}) => { const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, name), replicateMs: REPLICATE_MS, ...opts }); fleets.push(f); return f; };
const replicaTick = (f, i, timeoutMs = 40000) => { const b = fileId(f.replicaPath(i))?.mtimeMs ?? 0; return f.waitFor(() => (fileId(f.replicaPath(i))?.mtimeMs ?? 0) > b, timeoutMs, 50); };

try {
  // --- R1 ---------------------------------------------------------------------------------------
  console.log('R1 CC_REPLICATE_MS is the real loss bound');
  {
    const f = mkFleet('r1');
    await f.up();
    // Send IMMEDIATELY after a pull lands: the worst case — the message waits a full interval.
    ok(await replicaTick(f, 1), 'a replication pull landed (send is timed right after it)');
    const m = await f.send('repl', 'R1 must survive');
    await sleep(REPLICATE_MS + 2500);
    await f.killLeader({ clean: false });
    const nl = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2 });
    ok(nl && nl.i === 1, `node1 promoted (${nl ? `node${nl.i}@${nl.epoch}` : 'none'})`);
    const msgs = await f.messages('repl');
    ok(msgs.some((x) => x.id === m.id), `message id ${m.id}, sent ${REPLICATE_MS + 2500} ms before the kill with CC_REPLICATE_MS=${REPLICATE_MS}, is on the promoted leader`);
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  // --- R2 + R3 ----------------------------------------------------------------------------------
  console.log('R2/R3 drain stepdown: zero loss, read-only while draining, fast promotion');
  {
    const f = mkFleet('r2');
    await f.up();
    ok(await replicaTick(f, 1), 'a replication pull landed');
    const m = await f.send('repl', 'R2 sent the instant before the stepdown');
    const t0 = Date.now();
    const r = await fetch(f.baseUrl(0) + '/cc/stepdown?drain=1', { method: 'POST', headers: f.headers() });
    ok(r.ok, `drain stepdown accepted (${r.status})`);
    // R3: the leader may still be up (draining) — a write now must be refused, not swallowed.
    const w = await fetch(f.baseUrl(0) + '/api/messages', { method: 'POST', headers: f.headers(), body: JSON.stringify({ channel: 'repl', sender: 'fleet-harness', content: 'R3 during drain', message_type: 'message' }) }).catch(() => null);
    const wBody = w ? await w.json().catch(() => ({})) : {};
    ok(!!w && w.status === 503 && wBody.reason === 'draining' && !!w.headers.get('retry-after'), `a write during the drain is refused 503 draining + Retry-After (got ${w ? w.status : 'connection closed — the leader left before the write, scenario did not bite'})`);
    const nl = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2 });
    const ms = Date.now() - t0;
    ok(nl && nl.i === 1 && nl.epoch === 2, `node1 promoted to leader@2 (${nl ? `node${nl.i}@${nl.epoch}` : 'none'}) ${ms} ms after the stepdown`);
    ok(ms < 12000, `promotion beat a full 15s client tick (${ms} ms) — the successor knew the leader was leaving`);
    const msgs = await f.messages('repl');
    ok(msgs.some((x) => x.id === m.id), `message id ${m.id}, sent the instant before the drain, is on the promoted leader`);
    ok(!msgs.some((x) => /R3 during drain/.test(x.content)), 'the refused write is absent (no phantom)');
    ok(await f.waitFor(() => f.settled(0), 30000) && !(await f.whoami(0)), 'the stepped-down node is a settled CLIENT, serving nothing');
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  // --- R4 ---------------------------------------------------------------------------------------
  console.log('R4 three nodes: two replicas race a drain — exactly one leader');
  {
    const f = mkFleet('r4', { size: 3 });
    await f.up();
    ok(await replicaTick(f, 1) && await replicaTick(f, 2), 'both replicas are pulling');
    const m = await f.send('repl', 'R4 sent the instant before the stepdown');
    const r = await fetch(f.baseUrl(0) + '/cc/stepdown?drain=1', { method: 'POST', headers: f.headers() });
    ok(r.ok, 'drain stepdown accepted');
    // stable for 12s: longer than the 5s leader-monitor tick that resolves an equal-epoch double
    // promotion, so a lingering split brain or a flapping term cannot pass.
    const nl = await f.waitSingleLeader({ timeoutMs: 90000, minEpoch: 2, stableMs: 12000 });
    ok(nl && nl.i !== 0, `exactly one replica holds the term, stable 12s (${nl ? `node${nl.i}@${nl.epoch}` : 'none / split / flapping'})`);
    const serving = (await Promise.all([0, 1, 2].map((i) => f.whoami(i)))).filter(Boolean).length;
    ok(serving === 1, `only the leader serves (${serving} node(s) answer whoami)`);
    ok(await f.waitFor(async () => (await f.settled(0)) && (await f.settled(1)) && (await f.settled(2)), 45000), 'all three supervisors settled (one leader, two clients)');
    const msgs = await f.messages('repl');
    ok(msgs.some((x) => x.id === m.id), `message id ${m.id} survived the raced handover`);
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  // --- R5 ---------------------------------------------------------------------------------------
  console.log('R5 a drain with nobody to drain for');
  {
    const f = mkFleet('r5', { size: 1 });
    await f.up();
    const t0 = Date.now();
    const r = await fetch(f.baseUrl(0) + '/cc/stepdown?drain=1', { method: 'POST', headers: f.headers() });
    const body = await r.json().catch(() => ({}));
    ok(r.ok && body.draining === false, `no replica has pulled → the leader says it will NOT drain (${JSON.stringify(body)})`);
    ok(await f.waitFor(async () => !(await f.whoami(0)), 8000, 100), `the server left promptly (${Date.now() - t0} ms), not after the 20s drain deadline`);
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  // --- R6 + R7 ----------------------------------------------------------------------------------
  console.log('R6/R7 default cadence: the forced pull beats the drain deadline; a sender rides the drain out');
  {
    const f = mkFleet('r6', { replicateMs: 30000 });
    await f.up();
    ok(await f.waitFor(() => !!fileId(f.replicaPath(1)), 30000, 100), 'the replica holds its first snapshot');
    const m = await f.send('repl', 'R6 sent the instant before the stepdown');
    const t0 = Date.now();
    const r = await fetch(f.baseUrl(0) + '/cc/stepdown?drain=1', { method: 'POST', headers: f.headers() });
    ok(r.ok && (await r.json()).draining === true, 'the leader went into a drain');
    // R7: a REAL one-shot sender, exactly as an agent runs it, fired into the read-only window.
    const send = spawn(process.execPath, [join(__dirname, '..', 'src', 'cc-send.mjs'), 'node1/sender', 'repl', 'R7 rode the drain'], {
      env: { ...f.nodeEnv(1), HOME: join(SCRATCH, 'home-r7'), USERPROFILE: join(SCRATCH, 'home-r7') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let sendOut = '', sendErr = '';
    send.stdout.on('data', (d) => { sendOut += d; }); send.stderr.on('data', (d) => { sendErr += d; });
    const sendExit = new Promise((res) => send.on('exit', (code) => res(code)));
    const nl = await f.waitSingleLeader({ timeoutMs: 90000, minEpoch: 2 });
    const ms = Date.now() - t0;
    ok(nl && nl.i === 1 && nl.epoch === 2, `node1 promoted to leader@2 (${nl ? `node${nl.i}@${nl.epoch}` : 'none'}) ${ms} ms after the stepdown`);
    ok(/a replica pulled the final snapshot/.test(f.log(0)) && !/deadline reached/.test(f.log(0)), 'the old leader left on a FINAL replica pull, not on its 20s deadline');
    ok(/is DRAINING for a stepdown/.test(f.log(1)), 'the replica noticed the drain on its failover check and followed it');
    const code = await sendExit;
    ok(code === 0 && /sent →/.test(sendOut), `R7 cc-send exited 0 (${(sendOut || sendErr).trim().split('\n').pop()})`);
    ok(/handing over \(draining\)/.test(sendErr), 'R7 it met the 503 draining and waited (not a lucky send before/after the window)');
    const msgs = await f.messages('repl');
    ok(msgs.some((x) => x.id === m.id), `R6 message id ${m.id} survived at the default cadence`);
    ok(msgs.filter((x) => /R7 rode the drain/.test(x.content)).length === 1, 'R7 the message is on the new leader exactly once');
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  // --- R8 ---------------------------------------------------------------------------------------
  console.log('R8 holdoff: a stepped-down leader may join but not snatch the term back');
  {
    // Deliberately lopsided so the outcome does not hang on tick phase: node0 re-checks every 5s,
    // node1 every 15s. With NO holdoff node0 would find the estate empty ~6s after stepping down
    // and lead again — a "stepdown" that changes nothing — long before node1 even looks.
    const f = mkFleet('r8', { envOverrides: { 0: { CC_REPLICATE_MS: '5000' }, 1: { CC_REPLICATE_MS: '15000' } } });
    await f.up();
    const r = await fetch(f.baseUrl(0) + '/cc/stepdown', { method: 'POST', headers: f.headers() });   // PLAIN — nobody follows a drain
    ok(r.ok, 'plain stepdown accepted');
    const nl = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2, stableMs: 8000 });
    ok(nl && nl.i === 1, `the REPLICA took the term (${nl ? `node${nl.i}@${nl.epoch}` : 'none'}) — the ex-leader did not elect itself back`);
    ok(!/becoming LEADER at epoch 2/.test(f.log(0)), 'node0 never promoted itself at epoch 2');
    ok(await f.waitFor(() => f.settled(0), 30000) && !(await f.whoami(0)), 'node0 is a settled CLIENT');
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  if (failed) console.error('❌ replication.test FAILED');
  else console.log('✅ replication.test: all assertions passed (REPLICATE_MS honoured, loss-free drain stepdown, read-only drain, 3-node race → one leader, no-replica drain does not hang, default-cadence drain, sender rides the drain, ex-leader holdoff)');
} catch (e) {
  failed = true;
  console.error('❌ replication.test ERROR:', e.stack || e.message);
} finally {
  for (const x of fleets) { try { await x.down(); } catch {} }
  if (failed) console.error(`(scratch kept for inspection: ${SCRATCH})`);
  else { for (let k = 0; k < 10 && existsSync(SCRATCH); k++) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} await sleep(200); } }
}
process.exit(failed ? 1 : 0);
