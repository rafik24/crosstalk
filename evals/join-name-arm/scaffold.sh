#!/usr/bin/env bash
# Scratch bus for join-name-arm on :8831 (no peer traffic). See evals/README.md.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../fixtures/launch.sh" 8831
