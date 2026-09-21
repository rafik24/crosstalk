#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# qwen-join.sh — Qwen Code SessionStart hook: auto-join the live Crosstalk bus. PROTOTYPE (QA #42, A5).
#
# The Qwen flavour of codex-join.sh. Qwen Code >=0.24 hooks speak the same protocol as Claude Code
# hooks (same events, same stdin JSON with `session_id`; verified live 2026-09-21), so this does the
# same three things:
#   (1) mint a UNIQUE identity for this session — `host/qwen-<topic>-<shortid>` — and persist it
#       where the listen-gate reads it (~/.claude/.cc-listen/<sid>.id);
#   (2) register presence on the bus (honest HTTP-code reporting, fail-soft);
#   (3) start (idempotently, DETACHED) the cc-qwen-bridge for this session — it pushes every message
#       addressed to this session into it as a new turn via `qwen serve`'s POST /session/<sid>/prompt.
#
# TWO Qwen-specific constraints (both measured):
#   - `qwen serve` aborts session init after ~10 s ("Session initialization deadline exceeded"), and
#     the hook runs INSIDE that window — so the slow steps (the fallback client's cursor snapshot and
#     the bridge `ensure`) run in the BACKGROUND, fully detached from the hook's stdio. Only
#     discovery + one curl register stay in the foreground.
#   - the bridge sink is the `qwen serve` HTTP daemon (QWEN_SERVE_URL, default http://127.0.0.1:4170).
#     A plain TUI/one-shot session has no serve session to push into: the bridge then exits by itself
#     after two `session_not_found` answers, and the session falls back to `wait` (said in the text).
#
# OPT-IN PER MACHINE: no-ops unless the bus config exists. Advisory, fail-open, exit 0.
# Wire it in ~/.qwen/settings.json (see hooks/qwen-hooks.json). User-level Qwen hooks need no trust
# prompt, but are only read at session start.
# ---------------------------------------------------------------------------
set -u
CFG="${CC_BUS_CONFIG:-}"
if [ -z "$CFG" ]; then
  if [ -f "$HOME/.claude/.crosstalk" ]; then CFG="$HOME/.claude/.crosstalk"
  elif [ -f "$HOME/.claude/.cross-claude-bus" ]; then CFG="$HOME/.claude/.cross-claude-bus"
  else CFG="$HOME/.claude/.crosstalk"; fi
fi
[ -f "$CFG" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$HERE/cc-codex.mjs"
BRIDGE="$HERE/cc-qwen-bridge.mjs"
DISCOVER="$HERE/cc-discover.mjs"
[ -f "$CLIENT" ] && [ -f "$BRIDGE" ] || exit 0

PAYLOAD="$(cat 2>/dev/null || true)"
SID="$(printf '%s' "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).session_id||""))}catch{}})' 2>/dev/null || true)"
# session ids are UUIDs; sanitise anyway before the value becomes a file name under ~/.claude/.cc-listen
SID="$(printf '%s' "$SID" | tr -c 'A-Za-z0-9._-' '_')"
if command -v cygpath >/dev/null 2>&1; then
  HERE="$(cygpath -m "$HERE")"; CLIENT="$(cygpath -m "$CLIENT")"; BRIDGE="$(cygpath -m "$BRIDGE")"; DISCOVER="$(cygpath -m "$DISCOVER")"
fi

# shellcheck disable=SC1090
. "$CFG"

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
# NO early exit when discovery finds no leader: the identity file is still written and the bridge
# is still started — the bridge re-discovers on its own and joins the moment a leader appears
# (a hook that exited here left the session permanently deaf; codex review, 2026-09-17).
NO_LEADER=""
[ -z "${CC_BASE:-}" ] && NO_LEADER=1

