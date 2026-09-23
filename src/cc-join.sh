#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cc-join.sh — SessionStart hook: auto-join the live Crosstalk chat bus.
#
# OPT-IN PER MACHINE: this no-ops entirely unless the bus config (~/.claude/.crosstalk,
# or legacy ~/.claude/.cross-claude-bus) exists — so it only fires on enrolled machines (the
# local dev box and the Linux build/test box). Advisory, fail-open, exit 0.
#
# A SessionStart hook cannot call the Skill or Monitor tools itself, so it does
# the things it CAN: (1) mint a UNIQUE default identity for this session and
# persist it where the listen-gate reads it, (2) register presence on the bus,
# and (3) print the session's first three actions — load the skill, name itself,
# arm live-receive. Runs on Windows git-bash AND Linux.
#
# IDENTITY (why host/<branch>-<shortid>, not host/<branch>):
#   two sessions on the same branch used to both become "host/branch" and
#   collided on the bus. The <shortid> (first 8 of the Claude session id) makes
#   the default unique. The session then renames itself to host/<title-slug>
#   via cc-name.mjs. The identity is written to ~/.claude/.cc-listen/<sid>.id and
#   the listen-gate READS that file (it no longer recomputes) — so the gate always
#   agrees with the current name, default or renamed.
# ---------------------------------------------------------------------------
set -u
# Config: prefer the new ~/.claude/.crosstalk, fall back to the legacy ~/.claude/.cross-claude-bus
# (CC_BUS_CONFIG overrides). Keeps already-enrolled nodes working through the rename.
CFG="${CC_BUS_CONFIG:-}"
if [ -z "$CFG" ]; then
  if [ -f "$HOME/.claude/.crosstalk" ]; then CFG="$HOME/.claude/.crosstalk"
  elif [ -f "$HOME/.claude/.cross-claude-bus" ]; then CFG="$HOME/.claude/.cross-claude-bus"
  else CFG="$HOME/.claude/.crosstalk"; fi
fi
# Not enrolled: say so in ONE line instead of exiting silently (issue #38 — a fresh plugin
# install used to do nothing and say nothing, so the machine looked broken rather than unenrolled).
if [ ! -f "$CFG" ]; then
  # Enrolment by PASSWORD (issue 55): a hook cannot prompt, so point at the one command that can.
  ENROL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cc-enrol.mjs"
  command -v cygpath >/dev/null 2>&1 && ENROL="$(cygpath -m "$ENROL")"
  echo "crosstalk: plugin installed but this machine is NOT ENROLLED - run:  node \"$ENROL\" --auto-supervisor   and enter the estate password (verified against the live bus before anything is written). Details: the plugin's ENROLLMENT.md."
  exit 0
fi
command -v node >/dev/null 2>&1 || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="$HERE/cc-ws.mjs"
POLL="$HERE/cc-poll.mjs"
SEND="$HERE/cc-send.mjs"
NAME="$HERE/cc-name.mjs"
ACK="$HERE/cc-ack.mjs"
DISCOVER="$HERE/cc-discover.mjs"    # leader discovery (same module every cc-*.mjs client uses)
[ -f "$POLL" ] || exit 0

# SessionStart delivers a JSON payload on stdin that includes session_id. Grab it
# (node is guaranteed present — checked above) so we can key the identity by session.
PAYLOAD="$(cat 2>/dev/null || true)"
SID="$(printf '%s' "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).session_id||""))}catch{}})' 2>/dev/null || true)"

# On Windows git-bash, convert MSYS paths (/d/…) to node-friendly ones (D:/…) so the printed
# `node …` commands resolve. No-op on Linux (cygpath absent).
if command -v cygpath >/dev/null 2>&1; then
  HERE="$(cygpath -m "$HERE")"; WS="$(cygpath -m "$WS")"; POLL="$(cygpath -m "$POLL")"; SEND="$(cygpath -m "$SEND")"
  NAME="$(cygpath -m "$NAME")"; ACK="$(cygpath -m "$ACK")"; DISCOVER="$(cygpath -m "$DISCOVER")"
fi

# shellcheck disable=SC1090
. "$CFG"                       # CC_TOKEN, CC_AUTO_SUPERVISOR, and CC_BASE only if manually PINNED

