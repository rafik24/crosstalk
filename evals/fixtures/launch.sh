#!/usr/bin/env bash
# evals/fixtures/launch.sh <port> [--handoff] — case scaffold: (re)start the scratch eval bus
# DETACHED (the scaffold script must return; the bus outlives it and self-terminates on --ttl-s),
# then block until it answers /cc/whoami. Requires the eval shell to export the scratch env:
#   CC_BUS_CONFIG=$EVAL_SCRATCH/bus-config  CC_CACHE_DIR=$EVAL_SCRATCH/cache  CC_DATA_DIR=$EVAL_SCRATCH/data
#   CC_DISCOVERY=peers  CC_BIND=127.0.0.1   (and NO CC_TOKEN / CC_BASE / CC_PORT / CC_PEERS)
set -u
PORT="${1:?port}"; shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="${EVAL_SCRATCH:?EVAL_SCRATCH must point at the scratch dir}"
mkdir -p "$SCRATCH"
case "${CC_BUS_CONFIG:-}" in "$SCRATCH"/*|"${SCRATCH//\//\\}"\\*) ;; *) echo "refusing: CC_BUS_CONFIG (${CC_BUS_CONFIG:-unset}) is not under EVAL_SCRATCH" >&2; exit 1;; esac
# A previous case's bus (different port) still alive? Stop it — one bus at a time, no port pile-up.
if [ -f "$SCRATCH/evalbus.pid" ]; then
  old="$(cat "$SCRATCH/evalbus.pid" 2>/dev/null)"
  [ -n "$old" ] && { taskkill //PID "$old" //F >/dev/null 2>&1 || kill "$old" 2>/dev/null || true; }
  sleep 1
fi
command -v cygpath >/dev/null 2>&1 && { HERE="$(cygpath -m "$HERE")"; SCRATCH="$(cygpath -m "$SCRATCH")"; }
node -e '
  const { spawn } = require("node:child_process"); const fs = require("node:fs");
  const [script, port, scratch, ...rest] = process.argv.slice(1);
  const out = fs.openSync(scratch + "/evalbus-" + port + ".out", "a");
  const c = spawn(process.execPath, [script, "--port", port, "--scratch", scratch, "--ttl-s", "600", ...rest], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  c.unref(); console.log("spawned evalbus pid " + c.pid);
' "$HERE/evalbus.mjs" "$PORT" "$SCRATCH" "$@"
for i in $(seq 1 40); do
  curl -s -m 2 "http://127.0.0.1:$PORT/cc/whoami" | grep -q '"evalbus"' && { echo "evalbus ready on :$PORT (config $SCRATCH/bus-config)"; exit 0; }
  sleep 0.5
done
echo "evalbus did not come up on :$PORT" >&2; exit 1
