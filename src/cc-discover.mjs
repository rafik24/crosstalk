// ---------------------------------------------------------------------------
// cc-discover.mjs — zero-config discovery of the authoritative Crosstalk bus.
//
// No IP is configured in the default path. The leader is found by probing, in
// order, cheapest-first, then MERGING every responder and picking the HIGHEST
// election epoch (tiebreak: lexicographically lowest host id). Works LAN-only
// (UDP broadcast beacon, no Tailscale needed), tailnet-only (peer scan), or mixed.
//
//   loadConfig()                      → { token, admin, bind, allowFileOrigin, pin, peers[], port, beaconPort, discovery }
//   resolveFast({token,pin})          → {base,host,epoch} | null   (pin→cache→loopback; hot path)
//   resolveFull({token,pin,skipSelf}) → {base,host,epoch} | null   (full merged scan; election/migrate)
//   cacheLeader(leader) / readCache()
//   whoami(base, timeoutMs, token)    → {role,host,epoch,base_url} | null
//
// Every client script imports resolveFast(); cc-bus imports resolveFull().
// Zero external deps.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { configPath } from './cc-paths.mjs';
import { canonicalShort } from './cc-render.mjs';
import { nonce, whoamiProven, beaconProven, proofMode } from './cc-proof.mjs';

export const DEFAULT_PORT = 8787;
export const DEFAULT_BEACON_PORT = 8788;

// Cache location is resolved LAZILY (not at import) and honours CC_CACHE_DIR — so a test
// (or an isolated node) can point the leader cache at a scratch dir instead of the shared
// ~/.claude/.cc-listen, keeping discovery hermetic from the real estate.
function cacheDir() { return process.env.CC_CACHE_DIR || join(homedir(), '.claude', '.cc-listen'); }
function cacheFile() { return join(cacheDir(), 'leader.json'); }

// --- config (shell-style ~/.claude/.crosstalk, back-compat ~/.claude/.cross-claude-bus) ---
export function loadConfig() {
  const p = configPath();
  const out = {};
  try {
    for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*(?:export\s+)?(CC_[A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  const token = process.env.CC_TOKEN || out.CC_TOKEN || '';
  // Admin scope secret (gates /cc/export, /cc/stepdown, /cc/import). Read from the config file too,
  // not just the env — so "set CC_ADMIN_KEY in ~/.claude/.crosstalk" works for any launch method
  // (systemd/Scheduled-Task/manual), matching ENROLLMENT. Env still wins.
  const admin = process.env.CC_ADMIN_KEY || out.CC_ADMIN_KEY || '';
  // Interface to bind when THIS node hosts (leader / failover-promoted). Read from the config too,
  // not just env — else a host (or a supervisor that gets promoted) silently binds loopback and is
  // unreachable off-box. Empty ⇒ the server's own default (loopback, per refuse-run-open). Env wins.
  const bind = process.env.CC_BIND || out.CC_BIND || '';
  // Whether a console opened as a file:// page may talk to this node's server (CORS + WS grant for
  // the `null` origin). Off unless '1'. Read from the config too, for the same reason as CC_BIND: the
  // supervisor forwards it to the server it spawns, whatever launched the supervisor. Env wins.
  const allowFileOrigin = process.env.CC_ALLOW_FILE_ORIGIN || out.CC_ALLOW_FILE_ORIGIN || '';
  // CC_BASE is a manual PIN/override (back-compat). New configs omit it and rely on discovery.
  const pin = (process.env.CC_BASE || out.CC_BASE || '').replace(/\/$/, '') || null;
  const port = parseInt(process.env.CC_PORT || out.CC_PORT) || DEFAULT_PORT;
  const beaconPort = parseInt(process.env.CC_BEACON_PORT || out.CC_BEACON_PORT) || DEFAULT_BEACON_PORT;
  const peers = (process.env.CC_PEERS || out.CC_PEERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // CC_DISCOVERY=peers confines discovery to pin + cache + loopback + the explicit CC_PEERS list:
  // no LAN solicit, no tailnet scan, and (cc-bus) no beacon. /cc/whoami is unauthenticated, so in
  // the default 'auto' mode ANY reachable bus with a higher epoch is adopted as the leader — right
  // for a zero-config estate, wrong for a dev fleet or a CI run that must never find a stranger.
  const discovery = (process.env.CC_DISCOVERY || out.CC_DISCOVERY || '').toLowerCase() === 'peers' ? 'peers' : 'auto';
  return { token, admin, bind, allowFileOrigin, pin, port, beaconPort, peers, discovery };
}

// --- cache ---
export function readCache() {
  try { return JSON.parse(readFileSync(cacheFile(), 'utf8')); } catch { return null; }
}
// The cached leader, IF this node may trust it. In CC_DISCOVERY=peers mode a cache entry is only
// honoured when its base is one we would have probed anyway (pin, loopback, a CC_PEERS entry): a
// leader.json left behind by an earlier auto-mode run — which may have adopted a stranger — would
// otherwise keep winning on epoch, be re-cached on every resolve, and receive our bearer token.
export function readTrustedCache() { const cfg = loadConfig(); return trustedCache(cfg, cfg.pin); }
function trustedCache(cfg, pin) {
  const c = readCache();
  if (!c?.base) return null;
  if (cfg.discovery !== 'peers') return c;
  const base = c.base.replace(/\/$/, '');
  const allowed = new Set([`http://127.0.0.1:${cfg.port}`]);
  if (pin) allowed.add(pin.replace(/\/$/, ''));
  for (const p of cfg.peers) allowed.add(/^https?:\/\//.test(p) ? p.replace(/\/$/, '') : `http://${p.includes(':') ? p : p + ':' + cfg.port}`);
  return allowed.has(base) ? c : null;
}
export function cacheLeader(leader) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ ...leader, ts: Date.now() }));
  } catch {}
}

