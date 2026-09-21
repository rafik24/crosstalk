#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-ack.mjs — acknowledge an ownership handoff / attention request. Zero deps.
//
// The bus server only allows six message types (message, request, response,
// status, handoff, done) — there is no dedicated `ack` type — so an ack rides on
// a `response` whose body starts with "ACK". THIS is the ownership contract:
// when a peer sends you a `handoff` (or a message that needs your attention /
// changes what you own), you MUST reply with an ack into the SAME channel so the
// sender — and the PO console — can see the task was taken into a lane, not
// dropped. An unacked handoff is flagged on the dashboard until this fires.
//
//   node cc-ack.mjs <your_id> <channel|all> "<what you are taking on>"
//   node cc-ack.mjs laptop-rb/improve-bus dm-po "the bus rework — into my lane now"
//
// Emits:  #<channel>  [response]  "ACK — <note> · taken into lane <your_id>"
// Follow up with a `done` (cc-send --type done) when the work actually lands.
// ---------------------------------------------------------------------------
import { resolveFast, resolveFull, loadConfig } from './cc-discover.mjs';
import { throughDrain } from './cc-retry.mjs';
import { pkgVersion } from './cc-rev.mjs';   // x-cc-version — the fleet version gate refuses a mismatch

const a = process.argv.slice(2);
const sender = a[0], toArg = a[1];
const note = a.slice(2).filter((x) => !x.startsWith('--')).join(' ').trim();
if (!sender || !toArg || !note) {
  console.error('usage: cc-ack.mjs <your_id> <channel|all> "<what you are taking on>"');
  process.exit(2);
}
const cfg = loadConfig();
const TOKEN = process.env.CC_TOKEN || cfg.token;
const leader = await resolveFast({ pin: process.env.CC_BASE || cfg.pin, token: TOKEN });
if (!leader) { console.error('ack failed: no bus leader found (loopback / LAN / tailnet all silent)'); process.exit(1); }
let BASE = leader.base;
const channel = toArg === 'all' ? 'general' : toArg;
const content = `ACK — ${note} · taken into lane ${sender}`;

const r = await throughDrain(() => fetch(BASE + '/api/messages', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' },
  body: JSON.stringify({ channel, sender, content, message_type: 'response' }),
}), async () => { BASE = (await resolveFull({ pin: process.env.CC_BASE || cfg.pin, token: TOKEN }))?.base ?? BASE; }, { log: (l) => console.error(l) });
if (!r.ok) { console.error('ack failed:', r.status, await r.text().catch(() => '')); process.exit(1); }
const j = await r.json();
console.log(`ACK sent -> #${j.channel} as ${sender} (id ${j.id})`);
