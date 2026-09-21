// ---------------------------------------------------------------------------
// cc-rev.mjs — identify the running code revision of THIS checkout.
//
// The estate deploys by `git pull`, so a node can silently run stale code (the
// 2026-08 incident: a leader without the /console route kept serving an old
// build with no signal it was behind). Every process that participates in the
// bus advertises its short commit SHA (+ a `+` when the worktree is dirty) so
// the estate can VERIFY everyone is on the same code and nudge stale nodes to
// pull + re-arm/re-launch.
//
//   codeRev()   → { rev: 'abc1234'|null, dirty: bool }   (memoised; git run once)
//   revString() → 'abc1234' | 'abc1234+' | 'unknown'
//
// Fail-soft: no git / not a checkout → { rev: null }, never throws.
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives in src/; the repo root (which holds package.json + .git) is one level up.
// codeRev() tolerates either (git -C walks up to .git), but pkgVersion() reads REPO/package.json,
// so REPO must be the real root — otherwise it reads a non-existent src/package.json → null →
// the version gate silently fails OPEN. (The src/ reorg moved this file without fixing this path.)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let cached = null;

export function codeRev() {
  if (cached) return cached;
  try {
    // stdio: git's stderr must NOT be inherited — a plugin-cache install is not a checkout, so
    // every client run from one printed `fatal: not a git repository` to the caller's terminal
    // (an agent read it as an error in the 2026-09-17 Codex POC). Fail-soft stays: rev → null.
    const git = (a) => execFileSync('git', a, { encoding: 'utf8', timeout: 2500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rev = git(['-C', REPO, 'rev-parse', '--short', 'HEAD']);
    let dirty = false;
    try { dirty = git(['-C', REPO, 'status', '--porcelain']).length > 0; } catch {}
    cached = { rev: rev || null, dirty };
  } catch { cached = { rev: null, dirty: false }; }
  return cached;
}

export function revString() {
  const { rev, dirty } = codeRev();
  return rev ? rev + (dirty ? '+' : '') : 'unknown';
}

// The published RELEASE version (package.json semver). Unlike the git SHA above, this is present
// for BOTH a git checkout AND a plugin-cache install (where codeRev() is 'unknown'), so it is the
// only identity that works fleet-wide — which is why the bus version gate keys on it. Memoised;
// fail-soft: an unreadable/absent package.json → null (the gate then fails OPEN, never bricks).
let cachedPkg;
export function pkgVersion() {
  if (cachedPkg !== undefined) return cachedPkg;
  try {
    const raw = readFileSync(join(REPO, 'package.json'), 'utf8');
    const v = JSON.parse(raw).version;
    cachedPkg = (typeof v === 'string' && v) ? v : null;
  } catch { cachedPkg = null; }
  return cachedPkg;
}

// CLI: `node cc-rev.mjs` prints "<rev> <version>" for shell callers (cc-join.sh, issue #32) —
// the CROSSTALK code's identity, never the caller's cwd repo. Guarded so importing stays inert.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`${revString()} ${pkgVersion() || 'unknown'}`);
}