# --- self-healing supervisor (#6, approach B) -----------------------------------------------------
# Ensure exactly one `cc-bus` supervisor runs on this box, so any machine with a live Claude session
# has failover capacity by construction (the fix for "sole leader dies → bus blacks out"). This is
# OPT-IN via CC_AUTO_SUPERVISOR=1 in the config, so it stays INERT on the estate until the PO turns
# it on after testing. `cc-bus ensure` is idempotent (no-op if a supervisor is already live here),
# fast (no network — just a pid/heartbeat check + a detached spawn) and fail-soft. Run FOREGROUND
# (not backgrounded): it must finish spawning the detached supervisor before this hook exits, or the
# hook's exit could kill it first — and it returns in well under a second.
if [ "${CC_AUTO_SUPERVISOR:-0}" = "1" ] && [ -f "$HERE/cc-bus.mjs" ]; then
  sup_msg="$(node "$HERE/cc-bus.mjs" ensure 2>/dev/null || true)"
  [ -n "$sup_msg" ] && echo "🩺 SELF-HEALING SUPERVISOR — $sup_msg"
fi

# A discovery-based enrollment deliberately OMITS CC_BASE (ENROLLMENT.md §3/§5): the bus has no
# fixed IP, so the leader is DISCOVERED, not pinned. Every cc-*.mjs client already does this via
# cc-discover.mjs; this hook used to `exit 0` here when CC_BASE was unset and so joined silently on
# exactly the machines the docs tell you to set up. Resolve the leader the same way the clients do
# (resolveFast → resolveFull) rather than pinning CC_BASE, which would become a global override that
# breaks on the next leader migration. Fail-soft throughout — a SessionStart hook must never wedge.
if [ -z "${CC_BASE:-}" ] && [ -f "$DISCOVER" ]; then
  CC_BASE="$(node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    try {
      const m = await import(pathToFileURL(process.argv[1]).href);
      const cfg = m.loadConfig();
      let leader = await m.resolveFast({ token: cfg.token, pin: cfg.pin });
      if (!leader) leader = await m.resolveFull({ token: cfg.token, pin: cfg.pin });
      if (leader && leader.base) process.stdout.write(String(leader.base));
    } catch {}
  ' "$DISCOVER" 2>/dev/null || true)"
fi

if [ -z "${CC_BASE:-}" ]; then
  echo "⛔ LIVE CHAT BUS — no leader found (discovery silent, no CC_BASE pin). Would join once a host is up."
  exit 0
fi

machine=$(hostname 2>/dev/null | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-'); machine="${machine%-}"
[ -n "$machine" ] || machine="unknown"
branch=$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
topic="${branch##*/}"
{ [ -z "$topic" ] || [ "$topic" = "HEAD" ]; } && topic="$(basename "$PWD")"
# Canonical short name — MUST match cc-render.canonicalShort + the server's channel normalizer
# (lowercase · spaces/underscores -> '-' · drop anything outside [a-z0-9-] · collapse · trim), so the
# minted id's short == its dm-<short> channel and a rejoin re-attaches instead of forking (#5).
topic=$(printf '%s' "$topic" | tr 'A-Z' 'a-z' | sed 's/[[:space:]_]\{1,\}/-/g; s/[^a-z0-9-]//g; s/-\{1,\}/-/g; s/^-//; s/-$//')
[ -n "$topic" ] || topic="misc"
short="$(printf '%s' "$SID" | cut -c1-8)"
if [ -n "$short" ]; then ID="$machine/$topic-$short"; else ID="$machine/$topic"; fi

# persist the identity keyed by session so the listen-gate reads it (never recomputes).
# session ids are UUIDs — already filename-safe — so key the file by the raw sid.
LISTEN_DIR="$HOME/.claude/.cc-listen"
mkdir -p "$LISTEN_DIR" 2>/dev/null || true
[ -n "$SID" ] && printf '%s' "$ID" > "$LISTEN_DIR/$SID.id" 2>/dev/null || true

# running-code revision of the CROSSTALK code (short SHA, '+' if dirty) — via cc-rev.mjs, which
# resolves the plugin/checkout root and prints 'unknown' for a plugin-cache install. It used to be
# `git -C "$PWD"` — the SESSION'S cwd repo — so a mailroom session advertised mailroom's HEAD and
# the estate read it as an unpushed crosstalk commit (issue #32). Never measure the caller's repo.
rev="$(node "$HERE/cc-rev.mjs" 2>/dev/null | cut -d' ' -f1 || true)"
[ "$rev" = "unknown" ] && rev=""

# release version (package.json semver) — the fleet version gate refuses a host that is not on the
# leader's version, so register MUST carry it or a current host is 426'd on every session start.
# node is guaranteed present (checked above); read it from the plugin dir ($HERE, node-friendly).
ver="$(node -e 'try{process.stdout.write(String(require(process.argv[1]+"/../package.json").version||""))}catch{}' "$HERE" 2>/dev/null || true)"

# register presence now (fail-soft — never wedge a session start), but report the outcome
# HONESTLY: the header line must state whether the bus actually answered, not assume it did.
# curl's %{http_code} is 000 when the connection never lands (server down / wrong host / DNS),
# a 2xx when register succeeds, or 401/403 when the token is wrong. Works the same on Linux and
# on Windows git-bash (both ship curl). If curl is missing entirely, http_code is empty → treated
# as "could not connect" — still honest. Never `exit` non-zero: a SessionStart hook must not wedge.
http_code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$CC_BASE/api/register" \
  -H "Authorization: Bearer ${CC_TOKEN:-}" -H 'content-type: application/json' -H "x-cc-version: ${ver:-}" \
  -d "{\"instance_id\":\"$ID\",\"description\":\"$topic @ $machine\",\"rev\":\"$rev\",\"version\":\"$ver\"}" 2>/dev/null || true)"

case "$http_code" in
  2??)     JOIN_LINE="✅ LIVE CHAT BUS — CONNECTED, registered as: $ID   ($CC_BASE)" ;;
  000|"")  JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT to $CC_BASE (server unreachable — is the bus service up?). Would join as: $ID" ;;
  401|403) JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT: $CC_BASE rejected the token (HTTP $http_code — check CC_TOKEN in $CFG). Would join as: $ID" ;;
  426)     JOIN_LINE="⛔ LIVE CHAT BUS — VERSION GATE: this host (${ver:-unknown}) is not on the bus's version. Every host must run the same latest version — update the crosstalk plugin on this host, then re-arm. Would join as: $ID" ;;
  *)       JOIN_LINE="⚠️ LIVE CHAT BUS — bus at $CC_BASE answered HTTP $http_code (not a clean register). Would join as: $ID" ;;
