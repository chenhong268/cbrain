#!/bin/sh
set -eu
umask 077

BUN_EXEC=""
HERMES_EXEC=""
FAULT=""
APPROVED_COMMIT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bun) [ "$#" -ge 2 ] || exit 2; BUN_EXEC=$2; shift 2 ;;
    --hermes) [ "$#" -ge 2 ] || exit 2; HERMES_EXEC=$2; shift 2 ;;
    --fault) [ "$#" -ge 2 ] || exit 2; FAULT=$2; shift 2 ;;
    --approved-commit) [ "$#" -ge 2 ] || exit 2; APPROVED_COMMIT=$2; shift 2 ;;
    *) exit 2 ;;
  esac
done
case "$BUN_EXEC" in /*) ;; *) exit 2 ;; esac
case "$HERMES_EXEC" in /*) ;; *) exit 2 ;; esac
[ -x "$BUN_EXEC" ] && [ -x "$HERMES_EXEC" ] || exit 2
[ "${#APPROVED_COMMIT}" -eq 40 ] || exit 2
case "$APPROVED_COMMIT" in *[!0-9a-f]*) exit 2 ;; esac
case "$FAULT" in ""|matrix|bootstrap|runtime|fingerprint) ;; *) exit 2 ;; esac

emit_managed_fatal() {
  /usr/bin/printf '%s\n' '{"schema_version":1,"status":"fatal","code":"CANARY_MANAGED_SCOPE_PRESENT"}'
  exit 2
}
[ ! -e /etc/hermes ] || emit_managed_fatal
if [ -n "${HERMES_MANAGED_DIR-}" ] && [ -e "$HERMES_MANAGED_DIR" ]; then emit_managed_fatal; fi

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
SUPERVISOR_PID=""
forward() {
  SIGNAL=$1
  CODE=$2
  trap - INT TERM HUP
  if [ -n "$SUPERVISOR_PID" ]; then
    /bin/kill -"$SIGNAL" "$SUPERVISOR_PID" 2>/dev/null || true
    wait "$SUPERVISOR_PID" 2>/dev/null || true
    SUPERVISOR_PID=""
  fi
  exit "$CODE"
}
trap 'forward INT 130' INT
trap 'forward TERM 143' TERM
trap 'forward HUP 129' HUP

/usr/bin/python3 -I "$SCRIPT_DIR/hermes-structured-host-supervisor.py" \
  "$$" "$BUN_EXEC" "$HERMES_EXEC" "$SCRIPT_DIR/.." "$APPROVED_COMMIT" "$FAULT" &
SUPERVISOR_PID=$!
set +e
wait "$SUPERVISOR_PID"
STATUS=$?
SUPERVISOR_PID=""
set -e
exit "$STATUS"
