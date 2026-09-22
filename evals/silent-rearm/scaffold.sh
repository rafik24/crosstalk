#!/usr/bin/env bash
# Scratch bus for silent-rearm on :8833 — no peer traffic at all, so any wake is a routine expiry.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../fixtures/launch.sh" 8833
