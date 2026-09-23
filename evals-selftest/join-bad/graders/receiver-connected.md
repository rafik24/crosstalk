---
type: regex
pattern: '^WS\+ \S+/eval-join-lane$'
flags: m
match: contains
target: { source: file, path: crosstalk-bus-truth.log }
---

Step 3, EXECUTED: the server logged a live cc-ws WebSocket for the named id (`[ws] + <id>`).
