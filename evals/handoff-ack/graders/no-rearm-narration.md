---
type: regex
pattern: 're-?armed|standing by|※ recap'
flags: i
match: not_contains
target: last_message
---

The final message reports the handoff/ack — it must not narrate monitor re-arms or recaps.
