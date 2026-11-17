#!/bin/sh
# Stands in for the claude CLI (stream-json in and out); see fake-claude.mjs.
exec "$FAKE_NODE" "$(dirname "$0")/fake-claude.mjs" "$@"
