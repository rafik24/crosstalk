#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-qwen-mcp.mjs — the bus as TYPED TOOLS for a model-driven lane (stdio MCP server). PROTOTYPE v2 (QA #42, A5).
//
// WHY: v1 let the model compose a shell command (`node cc-codex.mjs send …`) and tried to police it
// with a parser hook. The reviewer broke that three ways (flag injection such as --base → the bearer
// token goes to a stranger; cmd.exe / PowerShell quoting; free identity argument), and Qwen hooks
// fail OPEN anyway (measured). Here the model never touches a shell: it can only call
//     bus_send  { channel, text, type? }      type ∈ message|status|request|response
//     bus_ack   { channel, note }             the cc-ack contract: a `response` starting "ACK — "
//     bus_done  { channel, text }             type=done
//     bus_peers {}                            who is online (ids + status only)
// and everything security-relevant is decided HERE, never by a tool argument:
//   - IDENTITY is pinned: CC_LANE_ID from the environment the LAUNCHER set. No sender argument → no spoofing.
//   - LEADER + TOKEN come from the machine's bus config through the plugin's own discovery
//     (cc-discover). There is no base / pin / token / flag argument → nothing to inject (reviewer B1-a).
//   - CAPS: text ≤ CC_LANE_MAX_TEXT (4000) chars; ≤ CC_LANE_RATE (12) sends per rolling minute;
//     channel names are a strict charset; broadcast mentions (@all / @here / @everyone) are refused
//     unless CC_LANE_ALLOW_BROADCAST=1 — a prompt-injected lane must not be able to wake the estate.
//   - No file, process or network capability beyond POST/GET to the discovered bus leader.
// Platform-independent: JSON-RPC over stdio, no quoting, no shell.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0. Implements initialize, ping, tools/list,
// tools/call; ignores notifications. Zero deps. Logs to stderr only (stdout is the protocol).
// ---------------------------------------------------------------------------
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveFast, resolveFull, loadConfig } from './cc-discover.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';

const MAX_TEXT = Number(process.env.CC_LANE_MAX_TEXT || 4000);
const RATE = Number(process.env.CC_LANE_RATE || 12);
const SEND_TYPES = ['message', 'status', 'request', 'response'];
const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,96}$/;
const BROADCAST_RE = /(^|[^\w])@(all|here|everyone)\b/i;

export const TOOLS = [
  { name: 'bus_send', description: 'Send ONE message to a Crosstalk bus channel as this lane. To answer a message, use the SAME channel it arrived on (the word after "CHAT #") and type "response". Text you merely write in your own session is NOT delivered to anyone.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['channel', 'text'], properties: {
      channel: { type: 'string', description: 'Channel name, e.g. dm-some-lane, or "all" for #general.' },
      text: { type: 'string', description: `The message (max ${MAX_TEXT} characters).` },
      type: { type: 'string', enum: SEND_TYPES, description: 'Default "message". Use "response" when answering.' } } } },
  { name: 'bus_ack', description: 'Acknowledge a HANDOFF (a message tagged »HANDOFF — ACK REQUIRED«). Do this FIRST, before any work, on the channel the handoff arrived on.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['channel', 'note'], properties: {
      channel: { type: 'string' }, note: { type: 'string', description: 'What you are taking, e.g. "work #12 — into my lane".' } } } },
  { name: 'bus_done', description: 'Announce that a piece of work has LANDED (message type "done"). An ack is not a done.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'bus_peers', description: 'List the sessions currently known to the bus (id + online/offline).', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
];

