#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-poll.mjs — Monitor-friendly live receiver for the Crosstalk bus.
//
// Prints ONE line per NEW message that is ADDRESSED TO YOU (a DM channel to you or an
// @mention of your id) and heartbeats presence so this instance shows "online". Ambient
// chatter between other sessions is suppressed by default so it doesn't pollute the terminal —
// you stay a live listener, you just aren't woken for traffic that isn't yours. Zero deps.
//
//   node cc-poll.mjs <instance_id> [--channel <ch>] [--all] [--base URL] [--token TOK] [--from-start]
//     --all         firehose: emit EVERY message (ambient included)
//     --channel ch  scope to one channel and emit all of it (a collaboration you're watching)
//   env: CC_BASE, CC_TOKEN, CC_DESC
//
// This is how a Claude Code session RECEIVES chat live — hand it to Monitor:
//   Monitor({ command: 'node .../cc-poll.mjs winbox/mytopic --token <TOK>',
//             description: 'crosstalk', persistent: true })
// Each printed line becomes a notification in the session. Cleaner than the
// upstream --dangerously-load-development-channels bridge, and it wakes the
// session (Monitor re-invokes on each stdout line).
//
// By default it skips existing backlog on startup (so a fresh listener is not
// flooded) but DOES show the messages of any channel created after startup —
// including a DM channel someone opens to you. Pass --from-start to replay all.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveFast, resolveFull, loadConfig } from './cc-discover.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';
import { addressedTo, renderLine, wrapForNotification } from './cc-render.mjs';

const args = process.argv.slice(2);
const instance = args[0];
if (!instance || instance.startsWith('--')) {
  console.error('usage: cc-poll.mjs <instance_id> [--channel ch] [--base URL] [--token TOK] [--from-start]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ALL = args.includes('--all');   // firehose: emit EVERY message (ambient included)
// Config: ~/.claude/.crosstalk (legacy .cross-claude-bus honoured) (CC_TOKEN + optional CC_BASE pin). The leader address is
// DISCOVERED (loopback/LAN/tailnet), so the Monitor command is just `node cc-poll.mjs <id>` with
// no IP and no secret on the command line.
const cfg = loadConfig();
const PIN = opt('--base', process.env.CC_BASE) || cfg.pin;
const TOKEN = opt('--token', process.env.CC_TOKEN) || cfg.token;
// BASE is mutable: a live listener RE-RESOLVES when its leader goes dead (e.g. after a migration),
// so this Monitor keeps receiving on the new host instead of going deaf.
let BASE = null;
async function ensureBase(full = false) {
  const leader = full ? await resolveFull({ pin: PIN, token: TOKEN }) : await resolveFast({ pin: PIN, token: TOKEN });
  // Lifecycle chatter → stderr, NEVER stdout: a Monitor beacon treats every stdout line as a
  // wake event, so leader-change/startup on stdout re-invoked idle sessions for nothing. Only
  // rendered messages (the emit below) belong on stdout. Mirrors cc-ws.mjs.
  if (leader && leader.base !== BASE) { BASE = leader.base; console.error(`[bus leader → ${leader.host} epoch=${leader.epoch} @ ${BASE}]`); }
  return BASE;
}
const ONLY = opt('--channel', null);
const fromStart = args.includes('--from-start');
// Firehose (emit ambient too) when explicitly asked (--all) or when scoped to ONE channel
// (--channel means "I'm watching this collaboration — show me all of it"). Otherwise, on the
// default all-channels watch, only messages ADDRESSED to me wake the session.
const FIREHOSE = ALL || ONLY !== null;
// x-cc-version on EVERY /api call — the data-plane version gate refuses a mismatch. See version-gate.mjs.
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

// Liveness beacon — the must-listen gate reads this file's mtime to confirm this session is
// actually RECEIVING (cc-poll running), not merely registered once by the join hook.
const LIVE_DIR = join(homedir(), '.claude', '.cc-listen');
const LIVE_FILE = join(LIVE_DIR, instance.replace(/[^A-Za-z0-9._-]/g, '_'));
function beat() { try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(LIVE_FILE, String(Date.now())); } catch {} }

async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  // A version-gate 426 on ANY /api call is fatal — surface it now rather than spin the poll loop
  // silently until the next register() tick notices. See version-gate.mjs.
  if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} failVersionGate(info); }
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}

