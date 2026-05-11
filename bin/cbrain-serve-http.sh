#!/bin/bash
# CBrain HTTP serve — managed by launchd
CBRAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export CBRAIN_CONFIG="$CBRAIN_DIR/cbrain.json"
export PATH="/Users/chenhong/.bun/bin:$PATH"
exec bun run "$CBRAIN_DIR/src/cli/index.ts" serve --http --port 3399
