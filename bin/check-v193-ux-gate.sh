#!/usr/bin/env bash
# check-v193-ux-gate.sh — v1.9.3 Hermes UX Release Gate
# Runs envelope unit tests + banned-term / compactness / privacy checks.
# Never exits early on failure — always runs all checks and prints summary.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

OK=0
FAIL=0

pass() { ((OK++)); echo "  ✅ $1"; }
fail() { ((FAIL++)); echo "  ❌ $1"; }

# Run a command that may fail, capture output, don't die.
# Usage: safe_output=$(capture bun test ...)
capture() {
  "$@" 2>&1 || true
}

echo "=== v1.9.3 Hermes UX Release Gate ==="
echo ""

# ── 1. Lint ──
echo "[1] Static checks (lint)"
LINT_OUTPUT=$(capture bun run lint)
if echo "$LINT_OUTPUT" | tail -1 | grep -q "No fixes applied"; then
  pass "tsc + biome lint clean"
else
  fail "lint failed — run 'bun run lint' for details"
fi

echo ""

# ── 2. UX gate test suite ──
echo "[2] UX gate test suite"
GATE_OUTPUT=$(capture bun test tests/mcp/v193-ux-gate.test.ts)
if echo "$GATE_OUTPUT" | grep -q "0 fail"; then
  GATE_PASS=$(echo "$GATE_OUTPUT" | grep -oE '[0-9]+ pass' | head -1)
  pass "v193-ux-gate: ${GATE_PASS}"
else
  fail "v193-ux-gate tests failed"
  echo "$GATE_OUTPUT" | grep "error\|fail" | head -5
fi

echo ""

# ── 3. Existing envelope tests ──
echo "[3] Envelope regression tests"
ENVELOPE_FILES=(
  "tests/mcp/graph-timeline-envelope.test.ts"
  "tests/mcp/health-dream-envelope.test.ts"
  "tests/mcp/version-profile-envelope.test.ts"
)
for f in "${ENVELOPE_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    RESULT=$(capture bun test "$f")
    if echo "$RESULT" | grep -q "0 fail"; then
      PASS_COUNT=$(echo "$RESULT" | grep -oE '[0-9]+ pass' | head -1)
      pass "$(basename $f): ${PASS_COUNT}"
    else
      fail "$(basename $f) failed"
    fi
  else
    fail "$f not found"
  fi
done

echo ""

# ── 4. Full test suite ──
echo "[4] Full test suite"
FULL_OUTPUT=$(capture bun test)
if echo "$FULL_OUTPUT" | grep -q "0 fail"; then
  FULL_PASS=$(echo "$FULL_OUTPUT" | tail -2 | grep -oE '[0-9]+ pass' | head -1)
  pass "full suite: ${FULL_PASS}"
else
  fail "full test suite has failures"
fi

echo ""

# ── 5. Privacy scan ──
echo "[5] Privacy scan"
PRIVACY_HITS=0
# Scan only v1.9.3 deliverables: envelope tests, new skills, product docs
PRIVACY_TARGETS=(
  tests/mcp/v193-ux-gate.test.ts
  tests/mcp/graph-timeline-envelope.test.ts
  tests/mcp/health-dream-envelope.test.ts
  tests/mcp/version-profile-envelope.test.ts
  skills/signal-router.md
  skills/signal-router.routing-eval.jsonl
  skills/signal-detector.md
  skills/response-contract.routing-eval.jsonl
  docs/product/agent-response-contract.md
)
for pattern in "张三" "李四" "王磊" "星辰" "某制药"; do
  for target in "${PRIVACY_TARGETS[@]}"; do
    if [[ -f "$target" ]]; then
      HITS=$(grep -c "$pattern" "$target" 2>/dev/null || true)
      HITS=$(echo "$HITS" | tr -d '[:space:]')
      HITS=${HITS:-0}
      PRIVACY_HITS=$((PRIVACY_HITS + HITS))
    fi
  done
done
if (( PRIVACY_HITS == 0 )); then
  pass "no real identifiers in tests/docs/skills"
else
  fail "found ${PRIVACY_HITS} potential privacy violations"
fi

