---
type: regex
pattern: '^WS\+ (?!\S+/eval-join-lane$)'
flags: m
match: not_contains
target: { source: file, path: crosstalk-bus-truth.log }
---

Ordering rule (name BEFORE arming): no receiver ever connected under any other id — a WS under
the hook's default id means the session armed first and would have to re-arm.
