// ---------------------------------------------------------------------------
// server.mjs — the Crosstalk bus HTTP + WebSocket server.
//
// This is the leader process: it owns the SQLite store, serves the
// REST API under /api behind a single bearer token, exposes a few unauthenticated
// discovery/health/console endpoints, and hangs the real-time WebSocket hub off the
// SAME http.Server (same port, same token). There is deliberately NO MCP, no stdio
// transport and no OAuth here — those live elsewhere. One process, one port.
//
// Wiring note (real-time push): the REST layer is provider-agnostic — createRestRouter
// only ever sees a `db`. So instead of teaching the router about the socket hub, we
// decorate db.sendMessage: every successful insert re-reads the stored row and hands
// it to hub.notify(), which fans it out to whichever connected identities the message
// is addressed to. The decoration is transparent to the router and fail-soft — a push
// error never breaks the HTTP response, because the REST cursor API is the reliability
// backstop the bridge replays from on reconnect.
// ---------------------------------------------------------------------------
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { createDB } from './db.mjs';
import { createRestRouter } from './rest-api.mjs';
import { attachWsHub, originAllowed } from './ws-hub.mjs';
import { versionGateMiddleware } from './version-gate.mjs';
import { codeRev, pkgVersion } from '../cc-rev.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Resolve configuration from the environment, letting explicit opts win (tests inject).
function resolveConfig(opts = {}) {
  const env = process.env;
  const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    port: Number(opts.port ?? env.PORT ?? 8787),
    // The INTERFACE we bind. Default is loopback: we never silently expose 0.0.0.0 — a node that
    // must serve the estate opts in with CC_BIND (its tailnet IP or 0.0.0.0), which then also
    // trips the refuse-run-open guard unless a token is set. This is separate from `host` below,
    // which is only the display/beacon identity.
    bind: opts.bind ?? env.CC_BIND ?? '127.0.0.1',
    apiKey: opts.apiKey ?? env.MCP_API_KEY ?? '',
    // A SEPARATE secret guarding the two dangerous admin routes (/cc/export full-DB download,
    // /cc/stepdown remote kill) and cc-bus's /cc/import. When unset those routes are loopback-only.
    adminKey: opts.adminKey ?? env.CC_ADMIN_KEY ?? '',
    // Explicit dev opt-in to run tokenless on a non-loopback interface (refuse-run-open otherwise).
    allowNoAuth: opts.allowNoAuth === true || env.CC_ALLOW_NO_AUTH === '1',
    epoch: Number(opts.epoch ?? env.CC_EPOCH ?? 0),
    host: opts.host ?? env.CC_HOST ?? os.hostname(),
    baseUrl: opts.baseUrl ?? env.SERVER_URL ?? null,
    cleanupDays: Number(opts.cleanupDays ?? env.CLEANUP_DAYS ?? 7),
    // SQLite is the only backend; snapshot/export rides its online backup.
    backend: opts.backend ?? 'sqlite',
    // Rate-limit knobs — env-overridable, opts win (tests drive tiny windows to trip a 429).
    rateLimit: {
      authFailMax: int(opts.authFailMax ?? env.CC_RL_AUTHFAIL_MAX, 20),
      authFailWindowMs: int(opts.authFailWindowMs ?? env.CC_RL_AUTHFAIL_WINDOW_MS, 60000),
      writeMax: int(opts.writeMax ?? env.CC_RL_WRITE_MAX, 60),
      writeWindowMs: int(opts.writeWindowMs ?? env.CC_RL_WRITE_WINDOW_MS, 10000),
    },
    // Extra browser Origins allowed to open the WS (beyond localhost/same-host). csv.
    allowedOrigins: String(opts.allowedOrigins ?? env.CC_WS_ALLOWED_ORIGINS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // A console opened as a file:// page sends `Origin: null` — but so does any web page that
    // wants to, via a sandboxed iframe, so it is OFF by default. CC_ALLOW_FILE_ORIGIN=1 grants
    // it for both the REST CORS grant and the WS upgrade (the launcher-served /console needs
    // nothing: it is same-origin).
    allowFileOrigin: opts.allowFileOrigin ?? (env.CC_ALLOW_FILE_ORIGIN === '1'),
  };
}

