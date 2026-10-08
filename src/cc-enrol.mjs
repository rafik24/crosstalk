#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-enrol.mjs — join this machine to the estate with a PASSWORD (issue 55). Zero deps.
//
//   node cc-enrol.mjs                 prompt for the estate password (hidden), verify it against
//                                     the live estate, write ~/.claude/.crosstalk, done
//   node cc-enrol.mjs --set-password  on an ALREADY-enrolled box: choose the estate password and
//                                     rewrite this box's config with the keys it derives (the other
//                                     boxes then re-enrol by password)
//   node cc-enrol.mjs --re-enrol      this box is enrolled but the estate password CHANGED: prompt,
//                                     verify, rewrite ONLY the two keys (CC_BIND/CC_PEERS/… kept)
//   node cc-enrol.mjs --token <tok>   the pre-3.3.5 way: write a raw token, no derivation (≥32 chars)
//   options: --auto-supervisor  (also set CC_AUTO_SUPERVISOR=1)   --no-verify  (write without
//            finding a leader — for the FIRST box of a brand-new estate)   --config <path>
//            --lan / --no-lan  (make this box's bus reachable when it hosts, or not: the tailnet
//            address when there is one, else CC_BIND=0.0.0.0). Default: the auto-supervisor implies
//            a TAILNET bind only (#60) — every-interface exposure is only ever --lan. A re-enrol /
//            --set-password never adds a bind; an existing CC_BIND is kept
//
// The usual way in is the browser page (/crosstalk:enrol → cc-enrol-web.mjs), which calls the
// exported core below; this CLI is the headless/SSH fallback (same core, same rules).
//
// The password is never stored. Both estate secrets are derived from it with scrypt and fixed,
// public salts, so every box that knows the password derives the SAME CC_TOKEN / CC_ADMIN_KEY —
// that is what makes "type the password on the new laptop" equivalent to copying the token file:
//   CC_TOKEN     = scrypt(password, "crosstalk/token/v1", N=2^17, r=8, p=1) → 32 bytes hex
//   CC_ADMIN_KEY = scrypt(password, "crosstalk/admin/v1", N=2^17, r=8, p=1) → 32 bytes hex
// The KDF cost is part of the salt string's version: it can never be raised silently (that would
// re-key every enrolled box) — a future v2 is a new enrolment. The password is the ONLY secret:
// a sniffer on the LAN captures (nonce, HMAC) pairs and can guess offline at ~2 guesses/s/core
// against this KDF, so it must be a real passphrase (four or more random words), not a word.
// Before anything is written the derived token is VERIFIED: discovery must find a leader that
// proves it holds that token (cc-proof). A wrong password therefore fails loudly and leaves the
// box untouched — it never half-enrols with a key nobody else has.
// ---------------------------------------------------------------------------
import { scryptSync } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { configPath } from './cc-paths.mjs';
import { resolveFull } from './cc-discover.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(n);

export function deriveKeys(password) {
  const pw = String(password);
  if (pw.length < 16) throw new Error('the estate password must be at least 16 characters — use a passphrase of four or more random words');
  const kdf = (salt) => scryptSync(pw, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex');
  return { token: kdf('crosstalk/token/v1'), admin: kdf('crosstalk/admin/v1') };
}

// Hidden prompt on a TTY; refuses to run without one (a hook or a pipe cannot answer it).
function askHidden(question) {
  return new Promise((resolve, reject) => {
    // Tests have no TTY: they hand the password in through this env var (never used otherwise).
    if (process.env.CC_ENROL_PASSWORD_FOR_TESTS !== undefined) return resolve(process.env.CC_ENROL_PASSWORD_FOR_TESTS);
    if (!process.stdin.isTTY) return reject(new Error('cc-enrol needs an interactive terminal (run it yourself, not from a hook)'));
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on('SIGINT', () => { process.stdout.write('\n'); process.exit(130); });   // Ctrl-C at the prompt must exit, not hang
    const orig = rl._writeToOutput;
    process.stdout.write(question);
    rl._writeToOutput = () => {};   // echo nothing while the password is typed
    rl.question('', (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); rl.close(); resolve(a); });
  });
}

