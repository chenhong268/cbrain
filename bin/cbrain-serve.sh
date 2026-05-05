#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/dist/cbrain" serve "$@"