// How often we sweep. Cleanup is cheap-but-not-free → hourly; stale-presence is a fast
// heartbeat check → every 30s. Both timers are unref'd so they never hold the process open.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const PRESENCE_INTERVAL_MS = 30 * 1000;
const PRESENCE_STALE_SECONDS = 90;

// Constant-time token comparison. Length is guarded first because timingSafeEqual
// throws on unequal-length buffers; an early length mismatch is not a timing leak of
// the secret's content. Behaviour is identical to === for valid/invalid tokens.
function tokensMatch(presented, expected) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// True for the loopback interface/host forms we treat as "not exposed to the network".
function isLoopbackHost(h) {
  const s = String(h ?? '').toLowerCase();
  return s === 'localhost' || s === '::1' || s === '127.0.0.1' || s.startsWith('127.');
}
// True when the PEER of a request is loopback (used to gate admin ops when no admin key is set).
function isLoopbackAddr(ip) {
  const s = String(ip ?? '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('127.');
}
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}
// Pull a bearer token from `Authorization: Bearer <t>`, falling back to a named query param.
function bearerFrom(req, queryName) {
  const header = req.headers?.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (bearer) return bearer;
  const q = req.query?.[queryName];
  return typeof q === 'string' ? q : '';
}

// Dep-free fixed-window rate limiter. Buckets are keyed by caller (IP, or IP+identity) and
// expire on their own next `hit` after the window; a periodic sweep() reclaims idle keys so
// the Map can never grow without bound. Returns {limited, retryAfterSec} per hit.
function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return {
    hit(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
      b.count += 1;
      return { limited: b.count > max, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
    },
    sweep() {
      const now = Date.now();
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
    },
  };
}

/**
 * Boot the bus. Returns { server, db, hub, config, close } so callers/tests can
 * introspect and shut down cleanly. Injectable factories (opts.createDB /
 * opts.createRestRouter) let a test drive the wiring without the real modules.
 */
