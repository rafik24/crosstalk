# A4 model-obedience eval — run 2 WITH TRACES (Linux lane, 2026-09-23)

Command: `claude plugin eval . --model haiku --judge-model haiku --runs 3 --ablation none --allow-tools Bash
--scaffold --trust-plugin --no-publish --max-cost-usd 2 --keep-temp --verbose --json a4-r2.json`
(`--debug-file` from the request is NOT a valid flag in claude 2.1.280 — dropped; `--verbose` + `--keep-temp`
preserved the traces.) silent-rearm `max_turns` raised 8→12 first (noted per request). 9 runs, cost $0.57.
Traces copied to `evals/results/traces/<case>/run<N>/trace.jsonl` (+ scaffold-listing.txt) before cleanup;
tracePath was populated for all 9. Prod bus untouched (leader desktop-7odo6ou@109 unchanged); ports clear after.

## HEADLINE: the results are INVALID — the eval's agent Bash sandbox cannot start on this box
Every one of the 9 runs, every case, the agent's FIRST real Bash call fails at shell init and never recovers.
Verbatim tool_result (identical across runs):
```
Exit code 1
/bin/bash: /tmp/claude-eval-XXXX/home/.bashrc: Permission denied
/bin/bash: /tmp/claude-eval-XXXX/home/.bashrc: Permission denied
apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied
```
So the model never actually runs cc-name / cc-ws / cc-ack against the bus — it only ATTEMPTS them. The
`tool_used` graders score an ATTEMPT (they match the command string, not its exit status), which is why the
scores look like partial obedience. They are noise. Ground truth = the bus logs: in all 9 runs the ONLY id
that ever registered is the join hook's default `cwd-*`; NO named id (`eval-…-lane`), NO cc-ws receiver, NO
cc-ack ever reached the bus. Nothing the agent "did" executed.

## What the traces actually show the model doing (reasonable, not disobedient)
Per run the pattern is identical: (1) `Skill crosstalk:crosstalk` loads OK; (2) it runs `cc-name … "eval … lane"`
— correct id, correct title, BEFORE arming (so the intent is right); (3) that Bash call dies with the seccomp
error above; (4) it RETRIES several shell work-arounds — `sh -c`, `env -i`, `bash --noprofile --norc`,
`/usr/bin/node`, `exec`, `which node`, `HOME=/tmp …`; (5) some runs then issue `cc-ws … <id>` (also dies);
(6) it ends with a final message correctly diagnosing a sandbox/bash failure. No run narrates "re-armed"; the
`judge-silence`/`no-rearm-narration` graders that pass do so because the final message is a sandbox report.

| case | run | score | graders (P/F) | note |
|---|---|---|---|---|
| handoff-ack | 1 | 0.33 | ack F, armed-cc-ws F, no-rearm P | 7 bash attempts, all seccomp-killed |
| handoff-ack | 2 | 0.67 | ack F, armed-cc-ws **P**, no-rearm P | "P" = a cc-ws.mjs string was issued; it still failed |
| handoff-ack | 3 | 0.67 | ack F, armed-cc-ws **P**, no-rearm P | same |
| join-name-arm | 1 | 0.50 | skill P, cc-name P, armed-cc-ws F, name-before-arm F | |
| join-name-arm | 2 | 0.50 | skill P, cc-name P, armed-cc-ws F, name-before-arm F | |
| join-name-arm | 3 | 0.75 | skill P, cc-name P, armed-cc-ws **P**, name-before-arm F | turns=1 record; cc-ws string issued, failed |
| silent-rearm | 1 | 0.33 | silent-on-expiry P, rearmed F, judge-silence F | (n=1 morning run "passed 1.0" — same artifact, different dice) |
| silent-rearm | 2 | 0.33 | silent-on-expiry P, rearmed F, judge-silence F | |
| silent-rearm | 3 | 0.33 | silent-on-expiry P, rearmed F, judge-silence F | |

The run-to-run and run-1-vs-run-2 variance (armed-cc-ws F then P; silent-rearm 1.0 this morning vs 0.33 now) is
NOT model variance — it is which retry happened to emit a matching command string before bash died.

## Root cause (diagnosed, not assumed)
Nested user-namespace / seccomp restriction on the eval's per-agent Bash sandbox. Diagnostics on this box:
- my own shell: `/proc/self/ns/user` = the INIT userns (4026531837) — i.e. NOT itself in a userns sandbox;
- `kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=440736`, `apparmor_restrict_unprivileged_userns=0` — all permissive;
- `bwrap --unshare-user … /bin/true` at my level: **OK**.
So the host allows unprivileged + one level of nested userns. The failure is one level DEEPER: `claude plugin eval`
spawns a child `claude` per run, whose Bash tool opens ITS OWN sandbox — nested inside this agent session's
context — and at that depth `apply-seccomp`/`setgroups` needs CAP_SYS_ADMIN it no longer has. This is the same
class of blocker Windows hit (sandbox gate off), surfaced differently on Linux.

## Recommendation
- Do NOT read obedience into run-1's numbers — A4 is currently UNMEASURED on this box.
- Try running `claude plugin eval …` from the operator's OWN terminal (one sandbox level, not nested inside an
  agent's Bash) — most likely to work. If claude exposes a way to run the eval agent WITHOUT its child Bash
  sandbox (or with CAP_SYS_ADMIN granted to it), that also unblocks it. This is a claude-harness question for
  Windows/PO, not a plugin bug.
- Fixture + graders are sound (bus came up, prod untouched). Once the agent Bash runs, re-run --runs 5.
- Grader hardening worth filing: the `tool_used` graders should require the tool call to have SUCCEEDED
  (exit 0), else a sandbox-killed attempt scores as obedience — which is exactly what masked this failure at n=1.
