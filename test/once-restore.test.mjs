// Persisted-cursor RESTORE edges for cc-ws --once (crosstalk-reviewer, 2026-10-08). Stub bus, no
// framework.   node test/once-restore.test.mjs
//
// A --once receiver is a NEW process on every wake, so everything a long-lived receiver keeps in
// memory across a failover (leader epoch, the seen-signature ring, which channels are old) must
// survive the exit → re-arm gap in the cursor file, or the gap becomes a loss/duplication window:
//   R1. a TERM change with a REWOUND history during the gap → the re-issued id is delivered (was LOST, F1);
//   R2. a loss-free term change (identical history), in the gap or after the restored start →
//       nothing re-delivered (was a whole-channel FLOOD, F2);
//   R3. same term, plain gap → exactly the gap is delivered;
//   R4. stop({save:false}) mid-backfill (a superseded receiver) → the file is left untouched (F3);
//   R5. stop() mid-backfill → no cursor persisted for a channel whose messages were not delivered (F3);
//   R6. a channel LISTED by the last run but never seeded is seeded at the tip, while a channel
//       never listed (created in the gap) is replayed (F5);
//   R7. a file written under another receive SCOPE, or in the old v1 shape, is ignored (F5).
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cconce-restore-'));
const PORT = 8798;
Object.assign(process.env, { HOME: SCRATCH, USERPROFILE: SCRATCH, CC_BUS_CONFIG: join(SCRATCH, 'none'), CC_CACHE_DIR: join(SCRATCH, 'cache'), CC_PORT: String(PORT), CC_BEACON_PORT: '8895', CC_DISCOVERY: 'peers', CC_PEERS: '' });
for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN']) delete process.env[k];
const { createReceiver } = await import('../src/cc-receive.mjs');
const { whoamiProof } = await import('../src/cc-proof.mjs');
const TOKEN = 't';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sigOf = (m) => `${m.sender}|${m.created_at}|${(m.content || '').length}|${(m.content || '').slice(0, 48)}`;   // = cc-receive's
const mk = (channel, id, at = '2026-01-01 00:00:00', content = `DM ${id}`) => ({ id, channel, sender: 'peer/x', content, message_type: 'message', created_at: at });