// --- one probe GET → parsed JSON | null. Deliberately node:http, NOT fetch (issue 44): aborting
// a fetch cancels the REQUEST but undici keeps the half-open connect alive until its own 10s
// connect timeout, so every probe of a black-holed peer (a static CC_PEERS entry that is down, an
// offline tailnet IP) pinned the event loop — one-shot clients printed their result and then
// hung ~9s before exiting. req.destroy() tears the socket down at OUR deadline. agent:false +
// connection:close: a probe never parks a keep-alive socket either.
function probeJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false, req, timer;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { req && req.destroy(); } catch {} resolve(v); };
    try {
      req = (url.startsWith('https:') ? https : http).get(url, { agent: false, headers: { connection: 'close' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 65536) finish(null); });   // a whoami is tiny
        res.on('end', () => { try { const j = JSON.parse(body); if (j && typeof j === 'object') j.__reached = { address: res.socket?.remoteAddress, port: res.socket?.remotePort }; finish(j); } catch { finish(null); } });
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
      timer = setTimeout(() => finish(null), timeoutMs);
    } catch { finish(null); }
  });
}

// What strict discovery IGNORED lately (base → { epoch, ts }). A supervisor about to promote
// asks: did anyone answer without proof at an epoch ≥ mine? — during a rollout that is the
// still-running pre-3.3.5 leader, and promoting beside it would split (or steal) the estate.
const unprovenSeen = new Map();
function noteUnproven(base, epoch) { unprovenSeen.set(base, { epoch: Number(epoch) || 0, ts: Date.now() }); }
export function highestUnprovenEpoch(withinMs = 30000) {
  let best = null;
  for (const [b, v] of unprovenSeen) { if (Date.now() - v.ts > withinMs) { unprovenSeen.delete(b); continue; } if (best === null || v.epoch > best.epoch) best = { base: b, epoch: v.epoch }; }
  return best;
}

// Unproven responders are reported once per base per process (a chatty warning would drown
// the logs — a forger answers every scan).
const warnedUnproven = new Set();
const warnedBeacon = new Set();
function warnUnproven(base, j) {
  if (warnedUnproven.has(base)) return;
  warnedUnproven.add(base);
  console.error(`[discovery] ⚠️  ${proofMode() === 'legacy' ? 'ACCEPTING (CC_DISCOVERY_PROOF=legacy)' : 'IGNORING'} unproven leader ${base} (host ${j?.host}, epoch ${j?.epoch}) — it did not prove it holds the estate token`);
}

