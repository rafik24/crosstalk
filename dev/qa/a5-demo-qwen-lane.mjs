#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A5 end-to-end demo (QA #42): a REAL Qwen Code session (qwen serve → local vLLM) joins an ISOLATED
// Crosstalk bus through a SessionStart hook, receives a DM through cc-qwen-bridge, and answers ON THE
// BUS by running the bus client from its own shell tool. Zero humans, zero Claude sessions.
//
//   node demo-qwen-lane.mjs <crosstalk-root-with-cc-qwen-bridge> [--keep]
//
// Isolation: scratch HOME (bus config, beacons), scratch QWEN_HOME (copy of the operator's model
// providers + a test hook), bus on 8797 / udp 8798, qwen serve on 4179. Prod bus, ~/.qwen and the
// vLLM server are only READ (vLLM is used for inference, never restarted).
// Shell permission requests are voted on by this driver: ALLOW only `node <root>/src/cc-codex.mjs …`.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(process.argv[2] || '.');
const KEEP = process.argv.includes('--keep');
const MODEL = process.env.QWEN_MODEL || 'qwen3.6-35b-a3b-fast';
const BUS_PORT = 8797, BEACON = 8798, SERVE_PORT = 4179;
const BUS = `http://127.0.0.1:${BUS_PORT}`, SERVE = `http://127.0.0.1:${SERVE_PORT}`;
const TOKEN = 'qa-' + randomBytes(12).toString('hex');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const RUN = mkdtempSync(join(tmpdir(), 'ct-qa-a5-'));
const HOME = join(RUN, 'home'), QH = join(RUN, 'qwen-home'), WORK = join(RUN, 'work');
const QWEN_ID = 'qa-box/qwen-lane', DRIVER_ID = 'qa-box/driver';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
const say = (...a) => console.log(T(), ...a);
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': VERSION };
const procs = [];
async function waitFor(fn, ms, every = 250) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return null; }
const J = async (url, init) => { const r = await fetch(url, init); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };

for (const d of [join(HOME, '.claude'), QH, WORK, join(RUN, 'data'), join(RUN, 'cache')]) mkdirSync(d, { recursive: true });
const cfg = join(HOME, '.claude', '.crosstalk');
writeFileSync(cfg, `CC_TOKEN=${TOKEN}\nCC_PORT=${BUS_PORT}\nCC_BEACON_PORT=${BEACON}\nCC_BASE=${BUS}\n`, { mode: 0o600 });
const busEnv = { PATH: process.env.PATH, HOME, CC_BUS_CONFIG: cfg, CC_DATA_DIR: join(RUN, 'data'), CC_CACHE_DIR: join(RUN, 'cache'), CC_HOST: 'qa-box', CC_PORT: String(BUS_PORT), CC_BEACON_PORT: String(BEACON) };

// --- the prototype join hook (what src/qwen-join.sh will become) --------------------------------
const CLIENT = join(ROOT, 'src', 'cc-codex.mjs'), BRIDGE = join(ROOT, 'src', 'cc-qwen-bridge.mjs');
const hook = join(RUN, 'qwen-join-proto.sh');
writeFileSync(hook, `#!/usr/bin/env bash
# PROTOTYPE Qwen SessionStart hook: register, start the bridge for THIS serve session, print the cheat-sheet.
sid="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).session_id||"")}catch{}})')"
[ -n "$sid" ] || exit 0
# Backgrounded + fully detached from the hook's stdio: the 3.3.3 one-shot clients linger ~9 s after finishing
# (pending discovery connects keep the event loop alive) and qwen serve aborts session init after ~10 s.
( node "${CLIENT}" join "${QWEN_ID}" "qwen lane (A5 demo)"; QWEN_SERVE_URL="${SERVE}" node "${BRIDGE}" ensure "${QWEN_ID}" --session "$sid" ) </dev/null >/dev/null 2>&1 &
disown
cat <<EOF
LIVE CHAT BUS — you are connected to the Crosstalk bus as: ${QWEN_ID}
Messages from other agents arrive as user turns that start with "CHAT #<channel> <sender> ...".
RULES: answer a message addressed to you by running exactly ONE shell command, then stop:
  node "${CLIENT}" send "${QWEN_ID}" <channel> "<your reply>" --type response
Use the SAME channel the message came in on (the word after "CHAT #"). Never paste tokens. Do not run any other command.
EOF
`);
chmodSync(hook, 0o755);
const settings = JSON.parse(readFileSync(join(homedir(), '.qwen', 'settings.json'), 'utf8'));
const qs = { env: settings.env, modelProviders: settings.modelProviders, security: settings.security, model: { ...(settings.model || {}), name: MODEL },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook, name: 'crosstalk-join-proto', timeout: 30 }] }] } };
writeFileSync(join(QH, 'settings.json'), JSON.stringify(qs, null, 2), { mode: 0o600 });