# Email / phone check in eval files
EMAIL_HITS=$(grep -rE '[a-z]+@[a-z]+\.(com|cn|org)' tests/ skills/*.jsonl docs/product/ 2>/dev/null | grep -v node_modules | grep -v '.sqlite' | wc -l | tr -d ' ')
if (( EMAIL_HITS == 0 )); then
  pass "no real email addresses"
else
  fail "found ${EMAIL_HITS} potential email addresses"
fi

PHONE_HITS=$(grep -rE '1[3-9][0-9]{9}' tests/ skills/*.jsonl docs/product/ 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')
if (( PHONE_HITS == 0 )); then
  pass "no real phone numbers"
else
  fail "found ${PHONE_HITS} potential phone numbers"
fi

echo ""

# ── 6. Envelope tool coverage ──
# Each tool maps to a specific formatter export in format-result.ts
# (or a special tool file for wakeup_diff).
# If the formatter disappears, this check fails.
echo "[6] Envelope tool coverage"

FORMAT_RESULT="$PROJECT_DIR/src/mcp/tools/format-result.ts"
MISSING_TOOLS=""

# tool:formatter pairs — each tool requires its specific export to exist
check_formatter() {
  local tool="$1"
  local symbol="$2"
  if grep -q "export function ${symbol}" "$FORMAT_RESULT" 2>/dev/null; then
    return 0
  else
    MISSING_TOOLS="${MISSING_TOOLS} ${tool}(missing:${symbol})"
    return 1
  fi
}

check_formatter "graph_query" "formatGraphEnvelope"
check_formatter "get_links" "formatLinksEnvelope"
check_formatter "get_timeline" "formatTimelineEnvelope"
check_formatter "health" "formatHealthEnvelope"
check_formatter "dream_status" "formatDreamStatusEnvelope"
check_formatter "dream" "formatDreamStatusEnvelope"
check_formatter "get_versions" "formatVersionsEnvelope"
check_formatter "revert_version" "formatRevertEnvelope"
check_formatter "get_profile" "formatGetProfileEnvelope"
check_formatter "update_profile" "formatUpdateProfileEnvelope"
check_formatter "remove_profile" "formatRemoveProfileEnvelope"
check_formatter "reload_profile" "formatReloadProfileEnvelope"

# wakeup_diff has its own display text builder in wakeup.ts
WAKEUP="$PROJECT_DIR/src/mcp/tools/wakeup.ts"
if [[ -f "$WAKEUP" ]] && grep -q "export function formatWakeupEnvelope" "$WAKEUP" 2>/dev/null; then
  : # OK
else
  MISSING_TOOLS="${MISSING_TOOLS} wakeup_diff(missing:formatWakeupEnvelope)"
fi

if [[ -z "$MISSING_TOOLS" ]]; then
  pass "all 13 envelope tools covered"
else
  fail "missing envelope coverage:${MISSING_TOOLS}"
fi

echo ""

# ── 7. Signal routing coverage ──
echo "[7] Signal routing (v1.9.3 skills)"
SIGNAL_FILES=(
  "skills/signal-router.md"
  "skills/signal-router.routing-eval.jsonl"
  "skills/signal-detector.md"
)
for f in "${SIGNAL_FILES[@]}"; do
  if [[ -f "$PROJECT_DIR/$f" ]]; then
    pass "$(basename $f) exists"
  else
    fail "$f missing"
  fi
done

# Response contract
if [[ -f "$PROJECT_DIR/docs/product/agent-response-contract.md" ]]; then
  pass "agent-response-contract.md exists"
else
  fail "agent-response-contract.md missing"
fi

if [[ -f "$PROJECT_DIR/skills/response-contract.routing-eval.jsonl" ]]; then
  EVAL_COUNT=$(wc -l < "$PROJECT_DIR/skills/response-contract.routing-eval.jsonl" | tr -d ' ')
  if (( EVAL_COUNT >= 10 )); then
    pass "response-contract eval (${EVAL_COUNT} cases)"
  else
    fail "response-contract eval only ${EVAL_COUNT} cases (need ≥ 10)"
  fi
else
  fail "response-contract.routing-eval.jsonl missing"
fi

echo ""

# ── Summary ──
echo "=== ${OK} OK, ${FAIL} FAIL ==="

if (( FAIL > 0 )); then
  echo "❌ Release gate FAILED — fix above issues before v1.9.3"
  exit 1
else
  echo "✅ v1.9.3 release gate PASSED"
  exit 0
fi
