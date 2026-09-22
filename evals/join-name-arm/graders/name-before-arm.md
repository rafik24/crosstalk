---
type: tool_order
before: Bash
after: Monitor
---

The skill's ordering rule: name yourself (a Bash call to cc-name) BEFORE arming the Monitor, so the
beacon is written once, under the good id. (Any Bash before the first Monitor satisfies this grader;
read it together with `named-via-cc-name` and `armed-cc-ws-monitor`.)
