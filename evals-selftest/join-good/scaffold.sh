#!/usr/bin/env bash
# selftest: plant a KNOWN truth file in the workspace (cwd)
printf '%s' 'EVALBUS-UP 8831
REGISTER box/cwd-ab12
REGISTER box/eval-join-lane
WS+ box/eval-join-lane
' > crosstalk-bus-truth.log
