// ---------------------------------------------------------------------------
// cc-paths.mjs — single source of truth for the on-disk locations, with a SAFE
// one-time migration from the pre-rename names.
//
// Rename (branding → "Crosstalk", and dropping the stale "-mcp" from when MCP was a thing):
//   config file : ~/.claude/.cross-claude-bus   →  ~/.claude/.crosstalk
//   data dir    : ~/.cross-claude-mcp           →  ~/.crosstalk   (messages.db, epoch, supervisor.json)
//
// Migration is BACK-COMPAT and never destructive:
//   - env override (CC_DATA_DIR / CC_BUS_CONFIG) always wins (tests + isolated nodes).
//   - if the NEW path already exists, use it.
//   - else if the OLD path exists, migrate it to the new name ONCE (atomic rename); if the rename
//     can't happen (e.g. the DB is still open on Windows, or a concurrent process raced it), FALL
//     BACK to the old path rather than create an empty new one — so a node is never left split or
//     blanked. A returning node self-heals on the next start once the old dir is free.
//   - else create the new path.
// ---------------------------------------------------------------------------
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

const OLD_DATA_DIR = join(homedir(), '.cross-claude-mcp');
const NEW_DATA_DIR = join(homedir(), '.crosstalk');
const OLD_CONFIG = join(homedir(), '.claude', '.cross-claude-bus');
const NEW_CONFIG = join(homedir(), '.claude', '.crosstalk');

export const DATA_DIR_NAMES = { old: OLD_DATA_DIR, new: NEW_DATA_DIR };
export const CONFIG_NAMES = { old: OLD_CONFIG, new: NEW_CONFIG };

// Pure, testable directory migration: prefer `newDir`; else migrate `oldDir`→`newDir` once (atomic
// rename); if the rename can't happen (in-use/raced) keep `oldDir`; if neither exists, create
// `newDir`. Never creates an empty `newDir` alongside a populated `oldDir`.
export function migrateDir(oldDir, newDir, renameImpl = renameSync) {
  if (existsSync(newDir)) return newDir;
  if (existsSync(oldDir)) {
    try { renameImpl(oldDir, newDir); return newDir; }
    catch {
      // Rename failed for one of two reasons — and they need OPPOSITE handling:
      //  (a) a CONCURRENT migrator won the race (moved old→new) between our existsSync(newDir)
      //      check above and this rename. old is now gone, new holds the data → use NEW. If we
      //      instead fell through and returned old, the caller's mkdirSync would recreate old
      //      EMPTY and open messages.db there — splitting/blanking the bus (the bug this guards).
      //  (b) genuinely in-use (Windows EPERM/EBUSY on an open DB): new was never created, old is
      //      still present + populated → keep OLD; self-heals next start once the DB is free.
      if (existsSync(newDir)) return newDir;
      return oldDir;
    }
  }
  try { mkdirSync(newDir, { recursive: true }); } catch {}
  return newDir;
}

// Resolve (and migrate once) the data directory that holds messages.db / epoch / supervisor.json.
export function dataDir() {
  if (process.env.CC_DATA_DIR) return process.env.CC_DATA_DIR;   // override wins (tests / isolation)
  return migrateDir(OLD_DATA_DIR, NEW_DATA_DIR);
}

// Resolve the connection-config file. Back-compat READ only (no move): a fresh install writes the
// new path; an already-enrolled node keeps working off the old file until it's rewritten.
export function configPath() {
  if (process.env.CC_BUS_CONFIG) return process.env.CC_BUS_CONFIG;   // override wins
  if (existsSync(NEW_CONFIG)) return NEW_CONFIG;
  if (existsSync(OLD_CONFIG)) return OLD_CONFIG;
  return NEW_CONFIG;
}
