// Stand-in for the `codex` binary in tests (CODEX_BIN=<this file> → the bridge runs it under node).
// Appends one JSON line per invocation to $CODEX_SHIM_LOG {argv, ok}. Fails (exit 1) while the
// file $CODEX_SHIM_FAIL exists (transient-failure mode) OR when the message contains "POISON"
// (permanent per-message failure — Codex refusing one message must not affect the others), and
// HANGS (never exits) when the message contains "HANG" — a stalled codex the bridge must time out.
// A "SLOW" message logs an ENTER marker, waits CODEX_SHIM_SLOW_MS, then logs its completion line and
// exits — so a test can observe concurrency: with a SERIALIZED sink (#26) ENTER/done never interleave,
// without it N ENTERs precede the dones. The ENTER line carries argv:[] so the existing
// calls()/queued() filters (which key on argv[0]==='queue') ignore it.
import { appendFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
const msg = argv[argv.indexOf('--message') + 1] || '';
const ok = !(process.env.CODEX_SHIM_FAIL && existsSync(process.env.CODEX_SHIM_FAIL)) && !/POISON/.test(msg);
if (/SLOW/.test(msg)) {
  appendFileSync(process.env.CODEX_SHIM_LOG, JSON.stringify({ enter: true, argv: [], ok: false, msg, t: Date.now() }) + '\n');
  setTimeout(() => {
    appendFileSync(process.env.CODEX_SHIM_LOG, JSON.stringify({ argv, ok, hang: false, t: Date.now() }) + '\n');
    process.exit(ok ? 0 : 1);
  }, Number(process.env.CODEX_SHIM_SLOW_MS || 250));
} else {
  appendFileSync(process.env.CODEX_SHIM_LOG, JSON.stringify({ argv, ok, hang: /HANG/.test(msg) }) + '\n');
  if (/HANG/.test(msg)) setInterval(() => {}, 1000);   // stall until killed
  else process.exit(ok ? 0 : 1);
}
