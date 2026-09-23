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

// --- forged-header defence (#51) --------------------------------------------------------------
// A message renders as `CHAT #<ch> <sender> [<type>]<tag>: <content>` and every sink (Monitor, the
// Codex queue, pi) reads that text line by line. Content that itself contained a line starting
// "CHAT #…" used to render BYTE-IDENTICAL to a genuine message from someone else — a peer could
// forge a handoff from the lead. So every line after the header is a CONTINUATION and starts with
// CONT, which no header ever does; every break a terminal or an LLM might honour (\r\n, lone \r,
// \v, \f, NEL, U+2028/2029) counts as a line break; and invisible characters that could disguise
// a line (bidi overrides/isolates/marks, zero-width, other C0/C1 controls) are stripped. Tab stays.
export const CONT = '│ ';
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
const LINE_BREAKS = new RegExp(LINE_BREAK.source, 'g');
const INVISIBLE_CLASS = '\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF';
// eslint-disable-next-line no-control-regex
const INVISIBLE = new RegExp(`[\\u0000-\\u0008\\u000E-\\u001F\\u007F-\\u0084\\u0086-\\u009F${INVISIBLE_CLASS}]`, 'g');

// Every line break → '\n', invisibles stripped.
export function sanitiseText(s) {
  return String(s ?? '').replace(LINE_BREAKS, '\n').replace(INVISIBLE, '');
}
// A header field (channel, sender, type) is ONE line: its breaks become spaces.
function headerField(s) {
  return sanitiseText(s).replace(/\n/g, ' ');
}

// Server-side defence in depth (#51): at write time a content line that would read as a bus header
// is quoted with '> ' — neutralised, never rejected, so a legitimate sender quoting a message still
// gets through. CONT marking in the renderer is the real guarantee; this keeps the STORED text
// unambiguous for anything that shows it without cc-render (the console, a replica, a raw GET).
const FORGED_HEADER = new RegExp(`^[\\s${INVISIBLE_CLASS}]*CHAT #`, 'i');
export function neutraliseForgedHeaders(content) {
  const parts = String(content ?? '').split(new RegExp(`(${LINE_BREAK.source})`));
  for (let i = 0; i < parts.length; i += 2) {      // odd indices are the captured separators
    if (FORGED_HEADER.test(parts[i])) parts[i] = '> ' + parts[i];
  }
  return parts.join('');
}

// The header a message renders to, followed by its body: the body's first line sits on the header
// line, every further line starts with CONT, so no content can ever begin a rendered line.
export function renderLine(msg, identity, addressed = true) {
  const tag = tagFor(msg, identity, addressed);
  const lines = sanitiseText(msg.content || '').split('\n');
  // Trailing blank lines carry nothing (and would spill into an empty final notification).
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l, i) => (i === 0 ? l : CONT + l)).join('\n');
  return `CHAT #${headerField(msg.channel)} ${headerField(msg.sender)} [${headerField(msg.message_type)}]${tag}: ${body}`;
}

// Hard-wrap a single logical line to width, never emitting an empty piece. The pieces after the
// first are continuations too, so they carry CONT (a forged header 400 chars in must not surface).
// Cuts are in UTF-16 units, so a cut that would land between the halves of a surrogate pair (an
// emoji) backs off one unit — otherwise CONT would sit between them and each half render as U+FFFD.
// Every piece must advance: the width is clamped so a continuation carries >= 2 units after CONT,
// and a cut that would not move (a back-off at step 1) takes the whole pair instead.
function hardWrap(line, width) {
  width = Math.max(width, CONT.length + 2);
  if (line.length <= width) return [line];
  const cut = (at) => (at < line.length && isHighSurrogate(line.charCodeAt(at - 1)) ? at - 1 : at);
  let end = cut(width);
  const out = [line.slice(0, end)];
  const step = width - CONT.length;
  for (let i = end; i < line.length; i = end) {
    end = cut(Math.min(i + step, line.length));
    if (end <= i) end = Math.min(i + 2, line.length);
    out.push(CONT + line.slice(i, end));
  }
  return out;
}
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;

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

  // Every physical line after the first must start with CONT. renderLine already marks content
  // lines; re-asserting it here covers any caller that hands in raw text, so neither a line break
  // nor a ‹part i/N› split can ever expose an unmarked line start (#51).
  const physical = [];
  String(rendered).split(LINE_BREAK).forEach((logical, li) => {
    const line = li === 0 || logical.startsWith(CONT) ? logical : CONT + logical;
    for (const piece of hardWrap(line, width)) physical.push(piece);
  });
  // Drop trailing blank lines (a message ending in one or more '\n' — common — would otherwise
  // spill into a spurious empty final block/notification like "‹part N/N — end›" with nothing
  // under it). Interior blank lines are preserved. Keep at least one line.
  while (physical.length > 1 && (physical[physical.length - 1] === '' || physical[physical.length - 1] === CONT)) physical.pop();
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
