// ---------------------------------------------------------------------------
// cc-proof.mjs — discovery AUTHENTICATION (issue 55). Zero deps.
//
// /cc/whoami and the LAN beacon carry no token, and discovery follows the HIGHEST advertised
// epoch — so any host that answered {epoch: 1e15} was adopted as the leader and then received
// every client's bearer token. Now a responder must PROVE it holds the estate secret:
//
//   whoami    the client sends a fresh nonce; the leader answers with
//             proof = HMAC-SHA256(CC_TOKEN, "whoami|" + nonce + "|" + host + "|" + epoch)
//             (the client never sends anything a forger could replay or learn from)
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

export const BEACON_FRESH_MS = 60000;

export function nonce() { return randomBytes(16).toString('hex'); }

function hmac(token, text) { return createHmac('sha256', String(token)).update(text).digest('hex'); }

export function whoamiProof(token, n, host, epoch) { return hmac(token, `whoami|${n}|${host}|${epoch}`); }
export function beaconProof(token, host, epoch, port, ts) { return hmac(token, `beacon|${host}|${epoch}|${port}|${ts}`); }

export function proofsMatch(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

// 'strict' (default) | 'legacy' (rollout window only)
export function proofMode() { return (process.env.CC_DISCOVERY_PROOF || '').toLowerCase() === 'legacy' ? 'legacy' : 'strict'; }

// Does a whoami answer prove itself? true = proven, false = wrong/missing proof, null = the caller
// has no token so nothing can be checked (an unenrolled box, a bare probe).
export function whoamiProven(token, n, j) {
  if (!token) return null;
  if (!j || typeof j.proof !== 'string') return false;
  return proofsMatch(whoamiProof(token, n, j.host, j.epoch), j.proof);
}

export function beaconProven(token, m, now = Date.now()) {
  if (!token) return null;
  if (!m || typeof m.proof !== 'string' || typeof m.ts !== 'number') return false;
  if (Math.abs(now - m.ts) > BEACON_FRESH_MS) return false;
  return proofsMatch(beaconProof(token, m.host, m.epoch, m.port, m.ts), m.proof);
}
