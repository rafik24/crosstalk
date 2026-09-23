#!/usr/bin/env bash
# selftest: plant a KNOWN truth file in the workspace (cwd)
printf '%s' 'EVALBUS-UP 8832
REGISTER box/eval-handoff-lane
WS+ box/eval-handoff-lane
MSG dm-eval-handoff-lane handoff evalbus/po: @box/eval-handoff-lane HANDOFF — ack this
MSG dm-eval-handoff-lane response box/eval-handoff-lane: ACK — taking it
' > crosstalk-bus-truth.log
