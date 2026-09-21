// ---------------------------------------------------------------------------
// ws-hub.mjs — real-time push transport for the Crosstalk bus (issue #3).
//
// Attaches a WebSocket endpoint to the leader's existing http.Server via the
// `upgrade` event, so push lives on the SAME port/token as the REST API — no new
// daemon, no new port, no new dependency. Hand-rolled framing (server->client
// text, plus enough client->server decode to honour ping/close): a handful of
// well-understood opcodes, verified against Node's built-in WebSocket client and
// Claude Code's Monitor `ws` source (2026-09-08).
//
// WHY hand-rolled and not the `ws` package: the estate is a fleet of machines,
// any of which may be the leader. node_modules is per-node and gitignored, so a
// new dependency would force `npm install` on every box before the bus could
// start. Hand-rolling keeps the estate update to a plain `git pull` + restart —
// which matters when a dozen live sessions are waiting on the upgrade.
//
// Model: a client (the cc-ws.mjs bridge) connects to
//   GET /cc/ws?identity=<id>&token=<tok>
// and the hub pushes it one JSON frame — {"type":"msg","message":{…}} — for every
// NEW message ADDRESSED to <id> (same filter cc-poll applied: dm channel, @mention,
// @all). The bridge does the rendering/wrapping and the cursor backfill; the hub is
// deliberately dumb about presentation. Fan-out is best-effort: a dead socket is
// dropped, never blocks a send, and the REST cursor API remains the reliability
// backstop (the bridge replays anything missed on reconnect).
// ---------------------------------------------------------------------------
import { createHash, timingSafeEqual } from 'node:crypto';
import { addressedTo } from '../src/cc-render.mjs';
import { versionGateReject } from './version-gate.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Cap on the client->server decode buffer. The bridge only ever sends tiny control frames
// (ping/close, <128 bytes), so a buffer that grows past this is either a stuck/oversized
// frame or an abusive peer — we drop the connection rather than accumulate unboundedly. A
// peer that lies about frame length (e.g. claims 10GB) never completes it, so it trips here.
const MAX_WS_BUFFER = 1 << 20; // 1 MiB

// Constant-time token comparison. Length is guarded first (timingSafeEqual throws on
// unequal-length buffers); behaviour is identical to === for valid/invalid tokens.
function tokensMatch(presented, expected) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- server->client text frame (unmasked, single, unfragmented) ---
function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// --- incoming (client->server) frame decoder: buffers across TCP chunks, unmasks,
// yields {opcode, payload} per complete frame. We only ACT on close (0x8) and ping
// (0x9); data frames from the bridge are ignored (it never sends app data). ---
function makeDecoder(onFrame, { maxBuffer = MAX_WS_BUFFER, onOverflow = () => {} } = {}) {
  let buf = Buffer.alloc(0);
  let dead = false;
  return (chunk) => {
    if (dead) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > maxBuffer) {   // partial-frame flood / oversized frame → cut the peer off
      dead = true; buf = Buffer.alloc(0); onOverflow();
      return;
    }
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset); offset += 8;
        len = Number(big);
      }
      let maskKey;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + len) return;   // frame not fully arrived yet
      let payload = buf.subarray(offset, offset + len);
      if (masked && maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      buf = buf.subarray(offset + len);
      onFrame(opcode, payload);
    }
  };
}

// Decide whether a browser Origin may open the socket (and, via server.mjs, receive CORS grants
// on the REST API). No Origin (Node clients — the bridge — never send one) is always allowed; a
// present Origin must be localhost, the same host we were dialed on, or explicitly allowlisted.
// This blocks a malicious web page from silently opening a cross-origin WS to a bus reachable
// from the victim's browser. The literal origin `null` is what a console opened as a file:// page
// sends; it is allowed only when the caller opts in (CC_ALLOW_FILE_ORIGIN=1, OFF by default: any web
// page can forge a null origin from a sandboxed iframe. The bus carries no cookies, so a bearer
// token is still required for anything beyond the public endpoints).
export function originAllowed(origin, req, allowedOrigins, allowFileOrigin = false) {
  if (!origin) return true;                          // non-browser client
  if (origin === 'null') return !!allowFileOrigin;   // file:// console
  if (allowedOrigins.includes(origin)) return true;  // explicit allowlist
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.')) return true;
  const reqHost = String(req.headers.host || '').split(':')[0];
  return !!reqHost && host === reqHost;              // same-origin
}

