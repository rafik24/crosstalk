#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-send.mjs — send one message to the Crosstalk bus. Zero deps.
// Reads ~/.claude/.crosstalk (legacy .cross-claude-bus still honoured) for CC_BASE + CC_TOKEN (override with flags/env).
//
//   node cc-send.mjs <sender_id> <channel|all> "message" [--type status|message|request|response|handoff|done]
//   node cc-send.mjs winbox/reclaim-offline all "rebased onto main abc1234"
//   node cc-send.mjs winbox/reclaim-offline dm-po "your delete change landed"
//
// 'all' is sugar for the #general channel (broadcast). Exit 0 on success, 1 otherwise.
// ---------------------------------------------------------------------------
import { resolveFast, loadConfig } from './cc-discover.mjs';
import { pkgVersion } from './cc-rev.mjs';   // x-cc-version — the fleet version gate refuses a mismatch

const a = process.argv.slice(2);
const sender = a[0], toArg = a[1];
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const type = opt('--type', 'message');
// body = the first positional after sender+channel that isn't a flag pair
const body = a.slice(2).filter((x, i, arr) => x !== '--type' && arr[i - 1] !== '--type' && !x.startsWith('--')).join(' ');
if (!sender || !toArg || !body) {
  console.error('usage: cc-send.mjs <sender_id> <channel|all> "message" [--type status]');
  process.exit(2);
}
const cfg = loadConfig();
// --base is an explicit pin; otherwise discovery finds the leader (no IP configured).
const pin = opt('--base', process.env.CC_BASE) || cfg.pin;
const TOKEN = opt('--token', process.env.CC_TOKEN) || cfg.token;
const leader = await resolveFast({ pin, token: TOKEN });
if (!leader) { console.error('send failed: no bus leader found (loopback / LAN / tailnet all silent)'); process.exit(1); }
const BASE = leader.base;
const channel = toArg === 'all' ? 'general' : toArg;

const r = await fetch(BASE + '/api/messages', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' },
  body: JSON.stringify({ channel, sender, content: body, message_type: type }),
});
if (!r.ok) { console.error('send failed:', r.status, await r.text().catch(() => '')); process.exit(1); }
const j = await r.json();
console.log(`sent → #${j.channel} as ${sender} [${type}] (id ${j.id})`);
