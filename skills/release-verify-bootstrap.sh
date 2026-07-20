#!/bin/sh
# skills/release-verify-bootstrap.sh
# Checkout-independent read-only launcher for the CBrain live-release verifier.
#
# Resolves the active deployment root from the loaded launchd service evidence
# (ai.cbrain.serve), then spawns the active-root verifier by absolute path.
# Does NOT rely on caller cwd or a global `cbrain` binary: even when the shell
# cwd is a stale checkout and PATH has no `cbrain`, the active-root verifier is
# the code that runs. Read-only — reads launchctl only; performs no writes,
# restarts, rollbacks, or installs.
#
# Usage:  sh skills/release-verify-bootstrap.sh [--json]
set -u

LABEL="ai.cbrain.serve"

PRINT="$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null)" || PRINT=""
if [ -z "$PRINT" ]; then
  printf '%s\n' '{"schema_version":1,"status":"fail","code":"SERVICE_EVIDENCE_INVALID","layer":"service"}'
  exit 1
fi

ACTIVE_ROOT="$(printf '%s\n' "$PRINT" | awk -F' = ' '$1 ~ /working directory$/ {print $2; exit}')"
BUN="$(printf '%s\n' "$PRINT" | awk -F' = ' '$1 ~ /program$/ {print $2; exit}')"

if [ -z "$ACTIVE_ROOT" ] || [ ! -d "$ACTIVE_ROOT" ]; then
  printf '%s\n' '{"schema_version":1,"status":"fail","code":"SERVICE_EVIDENCE_INVALID","layer":"service"}'
  exit 1
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  printf '%s\n' '{"schema_version":1,"status":"fail","code":"SERVICE_EVIDENCE_INVALID","layer":"service"}'
  exit 1
fi

VERIFIER="${ACTIVE_ROOT}/bin/live-release-verify.ts"
if [ ! -f "$VERIFIER" ]; then
  printf '%s\n' '{"schema_version":1,"status":"fail","code":"VERIFIER_ROOT_MISMATCH","layer":"verifier"}'
  exit 1
fi

exec "$BUN" "$VERIFIER" "$@"