const cursors = {};
async function register() {
  beat();
  try {
    const r = await fetch(BASE + '/api/register', {
      method: 'POST', headers: { ...H },
      body: JSON.stringify({ instance_id: instance, description: process.env.CC_DESC || '', rev: revString(), version: pkgVersion() }),
    });
    if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} failVersionGate(info); }
  } catch {}
}

// Bus refused us for a version mismatch — fatal + actionable. Print to STDOUT (surfaces as a
// Monitor event), drop the beacon so the listen-gate blocks edits at once, then exit. Mirrors cc-ws.
function failVersionGate(info) {
  try { rmSync(LIVE_FILE, { force: true }); } catch {}
  const req = info.required || '?';
  const mine = info.yours || pkgVersion() || 'unknown';
  console.log([
    '',
    `⛔ CHAT BUS — VERSION GATE: this host runs ${mine} but the bus requires ${req}.`,
    info.how_to_update || `Update the crosstalk plugin on this host to ${req}, then re-arm receive.`,
    `Every host must run the same latest version. (Operator override: CC_VERSION_GATE_BYPASS=1 on the bus leader.)`,
    '',
  ].join('\n'));
  process.exit(1);
}

async function tick(seed = false) {
  if (!BASE) { await ensureBase(true); if (!BASE) return; }
  let channels;
  try { channels = ONLY ? [{ name: ONLY }] : (await j('/api/channels')).channels; }
  catch { await ensureBase(true); return; }   // leader dead (e.g. migrated) → re-discover, pick up new host next tick
  for (const c of channels) {
    const first = cursors[c.name] === undefined;
    const after = cursors[c.name] ?? 0;
    let res;
    try { res = await j(`/api/messages/${encodeURIComponent(c.name)}?after_id=${after}`); }
    catch { continue; }
    if (first && seed && !fromStart) { cursors[c.name] = res.last_id || 0; continue; }  // skip backlog on the initial seed only
    for (const m of res.messages.sort((a, b) => a.id - b.id)) {
      cursors[c.name] = Math.max(cursors[c.name] || 0, m.id);
      if (m.sender === instance) continue;  // never echo my own
      // "Addressed to me" = a DM channel to me, or an @mention of my id. By DEFAULT only these WAKE
      // the session — ambient #general chatter between other sessions is SUPPRESSED so it doesn't
      // pollute the terminal. You're still a live listener: register()/beacon keep presence up and
      // the listen-gate green; you just aren't re-invoked for traffic that isn't yours. To reach a
      // session, DM it or @mention it. Firehose (see FIREHOSE) or the PO console see everything.
      // @all / @here / @everyone is the deliberate broadcast-to-every-session escape hatch: it
      // pierces the addressed-only filter and wakes EVERYONE. Bare chatter still doesn't.
      // The SHARED filter (issue #57): a local copy keyed off the raw short name missed the
      // server-normalized `dm-foo-bar` / `@foo-bar` for a `host/Foo_Bar` session (issue #5 again).
      const addressed = addressedTo(m, instance);
      if (!FIREHOSE && !addressed) continue;  // ambient, not for me → do not wake
      // renderLine (not a local template) so the tag AND the #51 forged-header marking match every
      // other sink. Wrap long bodies so the Claude Code harness delivers them WHOLE: it truncates a single
      // Monitor event line at ~470 chars and a notification at ~3 KB, which is why a long DM used
      // to arrive "…(truncated)". Short messages (the common case) are one block, printed at once;
      // a long one is split into blocks spaced >250ms apart so each lands as its own notification.
      const blocks = wrapForNotification(renderLine(m, instance, addressed));
      for (let bi = 0; bi < blocks.length; bi++) {
        if (bi > 0) await new Promise((r) => setTimeout(r, 300));
        console.log(blocks[bi]);
      }
    }
    if (cursors[c.name] === undefined) cursors[c.name] = res.last_id || 0;
  }
}

(async () => {
  await ensureBase(true);                             // full discovery scan at startup (no IP configured)
  await register();
  await tick(true);                                   // seed cursors (skips backlog unless --from-start)
  console.error(`[listening as ${instance} on ${ONLY ? '#' + ONLY : 'all channels'} @ ${BASE || 'discovering…'}]`);   // lifecycle → stderr (see ensureBase)
  setInterval(register, 20000);                       // heartbeat presence
  setInterval(() => tick(false).catch(() => {}), 2000);
})();
