// ---------------------------------------------------------------------------
// receive-rewind.test.mjs — the receive engine against a DEEPLY rewound history (issue 46), with
// a stub bus so the rewind can be bigger than the engine's memory.   node test/receive-rewind.test.mjs
//
// cursor-rewind.test covers the ordinary case on a real fleet (a few ids lost, all inside the
// 500-entry seen-ring). This covers the fallback a fleet cannot cheaply reach: a promotion on a
// LONG-stale replica, where MORE ids were lost than the receiver remembers.
//
//   D1  600 messages seen → the new term serves only ids 1..90 and has written nothing yet:
//       the receiver must replay NOTHING (a cursor reset to 0 once re-delivered all 90 to every
//       receiver at the same moment) and park its cursor on the real tip, 90
//   D2  the new term's first message (id 91) is then delivered exactly once
// ---------------------------------------------------------------------------
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRATCH = mkdtempSync(join(tmpdir(), 'ccrxrw-'));
const PORT = Number(process.env.CC_TEST_PORT || 8796);
// Hermetic BEFORE the engine loads: scratch home (beacon), config, cache; discovery confined.
Object.assign(process.env, { HOME: SCRATCH, USERPROFILE: SCRATCH, CC_BUS_CONFIG: join(SCRATCH, 'none'), CC_CACHE_DIR: join(SCRATCH, 'cache'), CC_PORT: String(PORT), CC_BEACON_PORT: '8896', CC_DISCOVERY: 'peers', CC_PEERS: '' });
for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN']) delete process.env[k];

const { createReceiver } = await import('../src/cc-receive.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };

// --- the stub bus: REST only (no /cc/ws → the engine falls back to polling + keeps re-discovering)
const mk = (id, at) => ({ id, channel: 'general', sender: 'someone/else', content: `message ${id}`, message_type: 'message', created_at: at });
let epoch = 1;
let store = Array.from({ length: 600 }, (_, k) => mk(k + 1, '2026-01-01 00:00:00'));
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/cc/whoami') return json({ role: 'leader', host: 'stub', epoch, watermark: store.length ? store[store.length - 1].id : 0 });
  if (u.pathname === '/api/register') return json({ ok: true });
  if (u.pathname === '/api/channels') return json({ channels: [{ name: 'general' }] });
  if (u.pathname === '/api/messages/general') {
    const after = Number(u.searchParams.get('after_id') || 0);
    const messages = store.filter((m) => m.id > after);
    return json({ messages, last_id: messages.length ? messages[messages.length - 1].id : after });
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const delivered = [], logs = [];
const rx = createReceiver({ instance: 'box/rx', token: 't', pin: `http://127.0.0.1:${PORT}`, firehose: true, emit: (_r, m) => { delivered.push(m); }, log: (l) => logs.push(l), onVersionGate: () => {} });
try {
  await rx.start();
  ok(rx.cursors.general === 600 && delivered.length === 0, `seeded at the tip (cursor ${rx.cursors.general}) without replaying the backlog`);

  console.log('D1 the history is rewound far below everything the receiver remembers');
  store = store.slice(0, 90);   // a long-stale replica was promoted: ids 91..600 are gone…
  epoch = 2;                    // …under a new term, which has written NOTHING yet
  const end = Date.now() + 40000;
  while (Date.now() < end && !logs.some((l) => /history REWOUND on #general/.test(l))) await sleep(250);
  ok(logs.some((l) => /history REWOUND on #general/.test(l)), 'the receiver noticed the new term and the rewind');
  await sleep(4500);            // two poll periods: a reset-to-0 cursor would replay right here
  ok(delivered.length === 0, `nothing old was re-delivered (${delivered.length} message(s) replayed)`);
  ok(rx.cursors.general === 90, `cursor parked on the REAL tip (${rx.cursors.general})`);

  console.log('D2 the new term starts writing');
  store.push(mk(91, '2026-06-01 00:00:00'));
  const end2 = Date.now() + 15000;
  while (Date.now() < end2 && !delivered.length) await sleep(200);
  await sleep(2500);
  ok(delivered.length === 1 && delivered[0].id === 91, `the first new message is delivered exactly once (${delivered.map((m) => m.id).join(',') || 'none'})`);

  if (failed) console.error('❌ receive-rewind.test FAILED');
  else console.log('✅ receive-rewind.test: a rewind deeper than the seen-ring replays nothing and resumes cleanly');
} catch (e) {
  failed = true;
  console.error('❌ receive-rewind.test ERROR:', e.stack || e.message);
} finally {
  rx.stop();
  await new Promise((r) => srv.close(r));
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