// --- the stub bus: mutable epoch + per-channel stores + optional per-fetch delay ---
const bus = { epoch: 1, chans: {}, delay: 0, fail: new Set() };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/cc/whoami') {
    const n = u.searchParams.get('nonce');
    return json({ role: 'leader', host: 'stub', epoch: bus.epoch, watermark: 0, ...(n ? { proof: whoamiProof(TOKEN, n, 'stub', bus.epoch, 0, req.socket.localAddress, req.socket.localPort) } : {}) });
  }
  if (u.pathname === '/api/register') return json({ ok: true });
  if (u.pathname === '/api/channels') return json({ channels: Object.keys(bus.chans).map((name) => ({ name })) });
  const m = u.pathname.match(/^\/api\/messages\/(.+)$/);
  if (m) {
    if (bus.delay) await sleep(bus.delay);
    if (bus.fail.has(decodeURIComponent(m[1]))) { res.statusCode = 500; return res.end(); }
    const after = Number(u.searchParams.get('after_id') || 0);
    const messages = (bus.chans[decodeURIComponent(m[1])] || []).filter((x) => x.id > after);
    return json({ messages, last_id: messages.length ? messages[messages.length - 1].id : after });   // = the real server's echo
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

let n = 0;
function fileWith(obj) { const f = join(SCRATCH, `rx${++n}.cursors.json`); writeFileSync(f, JSON.stringify(obj)); return f; }
const v2 = (o) => ({ v: 2, saved_at: Date.now(), scope: 'addressed', epoch: 1, channels: ['dm-rx'], ...o });
// Run one receiver against the bus; resolves what it delivered (channel#id).
async function run(cursorFile, { ms = 3500, onEmit = null, save = false } = {}) {
  const delivered = [];
  let rx;
  rx = createReceiver({
    instance: 'box/rx', token: TOKEN, pin: `http://127.0.0.1:${PORT}`, cursorFile,
    emit: (_r, msg) => { delivered.push(`${msg.channel}#${msg.id}`); onEmit && onEmit(rx, delivered); },
    log: () => {}, onVersionGate: () => {},
  });
  rx.start().catch(() => {});
  await sleep(ms);
  rx.stop({ save });
  return { delivered, rx };
}

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

try {
  const hist = Array.from({ length: 50 }, (_, k) => mk('dm-rx', k + 1));
  const savedSeen = { 'dm-rx': hist.slice(-16).map((m) => [m.id, sigOf(m)]) };

  // R1: unclean failover in the gap — new term serves its snapshot (1..40) and re-issues id 41
  bus.epoch = 2; bus.chans = { 'dm-rx': [...hist.slice(0, 40), mk('dm-rx', 41, '2026-06-01 00:00:00', 'NEW TERM DM')] };
  let r = await run(fileWith(v2({ cursors: { 'dm-rx': 50 }, seen: savedSeen })));
  ok(r.delivered.join() === 'dm-rx#41', `R1: re-issued id after a rewind in the gap is delivered (got ${r.delivered.join() || 'nothing'})`);
  ok(r.rx.cursors['dm-rx'] === 41, `R1: cursor pulled back to the new tip (got ${r.rx.cursors['dm-rx']})`);

  // R2: loss-free handover in the gap — identical history, only the term moved
  bus.epoch = 2; bus.chans = { 'dm-rx': hist };
  r = await run(fileWith(v2({ cursors: { 'dm-rx': 50 }, seen: savedSeen })));
  ok(r.delivered.length === 0, `R2: loss-free term change re-delivers nothing (got ${r.delivered.length})`);
  // R2b: …and the same handover AFTER a restored start (the reviewer's flood repro): the restored
  // seen-ring must make the reconcile see "intact". The stub has no /cc/ws, so the receiver's
  // reconnect loop re-discovers (≤15s backoff) and notices the new epoch.
  bus.epoch = 1;
  setTimeout(() => { bus.epoch = 2; }, 2000);
  r = await run(fileWith(v2({ cursors: { 'dm-rx': 50 }, seen: savedSeen })), { ms: 25000 });
  ok(r.delivered.length === 0, `R2b: a term change after a restored start re-delivers nothing (got ${r.delivered.length})`);

  // R3: same term, plain gap
  bus.epoch = 1; bus.chans = { 'dm-rx': [...hist, mk('dm-rx', 51), mk('dm-rx', 52)] };
  r = await run(fileWith(v2({ cursors: { 'dm-rx': 50 }, seen: savedSeen })));
  ok(r.delivered.join() === 'dm-rx#51,dm-rx#52', `R3: exactly the gap is delivered (got ${r.delivered.join()})`);

  // R4 + R5: stop mid-backfill (slow fetches; stop right after the first delivery)
  bus.epoch = 1; bus.delay = 600;
  bus.chans = { 'dm-rx': [1, 2, 3, 4, 5, 6].map((i) => mk('dm-rx', i)), 'dm-rx-new': [1, 2, 3].map((i) => mk('dm-rx-new', i)) };
  const before = JSON.stringify(v2({ cursors: { 'dm-rx': 5 }, seen: {} }));
  let f = fileWith(JSON.parse(before));
  const orig = readFileSync(f, 'utf8');
  await run(f, { ms: 4000, onEmit: (rx, d) => { if (d.length === 1) setTimeout(() => rx.stop({ save: false }), 50); } });
  ok(readFileSync(f, 'utf8') === orig, 'R4: a superseded (save:false) stop leaves the cursor file untouched');
  f = fileWith(JSON.parse(before));
  const r5 = await run(f, { ms: 4000, onEmit: (rx, d) => { if (d.length === 1) setTimeout(() => rx.stop(), 50); } });
  const saved = JSON.parse(readFileSync(f, 'utf8'));
  const newDelivered = r5.delivered.filter((x) => x.startsWith('dm-rx-new')).length;
  ok(!(saved.cursors['dm-rx-new'] > newDelivered), `R5: no cursor persisted past undelivered messages (file dm-rx-new=${saved.cursors['dm-rx-new']}, delivered ${newDelivered})`);
  bus.delay = 0;

  // R6: listed-but-unseeded channel vs. a channel created in the gap — a REAL two-run sequence (the
  // engine writes the file itself), not a hand-built file: run 1's seed fetch of dm-rx-old fails.
  bus.epoch = 1;
  bus.chans = { 'dm-rx': hist, 'dm-rx-old': [1, 2, 3].map((i) => mk('dm-rx-old', i)) };
  bus.fail = new Set(['dm-rx-old']);
  f = join(SCRATCH, 'r6.cursors.json');
  await run(f, { ms: 2500, save: true });
  const r6file = JSON.parse(readFileSync(f, 'utf8'));
  ok(r6file.channels.includes('dm-rx-old') && r6file.cursors['dm-rx-old'] === undefined, 'R6: run 1 saved the failed channel as LISTED with no cursor');
  bus.fail = new Set();
  bus.chans['dm-rx-gap'] = [1, 2].map((i) => mk('dm-rx-gap', i));   // created during the gap
  r = await run(f);
  ok(!r.delivered.some((x) => x.startsWith('dm-rx-old')), 'R6: a channel the last run listed (failed seed) is NOT replayed whole');
  ok(r.delivered.filter((x) => x.startsWith('dm-rx-gap')).join() === 'dm-rx-gap#1,dm-rx-gap#2', 'R6: a channel created in the gap IS replayed');

  // R7: another scope / the v1 shape → ignored (fresh seed at the tip: nothing replayed)
  bus.chans = { 'dm-rx': [...hist, mk('dm-rx', 51)] };
  r = await run(fileWith(v2({ scope: 'channel:dm-rx', cursors: { 'dm-rx': 50 }, seen: savedSeen })));
  ok(r.delivered.length === 0, `R7: a file from another receive scope is ignored (got ${r.delivered.join() || 'nothing'})`);
  r = await run(fileWith({ saved_at: Date.now(), cursors: { 'dm-rx': 50 } }));
  ok(r.delivered.length === 0, `R7: a v1 (cursors-only) file is ignored (got ${r.delivered.join() || 'nothing'})`);
} catch (e) {
  failed = true;
  console.error('❌ once-restore.test threw:', e.stack || e.message);
} finally {
  srv.close();
}
if (failed) { console.error('❌ once-restore.test FAILED'); process.exit(1); }
console.log('✅ once-restore.test: all assertions passed (rewind in gap, loss-free term change, plain gap, stop mid-backfill, listed-vs-new channels, scope/v1 ignored)');
process.exit(0);