machine=$(hostname 2>/dev/null | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-'); machine="${machine%-}"
[ -n "$machine" ] || machine="unknown"
branch=$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
topic="${branch##*/}"
{ [ -z "$topic" ] || [ "$topic" = "HEAD" ]; } && topic="$(basename "$PWD")"
topic=$(printf '%s' "$topic" | tr 'A-Z' 'a-z' | sed 's/[[:space:]_]\{1,\}/-/g; s/[^a-z0-9-]//g; s/-\{1,\}/-/g; s/^-//; s/-$//')
[ -n "$topic" ] || topic="misc"
short="$(printf '%s' "$SID" | cut -c1-8)"
# `qwen-` prefix so the operator console tells the agent classes apart at a glance.
if [ -n "$short" ]; then ID="$machine/qwen-$topic-$short"; else ID="$machine/qwen-$topic"; fi

LISTEN_DIR="$HOME/.claude/.cc-listen"
mkdir -p "$LISTEN_DIR" 2>/dev/null || true
[ -n "$SID" ] && printf '%s' "$ID" > "$LISTEN_DIR/$SID.id" 2>/dev/null || true

ver="$(node -e 'try{process.stdout.write(String(require(process.argv[1]+"/../package.json").version||""))}catch{}' "$HERE" 2>/dev/null || true)"
http_code=""
if [ -z "$NO_LEADER" ]; then
  http_code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$CC_BASE/api/register" \
    -H "Authorization: Bearer ${CC_TOKEN:-}" -H 'content-type: application/json' -H "x-cc-version: ${ver:-}" \
    -d "{\"instance_id\":\"$ID\",\"description\":\"qwen: $topic @ $machine\",\"rev\":\"\",\"version\":\"$ver\"}" 2>/dev/null || true)"
fi
case "$http_code" in
  "")      [ -n "$NO_LEADER" ] && JOIN_LINE="⛔ LIVE CHAT BUS — no leader found yet (discovery silent, no CC_BASE pin). Joining as: $ID — the bridge below keeps discovering and connects when a host is up." || JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT to $CC_BASE. Would join as: $ID" ;;
  2??)     JOIN_LINE="✅ LIVE CHAT BUS — CONNECTED, registered as: $ID   ($CC_BASE)" ;;
  000)     JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT to $CC_BASE (server unreachable). Would join as: $ID" ;;
  401|403) JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT: $CC_BASE rejected the token (HTTP $http_code — check CC_TOKEN in $CFG). Would join as: $ID" ;;
  426)     JOIN_LINE="⛔ LIVE CHAT BUS — VERSION GATE: this host (${ver:-unknown}) is not on the bus's version. Update the crosstalk plugin on this host. Would join as: $ID" ;;
  *)       JOIN_LINE="⚠️ LIVE CHAT BUS — bus at $CC_BASE answered HTTP $http_code (not a clean register). Would join as: $ID" ;;
esac

# The receive side + the fallback client's cursor snapshot — BACKGROUNDED and detached from this
# hook's stdio (see the header: qwen serve's ~10 s session-init deadline; the 3.3.3 one-shot clients
# linger ~9 s after finishing). Order matters: snapshot first, then the bridge.
BRIDGE_LINE="not started (no session id in the hook payload)"
if [ -n "$SID" ]; then
  ( [ -z "$NO_LEADER" ] && CC_DESC="qwen: $topic @ $machine" node "$CLIENT" join "$ID" "qwen: $topic @ $machine"
    CC_DESC="qwen: $topic @ $machine" node "$BRIDGE" ensure "$ID" --session "$SID" ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  BRIDGE_LINE="cc-qwen-bridge starting in the background → ${QWEN_SERVE_URL:-http://127.0.0.1:4170} (log ~/.claude/.cc-listen/$SID.bridge.log). It needs this session to be a \`qwen serve\` session; in a plain TUI/one-shot session it exits by itself — use the Fallback receive below."
fi

TEXT="$(cat <<EOF
$JOIN_LINE
   🔁 RECEIVE: $BRIDGE_LINE
      Every message addressed to you (DM channel dm-${ID##*/}, an @${ID##*/} mention, or @all) is pushed
      INTO this session as a new turn, prefixed CHAT #<channel> <sender> [<type>]. »HANDOFF — ACK REQUIRED« means ack it.
   ⚠️ TO REPLY YOU MUST RUN THE Send COMMAND BELOW WITH YOUR SHELL TOOL. Text you merely write in this session is NOT
      delivered — the sender never sees it. Reply on the SAME channel the message came in on (the word after "CHAT #"),
      with --type response for an answer. One command per reply; never paste tokens.
   Send:  node $CLIENT send $ID <channel|all> 'message' [--type status|request|response|handoff|done]
   ACK:   node $CLIENT ack  $ID <channel> 'taking X into my lane'
   Peers: node $CLIENT peers      Fallback receive (no bridge): node $CLIENT wait $ID --timeout 90
   Etiquette (reply only if addressed; DM or @mention to reach a session; \`done\` when work lands): see AGENTS.md / QWEN.md / the crosstalk skill.
EOF
)"
# JSON additionalContext (the same shape Claude Code and Codex accept; Qwen also injects plain stdout
# on SessionStart, but the structured form is the documented contract). Built with node so every
# quote/newline is escaped correctly.
printf '%s' "$TEXT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s}})))'
exit 0
