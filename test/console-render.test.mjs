// console-render.test.mjs — the browser console's render functions never emit bus data unescaped.
//
// The console is one inline <script>. This test lifts that script into a Function with a tiny
// fake DOM (enough for the top-level wiring to run without a browser), then feeds every render
// function a payload whose every string field is an XSS probe and asserts that the HTML each one
// emits contains the probe only in escaped form. It also pins the two display contracts the bus
// relies on: seenIds dedupe (exactly-once across push + poll) and the @mention chips being built
// from already-escaped text.
//
// Run: node test/console-render.test.mjs   (exits non-zero on any failed assertion)
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/cc-console.html', import.meta.url), 'utf8');
const js = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));

// ---- a minimal DOM: every element records innerHTML/textContent, supports the handful of
//      calls the console makes, and getElementById hands out one element per id. ----------------
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), innerHTML: '', textContent: '', className: '', value: '', checked: false,
    hidden: false, disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, title: '',
    dataset: {}, style: {}, children: [], previousElementSibling: null, _listeners: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); }, remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) { const on = force === undefined ? !this._set.has(c) : !!force; on ? this._set.add(c) : this._set.delete(c); return on; },
      contains(c) { return this._set.has(c); },
    },
    appendChild(child) { child.previousElementSibling = el.children[el.children.length - 1] || null; el.children.push(child); return child; },
    insertBefore(child, ref) {
      if (!ref) return el.appendChild(child);
      const i = el.children.indexOf(ref); el.children.splice(i, 0, child);
      child.previousElementSibling = el.children[i - 1] || null; ref.previousElementSibling = child; return child;
    },
    get lastElementChild() { return el.children[el.children.length - 1] || null; },
    querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
    addEventListener(t, fn) { (el._listeners[t] ||= []).push(fn); }, removeEventListener() {},
    setAttribute(k, v) { el['@' + k] = String(v); }, getAttribute(k) { return el['@' + k] ?? null; },
    focus() {}, setSelectionRange() {}, dispatchEvent() {},
  };
  return el;
}
const byId = new Map();
const document = {
  getElementById: (id) => { if (!byId.has(id)) byId.set(id, makeEl()); return byId.get(id); },
  createElement: (tag) => makeEl(tag),
  addEventListener() {}, hasFocus: () => true, visibilityState: 'visible',
  body: makeEl('body'), documentElement: makeEl('html'),
  querySelectorAll: () => [], querySelector: () => null,
};
const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const location = { protocol: 'file:', origin: 'null', hash: '', search: '' };
const window = { addEventListener() {}, focus() {} };   // no WebSocket, no Notification: both paths must be optional
const noop = () => 0;

const factory = new Function(
  'document', 'localStorage', 'location', 'window', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'fetch', 'AbortController',
  js + '\n;return { addMsg, renderBanner, renderRoster, renderChannels, workRowHtml, renderWorkSummary, openMentions, msgLog, seenIds: () => seenIds, $ };',
);
const c = factory(document, localStorage, location, window, noop, noop, noop, noop, () => Promise.reject(new Error('offline')), class { constructor() { this.signal = {}; } abort() {} });

const PROBE = '<img src=x onerror=alert(1)>"\'</span><script>x</script>';
// Fixture timestamps must be 'now': the roster and channel lists hide anything outside the 15-minute
// active window, so a fixed date would pass only until the clock moved past it.
const NOW = new Date().toISOString().replace('T', ' ').slice(0, 19);
const escapedOnly = (out, where) => {
  assert.ok(out.length > 0, where + ' emitted something');
  assert.ok(!out.includes('<img'), where + ' must not emit a raw <img');
  assert.ok(!out.includes('<script'), where + ' must not emit a raw <script');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), where + ' emits the probe escaped (entity-encoded, so it is inert text)');
};

