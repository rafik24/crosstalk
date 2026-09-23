#!/usr/bin/env bash
# selftest: plant a KNOWN truth file in the workspace (cwd)
printf '%s' 'EVALBUS-UP 8832
REGISTER box/eval-handoff-lane
MSG dm-eval-handoff-lane handoff evalbus/po: ACK required — HANDOFF
MSG dm-eval-handoff-lane message box/eval-handoff-lane: got it
' > crosstalk-bus-truth.log
