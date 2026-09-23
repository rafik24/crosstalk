// ---------------------------------------------------------------------------
// cc-proof.mjs — discovery AUTHENTICATION (issue 55). Zero deps.
//
// /cc/whoami and the LAN beacon carry no token, and discovery follows the HIGHEST advertised
// epoch — so any host that answered {epoch: 1e15} was adopted as the leader and then received
// every client's bearer token. Now a responder must PROVE it holds the estate secret:
//
//   whoami    the client sends a fresh nonce; the leader answers with
//             proof = HMAC-SHA256(CC_TOKEN, "whoami|" + nonce + "|" + host + "|" + epoch + "|" +
//                                 watermark + "|" + <the server's OWN socket address:port>)
//             The client checks it against the address it actually reached — so a RELAY on the
//             LAN that forwards the challenge to the real leader fails at the relay's address
//             (the leader signed ITS address, not the relay's), and the unsigned election
//             tiebreak (watermark) cannot be rewritten in flight either. The client never sends
//             anything a forger could replay or learn from.
//   beacon    every announce carries ts + HMAC(CC_TOKEN, "beacon|" + host + "|" + epoch +
//             "|" + port + "|" + ts); a solicitor accepts it only with a valid proof and a
//             fresh ts (replay window BEACON_FRESH_MS)
//
// An enrolled client (one that has a token) IGNORES any responder whose proof fails. Rollout
// window: CC_DISCOVERY_PROOF=legacy accepts unproven responders with a loud warning — for the
// sitting in which a pre-3.3.5 leader still serves, and removed the same sitting.
//
// The token is only ever an HMAC KEY here; nothing derived from it leaves the box except the
// HMAC itself, which reveals nothing about the key.
// ---------------------------------------------------------------------------
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { configPath } from './cc-paths.mjs';

export const BEACON_FRESH_MS = 60000;

export function nonce() { return randomBytes(16).toString('hex'); }

function hmac(token, text) { return createHmac('sha256', String(token)).update(text).digest('hex'); }

// Normalise an address so both ends agree: strip an IPv4-mapped-IPv6 prefix ('::ffff:127.0.0.1'),
// drop a v6 zone id ('fe80::1%eth0' → 'fe80::1'), and lowercase (v6 hex casing differs per stack).
// The binding is fail-CLOSED — a form the two sides render differently would reject a REAL leader —
// so this covers the reachable cases; compressed-vs-expanded v6 is not handled (v4 estate today).
export function normAddr(a) {
  let s = String(a || '').toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  return s;
}
export function whoamiProof(token, n, host, epoch, watermark, addr, port) { return hmac(token, `whoami|${n}|${host}|${epoch}|${watermark ?? 0}|${normAddr(addr)}:${port}`); }
export function beaconProof(token, host, epoch, port, ts) { return hmac(token, `beacon|${host}|${epoch}|${port}|${ts}`); }

export function proofsMatch(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

// The rollout escape must be reachable by the HOOK-STARTED supervisor, which gets its settings
// from the config FILE, not the operator's env: cc-join sources ~/.claude/.crosstalk without
// `export`, and cc-enrol writes non-exported lines, so `node cc-bus ensure` does not inherit them
// — every other CC_* works only because cc-bus reads the file directly. So proofMode must too, or
// the documented `CC_DISCOVERY_PROOF=legacy` rollback is inert on the auto-supervisor (reviewer
// B, RC2). Env wins over the file; a tiny inline read (not loadConfig) avoids a cc-discover cycle.
function configDiscoveryProof() {
  try {
    for (const l of readFileSync(configPath(), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*(?:export\s+)?CC_DISCOVERY_PROOF\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return '';
}
// 'strict' (default) | 'legacy' (rollout window only)
export function proofMode() {
  return (process.env.CC_DISCOVERY_PROOF || configDiscoveryProof() || '').toLowerCase() === 'legacy' ? 'legacy' : 'strict';
}

// Does a whoami answer prove itself? true = proven, false = wrong/missing proof, null = the caller
// has no token so nothing can be checked (an unenrolled box, a bare probe).
// reached = { address, port } — the peer this client's socket actually connected to.
export function whoamiProven(token, n, j, reached) {
  if (!token) return null;
  if (!j || typeof j.proof !== 'string' || !reached) return false;
  return proofsMatch(whoamiProof(token, n, j.host, j.epoch, j.watermark, reached.address, reached.port), j.proof);
}

export function beaconProven(token, m, now = Date.now()) {
  if (!token) return null;
  if (!m || typeof m.proof !== 'string' || typeof m.ts !== 'number') return false;
  if (Math.abs(now - m.ts) > BEACON_FRESH_MS) return false;
  return proofsMatch(beaconProof(token, m.host, m.epoch, m.port, m.ts), m.proof);
}
