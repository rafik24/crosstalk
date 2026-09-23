// ---------------------------------------------------------------------------
// known-edges.test.mjs — the two edges issue 49 found, now FIXED and pinned as contracts.
//   node test/known-edges.test.mjs
//
// This file used to CHARACTERISE both edges (it pinned the broken behaviour as a tripwire). Issue 49
// fixed them; the assertions below are the real contract, and every one of them was watched RED
// against the pre-fix code (the module namespaces are imported loosely on purpose, so a missing
// export reads as a failed assertion, not a crash that hides the rest).
//
//   E1  host identity no longer COLLIDES: the display slug (canonicalShort) still folds `box_1` and
//       `box-1` together — it is a name, for display and DM routing — but every "is this the same
//       machine?" decision (the #35 same-host replication guard, the supervisor presence id, the
//       election tie-break) now keys on a collision-safe host id (a short hash of the raw,
//       case-folded hostname), falling back to the slug only for a peer that does not advertise one
//   E2  a PRERELEASE is handed over: a release outranks its own prereleases (semver precedence), so
//       a fleet can no longer be locked out by an `-rc1` supervisor the version gate treats as
//       a different version
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ccedges-'));
process.env.CC_DATA_DIR = DATA_DIR;   // importing cc-bus must never resolve the real ~/.crosstalk …
process.env.CC_BUS_CONFIG = join(DATA_DIR, 'no-such-config');   // … nor read the operator's real bus config (token)

const { canonicalShort } = await import('../src/cc-render.mjs');
const bus = await import('../src/cc-bus.mjs');
const disc = await import('../src/cc-discover.mjs');
const { versionGateReject } = await import('../server/version-gate.mjs');

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };
const tryv = (f) => { try { return f(); } catch { return undefined; } };

try {
  console.log('E1 host identity is collision-safe (issue 49)');
  // The slug is unchanged — it is still what humans and DM routing see.
  ok(new Set(['box_1', 'box-1', 'BOX 1', 'Box__1'].map(canonicalShort)).size === 1, `the display slug still folds four hostnames into one (${canonicalShort('box_1')})`);
  const id = (raw) => tryv(() => disc.hostIdOf(raw));
  ok(typeof id('box_1') === 'string' && /^[0-9a-f]{8}$/.test(id('box_1')), `hostIdOf() gives an 8-hex host id (got ${id('box_1')})`);
  ok(id('box_1') !== id('box-1') && id('box-1') !== id('box.1'), 'box_1 / box-1 / box.1 are three DIFFERENT host ids');
  ok(id('机器一') !== undefined && id('机器一') !== id('机器二'), 'two all-non-ASCII hostnames (both slug to unknown-host) get different ids');
  ok(id('DESKTOP-7ODO6OU') !== undefined && id('DESKTOP-7ODO6OU') === id('desktop-7odo6ou'), 'casing alone is the SAME host (issue 39 — OS vs config casing of one box)');

  const same = (a, b) => tryv(() => disc.sameHost(a, b));
  const A = { host: 'box-1', hostId: id('box_1') }, B = { host: 'box-1', hostId: id('box-1') };
  ok(same(A, B) === false, 'same slug, different host id → NOT the same host (the #35 guard now replicates between them)');
  ok(same(A, { ...A }) === true, 'same host id → same host');
  ok(same({ host: 'box-1' }, A) === true && same({ host: 'BOX_1' }, { host: 'box-1' }) === true,
    'back-compat: a peer that advertises no host id (pre-3.3.5) falls back to the canonical slug compare');
  ok(same({ host: 'box-2', hostId: id('box_1') }, A) === false, 'the slug must agree too — a hash match alone is never enough');

  // The election's final tie-break sees two different boxes as different (exactly one outranks).
  const at = (h) => ({ epoch: 5, watermark: 0, ...h });
  const ab = disc.outranks(at(A), at(B)), ba = disc.outranks(at(B), at(A));
  ok(ab !== ba, `the election tie-break orders box_1 vs box-1 deterministically (neither-outranks tie is gone: ${ab}/${ba})`);

  // Two colliding supervisors register TWO presence ids, and coverage counts the standby.
  const sid = (h, hid) => tryv(() => bus.supervisorInstanceId(h, hid));
  const s1 = sid('box-1', A.hostId), s2 = sid('box-1', B.hostId);
  ok(!!s1 && !!s2 && s1 !== s2 && canonicalShort(s1.split('/').pop()) === s1.split('/').pop(),
    `the supervisor presence ids differ and survive the server's id canonicalisation (${s1} vs ${s2})`);
  const cov = tryv(() => bus.failoverCoverage([{ instance_id: s1, status: 'online' }, { instance_id: s2, status: 'online' }], 'box-1', A.hostId));
  ok(cov && cov.hosts.length === 2 && cov.backups.length === 1, `coverage sees TWO supervisors and ONE standby (got ${JSON.stringify(cov)})`);
  const legacy = tryv(() => bus.failoverCoverage([{ instance_id: 'cc-bus-supervisor/desktop-7odo6ou', status: 'online' }], 'DESKTOP-7ODO6OU'));
  ok(legacy && legacy.backups.length === 0, 'back-compat: a legacy slug-only presence id still matches its leader (no false standby)');
  const self = tryv(() => disc.localHostIdentity());
  ok(self && self.host === bus.HOST && self.hostId === id(process.env.CC_HOST || hostname()), 'this process derives its own identity from the same function it compares with');

  console.log('E2 prerelease versions are handed over (issue 49)');
  const nv = bus.needsVersionHandover;
  ok(nv({ version: '3.3.4-rc1' }, '3.3.4') === true, 'the final 3.3.4 REPLACES a running 3.3.4-rc1 supervisor');
  ok(nv({ version: '3.3.4' }, '3.3.4-rc1') === false, '…and an -rc1 never replaces the final release (directional)');
  ok(nv({ version: '3.3.4-rc.2' }, '3.3.4-rc.10') === true && nv({ version: '3.3.4-rc.10' }, '3.3.4-rc.2') === false, 'numeric prerelease identifiers compare numerically (rc.10 > rc.2)');
  ok(nv({ version: '3.3.4-alpha' }, '3.3.4-beta') === true && nv({ version: '3.3.4-alpha.1' }, '3.3.4-alpha') === false, 'alphanumeric ids compare lexically; a longer id list outranks its prefix');
  ok(nv({ version: '3.3.4' }, '3.3.5-rc1') === true, 'a prerelease of a HIGHER version still outranks an older release');
  ok(nv({ version: '3.3.4-rc1' }, '3.3.4-rc1') === false && nv({ version: '3.3.4+b7' }, '3.3.4') === false, 'equal versions (build metadata ignored) → no handover');
  ok(!!versionGateReject('3.3.4', '3.3.4-rc1'), 'the version gate still treats them as different — which is why the handover above must happen');
  ok(nv({ version: '3.3.9' }, '3.3.10') === true && nv({ version: '3.3.10' }, '3.3.9') === false, 'control: numeric (not lexicographic) compare across a digit boundary');

  if (failed) console.error('❌ known-edges.test FAILED');
  else console.log('✅ known-edges.test: host identity is collision-safe and prereleases are handed over (issue 49)');
} catch (e) {
  failed = true;
  console.error('❌ known-edges.test ERROR:', e.stack || e.message);
} finally {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
