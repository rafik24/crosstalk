// pi.dev extension test (3.3.0) — the pi RECEIVE + SEND path, against a REAL server and the
// REAL shared engine (cc-receive.mjs), with a FAKE pi ExtensionAPI. node:assert-free (own ok()).
//   node test/pi-extension.test.mjs        (CC_TEST_PORT=… to run beside another suite)
//
// The extension is in-process, so unlike the Codex bridge there is no subprocess to spawn: we
// install crosstalk-core against a fake `pi`, fire session_start/session_shutdown ourselves, and
// assert:
//   A. an addressed DM → exactly one pi.sendMessage, <2s, customType 'crosstalk', deliverAs 'steer';
//   C. ambient #general traffic is NOT delivered;
//   T. bus_send / bus_peers tools are registered and actually hit the bus over REST;
//   V. a version-gate 426 → ctx.ui.notify('error') once + receiver stopped (fake receiver, injected);
//   S. session_shutdown stops the receiver — a later DM is not delivered;
//   I. identity is host/pi-<slug> and CC_INSTANCE overrides it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); };

// Isolate HOME (the beacon dir ~/.claude/.cc-listen) BEFORE importing the engine — cc-receive.mjs
// fixes LIVE_DIR from homedir() at module load.
const HOME = mkdtempSync(join(tmpdir(), 'ccpi-home-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.CC_BUS_CONFIG = join(tmpdir(), `cc-no-config-pi-${process.pid}`);
process.env.CC_CACHE_DIR = mkdtempSync(join(tmpdir(), 'ccpi-cache-'));
// loadConfig() prefers process.env over the config file, so an operator shell exporting the real
// bus's CC_BASE/CC_TOKEN would pin test R to the PRODUCTION bus (and make its watch-fail vacuous).
delete process.env.CC_BASE; delete process.env.CC_TOKEN; delete process.env.CC_PIN;

const PORT = Number(process.env.CC_TEST_PORT || 8794);
// ISOLATE discovery from the real fleet (which outranks a scratch server by epoch): probe only the
// test port, and listen for LAN beacons on a scratch port so the real bus's 8788 beacon is unheard.
// Without this, resolveFull() finds the live bus and the client auths against it with the test token
// → 401 (codex-bridge.test learned the same, 2026-09-17).
process.env.CC_PORT = String(PORT);
process.env.CC_BEACON_PORT = String(process.env.CC_TEST_BEACON_PORT || 8896);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'tt';
const DATA = mkdtempSync(join(tmpdir(), 'ccpi-data-'));

const { whoami } = await import('../src/cc-discover.mjs');
const { pkgVersion } = await import('../src/cc-rev.mjs');
const { shortIdOf } = await import('../src/cc-render.mjs');
const { installCrosstalk, makeIdentity } = await import('../src/pi/crosstalk-core.mjs');

const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

function boot(epoch = 6) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), CC_EPOCH: String(epoch), CC_HOST: 'pihost', CC_DATA_DIR: DATA, MCP_API_KEY: TOKEN },
    stdio: 'ignore',
  });
}
async function waitUp(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await whoami(BASE, 1500)) return true; await sleep(500); }
  return false;
}
async function send(channel, content, sender = 'tester', type = 'message') {
  const r = await fetch(BASE + '/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ channel, sender, content, message_type: type }) });
  return r.json();
}
async function messages(channel) {
  const r = await fetch(BASE + `/api/messages/${encodeURIComponent(channel)}?after_id=0`, { headers: H });
  return (await r.json()).messages || [];
}

// --- fakes -----------------------------------------------------------------------------------
function makeFakePi() {
  const handlers = {}; const tools = {}; const commands = {}; const sent = [];
  return {
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    registerTool: (t) => { tools[t.name] = t; },
    registerCommand: (n, c) => { commands[n] = c; },
    sendMessage: (msg, opts) => { sent.push({ msg, opts }); },
    fire: (ev, event, ctx) => Promise.all((handlers[ev] || []).map((fn) => fn(event, ctx))),
    tools, commands, sent,
  };
}
function makeCtx(sid) {
  const notes = []; const status = {};
  return {
    cwd: process.cwd(), signal: undefined,
    sessionManager: { getSessionId: () => sid, getSessionFile: () => undefined },
    ui: { notify: (m, t) => notes.push({ m, t }), setStatus: (k, s) => { status[k] = s; }, setWidget: () => {} },
    notes, status,
  };
}
// A minimal TypeBox stand-in — the fake pi.registerTool only records, and tool execute() never
// reads the schema, so the shape need only be a marker.
const Type = { Object: (x) => ({ k: 'object', x }), String: () => ({ k: 'string' }), Optional: (x) => ({ k: 'optional', x }) };

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('❌', m); } else console.log('  ✓', m); };