// Attach the hub. Returns { notify(msg), connectionCount(), identities() }.
//   token: the shared bus token; a WS connect must present it (Authorization: Bearer <t>,
//          or ?token=/?api_key= for browsers that cannot set handshake headers).
//   allowedOrigins: extra browser Origins permitted beyond localhost/same-host.
//   allowFileOrigin: also accept the literal `null` Origin of a file:// page (opt-in).
//   authFailLimiter / clientIp: the server's per-IP auth-failure limiter, so a bad ?token= on
//          the upgrade path trips the same 429 as a bad bearer on REST (a browser page can
//          drive this path in a loop; REST alone being throttled would leave a token oracle).
//   ?firehose=1: the operator console asks for EVERY message, not just the addressed ones the
//          lanes get. Still token-gated, still never echoes a socket its own sends.
export function attachWsHub(httpServer, { token, log = () => {}, allowedOrigins = [], allowFileOrigin = false, authFailLimiter = null, clientIp = (req) => req.socket?.remoteAddress || '', serverVersion = null, versionGateBypass = false } = {}) {
  // identity -> Set<socket>. A box may briefly hold two (old + reconnect) — both get the push.
  const conns = new Map();

  function add(identity, socket) {
    if (!conns.has(identity)) conns.set(identity, new Set());
    conns.get(identity).add(socket);
  }
  function remove(identity, socket) {
    const set = conns.get(identity);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) conns.delete(identity);
  }

  httpServer.on('upgrade', (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/cc/ws') { socket.destroy(); return; }

    // Origin allowlist (M4): reject cross-origin browser upgrades before anything else.
    if (!originAllowed(req.headers.origin, req, allowedOrigins, allowFileOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Prefer the Authorization header (Node clients keep the token OUT of the URL, H1); fall
    // back to the query for browsers, which cannot set headers on the WS handshake.
    const auth = req.headers['authorization'] || '';
    const headerTok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const presented = headerTok || url.searchParams.get('token') || url.searchParams.get('api_key') || '';
    if (token && !tokensMatch(presented, token)) {
      const lim = authFailLimiter ? authFailLimiter.hit(clientIp(req)) : { limited: false };
      socket.write(lim.limited
        ? `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${lim.retryAfterSec}\r\nConnection: close\r\n\r\n`
        : 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Fleet version gate on the push channel — applied to EVERY upgrade, firehose included, so a stale
    // client cannot open a firehose socket to receive traffic while skipping the gate. The browser
    // console carries the leader's own version as &v= (it is a follower/viewer), so it always matches
    // and is never locked out. Placed after the origin + constant-time token checks: a 426 is only
    // reachable post-auth, never an unauthenticated version oracle. See version-gate.mjs.
    const vg = versionGateReject(url.searchParams.get('v') || '', serverVersion, { bypass: versionGateBypass });
    if (vg) {
      socket.write(`HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    const firehose = url.searchParams.get('firehose') === '1';
    const identity = url.searchParams.get('identity') || '';
    if (!identity) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket.setNoDelay?.(true);
    socket._firehose = firehose;
    add(identity, socket);
    log(`[ws] + ${identity} (now ${conns.get(identity).size} socket(s); ${conns.size} identities)`);

    // Greet so the bridge knows push is live (it flips from poll-fallback to push-primary).
    try { socket.write(encodeFrame(JSON.stringify({ type: 'hello', identity, firehose }))); } catch {}

    const cleanup = () => {
      remove(identity, socket);
      log(`[ws] - ${identity} (${conns.size} identities remain)`);
    };

    const decode = makeDecoder((opcode, payload) => {
      if (opcode === 0x8) {                       // close
        try { socket.write(encodeFrame('', 0x8)); } catch {}
        try { socket.end(); } catch {}
      } else if (opcode === 0x9) {                // ping -> pong (echo payload)
        try { socket.write(encodeFrame(payload.toString('binary'), 0xA)); } catch {}
      }
      // 0x1/0x2 (data) and 0xA (pong) ignored — the bridge sends no application data.
    }, {
      onOverflow: () => {                          // partial-frame flood → drop the connection
        log(`[ws] ! ${identity} exceeded the ${MAX_WS_BUFFER}B frame buffer → closing`);
        try { socket.destroy(); } catch {}
      },
    });

    socket.on('data', (chunk) => { try { decode(chunk); } catch {} });
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('end', () => { try { socket.end(); } catch {} });

    // Server-initiated keepalive: ping every 30s. Node's WebSocket client and the Monitor
    // ws source auto-pong at the protocol level, keeping NAT/tailnet paths warm and letting
    // 'error'/'close' fire promptly on a dead peer.
    const ping = setInterval(() => { try { socket.write(encodeFrame('', 0x9)); } catch {} }, 30000);
    ping.unref?.();
    const clearPing = () => clearInterval(ping);
    socket.on('close', clearPing);
    socket.on('error', clearPing);
  });

  // Fan out a freshly-inserted message to every connected identity it is addressed to.
  // Best-effort and synchronous-ish: a failed write drops that socket and never throws.
  function notify(msg) {
    if (!conns.size) return;
    let frame = null;   // built lazily, reused across recipients
    for (const [identity, sockets] of conns) {
      if (msg.sender === identity) continue;             // never echo a lane its own message
      const addressed = addressedTo(msg, identity);
      for (const socket of sockets) {
        if (!addressed && !socket._firehose) continue;   // lanes: addressed only; console: everything
        if (!frame) frame = encodeFrame(JSON.stringify({ type: 'msg', message: msg }));
        try { socket.write(frame); } catch { remove(identity, socket); try { socket.destroy(); } catch {} }
      }
    }
  }

  // Tear down every upgraded socket. server.closeAllConnections() does NOT touch sockets that
  // were upgraded off the http parser, so a shutdown that skips this never resolves while any
  // WS client is attached — the exact stepdown wedge of issue #34. Best-effort close frame
  // first (a well-behaved client sees 1000-ish close), then destroy.
  function destroy() {
    for (const sockets of conns.values()) {
      for (const socket of sockets) {
        try { socket.write(encodeFrame('', 0x8)); } catch {}
        try { socket.destroy(); } catch {}
      }
    }
    conns.clear();
  }

  return {
    notify,
    destroy,
    connectionCount: () => { let n = 0; for (const s of conns.values()) n += s.size; return n; },
    identities: () => [...conns.keys()],
  };
}
