---
type: regex
pattern: '^WS\+ \S+/eval-handoff-lane$'
flags: m
match: contains
target: { source: file, path: crosstalk-bus-truth.log }
---

Receive was really armed under the named id — without it the handoff can never reach the session.
