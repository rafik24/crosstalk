---
type: regex
pattern: '^WS\+ (\S+/eval-silent-lane)$[\s\S]*^WS\+ \1$'
flags: m
match: contains
target: { source: file, path: crosstalk-bus-truth.log }
---

On a routine expiry the session re-arms the SAME receiver: the server saw at least two cc-ws
connections for the named id (arm + re-arm).
