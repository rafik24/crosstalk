#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-work.mjs — the Crosstalk coordination board. Zero deps.
// Reads ~/.claude/.crosstalk (legacy .cross-claude-bus still honoured) for CC_BASE + CC_TOKEN (override with flags/env).
//
// A work item has an OWNER (the live session id holding it) and a STATE
// (queued → claimed → implementing → in-review → merged → deployed, plus blocked/abandoned).
// `claim` is an ATOMIC lock: a second session claiming an owned item is REJECTED, not duplicated.
//
//   node cc-work.mjs list [--project P] [--state S] [--owner O] [--mine <id>] [--kind K]
//   node cc-work.mjs show <id>
//   node cc-work.mjs add "<title>" [--project P] [--ref owner/repo#123] [--epic <parent_id>]
//                                  [--kind task|bug|epic] [--domain D] [--by <session-id>]
//   node cc-work.mjs claim <id> --as <session-id>
//   node cc-work.mjs advance <id> --to <state> [--as <session-id>]
//   node cc-work.mjs handoff <id> --to <session-id> [--as <session-id>]
//   node cc-work.mjs release <id>
//
// Exit 0 on success, 1 on failure (incl. a lost claim), 2 on bad usage.
// ---------------------------------------------------------------------------
import { resolveFast, loadConfig, resolveFull } from "./cc-discover.mjs";
import { throughDrain } from "./cc-retry.mjs";
import { pkgVersion } from "./cc-rev.mjs";   // x-cc-version — the fleet version gate refuses a mismatch

const WORK_STATES = ["queued", "claimed", "implementing", "in-review", "merged", "deployed", "blocked", "abandoned"];

const a = process.argv.slice(2);
const cmd = a[0];
const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
// first non-flag positional after the command (its value is not a flag and it doesn't follow a flag)
const positional = a.slice(1).filter((x, i, arr) => !x.startsWith("--") && !(arr[i - 1] || "").startsWith("--"));

function usage(msg) {
  if (msg) console.error("cc-work: " + msg);
  console.error(`usage:
  cc-work list [--project P] [--state S] [--owner O] [--mine <id>] [--kind K]
  cc-work show <id>
  cc-work add "<title>" [--project P] [--ref R] [--epic <parent_id>] [--kind K] [--domain D] [--by <id>]
  cc-work claim <id> --as <session-id>
  cc-work advance <id> --to <state> [--as <owner>]   (state: ${WORK_STATES.join(" | ")})
  cc-work handoff <id> --to <session-id> [--as <owner>]
  cc-work release <id> [--as <owner>]

  global: --base <url> (discovery seed) · --pin <url> (HARD pin, no discovery/election) · --token <t>`);
  process.exit(2);
}
if (!cmd) usage();

const cfg = loadConfig();
const TOKEN = opt("--token", process.env.CC_TOKEN) || cfg.token;
// --pin <base> (or --base/CC_BASE with CC_FORCE_BASE=1) is a HARD pin: talk to exactly this
// base, no discovery, no election. Without it, --base is only a discovery SEED — resolveFast
// escalates and picks the highest-epoch reachable leader, so a command aimed at an isolated
// TEST instance would still route to a live higher-epoch bus (F1, reported 2026-09-10). Use the
// hard pin to test against an isolated instance while a real bus is up.
const hardPin = opt("--pin") || (process.env.CC_FORCE_BASE === "1" ? (opt("--base", process.env.CC_BASE)) : null);
let BASE;
if (hardPin) {
  BASE = String(hardPin).replace(/\/+$/, "");
} else {
  const pin = opt("--base", process.env.CC_BASE) || cfg.pin;
  const leader = await resolveFast({ pin, token: TOKEN });
  if (!leader) { console.error("cc-work: no bus leader found (loopback / LAN / tailnet all silent)"); process.exit(1); }
  BASE = leader.base;
}

async function api(method, path, body) {
  // A leader mid-handover answers 503 draining: wait it out and re-send to whoever leads next
  // (never when the caller hard-pinned a base — then the pin is the whole point).
  const r = await throughDrain(() => fetch(BASE + "/api" + path, {
    method,
    headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json", "x-cc-version": pkgVersion() || "" },
    body: body ? JSON.stringify(body) : undefined,
  }), async () => { BASE = (await resolveFull({ pin: opt("--base", process.env.CC_BASE) || cfg.pin, token: TOKEN }))?.base ?? BASE; }, { tries: hardPin ? 0 : undefined, log: (l) => console.error(l) });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

const stateGlyph = { queued: "·", claimed: "◔", implementing: "◑", "in-review": "◕", merged: "●", deployed: "✓", blocked: "⛔", abandoned: "✗" };
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);

function renderItem(it, indent = "") {
  const g = stateGlyph[it.state] || "?";
  const who = it.owner ? "@" + it.owner : "(unowned)";
  const ref = it.external_ref ? "  ref:" + it.external_ref : "";
  const dom = it.domain ? " [" + it.domain + "]" : "";
  return `${indent}#${pad(String(it.id), 4)} ${g} ${pad("[" + it.state + "]", 15)} ${pad(it.title, 40)} ${who}${dom}${ref}`;
}

