# A5 recon — Qwen Code 0.24.3 as the fourth Crosstalk agent class (2026-09-21, Linux QA session)

Source: bundled docs at `~/.local/lib/qwen-code/lib/bundled/qc-helper/docs/` + the minified chunks. Read-only recon;
items marked UNVERIFIED still need an empirical check. The handover's open question ("does Qwen Code have hooks /
plugins for a join hook + listen gate?") is answered: YES, and it has a purpose-built message-injection channel.

## 1. Hooks (docs/features/hooks.md)
- `settings.json` → `hooks: { <Event>: [ { matcher?, sequential?, hooks: [ { type: "command", command, name, timeout, async } ] } ] }`.
  `timeout` is SECONDS (default 60; values >= 1000 are read as ms for compatibility).
- Events are a superset of Claude Code's: SessionStart (matcher = startup|resume|clear|compact), SessionEnd, PreToolUse,
  PostToolUse, UserPromptSubmit, Stop, Notification, PreCompact, plus PostToolUseFailure, PermissionRequest, SubagentStart,
  InstructionsLoaded, MessageDisplay, ...
- stdin JSON carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode` (+ `source`, `model` on
  SessionStart) — the same contract cc-join.sh / codex-join.sh already parse.
- SessionStart stdout as PLAIN TEXT is injected into model context (`PLAIN_TEXT_CONTEXT_EVENTS`), or use
  `hookSpecificOutput.additionalContext`. So the join hook can print the cheat-sheet exactly like codex-join.sh.
- PreToolUse can block: exit 2 (stderr → model) or `hookSpecificOutput.permissionDecision: allow|deny|ask` (+ reason).
  → a LISTEN GATE equivalent to cc-listen-gate is feasible. Matchers accept Claude tool names ("Write|Edit").
- No per-hook trust prompt; user-level hooks load regardless of folder trust. Hooks are read at session start only.
- Hooks are core-level: documented as firing in TUI, headless and ACP. UNVERIFIED: SessionStart under `qwen serve`.

## 2. Injecting a bus message into a RUNNING session — the `Monitor(cc-ws)` / `codex queue` equivalent
Two transports, by session kind:
- **TUI / headless sessions → cross-session IPC** (docs/features/cross-session-protocol.md, commands.md §6). Each session
  publishes `$QWEN_HOME/sessions/<pid>.json` with `sessionId`, `cwd`, `kind`, `ipcPath` (UNIX socket), `ipcToken`;
  list with `qwen sessions ps --json`. Send two NDJSON lines: `{"msgV":1,"type":"auth","token":…}` then
  `{"msgV":1,"msgId":<uuid>,"type":"user","priority":"next","toSessionId":…,"message":{"role":"user","content":…}}`.
  Token classes: the target's `ipcToken` (peer; may be HELD for review), `QWEN_CODE_MESSAGING_TOKEN` (auto-exported to
  the session's own children incl. hooks; no review), and a **controller token** `qpc_<64hex>` minted with
  `qwen sessions controllers add --label <name>` — "a relay daemon … a program the user trusts", delivered without
  per-message review. Receipts come back as `delivery_status` frames (held|delivered|denied|refused|expired|…).
  Limits: per-sender burst 30 then 1 per 2 s; 50-message queue; controllers exempt from duplicate suppression.
  A Node SDK exists: `@qwen-code/sdk/peer` (`PeerEndpoint`).
- **`qwen serve` / ACP sessions → HTTP** (docs/qwen-serve.md; loopback 127.0.0.1:4170, tokenless on loopback unless
  `--require-auth`). `POST /session` → `{sessionId}`; `POST /session/:id/prompt` `{prompt:[{type:"text",text}]}` is a FIFO
  queue (cap 5, 503 `prompt_queue_full`); `GET /session/:id/events` SSE; undocumented `POST /session/:id/mid-turn-message`
  (returns `session_idle` when no turn is running → fall back to /prompt). ACP-driven sessions REFUSE cross-session IPC.
- Not useful: `qwen board` (file ledger, no input), `qwen channel` (Telegram etc.), `--resume -p` (new process).

## 3. Packaging
- `qwen-extension.json` can bundle context file (`contextFileName`, default QWEN.md), commands, skills, MCP servers and
  hooks (inline `hooks` or `hooks/hooks.json`).
- `qwen extensions install <marketplace>:<plugin>` CONVERTS a Claude Code plugin: `${CLAUDE_PLUGIN_ROOT}` is substituted in
  hook commands, skills/agents carried over. UNVERIFIED: whether the crosstalk plugin converts cleanly as-is.
- Context files auto-loaded: `~/.qwen/QWEN.md`, project `QWEN.md`, and `AGENTS.md` (shared with Codex etiquette).

## 4. Proposed lane shape (mirrors the Codex lane; smallest new surface)
1. `src/qwen-join.sh` — SessionStart hook: mint id `host/qwen-<topic>-<shortid>`, persist it for the gate, register,
   `ensure` the bridge, print the cheat-sheet. Reuses cc-codex.mjs-style client for send / ack / peers.
2. `src/cc-qwen-bridge.mjs` — cc-receive.mjs engine with sink = cross-session IPC frame to the session's `ipcPath`
   (controller token), retry on `held/refused`, lifetime tied to the registry record / parent pid. HTTP sink variant for
   `qwen serve`.
3. Listen gate: PreToolUse hook on `Write|Edit` that denies until the bridge beacon is live (same beacon file the
   Claude gate reads).
4. Tests: a fake Qwen IPC endpoint (UNIX socket that records frames) the way codex-bridge.test uses a fake CODEX_BIN.

## 5. Operator decisions needed before anything touches the real `~/.qwen`
- Adding hooks to `~/.qwen/settings.json` and minting a controller token change the operator's Qwen config.
  Prototype runs use a scratch `QWEN_HOME` only.
- vLLM is loopback-only: a Windows-side Qwen lane needs a tunnel or a bind change (operator's call). A Linux-side lane needs neither.

## 6. Empirical checks (scratch QWEN_HOME, real ~/.qwen untouched, vLLM `qwen3.6-35b-a3b-fast`)
- VERIFIED: a user-level SessionStart command hook fires in HEADLESS one-shot mode (`qwen -m … "<prompt>"`). stdin =
  `{"session_id","cwd","hook_event_name":"SessionStart","timestamp","permission_mode","source":"startup","model"}`.
- VERIFIED: the hook's plain stdout reaches the model — a planted code word was returned verbatim by Qwen.
- OBSERVED: in a headless one-shot the hook env has NO `QWEN_CODE_MESSAGING_*` vars and no `sessions/` registry is
  created → the cross-session IPC inbox is a TUI-session feature. For a scripted, human-free lane (what #42 needs) the
  practical carrier is `qwen serve` + `POST /session/:id/prompt`; IPC + controller token is for the operator's live TUI.
- `QWEN_HOME=<dir>` fully relocates config/state → hermetic tests are possible.
- VERIFIED (`qwen serve --port <p> --workspace <dir>`, scratch QWEN_HOME): `POST /session {cwd}` → `{sessionId, clientId}`;
  the SessionStart hook FIRES for that session and its `session_id` equals the serve `sessionId` (so the join hook can
  key the bridge on it). `POST /session/:id/prompt` returns immediately with `{promptId, lastEventId, eventEpoch}`
  (asynchronous); the turn streams on `GET /session/:id/events` as `session_update` / `text` frames and ends with one
  `turn_complete`; `GET /session/:id/status` exposes `hasActivePrompt` / `activeWorkState: idle`. The model saw the
  hook-injected context in the serve session too. → carrier for the scripted Qwen lane is confirmed end to end.

## 7. Live lane results (isolated bus + `qwen serve` + local vLLM, scratch profile; driver = dev/qa/a5-demo-qwen-lane.mjs)
- The real wiring works end to end: `hooks/qwen-hooks.json` → `src/qwen-join.sh` mints `host/qwen-<topic>-<sid8>`, registers,
  backgrounds the bridge; `cc-listen-gate` (now matching Qwen's `write_file|edit`, both carry an absolute `file_path`) exits 2
  BEFORE the bridge beacon and 0 AFTER; a DM is pushed in as a turn and Qwen answers ON THE BUS via its shell tool.
- TOOL GATING under `qwen serve` = approval mode `auto` (an LLM classifier). It DENIED the bus send as "external messaging"
  in one run and allowed it in another → nondeterministic. A lane needs ONE explicit allow rule, nothing broader:
  `permissions.allow: ["Bash(node <plugin-src>/cc-codex.mjs *)"]`. Never `"*"` on a profile that receives bus text.
- The hook runs INSIDE serve's ~10 s session-init deadline; the 3.3.3 one-shot clients linger ~9 s (#44) → slow steps are
  backgrounded in qwen-join.sh. After #44 lands they can move back to the foreground.
- OBEDIENCE mini-eval (same prompt, same cheat-sheet, 1 DM "a + 23? reply with the number and a nonce on this channel"):
  `qwen3.6-35b-a3b` (thinking ON): 5/5 replied on the bus, correct channel, `--type response`, correct sum, ~24–27 s wall
  (≈6 s model turn). `qwen3.6-35b-a3b-fast` (thinking OFF): 4/8 overall — failures: answered in its own session text without
  calling the tool (3×, twice with a WRONG sum), sent an `ACK — taking … into my lane` instead of the answer (1×), and once
  used `--type message`. → the Qwen lane should pin the THINKING model id; the fast id is not reliable enough for bus etiquette.
- Wording matters: the generic Codex cheat-sheet alone was not enough for Qwen; the explicit rule "TO REPLY YOU MUST RUN THE
  Send COMMAND … text you merely write in this session is NOT delivered" is in qwen-join.sh. Both prompts are in git history.

## 8. Hook failure semantics — MEASURED (reviewer B1-e), headless, approval-mode yolo, PreToolUse on run_shell_command, hook timeout 2 s
Task given to the model: "run exactly: touch <marker>". Marker present = the tool call went through.
| hook behaviour                         | tool call |
|----------------------------------------|-----------|
| exit 2 (control)                       | BLOCKED   |
| exit 1                                 | RAN — fail OPEN |
| sleeps past its timeout                | RAN — fail OPEN |
| exit 0 with invalid JSON on stdout     | RAN — fail OPEN |
| hook command does not exist            | blocked in the single run (not conclusive — may be the 127 exit path or the model not attempting) |
CONCLUSION: a Qwen PreToolUse hook is NOT a fail-closed boundary — a crash, an import error, a slow box or garbage output
lets the call through. Hooks are belt-and-braces only; the boundary must be Qwen-native configuration (tool inventory).

## 9. Locking a Qwen lane down by CONFIG (recon of the 0.24.3 bundle + docs; drives the v2 design)
- There is NO "only these tools exist" allowlist. `tools.core: []` is treated as unset; a non-empty `tools.core` only
  governs 21 "core" names — `agent`, `skill`, `exec`, plan-mode, goal, worktree, omni_*, `tool_search`/`tool_call`, MCP bypass it.
- `tools.disabled` is the one deterministic knob: listed tools are NOT REGISTERED (invisible to the model, covers MCP too),
  `mergeStrategy: union` → a project `.qwen/settings.json` or an extension cannot remove entries. `permissions.deny` (whole-tool)
  also unregisters built-ins; precedence `deny > ask > allow`. `permissions.allow` is pure auto-approval, never an allowlist.
  Caveat from the docs: a built-in added by a future release registers until named → the list must be re-audited per release
  → v2 `check` must verify the EFFECTIVE tool inventory of the live session, not just the config text, and fail closed on
  any tool outside `mcp__crosstalk__*`.
- Built-in inventory (0.24.3): run_shell_command, monitor, exec · write_file, edit, notebook_edit · read_file, zoom_image,
  grep_search, glob, list_directory, read_mcp_resource · web_fetch, web_search, image_gen · agent, list_agents, send_message,
  task_stop/create/update/list, team_create/delete/plan_approval, request_shutdown, create_sub_session · skill, save_memory,
  todo_write · enter/exit_plan_mode, ask_user_question · tool_search, tool_call, structured_output · cron_create/list/delete,
  loop_wakeup · enter/exit_worktree, workflow, artifact, record_artifact, record_source, report_findings, display_image ·
  get/update/propose_goal · lsp · 15× omni_* · dynamic computer_use__* (reachable only through tool_search/tool_call).
- MCP tools are named `mcp__<server>__<tool>`, DEFERRED behind tool_search/tool_call unless `alwaysLoadTools: true`;
  pre-approve one server with `permissions.allow: ["mcp__crosstalk"]` (bypasses the AUTO classifier); `includeTools` allowlists
  per server; `mcp.allowed: ["crosstalk"]` gates servers (a project file can ADD mcpServers — shallow merge — so gate them).
- Approval: default mode is `auto` (LLM classifier); `qwen serve` children get no approval flag → `tools.approvalMode` from
  settings, frozen at boot. A PreToolUse hook `permissionDecision: allow` does NOT bypass the classifier or a deny: permission
  flow + classifier run at scheduling, PreToolUse fires later at execution → hooks can only restrict further. (So the shell
  gate's "allow skips the classifier" claim was WRONG.)
- Hooks FAIL OPEN by design (code comment: "Hook transport failures do NOT block tool execution") — matches §8's measurement;
  ENOENT is fail-open too per the code (my single 'blocked' run was the model not attempting).
- Highest-precedence settings file: `/etc/qwen-code/settings.json` (or `QWEN_CODE_SYSTEM_SETTINGS_PATH`) — the natural home of
  a lane lockdown. `--bare` / `--safe-mode` are unusable (they drop MCP servers AND deny rules).

## 10. Evidence status of the claims the v2 lane rests on (reviewer ask, 2026-09-22)
| claim | status | evidence |
|---|---|---|
| Qwen PreToolUse hooks fail OPEN on exit 1 / timeout / invalid JSON; only exit 2 blocks | VERIFIED live | §8 table (headless, yolo, marker file) + Qwen source comment "Hook transport failures do NOT block tool execution" (chunk-LWQKWO5I.js ~59971) |
| a hook `permissionDecision: allow` does NOT skip the approval classifier / a deny | ASSUMED from source order (permission flow + classifier at scheduling, PreToolUse at execution; chunk-LWQKWO5I.js 58597–59985) — not measured live | §9 |
| `QWEN_CODE_SYSTEM_SETTINGS_PATH` is the highest-precedence settings file | VERIFIED live for tools: a daemon started with only that env var and the lockdown file reported `/workspace/tools: []` while the same profile without it listed agent, run_shell_command, … (§9 probe 2026-09-21); documented order: defaults < system-defaults < user < project < system < env < CLI (settings.md:12-24) | launcher test C |
| `tools.disabled` unregisters tools and is union-merged (a project file / extension cannot re-enable) | VERIFIED live that the lockdown layer leaves zero built-ins; union-merge is ASSUMED from the schema (`mergeStrategy: "union"`, chunk-3QXU5BXM.js:2596-2606) — not tested with a hostile project file | — |
| `disableAllHooks: true` in the system layer wins over a user-layer hook | ASSUMED from precedence; positive control PENDING (a v1 `qwen-hooks.json` merged into ~/.qwen must NOT fire for a lane session) | to be measured |
| `GET /workspace/tools` reports the effective built-in inventory | VERIFIED live: default profile → agent, run_shell_command, … ; lockdown → [] (positive control) | launcher |
| MCP tools are NOT in `/workspace/tools`; they hang off `/workspace/mcp` + `/workspace/mcp/<server>/tools` | VERIFIED live (probe 2026-09-21) | launcher reads both |
| `--require-auth` + `QWEN_SERVER_TOKEN` makes every route incl. /health need the bearer | ASSUMED from `qwen serve --help` ("/health also requires Authorization when enabled") — not yet measured live | launcher A-check; to be measured |
| a serve session's approval mode is `tools.approvalMode` from settings, frozen at boot | ASSUMED from source (chunk-KL2BAPK7.js 50037-50053) + qwen-serve.md:955 | — |