// --- one whoami probe --- (token: the estate token to verify the answer with; default = config)
export async function whoami(base, timeoutMs = 1500, token = undefined) {
  base = base.replace(/\/$/, '');
  try {
    const tok = token === undefined ? loadConfig().token : token;
    const n = tok ? nonce() : null;
    const j = await probeJson(base + '/cc/whoami' + (n ? `?nonce=${n}` : ''), timeoutMs);
    if (!j) return null;
    if (typeof j.epoch !== 'number') return null;
    // Discovery authentication (issue 55): an enrolled client only trusts a responder that
    // proves it holds the estate token. Legacy mode (rollout window) accepts with a warning.
    const proven = whoamiProven(tok, n, j, j.__reached);
    if (proven === false) { warnUnproven(base, j); noteUnproven(base, j.epoch); if (proofMode() !== 'legacy') return null; }
    // Canonical base = the address WE dialed (guaranteed reachable from here), not what the
    // server guesses. host/epoch/rev/watermark come from the server. watermark is the highest
    // message id served — a freshness proxy the election uses to break an equal-epoch tie.
    return {
      base, host: j.host, epoch: j.epoch, role: j.role || 'leader',
      rev: j.rev || null, dirty: !!j.dirty,
      watermark: typeof j.watermark === 'number' ? j.watermark : 0,
      draining: !!j.draining,   // the leader is in a drain stepdown (read-only, about to leave)
      proven: proven === true,  // false for an unproven responder accepted in legacy mode / by an unenrolled caller
    };
  } catch { return null; }
}

// Election ordering, single source of truth (used by pickAuthoritative here AND cc-bus's
// leader-monitor step-down, so they can never disagree and split-brain):
//   1. HIGHEST election epoch          — the term authority; a migration always bumps it.
//   2. then HIGHEST watermark          — #7: among standbys forked from a common snapshot and
//                                        racing to promote at the SAME epoch, the branch that
//                                        took the most writes (highest message id) wins, so a
//                                        stale returning leader can't clobber fresher history.
//                                        "most-writes-win" — a defensible, deterministic policy
//                                        strictly better than the old arbitrary hostname tie.
//   3. then lexicographically LOWEST host — final deterministic tiebreak (equal epoch+watermark).
// Returns true when `a` should beat `b`.
export function outranks(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  const aw = a.watermark ?? 0, bw = b.watermark ?? 0;
  if (aw !== bw) return aw > bw;
  // Deterministic final tie-break (#39): canonicalize both host ids (lowercase slug — the same
  // filter instance ids get) and compare code points. localeCompare on raw hostnames made the
  // winner of an exact tie depend on casing and platform locale.
  const ah = canonicalShort(String(a.host || '')), bh = canonicalShort(String(b.host || ''));
  return ah < bh;
}

// pick the authoritative leader among responders per the outranks() ordering.
function pickAuthoritative(responders) {
  const live = responders.filter(Boolean);
  if (!live.length) return null;
  live.sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0));
  return live[0];
}

// --- LAN UDP solicit: broadcast "who's the leader?", collect unicast announces ---
function lanSolicit(beaconPort, timeoutMs = 400, token = '') {
  return new Promise((resolve) => {
    const found = [];
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch { return resolve(found); }
    // #10: done() is reachable from BOTH the 'error' handler and the timeout below. A
    // second sock.close() runs against a handle already in UV_HANDLE_CLOSING, which trips
    // a NATIVE libuv assertion on Windows (src\win\async.c) — an abort, not a JS throw, so
    // the try/catch cannot swallow it and the process dies with exit 127. Concurrency
    // raises the double-fire odds, matching the "intermittent under load" report. Make
    // done() fire exactly once and cancel the pending timer.
    let settled = false;
    let timer;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(found);
    };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString());
        if (m && m.t === 'announce' && typeof m.epoch === 'number') {
          // Issue 55: an announce must carry a fresh, valid proof (or the caller runs legacy).
          const proven = beaconProven(token, m);
          if (proven === false) {
            // Say WHY, once per source: a clock >60s off silently killed LAN discovery otherwise.
            const key = rinfo.address + ':' + m.port;
            if (!warnedBeacon.has(key)) { warnedBeacon.add(key); const skew = typeof m.ts === 'number' ? Math.round(Math.abs(Date.now() - m.ts) / 1000) : null; console.error(`[discovery] ⚠️  ${proofMode() === 'legacy' ? 'ACCEPTING' : 'IGNORING'} beacon from ${rinfo.address} (host ${m.host}, epoch ${m.epoch}): ${typeof m.proof !== 'string' ? 'unsigned (pre-3.3.5 leader?)' : skew !== null && skew > 60 ? `stale by ${skew}s — check the clocks on both boxes` : 'bad proof (different estate token)'}`); }
            if (proofMode() !== 'legacy') return;
          }
          found.push({ ip: rinfo.address, port: m.port || DEFAULT_PORT, host: m.host, epoch: m.epoch });
        }
      } catch {}
    });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      const payload = Buffer.from(JSON.stringify({ t: 'solicit', v: 1 }));
      // Send to the global broadcast plus each interface's directed broadcast (some
      // networks drop 255.255.255.255 but pass the subnet broadcast).
      const targets = new Set(['255.255.255.255']);
      for (const list of Object.values(networkInterfaces())) {
        for (const ni of list || []) {
          if (ni.family !== 'IPv4' || ni.internal) continue;
          const b = directedBroadcast(ni.address, ni.netmask);
          if (b) targets.add(b);
        }
      }
      for (const ip of targets) { try { sock.send(payload, beaconPort, ip); } catch {} }
      timer = setTimeout(done, timeoutMs);
    });
  });
}

