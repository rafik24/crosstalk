// ---------------------------------------------------------------------------
// turnplay.test.mjs — multi-agent TURN-PLAY with zero real sessions (dev/fake-lane.mjs on
// dev/fleet.mjs).   node test/turnplay.test.mjs
//
// Three scripted lanes — each a real child process on the real receive engine — play the
// coordination contract end to end against a real 2-node fleet:
//
//   T1  join: lanes register + listen; their liveness beacons land in the SCRATCH home
//   T2  addressing: ambient #general wakes nobody; a DM wakes only its target; @all wakes all
//   T3  the claim-lock: two lanes race ONE work item → exactly one 200, the other 409
//   T4  handoff → ACK → done: the board handoff wakes the new owner »HANDOFF — ACK REQUIRED«,
//       the ack rides a `response` starting "ACK", a non-owner's state change is refused (403),
//       the owner's lands, and `done` is a distinct message type
//   T5  failover continuity: leader killed uncleanly → lanes on BOTH boxes re-discover the
//       promoted leader on their own; a DM sent after the promotion is delivered exactly once
//
// Slow by nature (T5 waits out the 15s client failover tick).
// ---------------------------------------------------------------------------
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const dev = (f) => import(pathToFileURL(join(__dirname, '..', 'dev', f)).href);
const { Fleet } = await dev('fleet.mjs');
const { FakeLane } = await dev('fake-lane.mjs');

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 8;
const SCRATCH = mkdtempSync(join(tmpdir(), 'ccturn-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };

const f = new Fleet({ slot: SLOT, dir: join(SCRATCH, 'fleet') });
const lanes = [];
const lane = (identity, node, opts = {}) => {
  const l = new FakeLane(identity, { env: f.nodeEnv(node), home: join(SCRATCH, 'home-' + identity.replace(/\W+/g, '_')), ...opts });
  lanes.push(l); return l;
};
const got = (l, re) => l.inbox.filter((e) => re.test(e.msg.content));

try {
  await f.up();

  // --- T1 ---------------------------------------------------------------------------------------
  console.log('T1 join');
  const po = lane('node0/po', 0, { firehose: true });          // the operator console's view: everything
  const app = lane('node0/app-lane', 0);
  const infra = lane('node1/infra-lane', 1);                   // a session on the OTHER box
  ok((await Promise.all(lanes.map((l) => l.ready()))).every(Boolean), 'three lanes registered and listening');
  ok(await f.waitFor(() => lanes.every((l) => l.logs.some((x) => /push connected/.test(x))), 10000, 100),   // (until() only re-checks on its OWN lane's events)
     'all three hold a live WebSocket (push, not the poll fallback)');
  const roster = await po.rest('GET', '/api/instances');
  const online = (roster.body?.instances || []).filter((i) => i.status === 'online').map((i) => i.instance_id);
  ok(['node0/po', 'node0/app-lane', 'node1/infra-lane'].every((id) => online.includes(id)), `roster shows all three online (${online.filter((x) => !x.startsWith('cc-bus')).join(', ')})`);
  const beaconDir = join(SCRATCH, 'home-node1_infra_lane', '.claude', '.cc-listen');
  ok(existsSync(beaconDir) && readdirSync(beaconDir).some((n) => n.includes('infra-lane')), 'liveness beacon written under the SCRATCH home, not the real ~/.claude');

  // --- T2 ---------------------------------------------------------------------------------------
  console.log('T2 addressing');
  await po.send('all', 'ambient chatter nobody is named in');
  await po.send('dm-infra-lane', 'T2 direct question for infra');
  const dm = await infra.waitMsg((m) => /T2 direct question/.test(m.content));
  ok(dm && dm.addressed && / »TO YOU«/.test(dm.rendered) && dm.msg.channel === 'dm-infra-lane', 'DM woke its target, tagged »TO YOU«');
  await po.send('all', '@all T2 estate-wide signal');
  ok(await app.waitMsg((m) => /T2 estate-wide/.test(m.content)) && await infra.waitMsg((m) => /T2 estate-wide/.test(m.content)), '@all woke every lane');
  await sleep(500);
  ok(got(app, /ambient chatter/).length === 0 && got(infra, /ambient chatter/).length === 0, 'ambient #general traffic woke nobody');
  ok(got(app, /T2 direct question/).length === 0, "a DM to infra did not wake the app lane");

  // --- T3 ---------------------------------------------------------------------------------------
  console.log('T3 claim-lock race');
  const created = await po.rest('POST', '/api/work', { title: 'T3 contested item', kind: 'task', domain: 'infra', created_by: po.identity });
  const wid = created.body?.item?.id;
  ok(created.ok && Number.isInteger(wid), `work item created (#${wid})`);
  const [ca, ci] = await Promise.all([
    app.rest('POST', `/api/work/${wid}/claim`, { owner: app.identity }),
    infra.rest('POST', `/api/work/${wid}/claim`, { owner: infra.identity }),
  ]);
  const statuses = [ca.status, ci.status].sort().join(',');
  ok(statuses === '200,409', `exactly one claim won, the other got 409 (${ca.status} / ${ci.status})`);
  const [winner, loser, lost] = ca.ok ? [app, infra, ci] : [infra, app, ca];
  ok(lost.body?.reason === 'already_claimed' && lost.body?.owner === winner.identity, `the loser was told who holds it (${lost.body?.owner})`);

  // --- T4 ---------------------------------------------------------------------------------------
  console.log('T4 handoff → ACK → done');
  const stranger = await loser.rest('POST', `/api/work/${wid}/state`, { state: 'implementing', by: loser.identity });
  ok(stranger.status === 403 && stranger.body?.reason === 'not_owner', 'a non-owner cannot move a claimed item (403 not_owner)');
  const ho = await winner.rest('POST', `/api/work/${wid}/handoff`, { owner: loser.identity, by: winner.identity });
  ok(ho.ok && ho.body?.item?.owner === loser.identity, `owner handed #${wid} to ${loser.identity}`);
  const wake = await loser.waitMsg((m) => m.message_type === 'handoff' && m.content.includes(`work #${wid}`));
  ok(wake && wake.handoff, 'the new owner was woken »HANDOFF — ACK REQUIRED«');
  ok(got(winner, new RegExp(`work #${wid}`)).length === 0, 'the handoff notice did not wake the lane that sent it');
  const ack = await loser.ack('all', `work #${wid}`);
  ok(ack.ok, 'ack posted');
  const seenAck = await po.waitMsg((m) => m.sender === loser.identity && m.message_type === 'response' && m.content.startsWith('ACK'));
  ok(!!seenAck, 'the operator view shows the ack as a `response` starting "ACK"');
  const moved = await loser.rest('POST', `/api/work/${wid}/state`, { state: 'merged', by: loser.identity });
  ok(moved.ok && moved.body?.item?.state === 'merged', 'the NEW owner can move it');
  await loser.done('all', `work #${wid} landed`);
  const seenDone = await po.waitMsg((m) => m.sender === loser.identity && m.message_type === 'done');
  ok(!!seenDone && seenDone.msg.id > seenAck.msg.id, '`done` arrived as its own message type, after the ack');

  // --- T5 ---------------------------------------------------------------------------------------
  console.log('T5 failover continuity');
  // Let one replication pull land AFTER the T4 writes before killing the leader. Replication rides
  // the client's fixed 15s tick (issue 43), so anything newer than the last tick is legitimately
  // lost on an unclean kill — this test is about lanes surviving a failover, not that bound.
  {
    const { fileId } = await dev('fleet.mjs');
    const before = fileId(f.replicaPath(1))?.mtimeMs ?? 0;
    ok(await f.waitFor(() => (fileId(f.replicaPath(1))?.mtimeMs ?? 0) > before, 40000, 200), 'a replication pull landed after the T4 writes');
  }
  const killed = await f.killLeader({ clean: false });
  const nl = await f.waitSingleLeader({ timeoutMs: 60000, minEpoch: (killed?.epoch || 1) + 1 });
  ok(nl && nl.i !== killed.i, `leader node${killed?.i}@${killed?.epoch} killed → node${nl?.i}@${nl?.epoch} promoted`);
  // Lanes are told NOTHING. Each must find the new leader itself (send resolves per call; the
  // receiver re-discovers and re-attaches its socket).
  ok(await app.until(() => app.logs.some((x) => x.includes(`:${f.port(nl.i)}`) && /push connected/.test(x)), 45000), 'a lane on the DEAD leader\'s box re-attached its WebSocket to the promoted leader');
  const post = await infra.send('dm-app-lane', 'T5 after the failover');
  ok(post.ok, 'a lane posted through the promoted leader without being re-pointed');
  const after = await app.waitMsg((m) => /T5 after the failover/.test(m.content), 30000);
  await sleep(2500);   // one poll-fallback period: a push+backfill double delivery would show up here
  ok(after && got(app, /T5 after the failover/).length === 1, 'the DM was delivered to the re-attached lane EXACTLY once');
  const board = await po.rest('GET', `/api/work/${wid}`);
  ok(board.ok && board.body?.item?.owner === loser.identity && board.body?.item?.state === 'merged', 'work-board state (owner + merged) survived the failover');

  if (failed) console.error('❌ turnplay.test FAILED');
  else console.log('✅ turnplay.test: all assertions passed (join, addressing, claim-lock race, handoff→ACK→done, failover continuity)');
} catch (e) {
  failed = true;
  console.error('❌ turnplay.test ERROR:', e.stack || e.message);
} finally {
  for (const l of lanes) { try { await l.stop(); } catch {} }
  try { await f.down(); } catch {}
  if (failed) console.error(`(scratch kept for inspection: ${SCRATCH})`);
  else { for (let k = 0; k < 10 && existsSync(SCRATCH); k++) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} await sleep(200); } }
}
process.exit(failed ? 1 : 0);
