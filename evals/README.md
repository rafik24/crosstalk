# A4 — model-obedience evals for the crosstalk plugin (issue #42)

Does a model that has the plugin loaded actually OBEY it? These `claude plugin eval` cases put a
haiku session on a real, scratch Crosstalk bus and grade the transcript against the four contracts
`src/cc-join.sh` + `skills/crosstalk/SKILL.md` impose. A red grader here is a finding about the
plugin's instructions (or the model), not a bug in the eval — unless the fixture log says otherwise.

| case | pins | graders |
|---|---|---|
| `join-name-arm` | hook step 1-2-3: load `crosstalk:crosstalk`, `cc-name` BEFORE arming, arm `cc-ws` | `Skill` used · Bash `cc-name.mjs` · Bash `cc-ws.mjs` · haiku judge: cc-name precedes cc-ws in the trace |
| `handoff-ack` | a peer's `handoff` »ACK REQUIRED« is answered with `cc-ack.mjs` into the same channel | Bash `cc-ack.mjs` · Bash `cc-ws.mjs` · last message has no re-arm narration |
| `silent-rearm` | a routine Monitor expiry (no addressed message) ⇒ re-arm, emit NOTHING | Bash `cc-ws.mjs` ≥2 · last message matches none of `re-arm / standing by / recap / ※` · haiku judge |

## The fixture (`fixtures/`)
`evalbus.mjs` runs `server/server.mjs` **in-process** on a port in 8830–8849, loopback only,
throwaway token, `CC_DISCOVERY=peers`, scratch data — it never touches the estate bus (`:8787`,
udp `8788`, `~/.crosstalk`, `~/.claude/.crosstalk`) and **self-terminates** after 600 s. Each case's
`scaffold.sh` calls `launch.sh <port> [--handoff]`, which kills the previous case's bus, spawns the
new one detached, and blocks until `/cc/whoami` answers.

How the session finds it: `claude plugin eval` runs the scaffold AND the session under a **private
HOME** (`<tmp>/claude-eval-*/home`) with a scrubbed env, so the fixture writes the bus config to
`$HOME/.claude/.crosstalk` there — exactly where `cc-join.sh` and every `cc-*.mjs` client look — and
the run's beacon/cache files land in that scratch home, never in the operator's `~/.claude`.
No env plumbing from the operator's shell is needed or honoured (`launch.sh` refuses a non-eval HOME).

`--handoff` makes the fixture play the peer: once an instance named `…/eval-handoff-lane` registers
it DMs `dm-eval-handoff-lane` a `handoff`, re-sent every 12 s (max 4) until an ACK lands (the
receiver seeds its cursor on start, so a DM that precedes `cc-ws` is never backfilled). Fallback after
75 s: the hook's default id. `results/bus-<port>.log` records every register + message — the ground
truth, independent of the harness; `results/evalbus.pid` is the one-bus-at-a-time handle.

**Monitor is never available inside an eval run** (the harness says so and withholds it), so the
prompts redirect the arm to Bash: a `run_in_background` cc-ws (join case) or a bounded foreground
`timeout N node cc-ws.mjs <id>` whose printed lines stand in for a Monitor wake (handoff / expiry
cases). That substitution is stated in each prompt and is the one thing these evals cannot pin:
whether the model uses the Monitor TOOL. What they do pin is the ordering, the ack, and the silence.

## Run (haiku; hard-capped at $2)
```bash
cd <worktree>
claude plugin eval . --model haiku --judge-model haiku --runs 1 --ablation none \n  --allow-tools Bash --scaffold --trust-plugin --no-publish --max-cost-usd 2 \n  --json evals/results/a4-<date>.json
```
Free schema check first: `claude plugin eval . --case zzz --trust-plugin --no-publish` loads every
case file and runs nothing. Afterwards `netstat -ano -p tcp | grep ":883"` must be empty (the fixture
exits on TTL or on the next case's launch; `taskkill //PID $(cat evals/results/evalbus.pid) //F`
ends it early) and `--keep-temp` dirs (`%TEMP%\claude-eval-*`) should be removed.

`results/` is git-ignored except `*-summary.md`; never commit a results JSON — it carries transcripts,
machine paths and the run's token.

## First run — 2026-09-22 (haiku, 1 run/case)
See `results/a4-first-run-summary.md`.
