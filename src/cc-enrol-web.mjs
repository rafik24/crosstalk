#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-enrol-web.mjs — enrol this machine from a BROWSER PAGE (issue 55, /crosstalk:enrol). Zero deps.
//
//   node cc-enrol-web.mjs [--config <path>] [--no-open]
//       starts a one-shot enrol server in the background, opens the browser at it, prints ONE line
//       with the URL, and returns. The page closes the server itself.
//   node cc-enrol-web.mjs --serve [--config <path>]
//       the server itself, in the foreground: prints one JSON line {url, port, address, pid} on
//       stdout, then serves until it is done (what the launcher above spawns detached; tests too)
//
// Why a page and not a prompt: the terminal prompt (cc-enrol.mjs) needs a real TTY (Git Bash's
// mintty has none), a long versioned plugin path, and a user who is comfortable in a terminal.
// And the password must NEVER pass through the Claude chat/transcript: the slash command only
// starts this server and relays its URL; the password goes from the browser to 127.0.0.1 only.
//
// Hardening — a local HTTP server that writes a secret file is an attack surface of its own:
//   · binds 127.0.0.1 ONLY, on a random port
//   · a random one-time 128-bit token is the first path segment and is required on EVERY request
//     (page, state, enrol, cancel), compared in constant time. Path, not fragment: the token has
//     to reach the server on the page GET too, and a fragment never does. The cost — the token
//     sits in browser history and in the printed URL — is bounded: it dies with the server
//     (one enrolment, cancel, or IDLE_MS idle), and the page loads nothing external (no Referer)
//   · the Host header must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defence)
//   · POSTs need Origin = this same origin and a JSON content type; no CORS headers are ever sent,
//     so a cross-site page can neither read an answer nor get its preflight approved
//   · the password and the derived keys are never logged and never appear in a response body
//   · exits after one successful enrolment, on the page's Cancel, or after IDLE_MS without an
//     authenticated request (CC_ENROL_WEB_IDLE_MS, default 5 min)
// The derivation, verification and file write are cc-enrol.mjs's exported core — not duplicated.
// ---------------------------------------------------------------------------
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configPath } from './cc-paths.mjs';
import { resolveFull } from './cc-discover.mjs';
import { canonicalShort } from './cc-render.mjs';
import { deriveKeys, enrolPrecondition, verifyToken, writeEnrolment, SPLIT_WARNING } from './cc-enrol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDLE_MS = Number(process.env.CC_ENROL_WEB_IDLE_MS) || 5 * 60 * 1000;
const MAX_BODY = 4096;
const MIN_PASSWORD = 16;

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(n);

// Which form the page opens on. The estate probe is only a hint for this default — see machineState.
export function defaultMode({ enrolled, estate }) { return enrolled ? 'enrolled' : estate ? 'join' : 'setup'; }

