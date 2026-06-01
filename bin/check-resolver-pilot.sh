#!/usr/bin/env bash
# check-resolver-pilot.sh — CBrain Resolver Pilot 可达性审计
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$PROJECT_DIR/skills"

OK=0
FAIL=0
WARN=0

pass() { ((OK++)); echo "  [OK] $1"; }
fail() { ((FAIL++)); echo "  [FAIL] $1"; }
warn() { ((WARN++)); echo "  [WARN] $1"; }

echo "=== CBrain Resolver Pilot Check ==="
echo ""

# ── 1. 文件完整性 ──
echo "[1] 文件完整性"

if [[ -f "$SKILLS_DIR/recall-resolver.md" ]]; then
  pass "recall-resolver.md"
else
  fail "recall-resolver.md 不存在"
fi

if [[ -f "$SKILLS_DIR/filing-rules.md" ]]; then
  pass "filing-rules.md"
else
  fail "filing-rules.md 不存在"
fi

if [[ -f "$SKILLS_DIR/recall.routing-eval.jsonl" ]]; then
  eval_count=$(wc -l < "$SKILLS_DIR/recall.routing-eval.jsonl" | tr -d ' ')
  if (( eval_count >= 15 )); then
    pass "recall.routing-eval.jsonl (${eval_count} cases)"
  else
    fail "recall.routing-eval.jsonl 只有 ${eval_count} cases，需要 ≥ 15"
  fi
else
  fail "recall.routing-eval.jsonl 不存在"
fi

if [[ -f "$SKILLS_DIR/episodic.routing-eval.jsonl" ]]; then
  epi_count=$(wc -l < "$SKILLS_DIR/episodic.routing-eval.jsonl" | tr -d ' ')
  epi_pos=$(grep -c '"expected_flag": "episodic"' "$SKILLS_DIR/episodic.routing-eval.jsonl" 2>/dev/null || echo "0")
  epi_neg=$(grep -c '"expected_flag": null' "$SKILLS_DIR/episodic.routing-eval.jsonl" 2>/dev/null || echo "0")
  if (( epi_count >= 10 && epi_pos >= 5 && epi_neg >= 4 )); then
    pass "episodic.routing-eval.jsonl (${epi_count} cases: ${epi_pos} positive, ${epi_neg} negative)"
  else
    fail "episodic.routing-eval.jsonl ${epi_count} cases (需≥10, pos≥5, neg≥4), got pos=${epi_pos} neg=${epi_neg}"
  fi
else
  fail "episodic.routing-eval.jsonl 不存在"
fi

echo ""

# ── 2. 路由覆盖率 ──
echo "[2] 路由覆盖率"

TOOLS=("deep_recall" "query" "summarize" "brain_storm" "expand_entity" "recall_episode")

