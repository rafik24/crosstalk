#!/usr/bin/env bash
# selftest: plant a KNOWN truth file in the workspace (cwd)
printf '%s' 'EVALBUS-UP 8833
REGISTER box/eval-silent-lane
WS+ box/eval-silent-lane
WS- box/eval-silent-lane
WS+ box/eval-silent-lane
' > crosstalk-bus-truth.log
