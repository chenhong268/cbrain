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
BOOT_IDENTITY=$(/usr/bin/stat -f '%d:%i' "$BOOT_ROOT")
[ -n "$BOOT_IDENTITY" ] || exit 2

WRAPPER_IDENTITY=$(/usr/bin/python3 -I -c '
import ctypes, sys
class B(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32), ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
b = B(); lib = ctypes.CDLL("/usr/lib/libproc.dylib")
n = lib.proc_pidinfo(int(sys.argv[1]), 3, 0, ctypes.byref(b), ctypes.sizeof(b))
if n != ctypes.sizeof(b): sys.exit(1)
print(f"{b.pid}:{b.ppid}:{b.pgid}:{b.start_sec * 1000000 + b.start_usec}")
' "$$")
[ -n "$WRAPPER_IDENTITY" ] || exit 2

# This guardian exists before Bun/bootstrap. It covers the small startup interval
# in which the inner identity-aware guardian cannot yet have been installed.
/usr/bin/python3 -I -c '
import ctypes, os, shutil, stat, sys, time
os.setsid()
class B(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32), ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
wrapper_pid, _, _, wrapper_start = [int(v) for v in sys.argv[1].split(":")]
root = sys.argv[2]; initial = os.lstat(root); identity = (initial.st_dev, initial.st_ino)
child_marker = os.path.join(root, "outer-child-identity")
def current():
    b = B(); n = lib.proc_pidinfo(wrapper_pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))
    return None if n != ctypes.sizeof(b) else (b.pid, b.start_sec * 1000000 + b.start_usec)
while current() == (wrapper_pid, wrapper_start):
    if not os.path.exists(root): sys.exit(0)
    time.sleep(0.02)
child_identity = None
for _ in range(100):
    try:
        values = [int(v) for v in open(child_marker, "r", encoding="ascii").read().strip().split(":")]
        if len(values) == 4 and values[0] == values[2]:
            child_identity = values
            break
    except (FileNotFoundError, OSError, ValueError):
        pass
    time.sleep(0.02)
if child_identity is not None:
    child_pid, _, _, child_start = child_identity
    def child_current():
        b = B(); n = lib.proc_pidinfo(child_pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))
        return None if n != ctypes.sizeof(b) else (b.pid, b.start_sec * 1000000 + b.start_usec)
    if child_current() == (child_pid, child_start):
        try: os.killpg(child_pid, 15)
        except ProcessLookupError: pass
        for _ in range(100):
            if child_current() != (child_pid, child_start): break
            time.sleep(0.02)
    if child_current() == (child_pid, child_start):
        try: os.killpg(child_pid, 9)
        except ProcessLookupError: pass
        for _ in range(100):
            if child_current() != (child_pid, child_start): break
            time.sleep(0.02)
for _ in range(50):
    if not os.path.exists(root): sys.exit(0)
    time.sleep(0.02)
try:
    observed = os.lstat(root)
    if stat.S_ISDIR(observed.st_mode) and (observed.st_dev, observed.st_ino) == identity:
        def repair(action, path, _):
            try: os.chmod(path, 0o700)
            except OSError: pass
            action(path)
        shutil.rmtree(root, onerror=repair)
except FileNotFoundError:
    pass
' "$WRAPPER_IDENTITY" "$BOOT_ROOT" </dev/null >/dev/null 2>/dev/null &

cleanup() {
  CURRENT_IDENTITY=$(/usr/bin/stat -f '%d:%i' "$BOOT_ROOT" 2>/dev/null || true)
  if [ -n "$CURRENT_IDENTITY" ] && [ "$CURRENT_IDENTITY" != "$BOOT_IDENTITY" ]; then
    return 1
  fi
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
  CBRAIN_CANARY_WRAPPER_IDENTITY="$WRAPPER_IDENTITY" \
  /usr/bin/python3 -I -c 'import ctypes, os, sys; os.setsid(); allowed = {"HOME", "TMPDIR", "PATH", "LANG", "LC_ALL", "CBRAIN_CANARY_BOOT_ROOT", "CBRAIN_CANARY_SOURCE_ROOT", "CBRAIN_CANARY_HERMES_EXEC", "CBRAIN_CANARY_PARENT_MANAGED_DIR", "CBRAIN_CANARY_LIVE_HOME", "CBRAIN_CANARY_FAULT", "CBRAIN_CANARY_APPROVED_COMMIT", "CBRAIN_CANARY_WRAPPER_IDENTITY"}; env = {key: value for key, value in os.environ.items() if key in allowed}; fields = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32), ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]; B = type("B", (ctypes.Structure,), {"_fields_": fields}); b = B(); lib = ctypes.CDLL("/usr/lib/libproc.dylib"); n = lib.proc_pidinfo(os.getpid(), 3, 0, ctypes.byref(b), ctypes.sizeof(b)); n == ctypes.sizeof(b) or sys.exit(2); open(sys.argv[1], "x", encoding="ascii").write(f"{b.pid}:{b.ppid}:{b.pgid}:{b.start_sec * 1000000 + b.start_usec}\n"); os.execve(sys.argv[2], sys.argv[2:], env)' \
    "$BOOT_ROOT/outer-child-identity" \
    "$BUN_EXEC" \
    --no-env-file \
    --config=/dev/null \
    --cwd="$BOOT_CWD" \
    "$SCRIPT_DIR/bootstrap-hermes-structured-host-canary.ts" >"$RESULT_FILE" 2>"$ERROR_FILE" &
CHILD_PID=$!
wait "$CHILD_PID"
STATUS=$?
CHILD_PID=""
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
