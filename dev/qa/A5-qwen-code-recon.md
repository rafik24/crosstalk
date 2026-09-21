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
