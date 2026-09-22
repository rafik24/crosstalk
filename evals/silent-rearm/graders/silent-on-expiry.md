---
type: regex
pattern: 're-?arm|standing by|recap|※|routine|reconnect|expired|monitor'
flags: i
match: not_contains
target: last_message
---

The skill's rule: a routine wake (no »TO YOU« / »HANDOFF«, no bus error) produces ZERO user-facing
text — no "re-armed", no "standing by", no recap, no status table. The last message must not narrate it.
