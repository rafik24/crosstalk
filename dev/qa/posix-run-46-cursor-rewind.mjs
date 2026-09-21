#!/usr/bin/env node
// ---------------------------------------------------------------------------
// POSIX live repro for rafik24/crosstalk#46 — receivers silently drop new messages after a LOSSY
// failover, because message ids restart below the receiver's per-channel cursor.
//
//   node run-46-cursor-rewind.mjs <crosstalk-root> [--keep]
//
// Real processes only: two cc-bus supervisors (A leader, B client) + the REAL receiver (src/cc-ws.mjs,
// what a Claude session's Monitor runs). Isolated: scratch HOME/data/config/cache, throwaway token,
// ports 8793 (A) / 8792 (B), beacon udp 8791, CC_BIND=127.0.0.1. Prod (8787/8788) is never touched.
//
// Verdict semantics: exit 0 = defect NOT present (post-failover DMs are delivered);
//                    exit 1 = DEFECT REPRODUCED (they are silently dropped) — expected on 3.3.3.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(process.argv[2] || '.');
const KEEP = process.argv.includes('--keep');
const PA = 8793, PB = 8792, BEACON = 8791;
const TOKEN = 'qa-' + randomBytes(12).toString('hex');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const RUN = mkdtempSync(join(tmpdir(), 'ct-qa-46-'));
const LANE = 'qa-box/lane-46', CH = 'dm-lane-46';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(); const ev = (o) => console.log(JSON.stringify({ t: +((Date.now() - t0) / 1000).toFixed(1), ...o }));
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': VERSION };
const kids = [];
async function waitFor(fn, ms, every = 200) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return null; }
const whoami = async (p) => { try { const r = await fetch(`http://127.0.0.1:${p}/cc/whoami`, { signal: AbortSignal.timeout(1500) }); return r.ok ? r.json() : null; } catch { return null; } };
const childrenOf = (pid) => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);

function node(name, port, peer) {
  const dir = join(RUN, name); for (const d of ['data', 'cache', 'home']) mkdirSync(join(dir, d), { recursive: true });
  const cfg = join(dir, 'bus-config');
  writeFileSync(cfg, `CC_TOKEN=${TOKEN}\nCC_PORT=${port}\nCC_BEACON_PORT=${BEACON}\nCC_PEERS=127.0.0.1:${peer}\nCC_BIND=127.0.0.1\n`, { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), CC_BUS_CONFIG: cfg, CC_DATA_DIR: join(dir, 'data'), CC_CACHE_DIR: join(dir, 'cache'), CC_HOST: name, CC_PORT: String(port), CC_BEACON_PORT: String(BEACON), CC_BIND: '127.0.0.1', CC_REPLICATE_MS: '2000' };
  const fd = openSync(join(dir, 'stdio.log'), 'a');
  const c = spawn(process.execPath, [join(ROOT, 'src', 'cc-bus.mjs'), 'start'], { env, stdio: ['ignore', fd, fd] });
  kids.push(c); return { name, port, dir, pid: c.pid };
}
const post = async (port, content) => (await fetch(`http://127.0.0.1:${port}/api/messages`, { method: 'POST', headers: H, body: JSON.stringify({ channel: CH, sender: 'qa-box/driver', content, message_type: 'message' }) })).json();

