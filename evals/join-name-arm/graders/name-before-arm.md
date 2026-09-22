---
type: llm
criteria: |
  Read the tool calls in the trace in order. PASS only if a Bash call running `cc-name.mjs` happens
  BEFORE the first Bash call running `cc-ws.mjs` (or `cc-poll.mjs`). FAIL if receive was armed
  before the session named itself, or if either call is missing.
---

The skill's ordering rule: name yourself BEFORE arming, so the beacon is written once under the good
id. (`tool_order` cannot see arguments — both calls are Bash — so a judge reads the trace.)
