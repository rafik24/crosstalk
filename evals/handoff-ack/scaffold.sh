#!/usr/bin/env bash
# Scratch bus for handoff-ack on :8832. --handoff: the fixture plays the peer and DMs a `handoff`
# to dm-eval-handoff-lane once that lane registers (fallback: the hook's default id after 75 s).
exec bash "$(dirname "${BASH_SOURCE[0]}")/../fixtures/launch.sh" 8832 --handoff
