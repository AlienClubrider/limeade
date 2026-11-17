#!/bin/sh
# Stands in for the claude CLI and answers with what it was started with; see settings-claude.mjs.
exec "$FAKE_NODE" "$(dirname "$0")/settings-claude.mjs" "$@"
