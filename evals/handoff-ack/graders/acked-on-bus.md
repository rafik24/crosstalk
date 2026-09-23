---
type: regex
pattern: '^MSG dm-\S+ response (?!evalbus/)\S+: ACK'
flags: m
match: contains
target: { source: file, path: crosstalk-bus-truth.log }
---

The ack contract, EXECUTED: a `response` whose body starts `ACK` landed on the bus in the handoff's
DM channel from the lane (what `cc-ack.mjs` sends) — not merely a Bash call containing `cc-ack.mjs`.
