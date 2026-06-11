#!/usr/bin/env bash
# check-install-smoke.sh — Isolated, version-pinned Bun global install smoke test
#
# Usage:
#   ./bin/check-install-smoke.sh <tag-or-ref> --expected-version <version>
#   INSTALL_REF=v1.9.4 EXPECTED_VERSION=1.9.4 ./bin/check-install-smoke.sh
#
# This script creates an isolated temporary environment and installs CBrain
# from a pinned GitHub ref via `bun install -g`. It does NOT touch your real
# HOME, Bun install, or CBrain data.
#
# For offline/fixture testing:
#   ./bin/check-install-smoke.sh --local /path/to/fake-root --expected-version 1.9.4
#
# Exit codes: 0 = pass, 1 = fail, 2 = usage error

set -euo pipefail

# ─── Argument parsing ─────────────────────────────────────────────────────

INSTALL_REF="${INSTALL_REF:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"

show_help() {
  cat <<'EOF'
Usage: check-install-smoke.sh [OPTIONS] [tag-or-ref]

Options:
  --expected-version VERSION   Assert cbrain --version equals VERSION exactly
  --local PATH                 Use a local directory as a fake install root
                               (for offline fixture testing; does NOT run bun install)
  -h, --help                   Show this help

Environment variables:
  INSTALL_REF        Tag or ref to install (required unless --local)
  EXPECTED_VERSION   Assert cbrain --version output matches exactly

Examples:
  # Real tagged network install:
  ./bin/check-install-smoke.sh v1.9.4 --expected-version 1.9.4

  # Via environment variables:
  INSTALL_REF=v1.9.4 EXPECTED_VERSION=1.9.4 ./bin/check-install-smoke.sh

  # Offline fixture mode (no network):
  ./bin/check-install-smoke.sh --local /path/to/fake-root --expected-version 1.9.4

This script requires network access to GitHub for tagged installs.
It is NOT part of the default test suite (bun run check).
EOF
}

LOCAL_PATH=""
REF_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-version)
      if [[ -z "${2:-}" ]]; then
        echo "FAIL: --expected-version requires a value" >&2
        exit 2
      fi
      EXPECTED_VERSION="$2"
      shift 2
      ;;
    --local)
      if [[ -z "${2:-}" ]]; then
        echo "FAIL: --local requires a path" >&2
        exit 2
      fi
      LOCAL_PATH="$2"
      shift 2
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    -*)
      echo "FAIL: unknown option: $1" >&2
      show_help >&2
      exit 2
      ;;
    *)
      REF_ARG="$1"
      shift
      ;;
  esac
done

# ─── Resolve install spec ─────────────────────────────────────────────────

if [[ -n "${LOCAL_PATH}" ]]; then
  INSTALL_REF="(local: ${LOCAL_PATH})"
  INSTALL_SPEC="${LOCAL_PATH}"
  MODE="local"
elif [[ -n "${REF_ARG}" ]]; then
  INSTALL_REF="${REF_ARG}"
  INSTALL_SPEC="github:chenhong268/cbrain#${INSTALL_REF}"
  MODE="network"
elif [[ -n "${INSTALL_REF}" ]]; then
  INSTALL_SPEC="github:chenhong268/cbrain#${INSTALL_REF}"
  MODE="network"
else
  echo "FAIL: no install ref provided. Pass a tag or set INSTALL_REF." >&2
  show_help >&2
  exit 2
fi

# ─── Validate ref is pinned (not floating) ─────────────────────────────────