esac

# code-drift check: does THIS checkout match the code the bus leader is running? A mismatch means
# someone pulled and someone didn't — the class of bug where a leader served an old build silently.
if [ -n "$rev" ]; then
  leader_rev="$(curl -s -m 5 "$CC_BASE/cc/whoami" 2>/dev/null | grep -o '"rev":"[^"]*"' | head -1 | sed 's/.*:"//; s/"$//')"
  if [ -n "$leader_rev" ] && [ "$leader_rev" != "null" ] && [ "$rev" != "$leader_rev" ]; then
    JOIN_LINE="$JOIN_LINE
   ⚠️ CODE DRIFT — this checkout is $rev but the bus leader runs $leader_rev. To sync: git pull && restart the bus, then re-arm this session."
  fi
fi

cat <<EOF
$JOIN_LINE
   Your FIRST actions this session (in order):
   1. LOAD THE SKILL:  Skill(crosstalk:crosstalk)   (plugin-namespaced; a manually-installed skill is Skill(crosstalk))
        — defines your identity, the always-listen rule, reply-only-if-addressed, and the ack protocol.
   2. NAME yourself after this session's task so peers can @mention you and the PO console is readable:
        node $NAME ${SID:-<session_id>} "<what you're working on>"
        — prints your named id + the exact Monitor line to arm. Do this BEFORE step 3 to arm once.
   3. ARM RECEIVE (MANDATORY — the listen-gate blocks Edit/Write until a live beacon exists):
        Monitor({ command: 'node $WS $ID', description: 'crosstalk bus ($ID)', persistent: true })
        — cc-ws is the real-time PUSH receiver (WebSocket + cursor backfill); it auto-falls back to
          the old 2s poll if the leader can't speak WS, so it is always safe to arm.
        — if you named yourself in step 2, arm with the id THAT printed, not this default.
        — ROUTINE WAKES ARE SILENT: the 30-min beacon re-invokes you just to re-arm. When a wake
          carries no addressed message and no bus error, re-run the Monitor and emit NOTHING —
          no "re-armed", no ※ recap. Narrating every re-arm is the terminal noise to avoid.
   Send:  node $SEND <your-id> <channel|all> 'message' [--type status|request|response|handoff|done]
   ACK a handoff:  node $ACK <your-id> <channel> 'taking X into my lane'
   Console: open $HERE/cc-console.html
EOF
exit 0