// ---- messages: every string field is hostile ---------------------------------------------------
{
  const stream = c.$('stream');
  c.addMsg({ id: 1, channel: PROBE, sender: PROBE, message_type: PROBE, content: PROBE, created_at: PROBE });
  assert.equal(stream.children.length, 1, 'one row rendered');
  const row = stream.children[0];
  escapedOnly(row.innerHTML, 'addMsg');
  assert.ok(!row.className.includes('<'), 'class list carries no markup');
  // exactly-once: the same id again is dropped
  c.addMsg({ id: 1, channel: 'general', sender: 'x', message_type: 'status', content: 'dup', created_at: '2026-09-14 10:00:00' });
  assert.equal(stream.children.length, 1, 'duplicate id is not rendered twice');
  // mention chips are built from escaped text: a probe inside the mention id cannot break out
  c.addMsg({ id: 2, channel: 'general', sender: 'peer', message_type: 'message', content: '@po-console look @<b>x</b> and @all', created_at: '2026-09-14 10:00:01' });
  const m = stream.children[1].innerHTML;
  assert.ok(m.includes('<span class="at me">@po-console</span>'), 'mention of me becomes a highlighted chip');
  assert.ok(m.includes('<span class="at me">@all</span>'), 'broadcast keyword is highlighted');
  assert.ok(!m.includes('<b>'), 'markup inside a mention stays escaped');
  assert.ok(m.includes('&lt;b&gt;'), 'escaped form is what reaches the DOM');
  // mention boundaries: an entity or a quote right after the id can neither join the chip nor break out
  c.addMsg({ id: 4, channel: 'general', sender: 'peer', message_type: 'message', content: `@po-console' and @a&b and "@me&#39;`, created_at: '2026-09-14 10:00:02' });
  const b = stream.children[stream.children.length - 1].innerHTML;
  assert.ok(b.includes('<span class="at me">@po-console</span>&#39;'), 'quote after a mention stays outside the chip, escaped');
  assert.ok(b.includes('<span class="at">@a</span>&amp;b'), 'entity after a mention stays outside the chip');
  assert.ok(b.includes('&quot;<span class="at">@me</span>&amp;#39;'), 'a literal &#39; in content survives as text, not as a quote');
  assert.ok(!/<span class="at[^"]*">[^<]*&/.test(b), 'no chip ever contains an ampersand');
  // id-ordered insertion + grouping: a pushed newer id, then the sweep brings the older one
  c.addMsg({ id: 10, channel: 'ops', sender: 'lane', message_type: 'status', content: 'second', created_at: '2026-09-14 11:00:05' });
  c.addMsg({ id: 9, channel: 'ops', sender: 'lane', message_type: 'status', content: 'first', created_at: '2026-09-14 11:00:00' });
  const ids = stream.children.map((r) => r._m.id);
  assert.deepEqual(ids.slice(-2), [9, 10], 'rows are kept in id order even when pushed out of order');
  const last = stream.children[stream.children.length - 1];
  assert.ok(last.classList.contains('cont'), 'the later row of one sender+channel thread shares the header');
  assert.ok(!stream.children[stream.children.length - 2].classList.contains('cont'), 'the earlier row keeps its header');
}

// ---- unacked-handoff strip ----------------------------------------------------------------------
{
  c.addMsg({ id: 3, channel: PROBE, sender: PROBE, message_type: 'handoff', content: PROBE, created_at: '2099-01-01 00:00:00' });
  c.renderBanner();
  escapedOnly(c.$('ackbanner').innerHTML, 'renderBanner');
  assert.ok(c.$('ackbanner').className.includes('show'), 'strip shows for an unacked handoff');
}

// ---- roster + channels --------------------------------------------------------------------------
{
  // status must be 'online' or the active-window filter (correctly) hides the row before anything renders
  c.renderRoster([{ instance_id: PROBE + '/' + PROBE, status: 'online', last_seen: PROBE, description: PROBE, rev: PROBE }]);
  escapedOnly(c.$('roster').innerHTML, 'renderRoster');
  c.renderChannels([{ name: PROBE, last_message_at: NOW, message_count: 3 }]);
  escapedOnly(c.$('channels').innerHTML, 'renderChannels');
  const dl = c.$('chanlist').innerHTML;
  assert.ok(dl.includes('<option value="') && !dl.includes('<img') && dl.includes('&lt;img'), 'composer datalist options are escaped too');
}

// ---- work board -------------------------------------------------------------------------------
{
  const it = { id: 7, title: PROBE, state: PROBE, kind: PROBE, owner: PROBE, domain: PROBE, external_ref: PROBE, updated_at: PROBE, claimed_at: PROBE, parent_id: null };
  escapedOnly(c.workRowHtml(it, 0), 'workRowHtml');
  // an unknown state never reaches an <use href> — the glyph falls back to the constant
  assert.ok(c.workRowHtml(it, 0).includes('href="#i-circle"'), 'unknown state uses the fallback glyph');
  c.renderWorkSummary([{ ...it, state: 'blocked' }, { ...it, state: 'merged' }]);
  const sum = c.$('wbsummary').innerHTML;
  assert.ok(sum.includes('1 blocked') && sum.includes('1 merged'), 'summary counts by state');
}

// ---- mention autocomplete ------------------------------------------------------------------------
{
  c.$('body').value = '@x'; c.$('body').selectionStart = 2;
  c.renderRoster([{ instance_id: 'host/' + PROBE, status: 'online', last_seen: NOW }, { instance_id: 'host/xylo', status: 'online', last_seen: NOW }]);
  c.openMentions();
  const out = c.$('mentions').innerHTML;
  assert.ok(out.includes('xylo'), 'matching peer is offered');
  assert.ok(out.includes('&lt;img'), 'the probe peer is offered in escaped form (it matches on the x in src=x)');
  assert.ok(!out.includes('<img'), 'openMentions never emits a raw <img');
}

console.log('✅ console-render.test: all assertions passed (escaping in every render path incl. datalist, exactly-once, mention-chip boundaries, id-ordered insertion + grouping, fallback glyph)');