function directedBroadcast(addr, mask) {
  try {
    const a = addr.split('.').map(Number), m = mask.split('.').map(Number);
    if (a.length !== 4 || m.length !== 4) return null;
    return a.map((o, i) => (o & m[i]) | (~m[i] & 255)).join('.');
  } catch { return null; }
}

// --- Tailnet: enumerate online peers via `tailscale status --json` ---
function tailscalePeers() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 2500, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const j = JSON.parse(stdout);
        const ips = [];
        const take = (node) => {
          if (!node) return;
          const ip = (node.TailscaleIPs || []).find((x) => x.includes('.'));
          if (ip) ips.push(ip);
        };
        take(j.Self);
        for (const k of Object.keys(j.Peer || {})) {
          const p = j.Peer[k];
          if (p && p.Online) take(p);
        }
        resolve(ips);
      } catch { resolve([]); }
    });
  });
}

// --- fast path: pin → cache → loopback, HIGHEST epoch among live responders. Hot client path. ---
export async function resolveFast(opts = {}) {
  const cfg = loadConfig();
  const pin = opts.pin ?? cfg.pin;
  const port = cfg.port;
  const tryBases = [];
  if (pin) tryBases.push(pin);
  const cached = trustedCache(cfg, pin);
  if (cached?.base) tryBases.push(cached.base);
  tryBases.push(`http://127.0.0.1:${port}`);
  // Probe ALL candidates (≤3) and pick the HIGHEST epoch — NOT the first responder. A
  // stale/demoted loopback or a warm cache entry must never win over a live higher-epoch
  // leader (that bug let a superseded loopback "zombie" leader keep co-located clients
  // bound to it forever). pickAuthoritative applies the epoch>tiebreak ordering.
  const responders = await Promise.all(tryBases.map((b) => whoami(b, opts.timeoutMs || 1200, opts.token ?? cfg.token)));
  const best = pickAuthoritative(responders);
  if (best) { cacheLeader(best); return best; }
  // Fast path missed → escalate to a full scan (also follows a migration).
  return resolveFull({ ...opts, pin });
}

// --- full merged scan: every substrate, highest epoch wins. Election/migrate path. ---
export async function resolveFull(opts = {}) {
  const cfg = loadConfig();
  const pin = opts.pin ?? cfg.pin;
  const port = cfg.port;
  const selfHost = (process.env.CC_HOST || hostname());

  const bases = new Set();
  if (pin) bases.add(pin.replace(/\/$/, ''));
  const cached = trustedCache(cfg, pin);
  if (cached?.base) bases.add(cached.base.replace(/\/$/, ''));
  if (!opts.skipLoopback) bases.add(`http://127.0.0.1:${port}`);
  for (const p of cfg.peers) {
    bases.add(/^https?:\/\//.test(p) ? p.replace(/\/$/, '') : `http://${p.includes(':') ? p : p + ':' + port}`);
  }

  // LAN + tailnet in parallel — unless discovery is confined to the explicit peer list.
  const [lan, ts] = cfg.discovery === 'peers' ? [[], []] : await Promise.all([
    lanSolicit(cfg.beaconPort, opts.lanTimeoutMs || 400, opts.token ?? cfg.token),
    tailscalePeers(),
  ]);
  for (const r of lan) bases.add(`http://${r.ip}:${r.port}`);
  for (const ip of ts) bases.add(`http://${ip}:${port}`);

  const responders = await Promise.all([...bases].map((b) => whoami(b, opts.timeoutMs || 1500, opts.token ?? cfg.token)));
  let best = pickAuthoritative(responders);
  // Optionally ignore a leader that is THIS node (election needs "is anyone ELSE leading?").
  if (best && opts.skipSelf && best.host === selfHost && isLoopbackOrSelf(best.base)) {
    const others = pickAuthoritative(responders.filter((r) => r && r.base !== best.base));
    best = others;
  }
  if (best) cacheLeader(best);
  return best;
}

function isLoopbackOrSelf(base) {
  return /127\.0\.0\.1|localhost/.test(base);
}