// --- I: identity (pure) ---
{
  ok(/^testbox\/pi-[a-z0-9]{1,8}$/.test(makeIdentity({ env: {}, host: 'testbox', ctx: { sessionManager: { getSessionId: () => 'ABCD1234-ffff' } } })), 'I: identity is host/pi-<slug> from the session id');
  ok(makeIdentity({ env: { CC_INSTANCE: 'box/pi-custom' }, host: 'ignored' }) === 'box/pi-custom', 'I: CC_INSTANCE overrides the derived identity');
  ok(makeIdentity({ env: {}, host: 'Weird Host!!' }).startsWith('Weird-Host/pi-'), 'I: host is sanitized to the id charset');
}

let srv = boot();
try {
  ok(await waitUp(), 'server booted');

  // ---- A + C + T + S: one real install, real engine ----
  const ID = 'testbox/pi-lane-01a0';
  const DM = `dm-${shortIdOf(ID)}`;   // dm-pi-lane-01a0
  const pi = makeFakePi();
  const ctx = makeCtx('01a0af11-1111-4222-8333-444444444444');
  const ext = installCrosstalk(pi, { Type, pin: BASE, token: TOKEN, env: { CC_INSTANCE: ID }, host: 'testbox', log: () => {} });

  ok(!!pi.tools.bus_send && !!pi.tools.bus_ack && !!pi.tools.bus_peers, 'T: bus_send/bus_ack/bus_peers registered');
  ok(!!pi.commands.bus, 'T: /bus command registered');

  await pi.fire('session_start', { reason: 'startup' }, ctx);
  // 20s, not 5: start() runs a FULL discovery scan first (tailscale exec ≤2.5s + LAN solicit + probes),
  // which a loaded box or a shared CI runner stretches past 5s — seen RED once on Linux under load.
  ok(await until(() => ext.active, 20000), 'session_start: receiver started + active');
  ok(ext.identity === ID, 'session_start: identity is the CC_INSTANCE id');
  ok(ctx.status.crosstalk === '● ' + ID, 'session_start: status line shows ● <id>');

  // A: addressed DM → exactly one steered pi.sendMessage <2s
  await send(DM, 'DM_ONE hello pi', 'tester', 'request');
  const t0 = Date.now();
  ok(await until(() => pi.sent.some((s) => /DM_ONE/.test(s.msg.content)), 2500), 'A: DM delivered into the pi session');
  ok(Date.now() - t0 < 2500, 'A: within the poll/push window');
  const dm = pi.sent.find((s) => /DM_ONE/.test(s.msg.content));
  ok(dm && dm.msg.customType === 'crosstalk' && dm.msg.display === true, 'A: sendMessage customType=crosstalk, display=true');
  ok(dm && dm.opts && dm.opts.deliverAs === 'steer' && dm.opts.triggerTurn === true, 'A: delivered with {triggerTurn:true, deliverAs:"steer"} (not sendUserMessage)');
  ok(dm && /CHAT #dm-pi-lane-01a0 tester \[request\]/.test(dm.msg.content), 'A: rendered line shape CHAT #<ch> <sender> [<type>]');
  await sleep(400);
  ok(pi.sent.filter((s) => /DM_ONE/.test(s.msg.content)).length === 1, 'A: exactly once (cursor dedup)');

  // C: ambient is not delivered
  const before = pi.sent.length;
  await send('general', 'AMBIENT nobody addressed pi');
  await sleep(900);
  ok(pi.sent.length === before, 'C: ambient #general traffic not delivered');

  // T: bus_send actually posts over REST; bus_peers lists online peers
  const r = await pi.tools.bus_send.execute('call-1', { channel: DM + '-back', text: 'from pi tool', type: 'response' });
  ok(/sent #dm-pi-lane-01a0-back id=/.test(r.content[0].text), 'T: bus_send returns a sent confirmation');
  ok(await until(async () => (await messages(DM + '-back')).some((m) => m.sender === ID && /from pi tool/.test(m.content)), 3000), 'T: bus_send message landed on the bus as the pi identity');
  const peers = await pi.tools.bus_peers.execute('call-2', {});
  ok(peers.content[0].text.includes(ID), 'T: bus_peers lists this pi session as online');

  // S: session_shutdown stops the receiver — a later DM is not delivered
  await pi.fire('session_shutdown', { reason: 'quit' }, ctx);
  ok(!ext.active, 'S: shutdown cleared active');
  ok(ctx.status.crosstalk === '', 'S: shutdown cleared the status line');
  const afterShutdown = pi.sent.length;
  await send(DM, 'DM_AFTER_SHUTDOWN should not arrive');
  await sleep(1500);
  ok(pi.sent.length === afterShutdown, 'S: no delivery after shutdown (receiver stopped)');

  // ---- R: token/pin resolved from the config file when NOT passed explicitly ----
  // Regression for the first live install (2026-09-17): the extension loaded and `bus_peers` ran,
  // but returned "no CC_TOKEN" because the core defaulted token to '' and passed it down, shadowing
  // both cc-client's `?? cfg.token` and the receiver (which has no config fallback at all). Here NO
  // token/pin is passed — they must come from ~/.claude/.crosstalk (via CC_BUS_CONFIG) — and the
  // session must still join and send. Would fail against the pre-fix core.
  {
    const cfgFile = join(mkdtempSync(join(tmpdir(), 'ccpi-cfg-')), 'crosstalk');
    writeFileSync(cfgFile, `CC_TOKEN=${TOKEN}\nCC_BASE=${BASE}\n`);
    const savedCfg = process.env.CC_BUS_CONFIG;
    process.env.CC_BUS_CONFIG = cfgFile;
    try {
      const piR = makeFakePi();
      const ctxR = makeCtx('cfff0000-1111-4222-8333-444444444444');
      const CFGID = 'testbox/pi-fromcfg';
      const extR = installCrosstalk(piR, { Type, env: { CC_INSTANCE: CFGID }, host: 'testbox', log: () => {} });  // NO pin, NO token
      await piR.fire('session_start', { reason: 'startup' }, ctxR);
      ok(await until(() => extR.active, 20000), 'R: joins with token+base taken from the config file (no explicit token)');
      const rr = await piR.tools.bus_send.execute('r1', { channel: `dm-${shortIdOf(CFGID)}-x`, text: 'cfg token works', type: 'response' });
      ok(/id=\d+/.test(rr.content[0].text), 'R: bus_send authenticates with the config-file token (no "no CC_TOKEN")');
      await piR.fire('session_shutdown', { reason: 'quit' }, ctxR);
    } finally {
      if (savedCfg === undefined) delete process.env.CC_BUS_CONFIG; else process.env.CC_BUS_CONFIG = savedCfg;
    }
  }

  // ---- V: version-gate wiring, with an INJECTED fake receiver (no live 426 needed) ----
  // The engine fires onVersionGate SYNCHRONOUSLY inside start() on a 426, then start() resolves
  // WITHOUT throwing. So the fake start() must do exactly that — fire the gate, then resolve — or
  // the test can never catch the "clean resolve flips back to green online" regression (finding #1).
  {
    let captured = null; let stopped = false;
    const fakeCreate = (o) => {
      captured = o;
      return { start: async () => { o.onVersionGate('⛔ CHAT BUS — VERSION GATE: this host runs 3.3.0 but the bus requires 9.9.9.', { required: '9.9.9', yours: '3.3.0' }); }, stop: () => { stopped = true; }, base: BASE, pending: 0 };
    };
    const pi2 = makeFakePi();
    const ctx2 = makeCtx('bbbb0000-1111-4222-8333-444444444444');
    const ext2 = installCrosstalk(pi2, { Type, pin: BASE, token: TOKEN, env: { CC_INSTANCE: 'testbox/pi-gate' }, host: 'testbox', createReceiver: fakeCreate, log: () => {} });
    await pi2.fire('session_start', { reason: 'startup' }, ctx2);
    ok(!!captured && typeof captured.emit === 'function' && typeof captured.onVersionGate === 'function', 'V: receiver built with emit + onVersionGate');
    ok(ctx2.notes.filter((n) => n.t === 'error' && /VERSION GATE/.test(n.m)).length === 1, 'V: version gate → ctx.ui.notify(error) exactly once');
    ok(stopped === true, 'V: version gate stopped the receiver');
    ok(ext2.active === false, 'V: a gate fired DURING start() leaves active=false (no flip back to online)');
    ok(/version gate/i.test(ctx2.status.crosstalk || '') && !/●/.test(ctx2.status.crosstalk || ''), 'V: status stays ⛔ gate, never the green ● online');
  }

  // V2: the emit sink itself (independent of transport) uses steer, not sendUserMessage.
  {
    const pi3 = makeFakePi();
    installCrosstalk(pi3, { Type, pin: BASE, token: TOKEN, env: { CC_INSTANCE: 'x/pi-emit' }, host: 'x', createReceiver: () => ({ start: async () => {}, stop: () => {}, base: BASE, pending: 0 }), log: () => {} }).emit('CHAT #dm-x hi', { channel: 'dm-x', sender: 'y', id: 5, message_type: 'message' });
    ok(pi3.sent.length === 1 && pi3.sent[0].opts.deliverAs === 'steer' && pi3.sent[0].msg.details.id === 5, 'V2: emit → one steered sendMessage carrying msg details');
    ok(typeof pi3.sendUserMessage === 'undefined' || pi3.sent.every((s) => s.msg.customType === 'crosstalk'), 'V2: never routes through sendUserMessage');
  }
} catch (e) {
  failed = true;
  console.error('❌ pi-extension.test threw:', e.stack || e.message);
} finally {
  try { srv && srv.kill(); } catch {}
}
if (failed) { console.error('❌ pi-extension.test FAILED'); process.exit(1); }
console.log('✅ pi-extension.test: all assertions passed (in-process install, DM→steer <2s exactly-once, ambient suppressed, tools hit the bus, version-gate notify+stop, shutdown stops receive)');
process.exit(0);