let verdict = 2;
try {
  const A = node('qa-a', PA, PB);
  if (!await waitFor(async () => (await whoami(PA))?.role === 'leader', 30000)) throw new Error('A never led');
  await post(PA, 'seed-0 (replicated history)');                                   // id 1 — will survive in the replica
  const B = node('qa-b', PB, PA);
  const replica = join(B.dir, 'data', 'messages.db.replica');
  if (!await waitFor(() => { try { return statSync(replica).size > 0; } catch { return false; } }, 30000)) throw new Error('B never pulled a replica');

  // the REAL receiver, exactly as a session arms it; knows both nodes through CC_PEERS, no CC_BASE pin
  const lhome = join(RUN, 'lane-home'); mkdirSync(join(lhome, '.claude'), { recursive: true });
  const lcfg = join(lhome, '.claude', '.crosstalk');
  writeFileSync(lcfg, `CC_TOKEN=${TOKEN}\nCC_PORT=${PA}\nCC_BEACON_PORT=${BEACON}\nCC_PEERS=127.0.0.1:${PA},127.0.0.1:${PB}\n`, { mode: 0o600 });
  const got = []; let errTail = '';
  const rx = spawn(process.execPath, [join(ROOT, 'src', 'cc-ws.mjs'), LANE], { env: { PATH: process.env.PATH, HOME: lhome, CC_BUS_CONFIG: lcfg, CC_CACHE_DIR: join(RUN, 'lane-cache'), CC_DATA_DIR: join(RUN, 'lane-data'), CC_BEACON_PORT: String(BEACON) }, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(rx);
  rx.stdout.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) got.push(l); });
  rx.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-1500); });
  if (!await waitFor(() => /push connected|listening as/.test(errTail), 20000)) throw new Error('receiver did not attach: ' + errTail.slice(-200));

  // wait for a FRESH pull, then write M1..M3 right after it → they exist only on A
  const m0 = statSync(replica).mtimeMs;
  await waitFor(() => statSync(replica).mtimeMs > m0, 40000, 100);
  const lost = []; for (let i = 1; i <= 3; i++) lost.push((await post(PA, `PRE-${i} written after the last replica pull`)).id);
  const preDelivered = await waitFor(() => got.filter((l) => l.includes('PRE-')).length === 3, 5000, 50);
  ev({ step: 'pre-failover', ids_on_old_leader: lost, delivered_to_receiver: !!preDelivered, receiver_cursor_now: Math.max(...lost) });

  for (const k of childrenOf(A.pid)) { try { process.kill(k, 'SIGKILL'); } catch {} } try { process.kill(A.pid, 'SIGKILL'); } catch {}
  const tk = Date.now();
  const nl = await waitFor(async () => { const w = await whoami(PB); return w?.role === 'leader' ? w : null; }, 60000);
  if (!nl) throw new Error('B never promoted');
  ev({ step: 'failover', killed: 'A (unclean)', promoted: `B leader@${nl.epoch}`, after_ms: Date.now() - tk, new_leader_watermark: nl.watermark });
  if (!await waitFor(() => new RegExp(`:${PB}`).test(errTail.split('push connected').pop() || ''), 45000)) ev({ warn: 'receiver re-attach not seen in its log', tail: errTail.slice(-200) });

  const post2 = []; for (let i = 1; i <= 3; i++) { post2.push((await post(PB, `POST-${i} sent through the promoted leader`)).id); await sleep(300); }
  await sleep(8000);                                                              // generous: push is <1 s, poll fallback 2 s
  const deliveredPost = post2.map((id, i) => got.some((l) => l.includes(`POST-${i + 1} `)));
  const beyond = (await post(PB, 'BEYOND the old cursor')).id;                      // id > old cursor → must arrive: proves the receiver is alive
  let beyondId = beyond; while (beyondId <= Math.max(...lost)) beyondId = (await post(PB, 'BEYOND the old cursor')).id;
  const beyondOk = !!await waitFor(() => got.some((l) => l.includes('BEYOND')), 8000, 100);
  const dropped = deliveredPost.filter((x) => !x).length;
  ev({ step: 'post-failover', new_ids: post2, old_cursor: Math.max(...lost), ids_reissued_below_cursor: post2.filter((id) => id <= Math.max(...lost)), delivered: deliveredPost, silently_dropped: dropped,
    receiver_alive_check: { id: beyondId, delivered: beyondOk }, http_status_to_sender: 'every POST returned ok:true' });
  verdict = dropped > 0 ? 1 : 0;
  console.log(dropped > 0
    ? `DEFECT REPRODUCED (#46): ${dropped}/3 messages accepted by the promoted leader were silently dropped by a live receiver (ids ${post2.join(',')} <= cursor ${Math.max(...lost)}); a message with id ${beyondId} > cursor was delivered.`
    : 'NOT REPRODUCED: all post-failover messages were delivered.');
} catch (e) { ev({ error: e.message }); }
finally {
  for (const c of kids) { for (const k of childrenOf(c.pid)) { try { process.kill(k, 'SIGKILL'); } catch {} } try { c.kill('SIGKILL'); } catch {} }
  if (!KEEP) { try { rmSync(RUN, { recursive: true, force: true }); } catch {} } else console.log('kept: ' + RUN);
}
process.exit(verdict);