if [[ "${MODE}" == "network" ]]; then
  # Accept: version tags (vX.Y.Z with optional pre-release) or full commit SHAs (40 hex chars)
  if ! [[ "${INSTALL_REF}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ || "${INSTALL_REF}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "FAIL: refusing non-immutable ref '${INSTALL_REF}'. Use a version tag (v1.9.4) or full commit SHA." >&2
    exit 2
  fi
fi

# ─── Isolated environment setup ───────────────────────────────────────────

TMPDIR_ROOT=""
cleanup() {
  local ec=$?
  if [[ -n "${TMPDIR_ROOT}" && -d "${TMPDIR_ROOT}" ]]; then
    rm -rf "${TMPDIR_ROOT}"
  fi
  exit $ec
}
trap cleanup EXIT

TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cbrain-smoke-XXXXXX")"
echo "  tmpdir: ${TMPDIR_ROOT}"
export HOME="${TMPDIR_ROOT}/home"
export BUN_INSTALL="${TMPDIR_ROOT}/bun"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_DATA_HOME="${HOME}/.local/share"
export XDG_CACHE_HOME="${HOME}/.cache"

# Isolated CBrain configuration — real cbrain.json with all paths under tmpdir
cat > "${TMPDIR_ROOT}/cbrain.json" <<CBEOF
{
  "vaultPath": "${TMPDIR_ROOT}/vault",
  "dbPath": "${TMPDIR_ROOT}/brain.sqlite",
  "lancePath": "${TMPDIR_ROOT}/lancedb",
  "runtimePath": "${TMPDIR_ROOT}/runtime"
}
CBEOF
export CBRAIN_CONFIG="${TMPDIR_ROOT}/cbrain.json"
echo "  config_file: ${CBRAIN_CONFIG}"
echo "  config_content: $(cat "${CBRAIN_CONFIG}")"

# Create directories referenced by cbrain.json
mkdir -p "${HOME}" "${BUN_INSTALL}" "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${XDG_CACHE_HOME}"
mkdir -p "${TMPDIR_ROOT}/vault" "${TMPDIR_ROOT}/runtime" "${TMPDIR_ROOT}/lancedb"

# Ensure isolated bun bin is on PATH
export PATH="${BUN_INSTALL}/bin:${PATH}"

stage() { echo "  STAGE: $1"; }
fail()   {
  echo "FAIL: $1" >&2
  echo "  Next: check the failed stage above. For install failures, verify the tag exists and Bun can reach GitHub." >&2
  exit 1
}
pass()   { echo "PASS: $1"; }

# ─── Stage 1: Install ─────────────────────────────────────────────────────

stage "install ref=${INSTALL_REF}"
echo "  install spec: ${INSTALL_SPEC}"
echo "  mode: ${MODE}"

if [[ "${MODE}" == "network" ]]; then
  if ! bun install -g "${INSTALL_SPEC}" 2>&1; then
    fail "bun install -g failed for ${INSTALL_SPEC}"
  fi
else
  # Local/fixture mode: symlink or copy fake root into BUN_INSTALL
  if [[ ! -d "${LOCAL_PATH}" ]]; then
    fail "local path does not exist: ${LOCAL_PATH}"
  fi
  # Expect local_path to have bin/ and node_modules/ structure
  mkdir -p "${BUN_INSTALL}/bin"
  if [[ -d "${LOCAL_PATH}/bin" ]]; then
    ln -sf "${LOCAL_PATH}/bin/"* "${BUN_INSTALL}/bin/" 2>/dev/null || true
  fi
  if [[ -d "${LOCAL_PATH}/node_modules" ]]; then
    ln -sf "${LOCAL_PATH}/node_modules" "${BUN_INSTALL}/node_modules" 2>/dev/null || true
  fi
fi

# Verify cbrain is resolvable from the isolated Bun root
CBRAIN_BIN="$(command -v cbrain || true)"
if [[ -z "${CBRAIN_BIN}" ]]; then
  fail "cbrain not found on PATH after install"
fi

# Verify executable is inside the isolated Bun root
if [[ "${CBRAIN_BIN}" != "${BUN_INSTALL}"/* ]]; then
  fail "cbrain resolved outside isolated root: ${CBRAIN_BIN}"
fi
pass "cbrain installed at ${CBRAIN_BIN}"

# ─── Stage 2: Version check (exact match) ─────────────────────────────────

stage "version check"
VERSION_OUTPUT="$(cbrain --version 2>&1 || true)"
echo "  cbrain --version → ${VERSION_OUTPUT}"

if [[ -z "${VERSION_OUTPUT}" ]]; then
  fail "cbrain --version produced no output"
fi

# Strip common CLI prefixes (e.g. "cbrain v1.9.4" → "1.9.4")
VERSION_NORMALIZED="${VERSION_OUTPUT#cbrain }"
VERSION_NORMALIZED="${VERSION_NORMALIZED#v}"
VERSION_NORMALIZED="$(echo "${VERSION_NORMALIZED}" | tr -d '[:space:]')"

if [[ -n "${EXPECTED_VERSION}" ]]; then
  EXPECTED_NORMALIZED="${EXPECTED_VERSION#v}"
  EXPECTED_NORMALIZED="$(echo "${EXPECTED_NORMALIZED}" | tr -d '[:space:]')"
  if [[ "${VERSION_NORMALIZED}" != "${EXPECTED_NORMALIZED}" ]]; then
    fail "version mismatch: expected exactly '${EXPECTED_NORMALIZED}', got '${VERSION_NORMALIZED}'"
  fi
  pass "version matches ${EXPECTED_NORMALIZED}"
else
  pass "version reported: ${VERSION_NORMALIZED}"
fi

# ─── Stage 3: Help commands ───────────────────────────────────────────────

stage "help commands"

if ! cbrain --help >/dev/null 2>&1; then
  fail "cbrain --help failed"
fi
pass "cbrain --help"

if ! cbrain doctor --help >/dev/null 2>&1; then
  fail "cbrain doctor --help failed"
fi
pass "cbrain doctor --help"

# ─── Stage 4: LanceDB dependency — real import verification ───────────────

stage "LanceDB dependency check"

LANCEDB_IMPORT_OUTPUT=""

if [[ "${MODE}" == "local" ]]; then
  # Local/fixture mode: resolve from node_modules
  # Try cbrain package context first (handles hoisted sibling layout),
  # fall back to direct resolution (simple fixtures)
  if [[ -d "${BUN_INSTALL}/node_modules/cbrain" ]]; then
    LANCEDB_IMPORT_OUTPUT="$(cd "${BUN_INSTALL}/node_modules/cbrain" && bun -e "try { require('@lancedb/lancedb'); console.log('OK') } catch(e) { console.error('IMPORT_ERROR:' + e.message) }" 2>&1)"
  elif [[ -d "${BUN_INSTALL}/node_modules/@lancedb/lancedb" ]]; then
    LANCEDB_IMPORT_OUTPUT="$(cd "${BUN_INSTALL}/node_modules" && bun -e "try { require('@lancedb/lancedb'); console.log('OK') } catch(e) { console.error('IMPORT_ERROR:' + e.message) }" 2>&1)"
  else
    fail "@lancedb/lancedb not found in fixture"
  fi
else
  # Network mode: find cbrain package, resolve from its context
  # Bun walks up node_modules tree — handles both nested and hoisted deps
  CBRAIN_PKG_DIR=""
  if [[ -f "${BUN_INSTALL}/install/global/node_modules/cbrain/package.json" ]]; then
    CBRAIN_PKG_DIR="${BUN_INSTALL}/install/global/node_modules/cbrain"
  else
    CBRAIN_PKG_DIR="$(find "${BUN_INSTALL}" -path '*/node_modules/cbrain/package.json' -maxdepth 6 2>/dev/null | head -1 | sed 's|/package.json$||' || true)"
  fi

  if [[ -z "${CBRAIN_PKG_DIR}" ]]; then
    fail "cbrain package not found in installed node_modules"
  fi

  echo "  info: cbrain package at ${CBRAIN_PKG_DIR}"
  LANCEDB_IMPORT_OUTPUT="$(cd "${CBRAIN_PKG_DIR}" && bun -e "try { require('@lancedb/lancedb'); console.log('OK') } catch(e) { console.error('IMPORT_ERROR:' + e.message) }" 2>&1)"
fi

if echo "${LANCEDB_IMPORT_OUTPUT}" | grep -q "^OK$"; then
  pass "@lancedb/lancedb native module loads successfully"
elif echo "${LANCEDB_IMPORT_OUTPUT}" | grep -q "IMPORT_ERROR:"; then
  fail "@lancedb/lancedb import failed: $(echo "${LANCEDB_IMPORT_OUTPUT}" | grep "IMPORT_ERROR:" | sed 's/IMPORT_ERROR://')"
else
  fail "@lancedb/lancedb not found — native dependency may be missing"
fi

# ─── Stage 5: Skill pack verification (network mode only) ──────────────────

if [[ "${MODE}" == "network" ]]; then
  stage "skill-pack verification"

  SKILL_PACK_OUTPUT="$(cbrain skill-pack --json 2>&1 || true)"
  echo "  cbrain skill-pack --json → ${SKILL_PACK_OUTPUT}" | head -c 500

  # Parse verificationStatus using bun (no jq dependency)
  SKILL_PACK_STATUS="$(bun -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(data.verificationStatus);
  " <<< "${SKILL_PACK_OUTPUT}" 2>&1 || true)"

  if [[ "${SKILL_PACK_STATUS}" == "pass" ]]; then
    pass "skill-pack verificationStatus: pass"
  else
    fail "skill-pack verificationStatus: ${SKILL_PACK_STATUS:-parse_failed}"
  fi

  # Verify all 6 required files are present
  SKILL_PACK_MISSING="$(bun -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(data.missingFiles?.length ?? 'parse_error');
  " <<< "${SKILL_PACK_OUTPUT}" 2>&1 || true)"

  if [[ "${SKILL_PACK_MISSING}" == "0" ]]; then
    pass "skill-pack: all required files present"
  else
    fail "skill-pack: ${SKILL_PACK_MISSING} missing required file(s)"
  fi
else
  stage "skill-pack verification (skipped in local mode)"
  pass "skill-pack: skipped (local fixture mode)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "=== SMOKE TEST PASSED ==="
echo "  ref:         ${INSTALL_REF}"
echo "  version:     ${VERSION_NORMALIZED}"
echo "  executable:  ${CBRAIN_BIN}"
echo "  config:      ${CBRAIN_CONFIG}"
echo "==========================="
