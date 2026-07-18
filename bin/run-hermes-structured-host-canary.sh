#!/bin/sh
set -eu

umask 077

BUN_EXEC=""
HERMES_EXEC=""
FAULT=""

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
    *)
      exit 2
      ;;
  esac
done

case "$BUN_EXEC" in /*) ;; *) exit 2 ;; esac
case "$HERMES_EXEC" in /*) ;; *) exit 2 ;; esac
[ -x "$BUN_EXEC" ] || exit 2
[ -x "$HERMES_EXEC" ] || exit 2

case "$FAULT" in
  ""|matrix|bootstrap|runtime|fingerprint) ;;
  *) exit 2 ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
BOOT_ROOT=$(/usr/bin/mktemp -d /tmp/cbrain-hermes-structured-bootstrap.XXXXXX)
BOOT_HOME=$BOOT_ROOT/home
BOOT_CWD=$BOOT_ROOT/cwd
BOOT_TMP=$BOOT_ROOT/tmp
/bin/mkdir -m 700 "$BOOT_HOME" "$BOOT_CWD" "$BOOT_TMP"

cleanup() {
  /bin/rm -rf -- "$BOOT_ROOT"
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP
trap cleanup EXIT

PARENT_MANAGED_DIR=${HERMES_MANAGED_DIR-}

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
  CBRAIN_CANARY_FAULT="$FAULT" \
  "$BUN_EXEC" \
    --no-env-file \
    --config=/dev/null \
    --cwd="$BOOT_CWD" \
    "$SCRIPT_DIR/bootstrap-hermes-structured-host-canary.ts"
STATUS=$?
set -e

exit "$STATUS"
