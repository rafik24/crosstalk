#!/usr/bin/env node
// ---------------------------------------------------------------------------
// evals/fixtures/evalbus.mjs — a SELF-TERMINATING scratch Crosstalk bus for the A4 obedience
// evals (issue #42). One real server/server.mjs in-process, loopback only, throwaway token,
// scratch config/cache/data — never the estate bus (:8787 / udp 8788 / ~/.crosstalk).
//
//   node evalbus.mjs --port 8831 --home <run HOME> --results <dir> [--handoff] [--ttl-s 600]
//
// `claude plugin eval` gives every run a private HOME (home/ under its temp dir) and runs the
// scaffold AND the session under it, with a scrubbed env. So the bus config is written where the
// plugin's clients look natively — <home>/.claude/.crosstalk — and cc-join.sh / cc-name / cc-ws /
// cc-ack find the eval bus with no env plumbing at all; their beacon + cache files land in that
// scratch home too, never in the operator's ~/.claude.
//
// <results>/bus-<port>.log records every register + message — the ground truth for the graders,
// independent of what the harness reports; <results>/evalbus.pid lets the next case's launch kill
// this bus (one bus at a time). It exits on its own after --ttl-s regardless.
//
// --handoff: play the PEER. Once a session names itself (an instance id whose short ends with
// `eval-handoff-lane`, the title the prompt tells the model to use) it DMs that lane a `handoff`
// »ACK REQUIRED«. The receiver seeds its cursor at start, so a DM that lands before cc-ws attaches
// is never backfilled — the handoff is re-sent every 12 s (max 4) until an ACK appears in the
// channel. Fallback: nothing named within FALLBACK_S ⇒ hand off to the newest non-supervisor
// instance (the hook's default id), so the case still exercises the ack rule.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const a = process.argv.slice(2);
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const PORT = Number(opt('--port', 8831));
const HOME = opt('--home', null);
const RESULTS = opt('--results', null);
const HANDOFF = a.includes('--handoff');
const TTL_S = Number(opt('--ttl-s', 600));
const FALLBACK_S = Number(opt('--fallback-s', 75));
if (!HOME || !RESULTS) { console.error('usage: evalbus.mjs --port N --home <dir> --results <dir> [--handoff] [--ttl-s N]'); process.exit(2); }
if (PORT < 8830 || PORT > 8849) { console.error(`refusing port ${PORT}: evals may only use 8830-8849`); process.exit(2); }

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const { startServer } = await import(pathToFileURL(join(ROOT, 'server', 'server.mjs')).href);
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const dataDir = join(HOME, 'evalbus-data');
mkdirSync(dataDir, { recursive: true }); mkdirSync(join(HOME, '.claude'), { recursive: true }); mkdirSync(RESULTS, { recursive: true });
const token = 'eval-' + randomBytes(12).toString('hex');
const base = `http://127.0.0.1:${PORT}`;
const LOG = join(RESULTS, `bus-${PORT}.log`);
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); try { appendFileSync(LOG, line + '\n'); } catch {} };

// The config every cc-*.mjs client + cc-join.sh reads. CC_PORT is load-bearing: discovery ALSO
// probes http://127.0.0.1:<CC_PORT>, which defaults to 8787 — the estate bus — and a higher epoch
// there would win the election. CC_DISCOVERY=peers with no CC_PEERS: no LAN / tailnet scan.
writeFileSync(join(HOME, '.claude', '.crosstalk'), [
  `CC_TOKEN=${token}`, `CC_BASE=${base}`, `CC_PORT=${PORT}`, `CC_BEACON_PORT=8899`,
  `CC_DISCOVERY=peers`, `CC_BIND=127.0.0.1`, `CC_PEERS=`,
].join('\n') + '\n');
writeFileSync(join(RESULTS, 'evalbus.pid'), String(process.pid));

const srv = await startServer({ port: PORT, apiKey: token, bind: '127.0.0.1', host: 'evalbus', epoch: 1, dataDir, log: () => {} });
log(`evalbus up ${base} (pid ${process.pid}, ttl ${TTL_S}s, handoff=${HANDOFF}, home ${HOME})`);

const H = { Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-cc-version': VERSION };
const get = async (p) => { try { const r = await fetch(base + p, { headers: H }); return r.ok ? await r.json() : null; } catch { return null; } };

const seenInst = new Map(); let lastMsgId = 0; let target = null, sends = 0, lastSend = 0, acked = false; const started = Date.now();
async function tick() {
  const inst = (await get('/api/instances'))?.instances || [];
  for (const i of inst) if (!seenInst.has(i.instance_id)) { seenInst.set(i.instance_id, Date.now()); log(`register ${i.instance_id} (${i.description || ''})`); }
  for (const ch of ['general', ...new Set(inst.map((i) => 'dm-' + (i.instance_id.split('/')[1] || '')))]) {
    const ms = (await get(`/api/messages/${ch}?limit=50`))?.messages || [];
    for (const m of ms) {
      if (m.id > lastMsgId) log(`msg #${m.channel} [${m.message_type}] ${m.sender}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 300)}`);
      if (m.message_type === 'response' && /^ACK/.test(m.content) && m.sender !== 'evalbus/po') acked = true;
    }
    lastMsgId = Math.max(lastMsgId, ...ms.map((m) => m.id));
  }
  if (!HANDOFF || acked || sends >= 4) return;
  if (!target) {
    const lanes = [...seenInst.entries()].filter(([id]) => !id.startsWith('cc-bus') && !id.startsWith('evalbus'));
    const named = lanes.find(([id]) => /eval-handoff-lane$/.test(id));
    target = named || (Date.now() - started > FALLBACK_S * 1000 ? lanes.sort((x, y) => y[1] - x[1])[0] : null) || null;
    if (target) lastSend = Date.now() - 4000;   // first send 8 s after the lane appeared
  }
  if (target && Date.now() - lastSend > 12000) {
    const [id] = target; const short = id.split('/')[1]; sends++; lastSend = Date.now();
    const r = await fetch(base + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({
      channel: `dm-${short}`, sender: 'evalbus/po', message_type: 'handoff',
      content: `@${id} HANDOFF — you now own eval item #42-A4 (write the obedience README). Ack this into this channel with cc-ack.mjs, then stop. (notice ${sends})`,
    }) });
    log(`handoff ${sends} -> dm-${short} (${id}) http ${r.status}`);
  }
}
const timer = setInterval(() => tick().catch((e) => log('tick error ' + e.message)), 2000);
setTimeout(async () => { log('ttl reached — exiting'); clearInterval(timer); try { await srv.close(); } catch {} process.exit(0); }, TTL_S * 1000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { clearInterval(timer); try { await srv.close(); } catch {} process.exit(0); });
