// cc-render unit tests — pure, no I/O, no server. Guards the two invariants the whole
// bus rests on: the addressed-to filter (server fan-out == client display) and the
// notification wrapping that fixes DM truncation.
//   node test/render.test.mjs
import assert from 'node:assert';
import { addressedTo, isAtAll, renderLine, wrapForNotification, WRAP_WIDTH, MAX_LINES_PER_BLOCK, canonicalShort, shortIdOf } from '../src/cc-render.mjs';

let failed = false;
const ok = (cond, msg) => { try { assert.ok(cond, msg); } catch (e) { failed = true; console.error('❌', e.message); } };
const eq = (a, b, msg) => { try { assert.deepStrictEqual(a, b, msg); } catch (e) { failed = true; console.error('❌', e.message); } };

// --- addressedTo ---
const me = 'desktop-x/bus-work';
ok(addressedTo({ channel: 'dm-bus-work', content: 'hi' }, me), 'DM channel to my shortid is addressed');
ok(addressedTo({ channel: 'general', content: 'hey @bus-work look' }, me), '@shortid mention is addressed');
ok(addressedTo({ channel: 'general', content: 'hey @desktop-x/bus-work' }, me), '@full-id mention is addressed');
ok(addressedTo({ channel: 'general', content: '@all stop pushing' }, me), '@all is addressed to everyone');
ok(addressedTo({ channel: 'general', content: '@here ping' }, me), '@here is addressed');
ok(!addressedTo({ channel: 'general', content: 'chatter between others' }, me), 'ambient is NOT addressed');
ok(!addressedTo({ channel: 'dm-someone-else', content: 'x' }, me), "another lane's DM is NOT addressed to me");
ok(isAtAll('please @everyone'), '@everyone detected');
ok(!isAtAll('email@example.com'), 'a bare email is not @all');

// --- #5: one canonical short name, so id.short == dm-<short> channel byte for byte ---
eq(canonicalShort('Foo_Bar'), 'foo-bar', 'underscore + uppercase canonicalize');
eq(canonicalShort('ubuntu_24_04'), 'ubuntu-24-04', 'underscores -> dashes');
eq(canonicalShort('ubuntu-24-04'), 'ubuntu-24-04', 'already-canonical is stable (idempotent)');
eq(canonicalShort('a..b--c'), 'ab-c', 'dots dropped, dashes collapsed');
eq(shortIdOf('winbox/reclaim_offline'), 'reclaim-offline', 'shortIdOf canonicalizes the short name');
// THE bug: the server normalizes a posted channel, so a DM to an underscore id lands on
// `dm-reclaim-offline`; addressedTo must match it (it used to only match `dm-reclaim_offline`).
ok(addressedTo({ channel: 'dm-reclaim-offline', content: 'hi' }, 'winbox/reclaim_offline'),
  '#5: a dm to the canonical channel reaches an underscore-named session');
ok(!addressedTo({ channel: 'dm-someone-else', content: 'x' }, 'winbox/reclaim_offline'),
  "a different lane's dm is still not addressed");

// --- wrapForNotification: short message = exactly one block, one line, no decoration ---
{
  const line = renderLine({ channel: 'general', sender: 'alice', message_type: 'message', content: 'short and sweet' }, me);
  const blocks = wrapForNotification(line);
  eq(blocks.length, 1, 'short message → 1 block');
  ok(!blocks[0].includes('‹part'), 'short message is not decorated with a part header');
  ok(blocks[0].startsWith('CHAT #general alice'), 'render prefix intact');
}

// --- a long single line is HARD-WRAPPED to <= WRAP_WIDTH per physical line ---
{
  const body = 'x'.repeat(5000);
  const line = renderLine({ channel: 'general', sender: 'alice', message_type: 'message', content: body }, me);
  const blocks = wrapForNotification(line);
  ok(blocks.length > 1, 'a 5000-char body spans multiple blocks');
  for (const block of blocks) {
    for (const physical of block.split('\n')) {
      ok(physical.length <= WRAP_WIDTH, `every physical line <= ${WRAP_WIDTH} (got ${physical.length})`);
    }
    const contentLines = block.split('\n').filter((l) => !l.startsWith('‹part'));
    ok(contentLines.length <= MAX_LINES_PER_BLOCK, `<= ${MAX_LINES_PER_BLOCK} content lines per block`);
  }
  ok(blocks.every((b) => b.startsWith('‹part ')), 'multi-block message: every block carries a part header');
  // Reassembling the wrapped content must reproduce the original body (nothing dropped).
  const reassembled = blocks
    .map((b) => b.split('\n').filter((l) => !l.startsWith('‹part')).join(''))
    .join('');
  ok(reassembled.endsWith('x'.repeat(50)), 'the tail of the long body survives wrapping (no truncation)');
  ok(reassembled.includes('CHAT #general alice'), 'the head survives too');
}

// --- an embedded newline in the body is preserved as a wrap boundary ---
{
  const line = renderLine({ channel: 'general', sender: 'a', message_type: 'message', content: 'line1\nline2' }, me);
  const blocks = wrapForNotification(line);
  ok(blocks[0].includes('\n'), 'embedded newline preserved');
}

// --- trailing newlines must not spill into a spurious empty final block ---
{
  const line = renderLine({ channel: 'general', sender: 'a', message_type: 'message', content: 'body ends here\n\n' }, me);
  const blocks = wrapForNotification(line);
  eq(blocks.length, 1, 'a message with trailing newlines yields no empty trailing block');
  ok(!blocks[blocks.length - 1].endsWith('— end›'), 'no empty "end" part header');
}

// --- handoff tag ---
{
  const line = renderLine({ channel: 'dm-bus-work', sender: 'a', message_type: 'handoff', content: 'take this' }, me);
  ok(line.includes('»HANDOFF — ACK REQUIRED«'), 'handoff carries the ack-required tag');
}

if (failed) { console.error('❌ render.test FAILED'); process.exit(1); }
console.log('✅ render.test: all assertions passed (addressedTo filter + notification wrapping / truncation fix)');