function tokenMatches(expected, given) {
  const a = Buffer.from(expected), b = Buffer.from(String(given || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function machineState(path) {
  const host = canonicalShort(process.env.CC_HOST || hostname());   // the name the bus shows (cc-bus does the same)
  if (existsSync(path)) return { mode: 'enrolled', host, config: path };
  // This probe is UNAUTHENTICATED: an unenrolled machine has no key to challenge a responder with
  // (token '' → cc-discover skips the proof check). So a forged responder can at worst change
  // which form the page opens on (Join instead of Set up). That is all it may decide — the user
  // can always switch forms, and every write is still gated: Join/Re-enrol only write after a
  // leader PROVES it holds the password's token (verifyToken, strict discovery).
  let found = null;
  try { found = await resolveFull({ token: '', lanTimeoutMs: 800, timeoutMs: 2000 }); } catch {}
  const estate = found ? { host: String(found.host || '') } : null;
  return { mode: defaultMode({ enrolled: false, estate }), host, config: path, estate };
}

// What the written bind exposes, in words — shown after Set up / Join so the choice is never silent.
function bindNote() {
  return 'Its bus listens on EVERY network this machine joins (CC_BIND=0.0.0.0), including public Wi-Fi. Messages need the estate key, but a few status routes (/health, /cc/whoami) answer anyone — so keep the estate password a long passphrase.';
}

// One enrolment request → { status, body }. Never puts the password or a key in the body.
async function enrol(path, host, req) {
  const action = req.action;
  const pw = req.password;
  if (!['join', 'setup', 'set-password', 're-enrol'].includes(action)) return { status: 400, body: { error: 'Unknown action.' } };
  if (typeof pw !== 'string' || !pw) return { status: 400, body: { error: 'Enter the estate password.' } };
  const pre = enrolPrecondition(path, action === 'setup' ? 'join' : action);
  if (pre) return { status: 409, body: { error: action === 'join' || action === 'setup' ? 'This machine is already enrolled — reload the page.' : 'This machine is not enrolled yet — reload the page.' } };
  const choosing = action === 'setup' || action === 'set-password';
  if (choosing && pw.length < MIN_PASSWORD) return { status: 400, body: { error: `The estate password must be at least ${MIN_PASSWORD} characters — use a passphrase of four or more random words. Nothing was written.` } };
  if (choosing && req.confirm !== pw) return { status: 400, body: { error: "The two passwords don't match. Nothing was written." } };
  if (pw.length < MIN_PASSWORD) return { status: 422, body: { error: 'No estate answered this password — nothing was written. (Estate passwords are at least 16 characters.)' } };

  const { token, admin } = deriveKeys(pw);
  let leader = null;
  if (action === 'join' || action === 're-enrol') {
    const v = await verifyToken(token);
    if (!v.ok) return { status: 422, body: { error: 'No estate answered this password — nothing was written.', detail: v.why } };
    leader = v.leader;
  }
  const autoSupervisor = (action === 'join' || action === 'setup') && req.autoSupervisor !== false;
  // CC_BIND=0.0.0.0 (#60): Set up / Join each carry an explicit "reachable from my other machines"
  // box (`lan`, default OFF — it is every-network exposure); absent = off. Join also needs hosting: a
  // machine that never hosts needs no bind. Re-enrol / set-password never change the bind.
  const lan = (action === 'setup' || (action === 'join' && autoSupervisor)) && req.lan === true;
  writeEnrolment(path, { token, admin, autoSupervisor, lan, rewrite: action === 'set-password' || action === 're-enrol' });

  const bus = join(HERE, 'cc-bus.mjs').replace(/\\/g, '/');
  const message = {
    join: `Enrolled ✓ as ${host}. New sessions on this machine join the bus automatically; this session joins the next time you start or resume it.${lan ? ' ' + bindNote() : autoSupervisor ? ` It may host the bus but listens on loopback only: if a failover lands here, your other machines cannot reach it. To host for them, add CC_BIND=0.0.0.0 to ${path} and restart the bus supervisor.` : ''}`,
    setup: `Estate created ✓ — ${host} is its first machine. ${autoSupervisor
      ? 'Start a new Claude session: it starts the bus here.'
      : `Nothing hosts the bus yet — run node "${bus}" start, or enable the auto-supervisor.`} ${lan
      ? `Other machines join with the same password via /crosstalk:enrol. ${bindNote()}`
      : `Only this machine can reach its bus (it listens on loopback). To let other machines join later, add CC_BIND=0.0.0.0 to ${path} and restart the bus supervisor.`}`,
    'set-password': `Estate password set ✓ — this machine now uses the keys derived from it. Next, on every other machine run /crosstalk:enrol → Re-enrol with this password: ${SPLIT_WARNING}`,
    're-enrol': `Re-enrolled ✓ with the new estate password. Restart the bus supervisor on this machine so it uses the new keys.`,
  }[action];
  return { status: 200, body: { ok: true, message, host, leader: leader ? { host: leader.host, epoch: leader.epoch } : null, config: path } };
}

// Start the server. Resolves once listening; `onDone(code)` fires after the server has closed.
export function startEnrolServer({ config, idleMs = IDLE_MS, onDone = () => {} } = {}) {
  const path = config || configPath();
  const host = canonicalShort(process.env.CC_HOST || hostname());   // the name the bus shows (cc-bus does the same)
  const secret = randomBytes(16).toString('hex');   // the one-time 128-bit URL token
  const cspNonce = randomBytes(16).toString('base64');
  const page = readFileSync(join(HERE, 'cc-enrol-web.html'), 'utf8').replaceAll('__NONCE__', cspNonce);
  let busy = false, finished = false, idle, port = 0;

  const server = http.createServer((q, s) => { handle(q, s).catch(() => { try { send(s, 500, { error: 'Internal error — nothing was written.' }); } catch {} }); });

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(idle);
    server.close();
    // Windows: a keep-alive socket still open at process exit trips a libuv assertion (exit 127),
    // so drop every connection and give the handles a moment to close before onDone exits.
    server.closeAllConnections();
    setTimeout(() => onDone(code), 300);
  }
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => finish(0), idleMs); };

  function send(s, status, body, type = 'application/json; charset=utf-8') {
    s.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      ...(type.startsWith('text/html') ? { 'content-security-policy': `default-src 'none'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` } : {}),
    });
    s.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function readJson(q) {
    let size = 0; const chunks = [];
    for await (const c of q) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (j && typeof j === 'object') return j; } catch {}
    throw Object.assign(new Error('bad json'), { status: 400 });
  }

  async function handle(q, s) {
    const origins = [`127.0.0.1:${port}`, `localhost:${port}`];
    // DNS rebinding: a hostile site that re-points its own name at 127.0.0.1 still sends ITS Host.
    if (!origins.includes(String(q.headers.host || '').toLowerCase())) return send(s, 403, { error: 'Forbidden host.' });
    const url = new URL(q.url, 'http://127.0.0.1');
    const [, tok = '', route, ...extra] = url.pathname.split('/');
    if (!tokenMatches(secret, tok) || extra.length) return send(s, 403, { error: 'Forbidden.' });
    if (finished) return send(s, 410, { error: 'This enrol page has closed.' });
    touch();
    if (route === undefined) { s.writeHead(308, { location: `/${secret}/`, 'cache-control': 'no-store' }); return s.end(); }

    if (q.method === 'GET' && route === '') return send(s, 200, page, 'text/html; charset=utf-8');
    if (q.method === 'GET' && route === 'state') return send(s, 200, await machineState(path));
    if (q.method !== 'POST' || (route !== 'enrol' && route !== 'cancel')) return send(s, 404, { error: 'Not found.' });

    // A POST must come from this page itself: same origin, JSON body (a cross-site <form> can send
    // neither; a cross-site fetch with JSON needs a CORS preflight, which is never approved).
    if (!origins.map((o) => `http://${o}`).includes(String(q.headers.origin || '').toLowerCase())) return send(s, 403, { error: 'Forbidden origin.' });
    if (!/^application\/json\b/i.test(String(q.headers['content-type'] || ''))) return send(s, 415, { error: 'Expected JSON.' });
    let body;
    try { body = await readJson(q); } catch (e) { return send(s, e.status || 400, { error: 'Bad request.' }); }

    if (route === 'cancel') { send(s, 200, { ok: true }); return finish(0); }
    if (busy) return send(s, 409, { error: 'Already working on it — wait for the answer.' });
    busy = true;
    try {
      const r = await enrol(path, host, body);
      send(s, r.status, r.body);
      if (r.status === 200) finish(0);
    } finally { busy = false; }
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      touch();
      resolve({ server, port, address: server.address().address, url: `http://127.0.0.1:${port}/${secret}/` });
    });
  });
}

