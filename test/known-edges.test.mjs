// ---------------------------------------------------------------------------
// known-edges.test.mjs — CHARACTERISATION of two known, un-fixed edges (issue 49; from the QA
// program's "known-not-covered" list).   node test/known-edges.test.mjs
//
// These assertions PIN TODAY'S BEHAVIOUR — they are not endorsements. Each one is a tripwire IF the
// fix lands in the function it exercises (a fix elsewhere — e.g. in how cc-bus derives HOST — needs
// its own test; the coverage line below only ILLUSTRATES a consequence): when such a fix lands the
// assertion goes red, and whoever fixed it replaces it with the real
// contract (and closes the issue). Until then nobody can change the behaviour by accident, and
// nobody can assume it away.
//
//   E1  host-id canonicalisation COLLIDES: different machines can canonicalise to one id — and the
//       same-host guard, supervisor presence ids and the election tie-break all key on it
//   E2  a PRERELEASE version is never handed over (x.y.z is compared numerically, the suffix is
//       ignored) although the version gate treats it as a different version
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ccedges-'));
process.env.CC_DATA_DIR = DATA_DIR;   // importing cc-bus must never resolve the real ~/.crosstalk …
process.env.CC_BUS_CONFIG = join(DATA_DIR, 'no-such-config');   // … nor read the operator's real bus config (token)

const { canonicalShort } = await import('../src/cc-render.mjs');
const { needsVersionHandover, failoverCoverage } = await import('../src/cc-bus.mjs');
const { outranks } = await import('../src/cc-discover.mjs');
const { versionGateReject } = await import('../server/version-gate.mjs');

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };

try {
  console.log('E1 host-id canonicalisation collides (issue 49)');
  ok(new Set(['box_1', 'box-1', 'BOX 1', 'Box__1'].map(canonicalShort)).size === 1, `four different hostnames → one id (${canonicalShort('box_1')})`);
  ok(canonicalShort('ünï') === 'n' && canonicalShort('机器一') === '' && canonicalShort('机器二') === '', "non-ASCII is stripped: distinct non-Latin hostnames BOTH become '' — which cc-bus turns into 'unknown-host', so every such box shares one id");
  // …and what keys on it:
  ok(outranks({ epoch: 5, watermark: 0, host: 'box_1' }, { epoch: 5, watermark: 0, host: 'box-1' }) === false
    && outranks({ epoch: 5, watermark: 0, host: 'box-1' }, { epoch: 5, watermark: 0, host: 'box_1' }) === false,
    'the election tie-break sees two DIFFERENT boxes as a true tie (neither outranks)');
  const cov = failoverCoverage([
    { instance_id: 'cc-bus-supervisor/box-1', status: 'online' },   // box_1 and box-1 both register THIS id
  ], 'box_1');
  ok(cov.hosts.length === 1 && cov.backups.length === 0, '(illustration) two colliding supervisors register ONE presence id → coverage reports no standby');

  console.log('E2 prerelease versions are never handed over (issue 49)');
  ok(needsVersionHandover({ version: '3.3.4-rc1' }, '3.3.4') === false, 'final 3.3.4 does NOT replace a running 3.3.4-rc1 supervisor');
  ok(needsVersionHandover({ version: '3.3.4' }, '3.3.4-rc1') === false, '…and (correctly) not the other way round either');
  const gate = versionGateReject('3.3.4', '3.3.4-rc1');
  ok(!!gate, 'yet the version gate treats them as DIFFERENT: a leading -rc1 supervisor locks a final-3.3.4 fleet out');
  ok(needsVersionHandover({ version: '3.3.9' }, '3.3.10') === true && needsVersionHandover({ version: '3.3.10' }, '3.3.9') === false, 'control: numeric (not lexicographic) compare across a digit boundary');

  if (failed) console.error('❌ known-edges.test FAILED — if you FIXED one of these edges, replace the pinned assertion with the real contract and close issue 49');
  else console.log('✅ known-edges.test: both known edges still behave as characterised (issue 49 open)');
} catch (e) {
  failed = true;
  console.error('❌ known-edges.test ERROR:', e.stack || e.message);
} finally {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
