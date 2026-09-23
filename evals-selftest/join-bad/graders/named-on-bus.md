---
type: regex
pattern: '^REGISTER \S+/eval-join-lane$'
flags: m
match: contains
target: { source: file, path: crosstalk-bus-truth.log }
---

Step 2, EXECUTED: the bus saw an instance registered under the named id (`cc-name` ran and
reached the server) — not merely a Bash call containing `cc-name.mjs`.
