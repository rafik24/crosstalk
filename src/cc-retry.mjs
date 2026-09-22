// ---------------------------------------------------------------------------
// cc-retry.mjs — ride out a leader DRAIN (issue 43) instead of failing the caller.
//
// A leader in a drain stepdown is read-only for a few seconds: it answers writes with
// `503 {reason:'draining'}` + `Retry-After`, then leaves, and a replica takes the term on a
// complete copy. For a sender that is a non-event — IF it waits and re-sends to the NEW leader.
// Without this every send/ack/claim issued in that window surfaced as a hard failure to an agent
// that may or may not think to retry.
//
//   const r = await throughDrain(() => fetch(BASE + path, init), async () => { BASE = (await resolveFull(...))?.base ?? BASE; });
//
// `request` is called again after `relocate` has had the chance to move BASE. Only a 503 whose body
// says reason:'draining' is retried (a rate-limit 429, a 5xx fault or a plain 503 are the caller's
// to handle), at most `tries` times, waiting Retry-After (capped) each time; a connection error
// AFTER a drain was seen means "between leaders" and is retried too. Zero deps.
// ---------------------------------------------------------------------------
const MAX_WAIT_MS = 8000;

export async function throughDrain(request, relocate, { tries = 5, log = null } = {}) {
  if (tries === undefined) tries = 5;   // ≈ the server's 20s drain deadline
  let r = await request();
  let sawDrain = false;
  for (let i = 0; i < tries; i++) {
    let wait;
    if (r && r.status === 503) {
      let body = null;
      try { body = await r.clone().json(); } catch {}
      if (body?.reason !== 'draining') break;
      sawDrain = true;
      wait = Math.min(MAX_WAIT_MS, Math.max(1, parseInt(r.headers.get('retry-after')) || 5) * 1000);
    } else if (!r) {
      wait = 2000;            // the drained leader has LEFT and its successor is not up yet
    } else break;
    if (log) log(`[bus leader is handing over (draining) — retrying in ${wait / 1000}s]`);
    await new Promise((res) => setTimeout(res, wait));
    try { await relocate(); } catch {}
    // Once a drain was seen, a connection error only means "between leaders" — keep going. Before
    // any drain was seen, an error is the caller's (it propagates from the first request above).
    try { r = await request(); } catch (e) { if (!sawDrain || i === tries - 1) throw e; r = null; }
  }
  if (!r) throw new Error('bus leader handover did not complete in time — retry');
  return r;
}
