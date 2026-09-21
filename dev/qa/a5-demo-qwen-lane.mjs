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
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, existsSync } from 'node:fs';
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
let QWEN_ID = null; const DRIVER_ID = 'qa-box/driver';
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

// --- the REAL hook wiring: hooks/qwen-hooks.json with <plugin-src> substituted -----------------------
const CLIENT = join(ROOT, 'src', 'cc-codex.mjs'), GATE = join(ROOT, 'src', 'cc-listen-gate.mjs');
const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'qwen-hooks.json'), 'utf8').replaceAll('<plugin-src>', join(ROOT, 'src'))).hooks;
const settings = JSON.parse(readFileSync(join(homedir(), '.qwen', 'settings.json'), 'utf8'));
const qs = { env: settings.env, modelProviders: settings.modelProviders, security: settings.security, model: { ...(settings.model || {}), name: MODEL },
  // qwen serve runs in approval mode `auto`: an LLM classifier DENIES the bus send as "external messaging" (measured).
  // The lane therefore needs ONE explicit allow rule — the bus client, nothing else. No "*".
  permissions: { allow: [`Bash(node ${CLIENT} *)`, `Bash(node "${CLIENT}" *)`] },
  hooks };
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
  procs.push(spawn('qwen', ['serve', '--port', String(SERVE_PORT), '--workspace', WORK], { cwd: WORK, env: { ...process.env, HOME, QWEN_HOME: QH, QWEN_SERVE_URL: SERVE, CC_BUS_CONFIG: cfg, CC_CACHE_DIR: join(RUN, 'cache') }, stdio: ['ignore', qLog, qLog] }));
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

  // 4. qwen-join.sh must have minted the id, registered the lane and started the bridge (beacon = proof of listening)
  const LISTEN = join(HOME, '.claude', '.cc-listen');
  const gate = (sid, tool, file) => { const r = spawnSync(process.execPath, [GATE], { env: { PATH: process.env.PATH, HOME }, input: JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, cwd: WORK }), encoding: 'utf8' }); return { code: r.status, err: (r.stderr || '').split('\n')[0].slice(0, 120) }; };
  QWEN_ID = await waitFor(async () => { try { return readFileSync(join(LISTEN, sess.sessionId + '.id'), 'utf8').trim(); } catch { return null; } }, 15000);
  if (!QWEN_ID) throw new Error('qwen-join.sh did not write the session id file');
  const g0 = gate(sess.sessionId, 'write_file', join(WORK, 'x.txt'));
  say(`identity ${QWEN_ID}; listen gate BEFORE the bridge beacon: exit ${g0.code} ${g0.code === 2 ? '(BLOCKED — correct)' : '(bridge already live)'} ${g0.err}`);
  const present = await waitFor(async () => { const l = (await J(BUS + '/api/instances', { headers: H })).body; return (l.instances || l).find((i) => i.instance_id === QWEN_ID && i.status === 'online'); }, 30000);
  const beacon = join(LISTEN, QWEN_ID.replace(/[^A-Za-z0-9._-]/g, '_'));
  const armed = await waitFor(async () => existsSync(beacon), 40000);
  say(`join hook: presence=${present ? 'online' : 'MISSING'} bridge-beacon=${armed ? 'live' : 'MISSING'}`);
  if (!present || !armed) throw new Error('join hook did not bring the lane up — see ' + RUN);
  const g1 = gate(sess.sessionId, 'write_file', join(WORK, 'x.txt')), g2 = gate(sess.sessionId, 'edit', join(WORK, 'x.txt')), g3 = gate('no-such-session', 'write_file', join(WORK, 'x.txt'));
  say(`listen gate AFTER: write_file exit ${g1.code}, edit exit ${g2.code} (0 = allowed); a session with NO beacon: exit ${g3.code} (2 = blocked)`);
  if (g1.code !== 0 || g2.code !== 0 || g3.code !== 2) throw new Error('listen gate misbehaved for Qwen tool names');

  if (process.env.A5_PROBE) {
    await J(`${SERVE}/session/${sess.sessionId}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: [{ type: 'text', text: 'Do not run any tool. Quote verbatim the line from your context that starts with "Send:" and the line that starts with the warning sign about how to reply. If you have no such lines say NO-BUS-CONTEXT.' }] }) });
    await waitFor(async () => transcript.some((e) => e.type === 'turn_complete'), 60000);
    const txt = []; const walk = (o) => { if (o && typeof o === 'object') { if (typeof o.text === 'string') txt.push(o.text); Object.values(o).forEach(walk); } }; transcript.forEach(walk);
    say('PROBE answer (tail):', JSON.stringify(txt.join('').slice(-500)));
  }
  // 5. DM the Qwen lane with a question only a real model turn can answer, and wait for ITS reply on the bus
  const nonce = randomBytes(3).toString('hex'); const a = 17 + (Date.now() % 50), b = 23;
  const channel = 'dm-' + QWEN_ID.split('/')[1];
  const sent = (await J(BUS + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender: DRIVER_ID, message_type: 'request', content: `@${QWEN_ID} interop check ${nonce}: what is ${a} + ${b}? Reply on this channel with the number and the word ${nonce}.` }) })).body;
  say(`driver → #${channel} id ${sent.id}: "${a} + ${b}?" nonce ${nonce}`);
  const reply = await waitFor(async () => { const m = (await J(`${BUS}/api/messages/${channel}?limit=20`, { headers: H })).body.messages || []; return m.find((x) => (x.sender || x.instance_id) === QWEN_ID && x.id > sent.id); }, Number(process.env.A5_REPLY_TIMEOUT_MS || 90000), 500);
  if (!reply) { say('FAIL: no reply from the Qwen lane within 180 s'); }
  else {
    const ok = reply.content.includes(String(a + b)) && reply.content.includes(nonce);
    say(`qwen → #${channel} id ${reply.id} [${reply.message_type}]: ${JSON.stringify(reply.content.slice(0, 200))}`);
    say(ok ? `PASS: a real Qwen session received a bus DM via cc-qwen-bridge and answered on the bus (${a}+${b}=${a + b}, nonce ok) in ${((Date.now() - t0) / 1000).toFixed(0)} s` : 'FAIL: reply content wrong');
    rc = ok ? 0 : 1;
  }
  if (rc && perms.length) say('permission events seen:', JSON.stringify(perms[0]).slice(0, 600));
  if (rc) { const txt = []; const walk = (o) => { if (o && typeof o === 'object') { if (typeof o.text === 'string') txt.push(o.text); Object.values(o).forEach(walk); } }; transcript.forEach(walk); say('session text (tail):', JSON.stringify(txt.join('').slice(-700))); }
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
