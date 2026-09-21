// ---------------------------------------------------------------------------
// coldstart.test.mjs — the SIMULTANEOUS cold-start election race, repeated (the one-box analogue
// of cross-host scenario X1; tracking issue 42).   node test/coldstart.test.mjs
//
// Every other fleet scenario boots node0 first, so exactly one node ever sees an empty estate.
// Real estates do not: a power cut, a fleet-wide plugin upgrade or two laptops opened together
// start every supervisor at once, each finds nobody, each promotes. That race wedged a live box
// on 2026-09-21. The contract: however the race falls, the fleet CONVERGES — exactly one leader,
// held stable past the 5s leader-monitor tick that resolves an equal-epoch double promotion, the
// losers settled as clients, and the bus usable.
//
//   X1a  2 nodes, simultaneous start, ×ROUNDS
//   X1b  3 nodes, simultaneous start, once
// Each round runs in a FRESH data dir (a genuinely cold start: no epoch file, no DB).
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

for (const k of ['CC_TOKEN', 'CC_BASE', 'CC_PIN', 'CC_PEERS', 'CC_ADMIN_KEY', 'CC_BIND']) delete process.env[k];

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Fleet, cleanupOnSignal } = await import(pathToFileURL(join(__dirname, '..', 'dev', 'fleet.mjs')).href);

const SLOT = parseInt(process.env.CC_FLEET_SLOT) || 11;
const ROUNDS = parseInt(process.env.CC_COLDSTART_ROUNDS) || 5;
const CONVERGE_MS = 45000;      // budget to reach a single, stable leader (X1 asks <15s cross-host; see the report line)
const SCRATCH = mkdtempSync(join(tmpdir(), 'cccold-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗', msg); } else { console.log('  ✓', msg); } };
const fleets = [];
cleanupOnSignal(() => fleets);
const times = [];

async function round(name, size) {
  const f = new Fleet({ slot: SLOT, size, dir: join(SCRATCH, name) });
  fleets.push(f);
  const t0 = Date.now();
  // Start everything at once and WATCH the race (informational: how many nodes ever led at the
  // same instant), then REQUIRE convergence. stableMs 8s > the 5s leader-monitor tick, so a double
  // promotion that is still being resolved cannot pass.
  for (let i = 0; i < size; i++) f.startNode(i);
  let peak = 0;
  const watch = setInterval(async () => { try { peak = Math.max(peak, (await f.leaders()).length); } catch {} }, 300);
  const l = await f.waitSingleLeader({ timeoutMs: CONVERGE_MS, stableMs: 8000 });
  clearInterval(watch);
  const ms = Date.now() - t0 - 8000;
  ok(!!l, `${name}: converged on exactly one leader, stable 8s (${l ? `node${l.i}@${l.epoch} after ~${ms} ms; peak simultaneous leaders seen: ${peak}` : 'NO single stable leader within ' + CONVERGE_MS + ' ms'})`);
  if (l) times.push(ms);
  ok(await f.waitSettled(30000), `${name}: every supervisor settled (1 leader, ${size - 1} client${size > 2 ? 's' : ''})`);
  const serving = (await Promise.all(Array.from({ length: size }, (_, i) => f.whoami(i)))).filter(Boolean).length;
  ok(serving === 1, `${name}: only the leader serves (${serving} answer whoami)`);
  if (l) {
    const m = await f.send('cold', `hello from ${name}`).catch((e) => ({ error: e.message }));
    ok(m.ok && (await f.messages('cold')).some((x) => x.id === m.id), `${name}: the converged bus accepts and returns a message`);
  }
  const bad = f.hermeticityViolations();
  ok(bad.length === 0, `${name}: hermetic${bad.length ? ' — ' + bad.join('; ') : ''}`);
  const left = await f.destroy();
  ok(left.length === 0, `${name}: teardown left nothing behind${left.length ? ' — ' + left.join('; ') : ''}`);
  fleets.pop();
  return l;
}

try {
  console.log(`X1a two nodes, simultaneous cold start ×${ROUNDS}`);
  for (let r = 1; r <= ROUNDS; r++) await round(`x1a-${r}`, 2);
  console.log('X1b three nodes, simultaneous cold start');
  await round('x1b', 3);

  if (times.length) console.log(`  time to a single leader: min ${Math.min(...times)} ms · max ${Math.max(...times)} ms · n=${times.length}`);
  if (failed) console.error('❌ coldstart.test FAILED');
  else console.log(`✅ coldstart.test: all assertions passed (${ROUNDS}× 2-node + 1× 3-node simultaneous cold start → one stable leader every time)`);
} catch (e) {
  failed = true;
  console.error('❌ coldstart.test ERROR:', e.stack || e.message);
} finally {
  for (const x of fleets) { try { await x.down(); } catch {} }
  if (failed) console.error(`(scratch kept for inspection: ${SCRATCH})`);
  else { for (let k = 0; k < 10 && existsSync(SCRATCH); k++) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} await sleep(200); } }
}
process.exit(failed ? 1 : 0);