let rc = 1;
try {
  // 1. isolated bus
  const busLog = openSync(join(RUN, 'bus.log'), 'a');
  procs.push(spawn(process.execPath, [join(ROOT, 'src', 'cc-bus.mjs'), 'start'], { env: busEnv, stdio: ['ignore', busLog, busLog] }));
  const lead = await waitFor(async () => { const w = (await J(BUS + '/cc/whoami')).body; return w?.role === 'leader' ? w : null; }, 30000);
  if (!lead) throw new Error('isolated bus did not come up');
  say(`isolated bus up: leader@${lead.epoch} v${lead.version} on :${BUS_PORT}`);

  // 2. qwen serve (scratch QWEN_HOME + scratch HOME so the session's shell tool talks to the isolated bus)
  const qLog = openSync(join(RUN, 'qwen-serve.log'), 'a');
  procs.push(spawn('qwen', ['serve', '--port', String(SERVE_PORT), '--workspace', WORK], { cwd: WORK, env: { ...process.env, HOME, QWEN_HOME: QH, CC_BUS_CONFIG: cfg, CC_CACHE_DIR: join(RUN, 'cache') }, stdio: ['ignore', qLog, qLog] }));
  if (!await waitFor(async () => (await J(SERVE + '/health')).status === 200, 30000)) throw new Error('qwen serve did not come up');
  const sess = (await J(SERVE + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: WORK }) })).body;
  say(`qwen serve session ${sess.sessionId} (model ${MODEL})`);

  // 3. SSE: stream the session; vote on permission requests (allow ONLY the bus client)
  const transcript = []; const perms = [];
  (async () => {
    const r = await fetch(`${SERVE}/session/${sess.sessionId}/events`, { headers: { accept: 'text/event-stream' } });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        transcript.push(ev);
        if (ev.type === 'permission_request' || /permission_request/.test(data.slice(0, 200))) {
          perms.push(ev);
          const flat = JSON.stringify(ev);
          const okCmd = flat.includes(CLIENT) && / send /.test(flat) && !/[;&|`$]\s*(rm|curl|wget|bash|sh)\b/.test(flat);
          const reqId = ev.requestId || ev.data?.requestId || ev.payload?.requestId;
          const options = ev.options || ev.data?.options || ev.payload?.options || [];
          const pick = options.find((o) => (okCmd ? /allow.?once|proceed.?once/i : /reject|deny|cancel/i).test(o.kind || o.optionId || o.name || '')) || options[okCmd ? 0 : options.length - 1];
          say(`permission_request ${reqId}: ${okCmd ? 'ALLOW' : 'DENY'} (${pick?.optionId || '?'})`);
          const v = await J(`${SERVE}/permission/${reqId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome: { outcome: 'selected', optionId: pick?.optionId } }) });
          if (v.status >= 300) say('  vote →', v.status, JSON.stringify(v.body).slice(0, 300));
        }
      }
    }
  })().catch(() => {});

  // 4. the join hook must have registered the lane and started the bridge (beacon = proof of listening)
  const present = await waitFor(async () => { const l = (await J(BUS + '/api/instances', { headers: H })).body; return (l.instances || l).find((i) => i.instance_id === QWEN_ID && i.status === 'online'); }, 30000);
  const beacon = join(HOME, '.claude', '.cc-listen', QWEN_ID.replace(/[^A-Za-z0-9._-]/g, '_'));
  const armed = await waitFor(async () => existsSync(beacon), 30000);
  say(`join hook: presence=${present ? 'online' : 'MISSING'} bridge-beacon=${armed ? 'live' : 'MISSING'}`);
  if (!present || !armed) throw new Error('join hook did not bring the lane up — see ' + RUN);

  // 5. DM the Qwen lane with a question only a real model turn can answer, and wait for ITS reply on the bus
  const nonce = randomBytes(3).toString('hex'); const a = 17 + (Date.now() % 50), b = 23;
  const channel = 'dm-qwen-lane';
  const sent = (await J(BUS + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender: DRIVER_ID, message_type: 'request', content: `@${QWEN_ID} interop check ${nonce}: what is ${a} + ${b}? Reply on this channel with the number and the word ${nonce}.` }) })).body;
  say(`driver → #${channel} id ${sent.id}: "${a} + ${b}?" nonce ${nonce}`);
  const reply = await waitFor(async () => { const m = (await J(`${BUS}/api/messages/${channel}?limit=20`, { headers: H })).body.messages || []; return m.find((x) => (x.sender || x.instance_id) === QWEN_ID && x.id > sent.id); }, 180000, 500);
  if (!reply) { say('FAIL: no reply from the Qwen lane within 180 s'); }
  else {
    const ok = reply.content.includes(String(a + b)) && reply.content.includes(nonce);
    say(`qwen → #${channel} id ${reply.id} [${reply.message_type}]: ${JSON.stringify(reply.content.slice(0, 200))}`);
    say(ok ? `PASS: a real Qwen session received a bus DM via cc-qwen-bridge and answered on the bus (${a}+${b}=${a + b}, nonce ok) in ${((Date.now() - t0) / 1000).toFixed(0)} s` : 'FAIL: reply content wrong');
    rc = ok ? 0 : 1;
  }
  if (rc && perms.length) say('permission events seen:', JSON.stringify(perms[0]).slice(0, 600));
  if (rc) say('event types:', JSON.stringify([...new Set(transcript.map((e) => e.type))]));
} catch (e) { say('ERROR', e.message); }
finally {
  try { const pf = join(HOME, '.claude', '.cc-listen'); for (const f of existsSync(pf) ? (await import('node:fs')).readdirSync(pf) : []) if (f.endsWith('.bridge.pid')) { try { process.kill(Number(readFileSync(join(pf, f), 'utf8')), 'SIGTERM'); } catch {} } } catch {}
  for (const p of procs.reverse()) { try { spawn('pkill', ['-9', '-P', String(p.pid)]); p.kill('SIGTERM'); } catch {} }
  await sleep(1500);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  if (!KEEP && rc === 0) { try { rmSync(RUN, { recursive: true, force: true }); } catch {} } else say('kept: ' + RUN);
}
process.exit(rc);
