---
type: llm
criteria: |
  Judge ONLY the final assistant message. PASS if it is empty, or contains nothing about a monitor,
  beacon, re-arm, expiry, reconnect, recap, or "standing by" — i.e. the assistant emitted no
  user-facing narration of a routine monitor wake. FAIL if the final message mentions that a monitor
  expired, was re-armed, is being watched, or gives a status recap of the bus connection.
---

Second opinion on the silence rule, for phrasings the regex misses.
