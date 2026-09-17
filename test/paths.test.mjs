// ---------------------------------------------------------------------------
// paths.test.mjs — the storage-rename migration (cc-paths.migrateDir) + env overrides.
//   node test/paths.test.mjs
//
// migrateDir is the load-bearing safety of the .cross-claude-mcp → .crosstalk rename: it must
// preserve a populated old dir, never blank the bus, and be idempotent. Tested hermetically on
// scratch dirs (never the real ~/.crosstalk).
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDir, dataDir, configPath } from '../src/cc-paths.mjs';
import { loadConfig } from '../src/cc-discover.mjs';

let failed = false;
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗', m); } else console.log('  ✓', m); };
const scratch = () => mkdtempSync(join(tmpdir(), 'ccpaths-'));

try {
  // 1. old exists, new absent → migrate (rename), old gone, content preserved at new.
  {
    const base = scratch();
    const oldDir = join(base, 'old'); const newDir = join(base, 'new');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'messages.db'), 'DBDATA');
    writeFileSync(join(oldDir, 'epoch'), '24');
    const got = migrateDir(oldDir, newDir);
    ok(got === newDir, 'migrate: returns the new dir');
    ok(!existsSync(oldDir), 'migrate: old dir is gone (renamed, not copied)');
    ok(existsSync(newDir) && readFileSync(join(newDir, 'messages.db'), 'utf8') === 'DBDATA', 'migrate: DB content preserved at new');
    ok(readFileSync(join(newDir, 'epoch'), 'utf8') === '24', 'migrate: epoch sidecar preserved');
    rmSync(base, { recursive: true, force: true });
  }

  // 2. new already exists → use it, never touch old (idempotent second run / already-migrated).
  {
    const base = scratch();
    const oldDir = join(base, 'old'); const newDir = join(base, 'new');
    mkdirSync(oldDir, { recursive: true }); writeFileSync(join(oldDir, 'stale'), 'x');
    mkdirSync(newDir, { recursive: true }); writeFileSync(join(newDir, 'messages.db'), 'CURRENT');
    const got = migrateDir(oldDir, newDir);
    ok(got === newDir, 'new-exists: returns new');
    ok(existsSync(oldDir), 'new-exists: old dir left untouched (not clobbered)');
    ok(readFileSync(join(newDir, 'messages.db'), 'utf8') === 'CURRENT', 'new-exists: new content intact');
    rmSync(base, { recursive: true, force: true });
  }

  // 3. neither exists → create new empty.
  {
    const base = scratch();
    const newDir = join(base, 'new');
    const got = migrateDir(join(base, 'nope'), newDir);
    ok(got === newDir && existsSync(newDir), 'neither: creates the new dir');
    ok(readdirSync(newDir).length === 0, 'neither: new dir is empty (fresh bus)');
    rmSync(base, { recursive: true, force: true });
  }

  // 3b. rename FAILS but a concurrent migrator already created new (the race the MED-1 fix guards):
  //     must return NEW (never fall through to recreate an empty old → split/blank the bus).
  {
    const base = scratch();
    const oldDir = join(base, 'old'); const newDir = join(base, 'new');
    mkdirSync(oldDir, { recursive: true }); writeFileSync(join(oldDir, 'x'), '1');
    const throwRename = () => { mkdirSync(newDir, { recursive: true }); writeFileSync(join(newDir, 'messages.db'), 'WON'); throw new Error('EPERM (raced)'); };
    const got = migrateDir(oldDir, newDir, throwRename);
    ok(got === newDir, 'race: rename throws + new exists → returns NEW (not old)');
    ok(readFileSync(join(newDir, 'messages.db'), 'utf8') === 'WON', 'race: the concurrent winner\'s data is used');
    rmSync(base, { recursive: true, force: true });
  }

  // 3c. rename FAILS and new was NOT created (genuine in-use: DB open) → keep OLD, don't blank.
  {
    const base = scratch();
    const oldDir = join(base, 'old'); const newDir = join(base, 'new');
    mkdirSync(oldDir, { recursive: true }); writeFileSync(join(oldDir, 'messages.db'), 'LIVE');
    const throwRename = () => { throw new Error('EBUSY (in use)'); };
    const got = migrateDir(oldDir, newDir, throwRename);
    ok(got === oldDir, 'in-use: rename throws + new absent → keeps OLD');
    ok(!existsSync(newDir), 'in-use: no empty new dir created');
    ok(readFileSync(join(oldDir, 'messages.db'), 'utf8') === 'LIVE', 'in-use: old data intact');
    rmSync(base, { recursive: true, force: true });
  }

  // 4. env overrides win (tests + isolated nodes must never touch the real paths).
  {
    const d = scratch(); const c = join(scratch(), 'cfg');
    process.env.CC_DATA_DIR = d;
    ok(dataDir() === d, 'CC_DATA_DIR override wins for dataDir()');
    delete process.env.CC_DATA_DIR;
    writeFileSync(c, 'CC_TOKEN=x');
    process.env.CC_BUS_CONFIG = c;
    ok(configPath() === c, 'CC_BUS_CONFIG override wins for configPath()');
    delete process.env.CC_BUS_CONFIG;
  }

  // 5. loadConfig reads CC_ADMIN_KEY from the config FILE (not just env) — required so the admin
  //    scope works for a systemd/manual launch, not only the config-sourcing hook path.
  {
    const cfg = join(scratch(), 'cfg');
    writeFileSync(cfg, 'CC_TOKEN=t\nCC_ADMIN_KEY=k-from-file\nCC_BIND=0.0.0.0\nCC_ALLOW_FILE_ORIGIN=1\n');
    const savedC = process.env.CC_BUS_CONFIG, savedA = process.env.CC_ADMIN_KEY, savedB = process.env.CC_BIND, savedF = process.env.CC_ALLOW_FILE_ORIGIN;
    delete process.env.CC_ADMIN_KEY; delete process.env.CC_BIND; delete process.env.CC_ALLOW_FILE_ORIGIN; process.env.CC_BUS_CONFIG = cfg;
    ok(loadConfig().admin === 'k-from-file', 'loadConfig reads CC_ADMIN_KEY from the config file');
    ok(loadConfig().bind === '0.0.0.0', 'loadConfig reads CC_BIND from the config file');
    ok(loadConfig().allowFileOrigin === '1', 'loadConfig reads CC_ALLOW_FILE_ORIGIN from the config file (the supervisor forwards it to the server)');
    process.env.CC_ADMIN_KEY = 'k-from-env';
    ok(loadConfig().admin === 'k-from-env', 'env CC_ADMIN_KEY overrides the file');
    process.env.CC_ALLOW_FILE_ORIGIN = '0';
    ok(loadConfig().allowFileOrigin === '0', 'env CC_ALLOW_FILE_ORIGIN=0 overrides a 1 in the file (fails closed)');
    if (savedC !== undefined) process.env.CC_BUS_CONFIG = savedC; else delete process.env.CC_BUS_CONFIG;
    if (savedA !== undefined) process.env.CC_ADMIN_KEY = savedA; else delete process.env.CC_ADMIN_KEY;
    if (savedB !== undefined) process.env.CC_BIND = savedB; else delete process.env.CC_BIND;
    if (savedF !== undefined) process.env.CC_ALLOW_FILE_ORIGIN = savedF; else delete process.env.CC_ALLOW_FILE_ORIGIN;
  }

  console.log(failed ? '\n❌ paths.test FAILED' : '\n✅ paths.test: all assertions passed (migrateDir preserve/idempotent/create + env overrides + loadConfig admin)');
} catch (e) {
  failed = true; console.error('❌ paths.test ERROR:', e.stack || e.message);
}
process.exit(failed ? 1 : 0);
