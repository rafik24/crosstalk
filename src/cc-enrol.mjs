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
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
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

function writeConfig(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

async function verify(token) {
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

async function main() {
  const path = opt('--config') || configPath();
  const setPw = has('--set-password');
  const reEnrol = has('--re-enrol');
  const rawToken = opt('--token');
  if (rawToken && rawToken.length < 32) { console.error('--token: a raw token this short falls to an offline guess from one sniffed beacon; use ≥32 random characters, or enrol by password'); process.exit(1); }

  if (existsSync(path) && !setPw && !reEnrol) {
    console.error(`already enrolled: ${path} exists. Password changed on the estate? run with --re-enrol (keeps CC_BIND/CC_PEERS/…). Setting a NEW estate password from this box: --set-password.`);
    process.exit(1);
  }
  if ((setPw || reEnrol) && !existsSync(path)) { console.error(`${setPw ? '--set-password' : '--re-enrol'} is for an ALREADY-enrolled box (it rewrites its keys, keeping the other settings); to enrol a new box just run cc-enrol`); process.exit(1); }

  let token, admin;
  if (rawToken) {
    token = rawToken; admin = opt('--admin') || '';
  } else {
    const pw = await askHidden(setPw ? 'Choose the estate password (min 16 chars — a passphrase of four or more random words): ' : 'Estate password: ');
    if (setPw) { const again = await askHidden('Repeat it: '); if (again !== pw) { console.error('passwords differ — nothing written'); process.exit(1); } }
    ({ token, admin } = deriveKeys(pw));
    if (!setPw && !has('--no-verify')) {
      process.stdout.write('verifying against the estate… ');
      const v = await verify(token);
      if (!v.ok) { console.log('FAILED'); console.error(`not enrolled: ${v.why}`); process.exit(2); }
      console.log(`ok — leader ${v.leader.host} (epoch ${v.leader.epoch}) proved it`);
    }
  }

  const keep = [];
  if (setPw || reEnrol) {   // preserve everything except the two keys
    for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) if (l.trim() && !/^\s*(export\s+)?CC_(TOKEN|ADMIN_KEY)\s*=/.test(l)) keep.push(l);
  }
  const lines = [
    '# Crosstalk bus — per-machine enrolment (written by cc-enrol; keys derived from the estate password, never the password itself)',
    `CC_TOKEN=${token}`,
    ...(admin ? [`CC_ADMIN_KEY=${admin}`] : []),
    ...(has('--auto-supervisor') && !keep.some((l) => /CC_AUTO_SUPERVISOR/.test(l)) ? ['CC_AUTO_SUPERVISOR=1'] : []),
    ...keep,
  ];
  writeConfig(path, lines);
  if (setPw) console.log(`estate password set — this box now uses the derived keys: ${path}\n⚠️  the estate is SPLIT until every other box runs \`cc-enrol --re-enrol\` with this password: their supervisors will not trust this box (different token) and will elect among themselves. Do it in one sitting; stop their supervisors first if you can. Then restart the supervisor here.`);
  else console.log(`${reEnrol ? 're-enrolled with the new keys' : 'enrolled'}: ${path}\n${reEnrol ? 'restart the bus supervisor on this box' : 'start a Claude session — the join hook does the rest'}`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('cc-enrol:', e.message); process.exit(1); });
}
