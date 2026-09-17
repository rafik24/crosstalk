#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-codex.mjs — Crosstalk bus client for a Codex CLI session (send / ack / wait / peers).
//
// A Codex session RECEIVES through cc-codex-bridge.mjs (push → `codex queue`). This client is
// what the session itself runs from its shell: send, ack a handoff, list peers — and a BOUNDED
// `wait` as the fallback receive path when no bridge is running (a tool call that returns when
// something addressed to me lands, or on timeout). Discovery, token, version header and the
// register call are the plugin's own (cc-discover / cc-rev), so this client is subject to the
// same fleet version gate as every Claude host.
//
//   node cc-codex.mjs join  <id> ["description"]                    # register + snapshot cursors
//   node cc-codex.mjs send  <id> <channel|all> "message" [--type message|status|request|response|handoff|done]
//   node cc-codex.mjs ack   <id> <channel> "note"                   # response whose body starts ACK
//   node cc-codex.mjs wait  <id> [--timeout <sec>=90] [--channel <ch>] [--all] [--from-start]
//   node cc-codex.mjs peers
//
// Outcomes are signalled in STDOUT TEXT, exit 0: `CHAT #…` lines, or `WAIT_TIMEOUT: …`. Only a
// bus error is non-zero (1) — an agent's terminal wrapper mangled a non-zero "timeout" exit code
// in the 2026-09-17 POC and the peer read it as a failure. Usage error = 2.
//
// Cursor rule (POC lesson): `join` SNAPSHOTS every channel's tip — everything before the join is
// backlog, everything after is new. Seeding inside `wait` lost the very first reply, because the
// peer's DM channel was created after the wait began and was classed as backlog.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFast, resolveFull, loadConfig } from './cc-discover.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';
import { addressedTo, renderLine } from './cc-render.mjs';
import { dataDir } from './cc-paths.mjs';
import { LIVE_DIR, beaconPath } from './cc-receive.mjs';

const a = process.argv.slice(2);
const cmd = a[0], id = a[1];
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const usage = () => { console.error('usage: cc-codex.mjs join|send|ack|wait|peers <id> ...'); process.exit(2); };
if (!cmd || (cmd !== 'peers' && !id)) usage();

const cfg = loadConfig();
const PIN = opt('--base', process.env.CC_BASE) || cfg.pin;
const TOKEN = opt('--token', process.env.CC_TOKEN) || cfg.token;
if (!TOKEN) { console.error('bus error: no CC_TOKEN (bus config ~/.claude/.crosstalk missing?)'); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' };

let BASE = null;
async function ensureBase(full = false) {
  const leader = full ? await resolveFull({ pin: PIN, token: TOKEN }) : await resolveFast({ pin: PIN, token: TOKEN });
  if (leader && leader.base !== BASE) { BASE = leader.base; console.error(`[bus leader ${leader.host} epoch=${leader.epoch} @ ${BASE}]`); }
  return BASE;
}
async function api(path, o = {}) {
  const r = await fetch(BASE + path, { ...o, headers: { ...H, ...(o.headers || {}) } });
  if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} console.log(`⛔ CHAT BUS — VERSION GATE: this client is ${pkgVersion() || 'unknown'} but the bus requires ${info.required || '?'}. Update the crosstalk plugin on this host.`); process.exit(1); }
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

// The liveness beacon the listen-gate reads. ONLY a receiver may beat it — the bridge, or `wait`
// while it blocks. A one-shot send/ack/join must NOT: it would unlock estate edits for the freshness
// window on a session that is not listening (codex review, 2026-09-17).
function beat() { try { mkdirSync(LIVE_DIR, { recursive: true }); writeFileSync(beaconPath(id), String(Date.now())); } catch {} }
async function register(desc) {
  await api('/api/register', { method: 'POST', body: JSON.stringify({ instance_id: id, description: desc || process.env.CC_DESC || 'codex', rev: revString(), version: pkgVersion() }) });
}

