#!/usr/bin/env bash
# evals/fixtures/launch.sh <port> [--handoff] — case scaffold for `claude plugin eval --scaffold`.
# The harness runs this (and then the session) under a PRIVATE HOME with a scrubbed env. We
# (re)start the scratch eval bus DETACHED — the scaffold must return; the bus outlives it and
# self-terminates on --ttl-s — write its config into that HOME (where cc-join.sh looks), and block
# until it answers /cc/whoami. Nothing here reads the operator's shell env or ~/.claude.
set -u
PORT="${1:?port}"; shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS="$HERE/../results"; mkdir -p "$RESULTS"
RUN_HOME="${USERPROFILE:-$HOME}"
case "$RUN_HOME" in *claude-eval*) ;; *) echo "refusing: HOME ($RUN_HOME) is not an eval-run scratch home" >&2; exit 1;; esac
# The previous case's bus (another port) may still be alive — one bus at a time, no port pile-up.
if [ -f "$RESULTS/evalbus.pid" ]; then
  old="$(cat "$RESULTS/evalbus.pid" 2>/dev/null)"
  [ -n "$old" ] && { taskkill //PID "$old" //F >/dev/null 2>&1 || kill "$old" 2>/dev/null || true; }
  rm -f "$RESULTS/evalbus.pid"; sleep 1
fi
command -v cygpath >/dev/null 2>&1 && { HERE="$(cygpath -m "$HERE")"; RESULTS="$(cygpath -m "$RESULTS")"; RUN_HOME="$(cygpath -m "$RUN_HOME")"; }
node -e '
  const { spawn } = require("node:child_process"); const fs = require("node:fs");
  const [script, port, home, results, ...rest] = process.argv.slice(1);
  const out = fs.openSync(results + "/evalbus-" + port + ".out", "a");
  const c = spawn(process.execPath, [script, "--port", port, "--home", home, "--results", results, "--ttl-s", "600", ...rest], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  c.unref(); console.log("spawned evalbus pid " + c.pid);
' "$HERE/evalbus.mjs" "$PORT" "$RUN_HOME" "$RESULTS" "$@"
for i in $(seq 1 40); do
  curl -s -m 2 "http://127.0.0.1:$PORT/cc/whoami" | grep -q '"evalbus"' && { echo "evalbus ready on :$PORT (config $RUN_HOME/.claude/.crosstalk)"; exit 0; }
  sleep 0.5
done
echo "evalbus did not come up on :$PORT" >&2; exit 1
