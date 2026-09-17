// ---------------------------------------------------------------------------
// cc-render.mjs — the ONE source of truth for two things the bus client and the
// bus server must agree on, byte for byte:
//
//   1. "is this message ADDRESSED to identity X?" (addressedTo) — the fan-out
//      filter. The server uses it to decide whom to push a WS frame to; the
//      client uses it as defense-in-depth on what it prints. If these two ever
//      disagreed, a lane would be woken for traffic that isn't its, or (worse)
//      NOT woken for a DM that is. So both import this exact function.
//
//   2. how a message becomes NOTIFICATION-SAFE text (renderLine + wrapForNotification).
//      The Claude Code harness truncates a single Monitor event line at ~470 chars
//      and a whole notification (a burst of lines within ~200ms) at ~3 KB. A long
//      DM printed as one line was therefore delivered truncated — the "a DM got
//      truncated, let me read it in full" friction. The fix is not on the wire (the
//      DB + REST always carried the full body) but HERE, at the edge: wrap the body
//      onto <=WRAP_WIDTH-char lines and split a very long message across several
//      spaced notifications, so the whole thing arrives, in order, with no fetch.
//
// Zero deps. Pure functions — no I/O — so it is trivially testable and safe to
// import into the server process.
//
// Empirically calibrated (2026-09-08, by probing the live Monitor + a WS source):
//   per-LINE cap  ~470 chars   -> WRAP_WIDTH 400 (headroom for the CHAT-prefix)
//   per-EVENT cap ~3000 chars  -> MAX_LINES_PER_BLOCK 6  (6*400 + headers < 3000)
// ---------------------------------------------------------------------------

export const WRAP_WIDTH = 400;
export const MAX_LINES_PER_BLOCK = 6;

// The ONE canonical normalizer for an identity's short name (the part after `host/`), and the
// dm-<short> channel derived from it. It MUST match how the server normalizes a channel name
// (normalizeChannelName in server/db.mjs): lowercase · spaces/underscores -> '-' · drop anything
// outside [a-z0-9-] · collapse repeats · trim. Why this matters (issue #5): the server normalizes
// a posted channel (so `dm-foo_bar` is stored as `dm-foo-bar`), but a raw short name kept `foo_bar`
// — so addressedTo matched `dm-foo_bar` and MISSED the stored `dm-foo-bar` → silently dropped DMs,
// and slug variants (`x_1` vs `x-1`) forked into separate peers. Routing every identity short name
// through this one function (here, at mint, at registration) keeps id == dm-channel, byte for byte.
export function canonicalShort(short) {
  return String(short || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function shortIdOf(identity) {
  return canonicalShort(String(identity || '').split('/').pop());
}

// @all / @here / @everyone — the deliberate broadcast-to-every-session escape hatch.
export function isAtAll(body) {
  return /(^|\s)@(all|here|everyone)\b/i.test(body || '');
}

// "Addressed to me" = a DM channel to me, an @mention of my id (full or short), or an
// @all broadcast. Kept identical to the historical cc-poll filter so behaviour is unchanged.
export function addressedTo(msg, identity) {
  const short = shortIdOf(identity);
  const body = msg.content || '';
  const channel = msg.channel || '';
  return (
    isAtAll(body) ||
    channel === `dm-${short}` ||
    channel.startsWith(`dm-${short}`) ||
    body.includes('@' + identity) ||
    body.includes('@' + short)
  );
}

// The attention tag shown to the receiving session. addressed==false is used by a
// firehose/--channel watcher (which prints ambient traffic with no tag).
export function tagFor(msg, identity, addressed = true) {
  const body = msg.content || '';
  if (addressed && msg.message_type === 'handoff') return ' »HANDOFF — ACK REQUIRED«';
  if (isAtAll(body)) return ' »@ALL«';
  return addressed ? ' »TO YOU«' : '';
}

// The one-line header a message renders to (before wrapping). The body follows.
export function renderLine(msg, identity, addressed = true) {
  const tag = tagFor(msg, identity, addressed);
  return `CHAT #${msg.channel} ${msg.sender} [${msg.message_type}]${tag}: ${msg.content || ''}`;
}

// Hard-wrap a single logical line to width, never emitting an empty piece.
function hardWrap(line, width) {
  if (line.length <= width) return [line];
  const out = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
}

// Turn a rendered line (which may itself contain '\n's from the message body) into an
// array of NOTIFICATION BLOCKS. Each block is a string of up to MAX_LINES_PER_BLOCK
// physical lines (each <= WRAP_WIDTH chars) — small enough that the harness delivers it
// whole. The caller prints one block per console.log and SPACES successive blocks >250ms
// apart so the harness treats them as separate notifications (a burst within ~200ms would
// be batched and re-truncated at the ~3 KB event cap).
//
// The overwhelmingly common case — a short message — yields exactly ONE block of ONE
// line and prints instantly with no delay.
export function wrapForNotification(rendered, opts = {}) {
  const width = opts.width || WRAP_WIDTH;
  const maxLines = opts.maxLinesPerBlock || MAX_LINES_PER_BLOCK;

  const physical = [];
  for (const logical of String(rendered).split('\n')) {
    for (const piece of hardWrap(logical, width)) physical.push(piece);
  }
  // Drop trailing blank lines (a message ending in one or more '\n' — common — would otherwise
  // spill into a spurious empty final block/notification like "‹part N/N — end›" with nothing
  // under it). Interior blank lines are preserved. Keep at least one line.
  while (physical.length > 1 && physical[physical.length - 1] === '') physical.pop();
  if (physical.length === 0) physical.push('');

  const blocks = [];
  for (let i = 0; i < physical.length; i += maxLines) {
    blocks.push(physical.slice(i, i + maxLines));
  }

  const n = blocks.length;
  return blocks.map((lines, i) => {
    // Only annotate when the message actually spans multiple notifications, so a normal
    // short message is never decorated. The marker tells the reader ordering + that more
    // is coming, so a multi-part DM reads as one message, not N mysteries.
    const head = n > 1 ? `‹part ${i + 1}/${n}${i + 1 < n ? ' — more follows' : ' — end'}›` : null;
    return head ? head + '\n' + lines.join('\n') : lines.join('\n');
  });
}
