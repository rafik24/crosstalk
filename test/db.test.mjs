// db.test.mjs — storage-layer tests for Crosstalk's db.mjs.
//
// Plain node + node:assert. Forces the SQLite backend (deletes DATABASE_URL), points the
// data dir at a throwaway mkdtemp directory, and cleans both up in a finally. Run with:
//   node test/db.test.mjs
// Exits non-zero on the first failed assertion.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';   // reopen a snapshot to prove it round-trips

// Force SQLite BEFORE importing db.mjs — createDB() reads these at open time.
delete process.env.DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-test-'));
process.env.CC_DATA_DIR = dataDir;

const { createDB, normalizeChannelName, WORK_STATES, WORK_KINDS } = await import('../server/db.mjs');

let passed = 0;
const ok = (cond, label) => {
  assert.ok(cond, label);
  passed += 1;
};

let db;
try {
  // ── constants + normalizeChannelName ──────────────────────────────────────
  assert.deepEqual(WORK_STATES, [
    'queued',
    'claimed',
    'implementing',
    'in-review',
    'merged',
    'deployed',
    'blocked',
    'abandoned',
  ]);
  assert.deepEqual(WORK_KINDS, ['epic', 'task', 'bug']);
  ok(true, 'WORK_STATES / WORK_KINDS exported as specified');

  assert.equal(normalizeChannelName('  Hello World_Foo!! '), 'hello-world-foo');
  assert.equal(normalizeChannelName('---Multi   Space___Bar---'), 'multi-space-bar');
  assert.equal(normalizeChannelName('ALL@@@caps###'), 'allcaps');
  assert.equal(normalizeChannelName(''), '');
  ok(true, 'normalizeChannelName slugs as specified');

  // ── schema creates cleanly (proves the global-SERIAL fix) ──────────────────
  // If the second auto-increment table (work_items) had been left with a raw "SERIAL"
  // type on SQLite, createDB() would throw here. It doesn't — and below we confirm BOTH
  // messages and work_items actually auto-increment independently.
  db = await createDB();
  ok(db && typeof db.sendMessage === 'function', 'createDB() builds a db object');
  ok(db.db && typeof db.db.close === 'function', 'raw SQLite handle exposed as .db');

  const seeded = await db.listChannels();
  ok(seeded.some((c) => c.name === 'general'), 'general channel is seeded on init');

  // Both auto-increment PKs work — messages and work_items each mint numeric ids.
  const firstMsgId = await db.sendMessage('general', 'alice', 'first');
  ok(Number.isInteger(firstMsgId) && firstMsgId > 0, 'messages auto-increment (id > 0)');
  const firstWork = await db.createWorkItem({ title: 'first work item' });
  ok(Number.isInteger(firstWork.id) && firstWork.id > 0, 'work_items auto-increment (id > 0)');

  // ── presence round-trip ────────────────────────────────────────────────────
  await db.registerInstance('sess-a', 'Session A', 'rev-1');
  await db.registerInstance('sess-b', 'Session B', 'rev-9');
  let a1 = await db.getInstance('sess-a');
  ok(a1 && a1.status === 'online' && a1.rev === 'rev-1', 'registerInstance stores online + rev');

  ok((await db.heartbeat('sess-a')) === true, 'heartbeat returns true for a known instance');
  ok((await db.heartbeat('nobody')) === false, 'heartbeat returns false for an unknown instance');

  await db.markOffline('sess-b');
  ok((await db.getInstance('sess-b')).status === 'offline', 'markOffline flips status');

  // Deterministic staleness: register an instance, then backdate its last_seen an hour into
  // the past via the raw handle (test setup only). markStaleOffline(60) must flip it while
  // leaving the freshly-heartbeat sess-a online.
  await db.registerInstance('sess-stale', 'Old session', 'rev-0');
  db.db.prepare(`UPDATE instances SET last_seen = datetime('now', '-1 hours') WHERE instance_id = ?`).run('sess-stale');
  const flipped = await db.markStaleOffline(60);
  ok(flipped === 1, 'markStaleOffline flips exactly the stale online instance');
  ok((await db.getInstance('sess-stale')).status === 'offline', 'stale instance is now offline');
  ok((await db.getInstance('sess-a')).status === 'online', 'fresh instance stays online');

  const instances = await db.listInstances();
  ok(instances.length === 3, 'listInstances returns all instances');

  // ── channels ────────────────────────────────────────────────────────────
  await db.createChannel('random', 'Off topic');
  await db.createChannel('random', 'dup ignored'); // insert-or-ignore
  const chans = await db.listChannels();
  ok(chans.filter((c) => c.name === 'random').length === 1, 'createChannel is insert-or-ignore');

  const activity = await db.listChannelsWithActivity();
  const genActivity = activity.find((c) => c.name === 'general');
  ok(genActivity.message_count >= 1, 'listChannelsWithActivity counts messages');
  ok(String(genActivity.active_senders).includes('alice'), 'active_senders csv includes senders');

  const found = await db.findChannels('rand');
  ok(found.length === 1 && found[0].name === 'random', 'findChannels matches by LIKE');

  // ── messages ──────────────────────────────────────────────────────────────
  const m2 = await db.sendMessage('general', 'bob', 'second');
  const reply = await db.sendMessage('general', 'alice', 're: second', 'response', m2);

  const latest = await db.getMessages('general', 10);
  ok(latest[0].id === reply, 'getMessages is newest-first');
  const parentRow = latest.find((m) => m.id === m2);
  ok(Number(parentRow.reply_count) === 1, 'getMessages annotates reply_count');

  const since = await db.getMessagesSince('general', firstMsgId);
  ok(
    since.length === 2 && since.every((m) => m.id > firstMsgId),
    'getMessagesSince returns id>after, ascending',
  );

  const unreadForBob = await db.getUnread('general', 0, 'bob');
  ok(
    unreadForBob.length > 0 && unreadForBob.every((m) => m.sender !== 'bob'),
    'getUnread excludes the caller’s own messages',
  );

  ok((await db.getMessage(m2)).content === 'second', 'getMessage fetches by id');
  const replies = await db.getReplies(m2);
  ok(replies.length === 1 && replies[0].id === reply, 'getReplies returns direct replies');

  const search = await db.searchMessages('SECOND', 10);
  ok(search.length >= 1, 'searchMessages is case-insensitive LIKE');

  // ── read cursors (monotonic) ────────────────────────────────────────────
  ok((await db.getReadCursor('general', 'sess-a')) === undefined, 'cursor absent → undefined');
  await db.setReadCursor('general', 'sess-a', 10);
  ok((await db.getReadCursor('general', 'sess-a')) === 10, 'setReadCursor stores the id');
  await db.setReadCursor('general', 'sess-a', 5); // stale/backwards update
  ok((await db.getReadCursor('general', 'sess-a')) === 10, 'setReadCursor never regresses');
  await db.setReadCursor('general', 'sess-a', 25);
  ok((await db.getReadCursor('general', 'sess-a')) === 25, 'setReadCursor advances forward');

  // ── shared data ─────────────────────────────────────────────────────────
  const shared = await db.shareData('cfg', 'hello world', 'alice', 'a config blob');
  ok(shared.size_bytes === 11, 'shareData reports byte size');
  ok((await db.getSharedData('cfg')).content === 'hello world', 'getSharedData round-trips');
  await db.shareData('cfg', 'replaced', 'bob'); // upsert
  ok((await db.getSharedData('cfg')).content === 'replaced', 'shareData upserts on key');

  const dataList = await db.listSharedData();
  const cfgMeta = dataList.find((d) => d.key === 'cfg');
  ok(
    cfgMeta && cfgMeta.size_bytes === 8 && cfgMeta.content === undefined,
    'listSharedData is metadata-only with size_bytes',
  );
  ok((await db.deleteSharedData('cfg')) === true, 'deleteSharedData removes the key');
  ok((await db.getSharedData('cfg')) === undefined, 'deleted key is gone');

  // ── work board: ordering, state, transfer ─────────────────────────────────
  const epic = await db.createWorkItem({ title: 'Epic X', kind: 'epic', project: 'proj1' });
  const child1 = await db.createWorkItem({
    title: 'Child 1',
    parent_id: epic.id,
    project: 'proj1',
  });
  const child2 = await db.createWorkItem({
    title: 'Child 2',
    parent_id: epic.id,
    project: 'proj1',
  });

  const items = await db.listWorkItems({ project: 'proj1' });
  const order = items.map((i) => i.id);
  ok(
    order[0] === epic.id && order[1] === child1.id && order[2] === child2.id,
    'listWorkItems groups the epic before its children',
  );

  ok((await db.getWorkItem(epic.id)).title === 'Epic X', 'getWorkItem fetches by id');

  await db.setWorkItemState(child1.id, 'implementing');
  ok((await db.getWorkItem(child1.id)).state === 'implementing', 'setWorkItemState updates state');

  const owned = await db.createWorkItem({ title: 'born owned', owner: 'zoe' });
  ok(owned.owner === 'zoe' && owned.claimed_at, 'createWorkItem stamps claimed_at when owned');
  ok(owned.state === 'claimed', 'an owned item defaults to claimed, never owned-but-queued');

  // An explicit state still wins over the owned→claimed default.
  const ownedBlocked = await db.createWorkItem({ title: 'owned+blocked', owner: 'zoe', state: 'blocked' });
  ok(ownedBlocked.state === 'blocked', 'an explicit state overrides the owned→claimed default');

  // No owner and no explicit state still starts queued.
  const plain = await db.createWorkItem({ title: 'plain' });
  ok(plain.state === 'queued' && plain.owner === null, 'an unowned item defaults to queued');

  // ── ATOMIC CLAIM RACE (the core mutex) ─────────────────────────────────────
  const race = await db.createWorkItem({ title: 'contended' });
  ok(race.state === 'queued' && race.owner === null, 'new item starts queued + unowned');

  const claimA = await db.claimWorkItem(race.id, 'A');
  ok(claimA.claimed === true && claimA.item.owner === 'A', 'A wins the claim');
  ok(claimA.item.state === 'claimed', 'queued → claimed on first claim');

  const claimB = await db.claimWorkItem(race.id, 'B');
  ok(claimB.claimed === false, 'B loses — claimed:false');
  ok(claimB.item.owner === 'A', 'owner stays A after B’s failed claim');

  const claimAgain = await db.claimWorkItem(race.id, 'A');
  ok(claimAgain.claimed === true && claimAgain.item.owner === 'A', 'A re-claim is idempotent');

  await db.transferWorkItem(race.id, null); // release
  ok((await db.getWorkItem(race.id)).owner === null, 'transfer(null) releases ownership');

  const claimC = await db.claimWorkItem(race.id, 'C');
  ok(claimC.claimed === true && claimC.item.owner === 'C', 'after release, C can claim');

  await db.transferWorkItem(race.id, 'D');
  ok((await db.getWorkItem(race.id)).owner === 'D', 'transfer reassigns to a new owner');

  // ── listWorkItems: states[] + updated_after filters ────────────────────────
  const fq = await db.createWorkItem({ title: 'filt queued', project: 'filt' }); // queued
  const fc = await db.createWorkItem({ title: 'filt claimed', project: 'filt', owner: 'x' }); // claimed
  const fm = await db.createWorkItem({ title: 'filt merged', project: 'filt', state: 'merged' });

  // states (array) → state IN (...)
  const inQueuedClaimed = await db.listWorkItems({ project: 'filt', states: ['queued', 'claimed'] });
  ok(
    inQueuedClaimed.length === 2 &&
      inQueuedClaimed.some((i) => i.id === fq.id) &&
      inQueuedClaimed.some((i) => i.id === fc.id) &&
      !inQueuedClaimed.some((i) => i.id === fm.id),
    'listWorkItems states[] matches state IN (...)',
  );

  // single `state` still works on its own.
  const onlyMerged = await db.listWorkItems({ project: 'filt', state: 'merged' });
  ok(
    onlyMerged.length === 1 && onlyMerged[0].id === fm.id,
    'listWorkItems single state filter still works',
  );

  // states[] takes precedence over a single `state` when both are given.
  const bothGiven = await db.listWorkItems({
    project: 'filt',
    state: 'merged',
    states: ['queued', 'claimed'],
  });
  ok(
    bothGiven.length === 2 && !bothGiven.some((i) => i.id === fm.id),
    'listWorkItems prefers states[] over a single state',
  );

  // updated_after → only items touched since the given timestamp. Backdate deterministically
  // via the raw handle (test setup only) so the comparison isn't at the mercy of clock ticks.
  db.db.prepare(`UPDATE work_items SET updated_at = ? WHERE id = ?`).run('2020-01-01 00:00:00', fq.id);
  db.db.prepare(`UPDATE work_items SET updated_at = ? WHERE id = ?`).run('2020-06-01 00:00:00', fc.id);
  db.db.prepare(`UPDATE work_items SET updated_at = ? WHERE id = ?`).run('2020-06-01 00:00:00', fm.id);
  const touchedSince = await db.listWorkItems({ project: 'filt', updated_after: '2020-03-01 00:00:00' });
  ok(
    touchedSince.length === 2 && !touchedSince.some((i) => i.id === fq.id),
    'listWorkItems updated_after filters by updated_at',
  );

  // updated_after composes with states[].
  const touchedAndMerged = await db.listWorkItems({
    project: 'filt',
    states: ['merged'],
    updated_after: '2020-03-01 00:00:00',
  });
  ok(
    touchedAndMerged.length === 1 && touchedAndMerged[0].id === fm.id,
    'listWorkItems composes updated_after with states[]',
  );

  // ── maintenance ─────────────────────────────────────────────────────────
  const counts = await db.cleanup(7);
  ok(
    typeof counts.messages === 'number' &&
      typeof counts.instances === 'number' &&
      typeof counts.shared_data === 'number' &&
      typeof counts.read_cursors === 'number',
    'cleanup returns per-table counts',
  );
  // Recent rows survive a 7-day cleanup.
  ok((await db.getMessage(m2)) !== undefined, 'cleanup keeps fresh messages');

  // snapshot — the `VACUUM INTO` path (export + replication + migrate). This is the riskiest
  // line in the node:sqlite port, so don't just check the file is non-empty: REOPEN it as a real
  // SQLite DB and assert every table round-trips against the live counts. Also snapshot twice to
  // the SAME path — VACUUM INTO refuses an existing file, so this exercises the rm-then-vacuum
  // overwrite (a broken safeDest escape or a missing rm would turn one of these red).
  const snapPath = path.join(dataDir, 'snap.db');
  await db.snapshot(snapPath);
  await db.snapshot(snapPath); // second write to the same dest must not throw
  ok(fs.existsSync(snapPath) && fs.statSync(snapPath).size > 0, 'snapshot writes a backup file');
  const liveCount = (t) => db.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  // Guard the teeth: the round-trip check only bites while the source has rows, so assert the
  // live DB is non-empty here (a future reorder that empties it would otherwise make the loop pass
  // vacuously against an empty snapshot).
  ok(liveCount('messages') > 0 && liveCount('channels') > 0, 'live DB is non-empty before snapshot');
  const snap = new DatabaseSync(snapPath);
  try {
    for (const t of ['messages', 'channels', 'instances', 'shared_data', 'work_items', 'read_cursors']) {
      ok(
        snap.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c === liveCount(t),
        `snapshot round-trips ${t} (count matches live DB, non-vacuous)`,
      );
    }
  } finally {
    snap.close();
  }

  console.log(`\n  db.test.mjs: ${passed} checks passed ✓\n`);
} catch (err) {
  console.error('\n  db.test.mjs FAILED:\n', err);
  process.exitCode = 1;
} finally {
  try {
    if (db) await db.close();
  } catch {
    /* ignore close errors during teardown */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