// Atomic (tmp + rename): a write that fails half-way (disk full, file locked) must leave the old
// config intact — the page's "nothing was written" must be true.
function writeConfig(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, path);
  } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}

// This machine's tailnet address (Tailscale/Headscale CGNAT range 100.64.0.0/10), or null. A bus
// that must be reachable binds THERE when it can: reachable by the estate's machines over the
// tailnet, invisible on whatever café Wi-Fi the laptop is on (crosstalk-reviewer 2026-10-08).
export function tailnetAddress(ifaces = networkInterfaces()) {
  // Tests pin the answer ('none' or an address), as they do the password (CC_ENROL_PASSWORD_FOR_TESTS).
  const forced = process.env.CC_ENROL_TAILNET_FOR_TESTS;
  if (forced !== undefined) return forced === 'none' ? null : forced;
  for (const list of Object.values(ifaces || {})) for (const a of list || []) {
    if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
    const [o1, o2] = String(a.address).split('.').map(Number);
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
  }
  return null;
}
// The CC_BIND a reachable bus gets: the tailnet address when there is one, else every interface.
export function reachableBind() { return tailnetAddress() || '0.0.0.0'; }

// --- the enrolment core, shared by this CLI and the browser page (cc-enrol-web.mjs) -------------
// Exported so the page reuses the SAME derivation, verification and file write: the crypto and
// the "nothing is written unless a leader proves the token" rule live in exactly one place.

// Why this box may not run `mode` ('join' | 'set-password' | 're-enrol'), or null if it may.
export function enrolPrecondition(path, mode) {
  const enrolled = existsSync(path);
  if (enrolled && mode === 'join') return `already enrolled: ${path} exists. Password changed on the estate? run with --re-enrol (keeps CC_BIND/CC_PEERS/…). Setting a NEW estate password from this box: --set-password.`;
  if (!enrolled && mode !== 'join') return `${mode === 'set-password' ? '--set-password' : '--re-enrol'} is for an ALREADY-enrolled box (it rewrites its keys, keeping the other settings); to enrol a new box just run cc-enrol`;
  return null;
}

// Does a leader on this network PROVE it holds `token`? → { ok: true, leader } | { ok: false, why }
export async function verifyToken(token) {
  let leader = await resolveFull({ token, lanTimeoutMs: 800, timeoutMs: 2500 });
  if (!leader) {
    // Strict discovery hides unproven leaders. Look once more accepting them, only to tell the
    // user WHICH failure this is: no estate reachable, or an estate that rejects this password.
    const saved = process.env.CC_DISCOVERY_PROOF;
    process.env.CC_DISCOVERY_PROOF = 'legacy';
    try { leader = await resolveFull({ token, lanTimeoutMs: 800, timeoutMs: 2500 }); } finally { if (saved === undefined) delete process.env.CC_DISCOVERY_PROOF; else process.env.CC_DISCOVERY_PROOF = saved; }
    if (!leader) return { ok: false, why: 'no bus leader answered on this network (LAN / tailnet / CC_PEERS)' };
  }
  if (!leader.proven) return { ok: false, why: `a leader answered (${leader.host} @ ${leader.base}) but did NOT prove it holds this password's token — wrong password, or a pre-3.3.5 leader (use --token to copy its raw token instead)` };
  return { ok: true, leader };
}