function renderBoard(items) {
  if (!items.length) { console.log("(no work items)"); return; }
  const byId = new Map(items.map(i => [i.id, i]));
  const shown = new Set();
  for (const it of items) {
    if (it.parent_id && byId.has(it.parent_id)) continue; // rendered under its epic
    console.log(renderItem(it));
    shown.add(it.id);
    for (const child of items.filter(c => c.parent_id === it.id)) {
      console.log(renderItem(child, "    "));
      shown.add(child.id);
    }
  }
  // orphans (parent filtered out of this view) — show flat so nothing is hidden
  for (const it of items) if (!shown.has(it.id)) console.log(renderItem(it));
}

switch (cmd) {
  case "list": {
    const q = new URLSearchParams();
    for (const [flag, key] of [["--project", "project"], ["--state", "state"], ["--owner", "owner"], ["--kind", "kind"]]) {
      const v = opt(flag); if (v) q.set(key, v);
    }
    const mine = opt("--mine"); if (mine) q.set("owner", mine);
    const { ok, status, json } = await api("GET", "/work?" + q.toString());
    if (!ok) { console.error("list failed:", status, json.error || ""); process.exit(1); }
    renderBoard(json.items || []);
    break;
  }
  case "show": {
    const id = positional[0]; if (!id) usage("show needs <id>");
    const { ok, status, json } = await api("GET", "/work/" + id);
    if (!ok) { console.error("show failed:", status, json.error || ""); process.exit(1); }
    console.log(JSON.stringify(json.item, null, 2));
    break;
  }
  case "add": {
    const title = positional[0]; if (!title) usage('add needs a "<title>"');
    const body = {
      title,
      project: opt("--project"),
      external_ref: opt("--ref"),
      parent_id: opt("--epic") ? parseInt(opt("--epic")) : undefined,
      kind: opt("--kind"),
      domain: opt("--domain"),
      created_by: opt("--by"),
    };
    const { ok, status, json } = await api("POST", "/work", body);
    if (!ok) { console.error("add failed:", status, json.error || ""); process.exit(1); }
    console.log("created " + renderItem(json.item).trim());
    break;
  }
  case "claim": {
    const id = positional[0]; const as = opt("--as");
    if (!id || !as) usage("claim needs <id> --as <session-id>");
    const { ok, status, json } = await api("POST", "/work/" + id + "/claim", { owner: as });
    if (status === 409) {
      console.error(`✗ claim REJECTED — #${id} is already owned by @${json.owner}. DM them; do not re-implement.`);
      process.exit(1);
    }
    if (!ok) { console.error("claim failed:", status, json.error || ""); process.exit(1); }
    console.log("✓ claimed " + renderItem(json.item).trim());
    break;
  }
  case "advance": {
    const id = positional[0]; const to = opt("--to"); const as = opt("--as");
    if (!id || !to) usage("advance needs <id> --to <state> [--as <session-id>]");
    if (!WORK_STATES.includes(to)) usage(`unknown state "${to}" (want: ${WORK_STATES.join(" | ")})`);
    const { ok, status, json } = await api("POST", "/work/" + id + "/state", { state: to, by: as });
    if (status === 409 || status === 403) { console.error(`✗ #${id} is owned by @${json.owner} — only the owner can change its state (pass --as <your-id> if that's you).`); process.exit(1); }
    if (!ok) { console.error("advance failed:", status, json.error || ""); process.exit(1); }
    console.log("→ " + renderItem(json.item).trim());
    break;
  }
  case "handoff": {
    const id = positional[0]; const to = opt("--to"); const as = opt("--as");
    if (!id || !to) usage("handoff needs <id> --to <session-id> [--as <session-id>]");
    const { ok, status, json } = await api("POST", "/work/" + id + "/handoff", { owner: to, by: as });
    if (status === 403) { console.error(`✗ #${id} is owned by @${json.owner} — only the owner can hand it off (pass --as <your-id>).`); process.exit(1); }
    if (!ok) { console.error("handoff failed:", status, json.error || ""); process.exit(1); }
    console.log("→ handed #" + id + " to @" + to + " — they must ACK. " + renderItem(json.item).trim());
    break;
  }
  case "release": {
    const id = positional[0]; const as = opt("--as");
    if (!id) usage("release needs <id> [--as <session-id>]");
    const { ok, status, json } = await api("POST", "/work/" + id + "/handoff", { owner: null, by: as });
    if (status === 403) { console.error(`✗ #${id} is owned by @${json.owner} — only the owner can release it (pass --as <your-id>).`); process.exit(1); }
    if (!ok) { console.error("release failed:", status, json.error || ""); process.exit(1); }
    console.log("↩ released #" + id + " back to the pool. " + renderItem(json.item).trim());
    break;
  }
  default:
    usage(`unknown command "${cmd}"`);
}