export async function startServer(opts = {}) {
  const config = resolveConfig(opts);
  const log = opts.log ?? ((...a) => console.log(...a));

  // ---- Refuse-run-open (M1) --------------------------------------------------------
  // With no token, the REST API is world-writable to anyone who can reach the port. We
  // allow that ONLY when it cannot leak past this machine (loopback bind) or the operator
  // has explicitly accepted the risk (CC_ALLOW_NO_AUTH=1, dev only). Otherwise we refuse to
  // start rather than come up silently open on a network interface. Checked before we open
  // the DB or bind, so a refusal has no side effects.
  const loopbackOnly = isLoopbackHost(config.bind);
  if (!config.apiKey && !config.allowNoAuth && !loopbackOnly) {
    throw new Error(
      `refuse-run-open: MCP_API_KEY is not set and the server would bind a non-loopback ` +
      `interface (${config.bind}). Set MCP_API_KEY, bind loopback (CC_BIND=127.0.0.1), or ` +
      `set CC_ALLOW_NO_AUTH=1 (dev only).`,
    );
  }

  const makeDB = opts.createDB ?? createDB;
  const makeRouter = opts.createRestRouter ?? createRestRouter;

  // Fleet version gate (see version-gate.mjs): this leader is the authority on "the latest version"
  // — a client whose release version != ours is refused (426) on both REST /register and the WS
  // upgrade, forcing it to update. Tests may pin the version via opts.serverVersion; a boot reads it
  // from pkgVersion(). CC_VERSION_GATE_BYPASS admits everyone (rollout/emergency), logged loud below.
  const serverVersion = opts.serverVersion ?? pkgVersion();
  const versionGateBypass = opts.versionGateBypass ?? !!process.env.CC_VERSION_GATE_BYPASS;
  if (versionGateBypass) log('⚠️  VERSION GATE BYPASS active — every client version is admitted (CC_VERSION_GATE_BYPASS).');
  else if (!serverVersion) log('⚠️  version gate DISABLED — leader could not read its own version (package.json); admitting all clients (fail-open).');
  else log(`[version-gate] enforcing: clients must run ${serverVersion}`);

  const db = await makeDB();

  // Data watermark: the highest message id this leader has served, tracked IN MEMORY so
  // /cc/whoami (a discovery hot path) never hits the DB. Seeded from the store at boot (so a
  // just-imported/replicated snapshot reports the right level) and bumped by the sendMessage
  // decorator below. Election uses it as a freshness tiebreak (see cc-discover.outranks): among
  // standbys forked from a common snapshot, the one that took the most writes outranks a staler
  // one at the same epoch. Fail-soft: a db without maxMessageId (e.g. a test stub) starts at 0.
  let watermark = 0;
  try { watermark = (await db.maxMessageId?.()) ?? 0; } catch { watermark = 0; }

  // Per-caller limiters: repeated auth failures (per-IP) and write/claim churn (per-IP+identity).
  const authFailLimiter = createRateLimiter({ windowMs: config.rateLimit.authFailWindowMs, max: config.rateLimit.authFailMax });
  const writeLimiter = createRateLimiter({ windowMs: config.rateLimit.writeWindowMs, max: config.rateLimit.writeMax });

  const app = express();
  app.disable('x-powered-by');
  // Bound the request body (M3): a message/work payload is tiny; 64kb is generous and stops a
  // memory-blowup POST. Over-limit bodies surface as a 413 via the fallback error handler.
  // ---- CORS for the browser console ---------------------------------------------------
  // The console may be served by a different node than the leader it follows, or opened as
  // a file:// page, so its fetches are cross-origin. One policy for REST and WS: reflect the
  // Origin only when originAllowed() says so (localhost, same host, CC_WS_ALLOWED_ORIGINS,
  // and `null` for file:// only with CC_ALLOW_FILE_ORIGIN=1). No credentials flag — the bus
  // uses bearer tokens, never cookies — so a reflected origin unlocks only the public
  // endpoints plus whatever the token already unlocks. Mounted before the body parser so a
  // 413/400 from express.json still reaches a cross-origin console as a status, not an
  // opaque network error. `Vary: Origin` is always set: the grant differs per origin.
  app.use((req, res, next) => {
    res.vary('Origin');
    const origin = req.headers.origin;
    if (origin && originAllowed(origin, req, config.allowedOrigins, config.allowFileOrigin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');   // the API is GET/POST only
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }
    // Preflights carry no credentials and never touch a route, so they neither authenticate
    // nor count as an auth failure: answer before requireAuth.
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // ---- Public endpoints (no auth) --------------------------------------------------
  const startedAt = Date.now();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      host: config.host,
      epoch: config.epoch,
      uptime: (Date.now() - startedAt) / 1000,
    });
  });

  // Discovery beacon: advertises WHO is leading and WHERE — never the token.
  //   watermark    highest message id served — the freshness tiebreak for election.
  //   rev / dirty  the running code revision of this leader's checkout, so the estate can spot a
  //                leader silently serving stale code (the drift check the rewrite had dropped).
  app.get('/cc/whoami', (_req, res) => {
    const code = codeRev();
    res.json({
      role: 'leader', host: config.host, epoch: config.epoch, base: config.baseUrl,
      watermark, rev: code.rev, dirty: code.dirty,
      version: serverVersion,   // the release version the fleet must match (see version-gate.mjs)
    });
  });

  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send(
        `Crosstalk bus — leader ${config.host} (epoch ${config.epoch}).\n` +
          `REST API under /api (bearer token required). Console at /console. Spec at /openapi.json.\n`,
      );
  });

  app.get('/openapi.json', (_req, res, next) => {
    res.sendFile(path.join(__dirname, 'openapi.json'), (err) => {
      if (err) next(err);
    });
  });

  app.get('/console', (_req, res, next) => {
    res.sendFile(path.join(REPO_ROOT, 'cc-console.html'), (err) => {
      if (err) next(err);
    });
  });

  // ---- Bearer auth (guards /api/*) -------------------------------------------------
  // Accept `Authorization: Bearer <key>` or `?api_key=<key>`. If no key is configured
  // the bus runs open — DEV ONLY (and only loopback/opt-in per refuse-run-open), and we
  // shout about it at boot. Repeated auth failures from one IP trip a 429 (M2).
  function requireAuth(req, res, next) {
    if (!config.apiKey) return next(); // dev: no token configured, allow all
    const presented = bearerFrom(req, 'api_key');
    if (tokensMatch(presented, config.apiKey)) return next();
    const { limited, retryAfterSec } = authFailLimiter.hit(clientIp(req));
    if (limited) {
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'too_many_auth_failures', retry_after: retryAfterSec });
    }
    return res.status(401).json({ error: 'invalid_token' });
  }

  // ---- Admin auth (H2): guards /cc/export + /cc/stepdown ---------------------------
  // The full-DB download and remote kill are far more dangerous than a chat write, so a
  // leaked chat token must NOT reach them. When CC_ADMIN_KEY is set it is REQUIRED (the chat
  // token alone is refused); when it is not set these routes are restricted to loopback peers.
  function requireAdmin(req, res, next) {
    if (config.adminKey) {
      const presented = bearerFrom(req, 'admin_key');
      if (tokensMatch(presented, config.adminKey)) return next();
      return res.status(401).json({ error: 'invalid_admin_token' });
    }
    if (isLoopbackAddr(clientIp(req))) return next();
    return res.status(403).json({ error: 'admin_requires_loopback_or_admin_key' });
  }

  // ---- Write/claim churn limiter (M2) ----------------------------------------------
  // Caps POST /api/messages and work-claim churn per IP+identity over a short window. Other
  // /api routes (reads, register) are unthrottled. Keyed off the parsed body's sender/owner
  // so one noisy identity can't starve the rest sharing its IP.
  function writeLimit(req, res, next) {
    const p = (req.originalUrl || req.url || '').split('?')[0];
    const isWrite = req.method === 'POST' && (p === '/api/messages' || /^\/api\/work\/[^/]+\/claim$/.test(p));
    if (!isWrite) return next();
    const id = (req.body && (req.body.sender || req.body.owner)) || '';
    const { limited, retryAfterSec } = writeLimiter.hit(clientIp(req) + '|' + id);
    if (limited) {
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'rate_limited', retry_after: retryAfterSec });
    }
    next();
  }

  // ---- WebSocket hub + push wiring -------------------------------------------------
  const server = http.createServer(app);
  const hub = attachWsHub(server, { token: config.apiKey, log, allowedOrigins: config.allowedOrigins, allowFileOrigin: config.allowFileOrigin, authFailLimiter, clientIp, serverVersion, versionGateBypass });

  // Decorate sendMessage so every insert fans out over the socket hub (see file header).
  const rawSendMessage = db.sendMessage.bind(db);
  db.sendMessage = async (...args) => {
    const id = await rawSendMessage(...args);
    if (typeof id === 'number' && id > watermark) watermark = id;   // keep the whoami watermark current
    try {
      const msg = await db.getMessage(id);
      if (msg) hub.notify(msg);
    } catch (e) {
      log(`[ws] notify skipped for message ${id}: ${e?.message ?? e}`);
    }
    return id;
  };

  // ---- Mount the authed REST API ---------------------------------------------------
  // versionGateMiddleware sits AFTER requireAuth (never a pre-auth oracle) and BEFORE the router, so
  // it gates the WHOLE data plane — send, poll-receive, work-claim, data — not just /register. This is
  // what makes a stale host actually unable to coordinate, rather than merely warned. See version-gate.mjs.
  app.use('/api', requireAuth, versionGateMiddleware({ serverVersion, versionGateBypass }), writeLimit, makeRouter(db));

  // Fresh SQLite snapshot for replication/migration. Postgres has no local file → 501.
  app.get('/cc/export', requireAdmin, async (_req, res, next) => {
    if (config.backend !== 'sqlite') {
      return res.status(501).json({ error: 'snapshot export is only supported on the SQLite backend' });
    }
    const tmp = path.join(os.tmpdir(), `cc-export-${Date.now()}-${process.pid}.db`);
    try {
      await db.snapshot(tmp);
    } catch (e) {
      return next(e);
    }
    res.download(tmp, 'messages.db', (err) => {
      fs.rm(tmp, { force: true }, () => {});
      if (err && !res.headersSent) next(err);
    });
  });

  // Graceful step-down for the migration/election flow: ack, then wind down.
  app.post('/cc/stepdown', requireAdmin, (_req, res) => {
    res.json({ ok: true });
    // Let the response flush before we tear the listener down.
    setTimeout(() => { close().catch(() => {}); }, 50);
  });

  // Server-level fallback error handler (the REST router has its own; this covers /cc/* and
  // the body-parser). Honour a thrown status so an over-limit body is a 413 and malformed JSON
  // a 400 — not a blanket 500. Only genuine server faults (>=500) are logged and get detail.
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) log(`[http] error: ${err?.stack || err}`);
    if (res.headersSent) return;
    const error = status === 413 ? 'payload too large'
      : status >= 500 ? 'internal server error'
      : 'bad request';
    res.status(status).json({ error });
  });

  // ---- Background maintenance ------------------------------------------------------
  const cleanupTimer = setInterval(() => {
    Promise.resolve()
      .then(() => db.cleanup(config.cleanupDays))
      .catch((e) => log(`[cleanup] failed: ${e?.message ?? e}`));
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  const presenceTimer = setInterval(() => {
    Promise.resolve()
      .then(() => db.markStaleOffline(PRESENCE_STALE_SECONDS))
      .catch((e) => log(`[presence] failed: ${e?.message ?? e}`));
  }, PRESENCE_INTERVAL_MS);
  presenceTimer.unref?.();

  // Reclaim idle rate-limit buckets so neither Map grows without bound.
  const rlSweepTimer = setInterval(() => { authFailLimiter.sweep(); writeLimiter.sweep(); }, 60 * 1000);
  rlSweepTimer.unref?.();

  // ---- Shutdown --------------------------------------------------------------------
  let closing = null;
  function close() {
    if (closing) return closing;
    clearInterval(cleanupTimer);
    clearInterval(presenceTimer);
    clearInterval(rlSweepTimer);
    closing = new Promise((resolve) => {
      server.close(() => {
        try { db.db?.close?.(); } catch { /* ignore close races */ }
        resolve();
      });
      // Nudge any lingering keep-alive/WS sockets so close() actually resolves.
      server.closeAllConnections?.();
    });
    return closing;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind the configured interface (loopback by default; CC_BIND to serve the estate).
    server.listen(config.port, config.bind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  if (!config.apiKey) {
    log('  ****************************************************************');
    log('  * WARNING: MCP_API_KEY is not set — the REST API is OPEN.     *');
    log('  * Anyone who can reach this bind can read and write the bus.  *');
    log('  * Set MCP_API_KEY before exposing this beyond localhost.      *');
    log('  ****************************************************************');
  }
  log(
    `[crosstalk] leader=${config.host} epoch=${config.epoch} ` +
      `bind=${config.bind} port=${config.port} auth=${config.apiKey ? 'on' : 'OFF'} ` +
      `admin=${config.adminKey ? 'key' : 'loopback-only'} backend=${config.backend}`,
  );

  return { server, db, hub, config, close };
}

// Boot when executed directly (node server/server.mjs), not when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer().catch((e) => {
    console.error('[crosstalk] failed to start:', e);
    process.exit(1);
  });
}
