#!/bin/bash
# CBrain HTTP serve — managed by launchd
CBRAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_EXEC="$HOME/.bun/bin/bun"
else
  BUN_EXEC="$(command -v bun)"
fi
if [ -z "$BUN_EXEC" ]; then
  exit 127
fi
if [ "$#" -eq 0 ]; then
  export CBRAIN_CONFIG="${CBRAIN_CONFIG:-$CBRAIN_DIR/cbrain.json}"
  set -- serve --http --port 3399
elif [ -z "$CBRAIN_CONFIG" ]; then
  exit 64
fi
exec "$BUN_EXEC" run --smol "$CBRAIN_DIR/src/cli/index.ts" "$@"