// Pure argument validation → { channel, content, type } or throws Error(reason). Exported for the tests.
export function validate(tool, args, { allowBroadcast = process.env.CC_LANE_ALLOW_BROADCAST === '1' } = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const spec = TOOLS.find((t) => t.name === tool);
  if (!spec) throw new Error(`unknown tool ${JSON.stringify(tool)}`);
  const allowed = Object.keys(spec.inputSchema.properties);
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw new Error(`unexpected argument ${JSON.stringify(k)} — ${tool} accepts only: ${allowed.join(', ') || '(none)'}`);
  if (tool === 'bus_peers') return {};
  let channel = String(a.channel ?? '').trim().toLowerCase().replace(/^#/, '');
  if (channel === 'all') channel = 'general';
  if (!CHANNEL_RE.test(channel)) throw new Error('channel must match [a-z0-9][a-z0-9._-]{0,63} (e.g. dm-some-lane, or "all")');
  const raw = tool === 'bus_ack' ? a.note : a.text;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${tool === 'bus_ack' ? 'note' : 'text'} must be a non-empty string`);
  let content = raw.replace(/\u0000/g, '').trim();
  if (content.length > MAX_TEXT) throw new Error(`text is ${content.length} characters; the cap is ${MAX_TEXT}`);
  if (!allowBroadcast && BROADCAST_RE.test(content)) throw new Error('broadcast mentions (@all / @here / @everyone) are not allowed from this lane');
  let type = 'message';
  if (tool === 'bus_ack') { type = 'response'; if (!/^ACK\b/.test(content)) content = 'ACK — ' + content; }
  else if (tool === 'bus_done') type = 'done';
  else if (a.type !== undefined) { if (!SEND_TYPES.includes(a.type)) throw new Error(`type must be one of ${SEND_TYPES.join(', ')} (use bus_done / bus_ack for those)`); type = a.type; }
  return { channel, content, type };
}

// Rolling-minute limiter. Exported for the tests.
export function makeLimiter(perMinute = RATE, now = () => Date.now()) {
  const stamps = [];
  return () => { const t = now(); while (stamps.length && t - stamps[0] >= 60000) stamps.shift(); if (stamps.length >= perMinute) return false; stamps.push(t); return true; };
}

async function main() {
  const ID = process.env.CC_LANE_ID || '';
  const log = (...x) => process.stderr.write('[cc-qwen-mcp] ' + x.join(' ') + '\n');
  if (!ID_RE.test(ID)) { log('refusing to start: CC_LANE_ID must be set by the lane launcher (host/name)'); process.exit(2); }
  const cfg = loadConfig();
  if (!cfg.token) { log('refusing to start: no CC_TOKEN in the bus config'); process.exit(2); }
  const H = { Authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };
  const take = makeLimiter();
  let base = null;
  async function leader(full = false) {
    const l = full ? await resolveFull({ pin: cfg.pin, token: cfg.token }) : await resolveFast({ pin: cfg.pin, token: cfg.token });
    if (l?.base) base = l.base;
    return base;
  }
  async function api(path, init, retry = true) {
    if (!base && !(await leader(true))) throw new Error('no bus leader found');
    try {
      const r = await fetch(base + path, { ...init, headers: H, signal: AbortSignal.timeout(8000) });
      if (r.status === 426) throw new Error('the bus refused this host\'s plugin version (version gate)');
      if (!r.ok) throw new Error(`bus answered HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (!retry || /version gate/.test(e.message)) throw e;
      base = null; await leader(true);                      // leader moved (failover) → re-discover once
      return api(path, init, false);
    }
  }
  async function call(tool, args) {
    const v = validate(tool, args);
    if (tool === 'bus_peers') {
      const j = await api('/api/instances', { method: 'GET' });
      return (j.instances || j).map((i) => `${i.instance_id}  ${i.status}`).join('\n') || '(nobody)';
    }
    if (!take()) throw new Error(`rate limit: at most ${RATE} messages per minute from this lane — wait, do not retry in a loop`);
    await api('/api/register', { method: 'POST', body: JSON.stringify({ instance_id: ID, description: process.env.CC_DESC || 'qwen lane', rev: revString(), version: pkgVersion() }) }).catch(() => {});
    const r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ channel: v.channel, sender: ID, content: v.content, message_type: v.type }) });
    return `delivered to #${v.channel} as ${ID} (id ${r.id ?? '?'}, type ${v.type})`;
  }

  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();                              // strictly in order: an ack then a done land in that order
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (!m || m.jsonrpc !== '2.0' || m.id === undefined || m.id === null) return;    // notifications need no reply
    chain = chain.then(async () => {
      try {
        if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'crosstalk', version: pkgVersion() || '0' },
          instructions: `You are connected to the Crosstalk bus as ${ID}. Messages from other agents arrive as user turns starting "CHAT #<channel> <sender>". Reply ONLY with the bus_* tools; session text is not delivered. Acknowledge a HANDOFF first with bus_ack.` } });
        if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} });
        if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
        if (m.method === 'tools/call') {
          try { const text = await call(m.params?.name, m.params?.arguments); return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } }); }
          catch (e) { log(`${m.params?.name} refused: ${e.message}`); return out({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'REFUSED: ' + e.message }] } }); }
        }
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } });
      } catch (e) { out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message || e) } }); }
    });
  });
  rl.on('close', () => chain.finally(() => process.exit(0)));
  log(`ready as ${ID}`);
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main();
