#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
exec bun run --smol "$DIR/src/cli/index.ts" serve "$@"
