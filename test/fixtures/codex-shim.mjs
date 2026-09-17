// Stand-in for the `codex` binary in tests (CODEX_BIN=<this file> → the bridge runs it under node).
// Appends one JSON line per invocation to $CODEX_SHIM_LOG {argv, ok}. Fails (exit 1) while the
// file $CODEX_SHIM_FAIL exists (transient-failure mode) OR when the message contains "POISON"
// (permanent per-message failure — Codex refusing one message must not affect the others), and
// HANGS (never exits) when the message contains "HANG" — a stalled codex the bridge must time out.
import { appendFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
const msg = argv[argv.indexOf('--message') + 1] || '';
const ok = !(process.env.CODEX_SHIM_FAIL && existsSync(process.env.CODEX_SHIM_FAIL)) && !/POISON/.test(msg);
appendFileSync(process.env.CODEX_SHIM_LOG, JSON.stringify({ argv, ok, hang: /HANG/.test(msg) }) + '\n');
if (/HANG/.test(msg)) setInterval(() => {}, 1000);   // stall until killed
else process.exit(ok ? 0 : 1);