// Cursor persistence — a bounded wait must not replay what a previous wait already showed.
const curFile = () => join(dataDir(), 'codex-cursors-' + (id || '').replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
function loadCursors() { try { return JSON.parse(readFileSync(curFile(), 'utf8')); } catch { return null; } }
function saveCursors(c) { try { mkdirSync(dataDir(), { recursive: true }); writeFileSync(curFile(), JSON.stringify(c)); } catch {} }
// Channel tips only: `?limit=1` returns the newest message + last_id — never `after_id=0`, which is
// the unbounded "everything since" query (a long-lived bus = the whole DB per join).
async function snapshot() {
  const snap = {};
  for (const c of (await api('/api/channels')).channels) {
    try { const r = await api(`/api/messages/${encodeURIComponent(c.name)}?limit=1`); snap[c.name] = r.last_id || 0; } catch {}
  }
  return snap;
}

async function main() {
  if (!(await ensureBase(true))) { console.error('bus error: no bus leader found'); process.exit(1); }

  if (cmd === 'peers') { console.log(JSON.stringify(await api('/api/instances').catch(() => null), null, 2)); return; }

  if (cmd === 'join') {
    await register(a[2]);
    let snap = {}; try { snap = await snapshot(); } catch {}
    saveCursors(snap);
    console.log(`joined the bus as ${id} (cursor snapshot: ${Object.keys(snap).length} channels)`);
    return;
  }

  if (cmd === 'send' || cmd === 'ack') {
    const channel = a[2] === 'all' ? 'general' : a[2];
    const type = cmd === 'ack' ? 'response' : opt('--type', 'message');
    // Strip every value-carrying flag WITH its value (`--type X`, `--token X`, `--base X`) — the
    // first draft dropped the flag and posted the token into the message body (reviewer, 2026-09-17).
    const VALUE_FLAGS = new Set(['--type', '--token', '--base']);
    let body = a.slice(3).filter((x, i, arr) => !VALUE_FLAGS.has(x) && !VALUE_FLAGS.has(arr[i - 1]) && !x.startsWith('--')).join(' ');
    if (cmd === 'ack' && !/^ACK\b/.test(body)) body = 'ACK — ' + body;
    if (!channel || !body) usage();
    await register();
    const r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ channel, sender: id, content: body, message_type: type }) });
    console.log(`sent #${channel} id=${r.id ?? '?'}`);
    return;
  }

  if (cmd === 'wait') {
    const timeoutS = Number(opt('--timeout', 90));
    const ONLY = opt('--channel', null);
    const FIREHOSE = a.includes('--all') || ONLY !== null;
    const fromStart = a.includes('--from-start');
    await register();
    beat();                                        // wait IS a receiver while it blocks (see beat())
    let cursors = loadCursors();
    let seeding = cursors === null && !fromStart;   // no snapshot (join skipped) → seed on the FIRST pass only
    if (cursors === null) cursors = {};
    const deadline = Date.now() + timeoutS * 1000;
    let printed = 0;
    while (true) {
      let channels;
      try { channels = ONLY ? [{ name: ONLY }] : (await api('/api/channels')).channels; }
      catch { await ensureBase(true); channels = []; }
      for (const c of channels) {
        const first = cursors[c.name] === undefined;
        const after = cursors[c.name] ?? 0;
        let res; try { res = await api(`/api/messages/${encodeURIComponent(c.name)}?after_id=${after}`); } catch { continue; }
        if (first && seeding) { cursors[c.name] = res.last_id || 0; continue; }
        for (const m of res.messages.sort((x, y) => x.id - y.id)) {
          cursors[c.name] = Math.max(cursors[c.name] || 0, m.id);
          if (m.sender === id) continue;
          const addressed = addressedTo(m, id);
          if (!FIREHOSE && !addressed) continue;
          console.log(renderLine(m, id, addressed));
          printed++;
        }
        if (cursors[c.name] === undefined) cursors[c.name] = res.last_id || 0;
      }
      seeding = false;
      saveCursors(cursors);
      if (printed) return;
      if (Date.now() > deadline) { console.log(`WAIT_TIMEOUT: no message for ${id} within ${timeoutS}s`); return; }
      await new Promise((r) => setTimeout(r, 2000));
      beat();
    }
  }
  usage();
}
main().catch((e) => { console.error('bus error:', e.message); process.exit(1); });