// Write the enrolment. rewrite=true (set-password / re-enrol) keeps every line of the existing
// file except the two keys; a fresh enrolment writes just the keys (+ the supervisor opt-in).
const ENROLMENT_HEADER = '# Crosstalk bus — per-machine enrolment (written by cc-enrol; keys derived from the estate password, never the password itself)';
// CC_BIND makes the bus this box hosts listen beyond loopback (#60) — on the tailnet address when
// there is one, else on every interface (0.0.0.0). /api/* needs the estate token and a client only
// adopts a leader that proves it holds it (cc-proof), but /health, /console, /openapi.json and
// /cc/whoami answer anyone who can reach the port — so reachability is chosen, never slipped in.
// lan: true / false decides explicitly (true without a tailnet = 0.0.0.0). Left undefined on a FRESH
// enrolment it follows hosting — but only onto a TAILNET address: a box that may become leader must
// be reachable (#60), yet every-interface exposure is only ever an explicit choice (--lan / the box).
// A REWRITE (set-password / re-enrol) never adds a bind on its own; an existing CC_BIND is never
// overridden (e.g. an address chosen by hand).
export function writeEnrolment(path, { token, admin, autoSupervisor = false, lan, rewrite = false }) {
  const keep = [];
  if (rewrite) {   // our own header is re-emitted below — keeping it too stacked one copy per rewrite
    for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) if (l.trim() && l !== ENROLMENT_HEADER && !/^\s*(export\s+)?CC_(TOKEN|ADMIN_KEY)\s*=/.test(l)) keep.push(l);
  }
  const bind = lan ?? (!rewrite && autoSupervisor && !!tailnetAddress());
  writeConfig(path, [
    ENROLMENT_HEADER,
    `CC_TOKEN=${token}`,
    ...(admin ? [`CC_ADMIN_KEY=${admin}`] : []),
    ...(autoSupervisor && !keep.some((l) => /CC_AUTO_SUPERVISOR/.test(l)) ? ['CC_AUTO_SUPERVISOR=1'] : []),
    ...(bind && !keep.some((l) => /^\s*(export\s+)?CC_BIND\s*=/.test(l)) ? [`CC_BIND=${reachableBind()}`] : []),
    ...keep,
  ]);
}

// What --set-password leaves behind, shared with the page so both say the same thing.
export const SPLIT_WARNING = 'the estate is SPLIT until every other box re-enrols with this password: their supervisors will not trust this box (different token) and will elect among themselves. Do it in one sitting; stop their supervisors first if you can. Then restart the supervisor here.';

async function main() {
  const path = opt('--config') || configPath();
  const setPw = has('--set-password');
  const reEnrol = has('--re-enrol');
  const rawToken = opt('--token');
  if (rawToken && rawToken.length < 32) { console.error('--token: a raw token this short falls to an offline guess from one sniffed beacon; use ≥32 random characters, or enrol by password'); process.exit(1); }

  const why = enrolPrecondition(path, setPw ? 'set-password' : reEnrol ? 're-enrol' : 'join');
  if (why) { console.error(why); process.exit(1); }

  let token, admin;
  if (rawToken) {
    token = rawToken; admin = opt('--admin') || '';
  } else {
    const pw = await askHidden(setPw ? 'Choose the estate password (min 16 chars — a passphrase of four or more random words): ' : 'Estate password: ');
    if (setPw) { const again = await askHidden('Repeat it: '); if (again !== pw) { console.error('passwords differ — nothing written'); process.exit(1); } }
    ({ token, admin } = deriveKeys(pw));
    if (!setPw && !has('--no-verify')) {
      process.stdout.write('verifying against the estate… ');
      const v = await verifyToken(token);
      if (!v.ok) { console.log('FAILED'); console.error(`not enrolled: ${v.why}`); process.exit(2); }
      console.log(`ok — leader ${v.leader.host} (epoch ${v.leader.epoch}) proved it`);
    }
  }

  writeEnrolment(path, { token, admin, autoSupervisor: has('--auto-supervisor'), lan: has('--lan') ? true : has('--no-lan') ? false : undefined, rewrite: setPw || reEnrol });
  if (setPw) console.log(`estate password set — this box now uses the derived keys: ${path}\n⚠️  ${SPLIT_WARNING.replace('re-enrols', 'runs `cc-enrol --re-enrol`')}`);
  else console.log(`${reEnrol ? 're-enrolled with the new keys' : 'enrolled'}: ${path}\n${reEnrol ? 'restart the bus supervisor on this box' : 'start a Claude session — the join hook does the rest'}`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('cc-enrol:', e.message); process.exit(1); });
}
