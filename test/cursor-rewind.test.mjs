// ---------------------------------------------------------------------------
// cursor-rewind.test.mjs — a receiver must survive a REWOUND history (issue 46), on a real
// fleet with a real lane.   node test/cursor-rewind.test.mjs
//
// An unclean leader death promotes the survivor on its last replicated snapshot: the newest
// messages of the old term are gone and the new leader RE-ISSUES their ids. A receiver's
// per-channel cursor still sits above them, so — before the fix — every re-issued id was
// discarded as "already seen": the sender got a 200, the lane got nothing, nobody logged a thing.
//
//   C1  lane receives K (replicated) then L1, L2 (sent after the last pull → lost with the term)
//   C2  leader killed uncleanly → promoted leader has K but neither L1 nor L2
//   C3  NEW DMs get re-issued ids (≤ the lane's old cursor) — and the lane RECEIVES them, both
//       the one sent BEFORE it re-attached (found by the reconcile's signature check: same id,
//       different message) and the one sent after (the cursor was pulled back)
//   C4  exactly once; K is not replayed; a second new DM flows normally afterwards
//   C5  control: a loss-free drain stepdown changes nothing for the lane (no replay, no drop)
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const dev = (f) => import(pathToFileURL(join(__dirname, '..', 'dev', f)).href);
const { Fleet, fileId, cleanupOnSignal } = await dev('fleet.mjs');
const { FakeLane } = await dev('fake-lane.mjs');

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 9;
const SCRATCH = mkdtempSync(join(tmpdir(), 'cccursor-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };
const things = [];
cleanupOnSignal(() => things);
const count = (lane, re) => lane.inbox.filter((e) => re.test(e.msg.content)).length;
const pullLanded = (f, i) => { const b = fileId(f.replicaPath(i))?.mtimeMs ?? 0; return f.waitFor(() => (fileId(f.replicaPath(i))?.mtimeMs ?? 0) > b, 40000, 25); };

try {
  // --- C1–C4: lossy failover -----------------------------------------------------------------
  console.log('C1–C4 lossy failover re-issues ids below the lane cursor');
  {
    const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, 'lossy'), replicateMs: 4000 }); things.push(f);
    await f.up();
    const rx = new FakeLane('node1/rx', { env: f.nodeEnv(1), home: join(SCRATCH, 'home-rx') }); things.push(rx);
    ok(await rx.ready(), 'lane listening');
    ok(await f.waitFor(() => rx.logs.some((x) => /push connected/.test(x)), 10000, 100), 'lane holds the WebSocket');

    const k = await f.send('dm-rx', 'K kept — replicated before the crash');
    ok(await rx.waitMsg((m) => /^K kept/.test(m.content)), 'lane received K');
    ok(await pullLanded(f, 1) && await pullLanded(f, 1), 'two replica pulls landed after K (K is in the snapshot)');
    // Right after a pull: the next one is ~4s away, so these two die with the term.
    const l1 = await f.send('dm-rx', 'L1 lost with the old term');
    const l2 = await f.send('dm-rx', 'L2 lost with the old term');
    ok(await rx.waitMsg((m) => /^L2 lost/.test(m.content)), `lane received L1+L2 (its cursor is now ${l2.id})`);
    const killed = await f.killLeader({ clean: false });
    const nl = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: killed.epoch + 1 });
    ok(nl && nl.i === 1, `node1 promoted to leader@${nl?.epoch}`);
    const hist = await f.messages('dm-rx');
    ok(hist.some((m) => m.id === k.id) && !hist.some((m) => /^L[12] lost/.test(m.content)), `C2 scenario bites: promoted history has K but not L1/L2 (${hist.map((m) => m.id).join(',') || 'empty'})`);

    // Sent the moment the new leader exists — normally BEFORE the lane has re-attached, so it is
    // already sitting under the lane's stale cursor when the reconcile runs.
    const n0 = await f.send('dm-rx', 'N0 sent before the lane re-attached');
    const attachedBefore = rx.logs.some((x) => x.includes(`:${f.port(1)}`) && /push connected/.test(x));
    ok(n0.id <= l2.id, `C3 precondition: N0 was given a RE-ISSUED id (${n0.id} ≤ old cursor ${l2.id})${attachedBefore ? ' [lane had ALREADY re-attached — the pre-attach path did not bite this run]' : ''}`);
    ok(await f.waitFor(() => rx.logs.some((x) => x.includes(`:${f.port(1)}`) && /push connected/.test(x)), 45000, 100), 'lane re-attached to the promoted leader');
    ok(await rx.waitMsg((m) => /^N0 sent before/.test(m.content), 20000), 'C3 the lane RECEIVED N0 — a re-issued id that landed before it re-attached');
    const n1 = await f.send('dm-rx', 'N1 first message of the new term');
    ok(n1.id <= l2.id, `C3 precondition: N1 was given a RE-ISSUED id (${n1.id} ≤ old cursor ${l2.id})`);
    ok(await rx.waitMsg((m) => /^N1 first/.test(m.content), 20000), 'C3 the lane RECEIVED the message with the re-issued id');
    const n2 = await f.send('dm-rx', 'N2 second message of the new term');
    ok(await rx.waitMsg((m) => /^N2 second/.test(m.content), 20000), 'C4 the next message flows too');
    await sleep(3000);   // a poll-fallback period + a backfill: any replay would have arrived by now
    ok(count(rx, /^N0 sent/) === 1 && count(rx, /^N1 first/) === 1 && count(rx, /^N2 second/) === 1, `C4 exactly once (N0×${count(rx, /^N0 sent/)}, N1×${count(rx, /^N1 first/)}, N2×${count(rx, /^N2 second/)})`);
    ok(count(rx, /^K kept/) === 1, `C4 the surviving message K was not replayed (K×${count(rx, /^K kept/)})`);
    ok(rx.logs.some((x) => /history REWOUND on #dm-rx/.test(x)), 'the lane logged the rewind loudly');
    await rx.stop();
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  // --- C5: control — loss-free handover ---------------------------------------------------------
  console.log('C5 control: a drain stepdown is invisible to the lane');
  {
    const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, 'drain'), replicateMs: 2000 }); things.push(f);
    await f.up();
    const rx = new FakeLane('node1/rx', { env: f.nodeEnv(1), home: join(SCRATCH, 'home-rx2') }); things.push(rx);
    ok(await rx.ready(), 'lane listening');
    ok(await pullLanded(f, 1), 'a replica pull landed');
    const a = await f.send('dm-rx', 'A before the drain');
    ok(await rx.waitMsg((m) => /^A before/.test(m.content)), 'lane received A');
    const r = await fetch(f.baseUrl(0) + '/cc/stepdown?drain=1', { method: 'POST', headers: f.headers() });
    ok(r.ok, 'drain stepdown accepted');
    const nl = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: 2 });
    ok(nl && nl.i === 1, `node1 promoted to leader@${nl?.epoch}`);
    ok(await f.waitFor(() => rx.logs.some((x) => x.includes(`:${f.port(1)}`) && /push connected/.test(x)), 45000, 100), 'lane re-attached');
    const b = await f.send('dm-rx', 'B after the drain');
    ok(b.id > a.id, `ids continue across a loss-free handover (${a.id} → ${b.id})`);
    ok(await rx.waitMsg((m) => /^B after/.test(m.content), 20000), 'lane received B');
    await sleep(3000);
    ok(count(rx, /^A before/) === 1 && count(rx, /^B after/) === 1, 'no replay, no drop');
    ok(!rx.logs.some((x) => /history REWOUND/.test(x)), 'no rewind reported when nothing was lost');
    await rx.stop();
    { const left = await f.destroy(); ok(left.length === 0, `teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`); }
  }

  if (failed) console.error('❌ cursor-rewind.test FAILED');
  else console.log('✅ cursor-rewind.test: all assertions passed (re-issued ids delivered exactly once after a lossy failover; loss-free handover untouched)');
} catch (e) {
  failed = true;
  console.error('❌ cursor-rewind.test ERROR:', e.stack || e.message);
} finally {
  for (const t of things) { try { await (t.down ? t.down() : t.stop()); } catch {} }
  if (failed) console.error(`(scratch kept for inspection: ${SCRATCH})`);
  else { for (let k = 0; k < 10 && existsSync(SCRATCH); k++) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} await sleep(200); } }
}
process.exit(failed ? 1 : 0);
