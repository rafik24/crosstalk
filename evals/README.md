# A4 — model-obedience evals for the crosstalk plugin (issue #42)

Does a model that has the plugin loaded actually OBEY it? These `claude plugin eval` cases put a
haiku session on a real, scratch Crosstalk bus and grade the transcript against the four contracts
`src/cc-join.sh` + `skills/crosstalk/SKILL.md` impose. A red grader here is a finding about the
plugin's instructions (or the model), not a bug in the eval — unless the fixture log says otherwise.

| case | pins | graders |
|---|---|---|
| `join-name-arm` | hook step 1-2-3: load `crosstalk:crosstalk`, `cc-name` BEFORE arming, arm `cc-ws` as a **Monitor** | `Skill` used · Bash `cc-name.mjs` · Monitor `cc-ws.mjs` · tool_order Bash→Monitor |
| `handoff-ack` | a peer's `handoff` »ACK REQUIRED« is answered with `cc-ack.mjs` into the same channel | Bash `cc-ack.mjs` · Monitor `cc-ws.mjs` · last message has no re-arm narration |
| `silent-rearm` | a routine Monitor expiry (no addressed message) ⇒ re-arm, emit NOTHING | Monitor `cc-ws.mjs` ≥2 · last message matches none of `re-arm / standing by / recap / ※` · haiku judge |

## The fixture (`fixtures/`)
`evalbus.mjs` runs `server/server.mjs` **in-process** on a port in 8830–8849, loopback only,
throwaway token, `CC_DISCOVERY=peers`, scratch config/cache/data — it never touches the estate bus
(`:8787`, udp `8788`, `~/.crosstalk`, `~/.claude/.crosstalk`) and **self-terminates** after its TTL
(600 s from the scaffold). Each case's `scaffold.sh` calls `launch.sh <port> [--handoff]`, which kills
the previous case's bus, spawns the new one detached and blocks until `/cc/whoami` answers.
`--handoff` makes the fixture play the peer: once an instance named `…/eval-handoff-lane` registers it
DMs `dm-eval-handoff-lane` a `handoff` (fallback after 75 s: the hook's default id).
`<scratch>/bus.log` records every register + message — the ground truth, independent of the harness.

The two timing cases ask the model to `sleep` once in Bash: a headless run ends when the assistant
stops, so without it the peer's DM / the Monitor expiry would land on a session that is already gone.
That scaffolding is documented in each prompt; graders do not score it.

## Run (≈ $0.10–0.30 per full pass on haiku; hard-capped at $2)
```bash
cd <worktree>
export EVAL_SCRATCH="$TEMP/crosstalk-evals" CC_BUS_CONFIG="$EVAL_SCRATCH/bus-config" \
       CC_CACHE_DIR="$EVAL_SCRATCH/cache" CC_DATA_DIR="$EVAL_SCRATCH/data" CC_DISCOVERY=peers CC_BIND=127.0.0.1
unset CC_TOKEN CC_BASE CC_PORT CC_PEERS          # nothing from an enrolled shell may leak in
claude plugin eval . --model haiku --judge-model haiku --runs 1 --ablation none \
  --allow-tools Bash --scaffold --trust-plugin --no-publish --max-cost-usd 2 \
  --json evals/results/a4-<date>.json --keep-temp
```
The child `claude` sessions inherit that env, so the plugin's SessionStart hook (`cc-join.sh`) finds
the scratch config and joins the eval bus. Afterwards: `netstat -ano -p tcp | grep ":883"` must be
empty (the fixture exits on TTL or on the next case's launch), and remove the run's beacon files from
`~/.claude/.cc-listen/` (`<sid>.id` + `<host>_eval-*-lane`) — the clients write them to the real
home by design, and a hermetic HOME would break the `claude` CLI itself.

`results/` is git-ignored except for score-only summaries; never commit a results JSON that carries
tokens, transcripts or machine paths.

## First run — 2026-09-22 (haiku, 1 run/case)
See `results/a4-first-run-summary.md`.
