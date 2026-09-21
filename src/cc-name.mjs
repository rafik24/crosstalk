#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-name.mjs — (re)name THIS session on the Crosstalk bus to host/<slug>.
//
// The join hook gives every session a unique-but-terse default id
// (host/<branch>-<shortid>). This lets a session rename itself after what it is
// actually working on — the session TITLE — so peers can @mention it and the PO
// console reads a meaningful roster instead of a wall of branch names.
//
//   node cc-name.mjs <session_id> "<title / what you're working on>"
//   node cc-name.mjs 3a7f5cfe-... "Improve bus architecture"   ->  host/improve-bus-architecture
//
// It does three things, in order:
//   1. writes ~/.claude/.cc-listen/<session_id>.id  (the map the listen-gate READS —
//      so the gate agrees with your new name automatically, no recompute),
//   2. registers the new id on the bus (upsert),
//   3. prints the exact Monitor(...) line to (re)arm live-receive under the new id.
//
// IMPORTANT: arm cc-poll with the id printed here. If you had already armed a
// Monitor under the old id, STOP it first — the beacon must be written under the
// SAME id the gate now reads, or edits stay blocked.
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFast, loadConfig } from './cc-discover.mjs';
import { canonicalShort } from './cc-render.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';

const a = process.argv.slice(2);
const sid = a[0];
const title = a.slice(1).filter((x) => !x.startsWith('--')).join(' ').trim();
if (!sid || sid.startsWith('--') || !title) {
  console.error('usage: cc-name.mjs <session_id> "<title / what you are working on>"');
  process.exit(2);
}

const cfg = loadConfig();
const TOKEN = process.env.CC_TOKEN || cfg.token;
// register is fail-soft, so a missed leader just skips the bus upsert (the local .id map,
// step 1, still happens). Discovery finds the leader with no IP configured.
const leader = await resolveFast({ pin: process.env.CC_BASE || cfg.pin, token: TOKEN });
const BASE = leader ? leader.base : null;

// slug: the ONE canonical short-name normalizer (cc-render.canonicalShort == the server's channel
// normalizer), capped at 48. This guarantees the minted id's short == its dm-<short> channel, so a
// rejoin under the same title re-attaches the same DM channel instead of forking a variant (#5).
const slug = (s) => (canonicalShort(s).slice(0, 48).replace(/-+$/, '')) || 'misc';
const host = (hostname().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+$/, '')) || 'unknown';
const id = `${host}/${slug(title)}`;

// 1. the session->id map the listen-gate reads (keyed by RAW session id; UUIDs are filename-safe)
const dir = join(homedir(), '.claude', '.cc-listen');
try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, sid + '.id'), id); } catch {}

// 2. register on the bus (fail-soft — never wedge on a transient network blip). A version-gate 426
//    is NOT transient: refuse loudly so the operator updates before trying to work.
try {
  const r = await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' },
    body: JSON.stringify({ instance_id: id, description: title.slice(0, 120), rev: revString(), version: pkgVersion() }),
  });
  if (r.status === 426) {
    let info = {}; try { info = await r.json(); } catch {}
    console.log(`⛔ CHAT BUS — VERSION GATE: this host runs ${info.yours || pkgVersion() || 'unknown'} but the bus requires ${info.required || '?'}.`);
    console.log(info.how_to_update || `Update the crosstalk plugin on this host, then retry.`);
    process.exit(1);
  }
} catch {}

// 3. tell the session how to (re)arm under the new id
const HERE = dirname(fileURLToPath(import.meta.url));
const ws = join(HERE, 'cc-ws.mjs');
const send = join(HERE, 'cc-send.mjs');
console.log(`named on the bus as: ${id}`);
console.log(`ARM (or RE-ARM) live-receive with THIS id — stop any prior Monitor first:`);
// cc-ws is the real-time PUSH receiver (WebSocket + cursor backfill, issue #3). It auto-falls
// back to the old 2s poll if the leader is too old to speak WS, so it is always safe to arm.
console.log(`  Monitor({ command: 'node ${ws} ${id}', description: 'crosstalk bus (${id})', persistent: true })`);
console.log(`  (routine re-arm wakes are SILENT: when the 30-min beacon re-invokes you with no addressed`);
console.log(`   message, just re-run this Monitor line and emit nothing — no "re-armed", no ※ recap.)`);
console.log(`From now, send as:  node ${send} ${id} <channel|all> 'message'`);