// Open the URL in the default browser, detached. Resolves false only if the opener itself failed
// to spawn; the caller prints the URL either way (a headless box has an opener but no browser).
function openBrowser(url) {
  const [cmd, argv, extra] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `"start "" "${url}""`], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin' ? ['open', [url], {}] : ['xdg-open', [url], {}];
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, argv, { ...extra, detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('spawn', () => { p.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

// Foreground server: report where it listens as ONE JSON line, then never write stdout again (the
// launcher closes its end of that pipe as soon as it has read the line).
async function serve() {
  const { url, port, address } = await startEnrolServer({ config: opt('--config'), onDone: (code) => process.exit(code) });
  process.stdout.on('error', () => {});
  process.stdout.write(JSON.stringify({ url, port, address, pid: process.pid }) + '\n');
}

// Launcher: start the server DETACHED (its own process group, no inherited stdio), so the Claude
// Bash call that ran this returns at once while the server lives on. The server exits by itself
// (success / cancel / idle), so nothing is orphaned. Only the ready line crosses the pipe.
async function launch() {
  const passthrough = opt('--config') ? ['--config', opt('--config')] : [];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', ...passthrough], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const ready = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(timer); try { resolve(JSON.parse(buf.slice(0, i))); } catch { resolve(null); } } });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  child.stdout.destroy();
  if (!ready?.url) { try { child.kill(); } catch {} console.error('crosstalk enrol: the enrol page server did not start — use the terminal instead: node "' + join(HERE, 'cc-enrol.mjs').replace(/\\/g, '/') + '" --auto-supervisor'); process.exit(1); }
  child.unref();
  const opened = has('--no-open') ? false : await openBrowser(ready.url);
  const mins = Math.round(IDLE_MS / 60000);
  console.log(`crosstalk enrol page: ${ready.url}  — ${opened ? 'opening in your browser; if no tab appeared, open that link' : 'open that link in your browser'}. It closes itself after enrolling, on Cancel, or after ${mins} min idle (server pid ${ready.pid}).`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (has('--serve') ? serve() : launch()).catch((e) => { console.error('crosstalk enrol:', e.message); process.exit(1); });
}
