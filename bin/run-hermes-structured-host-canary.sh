#!/bin/sh
set -eu

umask 077

BUN_EXEC=""
HERMES_EXEC=""
FAULT=""
APPROVED_COMMIT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bun)
      [ "$#" -ge 2 ] || exit 2
      BUN_EXEC=$2
      shift 2
      ;;
    --hermes)
      [ "$#" -ge 2 ] || exit 2
      HERMES_EXEC=$2
      shift 2
      ;;
    --fault)
      [ "$#" -ge 2 ] || exit 2
      FAULT=$2
      shift 2
      ;;
    --approved-commit)
      [ "$#" -ge 2 ] || exit 2
      APPROVED_COMMIT=$2
      shift 2
      ;;
    *)
      exit 2
      ;;
  esac
done

case "$BUN_EXEC" in /*) ;; *) exit 2 ;; esac
case "$HERMES_EXEC" in /*) ;; *) exit 2 ;; esac
[ -x "$BUN_EXEC" ] || exit 2
[ -x "$HERMES_EXEC" ] || exit 2
[ "${#APPROVED_COMMIT}" -eq 40 ] || exit 2
case "$APPROVED_COMMIT" in *[!0-9a-f]*) exit 2 ;; esac

emit_fatal() {
  /usr/bin/printf '%s\n' '{"schema_version":1,"status":"fatal","code":"CANARY_MANAGED_SCOPE_PRESENT"}'
  exit 2
}

[ ! -e /etc/hermes ] || emit_fatal
if [ -n "${HERMES_MANAGED_DIR-}" ] && [ -e "$HERMES_MANAGED_DIR" ]; then
  emit_fatal
fi

case "$FAULT" in
  ""|matrix|bootstrap|runtime|fingerprint) ;;
  *) exit 2 ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
BOOT_ROOT=$(/usr/bin/mktemp -d /tmp/cbrain-hermes-structured-bootstrap.XXXXXX)
BOOT_HOME=$BOOT_ROOT/home
BOOT_CWD=$BOOT_ROOT/cwd
BOOT_TMP=$BOOT_ROOT/tmp
RESULT_FILE=$BOOT_ROOT/result
ERROR_FILE=$BOOT_ROOT/error
/usr/bin/touch "$RESULT_FILE" "$ERROR_FILE"
/bin/mkdir -m 700 "$BOOT_HOME" "$BOOT_CWD" "$BOOT_TMP"

cleanup() {
  /bin/chmod -R u+w -- "$BOOT_ROOT" 2>/dev/null || true
  /bin/rm -rf -- "$BOOT_ROOT" "$RESULT_FILE" "$ERROR_FILE" 2>/dev/null || true
  [ ! -e "$BOOT_ROOT" ] && [ ! -e "$RESULT_FILE" ] && [ ! -e "$ERROR_FILE" ]
}
CHILD_PID=""
terminate() {
  SIGNAL=$1
  CODE=$2
  trap - INT TERM HUP
  if [ -n "$CHILD_PID" ]; then
    /bin/kill -"$SIGNAL" -"$CHILD_PID" 2>/dev/null || true
    I=0
    while /bin/kill -0 -"$CHILD_PID" 2>/dev/null && [ "$I" -lt 40 ]; do
      /bin/sleep 0.05
      I=$((I + 1))
    done
    /bin/kill -KILL -"$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  cleanup || true
  exit "$CODE"
}
trap 'terminate INT 130' INT
trap 'terminate TERM 143' TERM
trap 'terminate HUP 129' HUP
trap cleanup EXIT

PARENT_MANAGED_DIR=${HERMES_MANAGED_DIR-}
PARENT_HOME=${HOME-}

set +e
/usr/bin/env -i \
  HOME="$BOOT_HOME" \
  TMPDIR="$BOOT_TMP" \
  PATH="/usr/bin:/bin" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  CBRAIN_CANARY_BOOT_ROOT="$BOOT_ROOT" \
  CBRAIN_CANARY_SOURCE_ROOT="$SCRIPT_DIR/.." \
  CBRAIN_CANARY_HERMES_EXEC="$HERMES_EXEC" \
  CBRAIN_CANARY_PARENT_MANAGED_DIR="$PARENT_MANAGED_DIR" \
  CBRAIN_CANARY_LIVE_HOME="$PARENT_HOME" \
  CBRAIN_CANARY_FAULT="$FAULT" \
  CBRAIN_CANARY_APPROVED_COMMIT="$APPROVED_COMMIT" \
  /usr/bin/python3 -I -c 'import os, sys; os.setsid(); allowed = {"HOME", "TMPDIR", "PATH", "LANG", "LC_ALL", "CBRAIN_CANARY_BOOT_ROOT", "CBRAIN_CANARY_SOURCE_ROOT", "CBRAIN_CANARY_HERMES_EXEC", "CBRAIN_CANARY_PARENT_MANAGED_DIR", "CBRAIN_CANARY_LIVE_HOME", "CBRAIN_CANARY_FAULT", "CBRAIN_CANARY_APPROVED_COMMIT"}; env = {key: value for key, value in os.environ.items() if key in allowed}; os.execve(sys.argv[1], sys.argv[1:], env)' \
    "$BUN_EXEC" \
    --no-env-file \
    --config=/dev/null \
    --cwd="$BOOT_CWD" \
    "$SCRIPT_DIR/bootstrap-hermes-structured-host-canary.ts" >"$RESULT_FILE" 2>"$ERROR_FILE" &
CHILD_PID=$!
wait "$CHILD_PID"
STATUS=$?
set -e

RESULT=$(/bin/cat "$RESULT_FILE" 2>/dev/null || true)
if ! cleanup; then
  /usr/bin/printf '%s\n' '{"schema_version":1,"status":"fatal","code":"CANARY_OUTER_CLEANUP_FAILED"}'
  trap - EXIT
  exit 2
fi
trap - EXIT
[ -n "$RESULT" ] || {
  /usr/bin/printf '%s\n' '{"schema_version":1,"status":"fatal","code":"CANARY_OUTPUT_MISSING"}'
  exit 2
}
/usr/bin/printf '%s\n' "$RESULT"
exit "$STATUS"