for tool in "${TOOLS[@]}"; do
  status="ok"
  details=""

  # 检查 eval 覆盖（recall + episodic eval 文件）
  eval_hits=0
  if [[ -f "$SKILLS_DIR/recall.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/recall.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
  fi
  if [[ -f "$SKILLS_DIR/episodic.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/episodic.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
  fi
  if (( eval_hits < 2 )); then
    status="fail"
    details+="eval 只有 ${eval_hits} cases (需≥2), "
  else
    details+="eval ${eval_hits} cases, "
  fi

  # 检查 resolver 有触发词
  if [[ -f "$SKILLS_DIR/recall-resolver.md" ]]; then
    if grep -q "$tool" "$SKILLS_DIR/recall-resolver.md" 2>/dev/null; then
      details+="resolver 有触发词, "
    else
      status="fail"
      details+="resolver 缺触发词, "
    fi
  fi

  # 检查 MEMORY.md 有规则（可选，WARN）
  memory_file="$HOME/.hermes/memories/MEMORY.md"
  if [[ -f "$memory_file" ]]; then
    if grep -q "$tool" "$memory_file" 2>/dev/null; then
      details+="MEMORY.md 有规则"
    else
      details+="MEMORY.md 缺规则"
      if [[ "$status" == "ok" ]]; then
        status="warn"
      fi
    fi
  fi

  case "$status" in
    ok)   pass "$tool: ${details}" ;;
    warn) warn "$tool: ${details}" ;;
    fail) fail "$tool: ${details}" ;;
  esac
done

echo ""

# ── 3. Filing Rules 覆盖 ──
echo "[3] Filing Rules"

if [[ -f "$SKILLS_DIR/filing-rules.md" ]]; then
  page_types=("entity" "concept" "record" "insight")
  all_found=true
  for pt in "${page_types[@]}"; do
    if ! grep -q "→ $pt" "$SKILLS_DIR/filing-rules.md" 2>/dev/null; then
      all_found=false
      break
    fi
  done
  if $all_found; then
    pass "4 种 pageType 都有决策规则"
  else
    fail "有 pageType 缺决策规则"
  fi
else
  fail "filing-rules.md 不存在"
fi

# MEMORY.md filing 规则一致性
memory_file="$HOME/.hermes/memories/MEMORY.md"
if [[ -f "$memory_file" ]]; then
  filing_hits=0
  for pt in "→ entity" "→ concept" "→ record" "→ insight"; do
    grep -q "$pt" "$memory_file" 2>/dev/null && (( filing_hits++ )) || true
  done
  if (( filing_hits >= 4 )); then
    pass "MEMORY.md filing 规则与 filing-rules.md 一致"
  else
    warn "MEMORY.md filing 规则不完整（找到 $filing_hits/4 种 pageType）"
  fi
fi

echo ""

# ── 4. 反模式覆盖 ──
echo "[4] 反模式"

if [[ -f "$SKILLS_DIR/recall.routing-eval.jsonl" ]]; then
  anti_count=$(grep -c '"category": "anti_pattern"' "$SKILLS_DIR/recall.routing-eval.jsonl" 2>/dev/null) || anti_count=0
  if (( anti_count >= 3 )); then
    pass "${anti_count} 条反模式 eval 用例"
  else
    fail "反模式 eval 只有 ${anti_count} 条，需要 ≥ 3"
  fi
fi

if [[ -f "$memory_file" ]]; then
  forbidden_count=$(grep -c "禁止" "$memory_file" 2>/dev/null) || forbidden_count=0
  if (( forbidden_count >= 3 )); then
    pass "MEMORY.md 有 ≥ 3 条禁止规则"
  else
    warn "MEMORY.md 禁止规则可能不足（${forbidden_count} 条）"
  fi
fi

echo ""

# ── 5. Skill 层一致性 ──
echo "[5] Skill 层一致性"

# review.md vs deep_recall 冲突检测
if [[ -f "$SKILLS_DIR/review.md" ]]; then
  has_4step=$(grep -c "Step\|step\|get_page\|get_links\|get_timeline\|graph_query" "$SKILLS_DIR/review.md" 2>/dev/null) || has_4step=0
  has_deep_recall_note=$(grep -c "deep_recall" "$SKILLS_DIR/review.md" 2>/dev/null) || has_deep_recall_note=0
  if (( has_4step > 0 && has_deep_recall_note == 0 )); then
    warn "review.md 4 步协议与 deep_recall 1 步重叠——建议加 deep_recall 优先标注"
  elif (( has_deep_recall_note > 0 )); then
    pass "review.md 已标注 deep_recall 优先"
  fi
fi

# RESOLVER.md skill 文件存在性
if [[ -f "$SKILLS_DIR/RESOLVER.md" ]]; then
  missing_skills=()
  for skill_file in $(grep -oE '\b[a-z-]+\.md\b' "$SKILLS_DIR/RESOLVER.md" 2>/dev/null | sort -u); do
    if [[ ! -f "$SKILLS_DIR/$skill_file" ]]; then
      missing_skills+=("$skill_file")
    fi
  done
  if (( ${#missing_skills[@]} == 0 )); then
    pass "RESOLVER.md 引用的 skill 文件全部存在"
  else
    fail "RESOLVER.md 引用了不存在的 skill: ${missing_skills[*]}"
  fi
fi

echo ""

# ── 6. 汇总 ──
echo "=== ${OK} OK, ${FAIL} FAIL, ${WARN} WARN ==="

if (( FAIL > 0 )); then
  echo "❌ 有 FAIL 项，必须修复才能发布"
  exit 1
else
  echo "✅ 全部通过（WARN 建议修复但非阻塞）"
  exit 0
fi
