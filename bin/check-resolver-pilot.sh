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

if [[ -f "$SKILLS_DIR/agentic.routing-eval.jsonl" ]]; then
  ago_count=$(wc -l < "$SKILLS_DIR/agentic.routing-eval.jsonl" | tr -d ' ')
  ago_pos=$(grep -c '"expected_tool": "agentic_research"' "$SKILLS_DIR/agentic.routing-eval.jsonl" 2>/dev/null || echo "0")
  ago_neg=$((ago_count - ago_pos))
  if (( ago_count >= 12 && ago_pos >= 6 && ago_neg >= 6 )); then
    pass "agentic.routing-eval.jsonl (${ago_count} cases: ${ago_pos} positive, ${ago_neg} negative)"
  else
    fail "agentic.routing-eval.jsonl ${ago_count} cases (需≥12, pos≥6, neg≥6), got pos=${ago_pos} neg=${ago_neg}"
  fi
else
  fail "agentic.routing-eval.jsonl 不存在"
fi

if [[ -f "$SKILLS_DIR/compounding-review.routing-eval.jsonl" ]]; then
  cr_count=$(wc -l < "$SKILLS_DIR/compounding-review.routing-eval.jsonl" | tr -d ' ')
  cr_pos=$(grep -c '"expected_action": "compounding_review"' "$SKILLS_DIR/compounding-review.routing-eval.jsonl" 2>/dev/null || echo "0")
  cr_silent=$(grep -c '"expected_action": "silent"' "$SKILLS_DIR/compounding-review.routing-eval.jsonl" 2>/dev/null || echo "0")
  if (( cr_count >= 10 && cr_pos >= 3 && cr_silent >= 4 )); then
    pass "compounding-review.routing-eval.jsonl (${cr_count} cases: ${cr_pos} review, ${cr_silent} silent)"
  else
    fail "compounding-review.routing-eval.jsonl ${cr_count} cases (需≥10, review≥3, silent≥4), got review=${cr_pos} silent=${cr_silent}"
  fi
else
  fail "compounding-review.routing-eval.jsonl 不存在"
fi

echo ""

# ── 2. 路由覆盖率 ──
echo "[2] 路由覆盖率"

TOOLS=("deep_recall" "query" "summarize" "brain_storm" "expand_entity" "recall_episode" "agentic_research")

for tool in "${TOOLS[@]}"; do
  status="ok"
  details=""

  # 检查 eval 覆盖（recall + episodic + agentic eval 文件）
  eval_hits=0
  if [[ -f "$SKILLS_DIR/recall.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/recall.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
  fi
  if [[ -f "$SKILLS_DIR/episodic.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/episodic.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
  fi
  if [[ -f "$SKILLS_DIR/agentic.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/agentic.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
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

# ── 5. Agent-facing Routing Acceptance ──
echo "[5] Agent-facing Routing Acceptance"

AF_EVAL="$SKILLS_DIR/agent-facing.routing-eval.jsonl"

if [[ -f "$AF_EVAL" ]]; then
  af_count=$(wc -l < "$AF_EVAL" | tr -d ' ')
  if (( af_count >= 25 )); then
    pass "agent-facing.routing-eval.jsonl (${af_count} cases, 需要 ≥ 25)"
  else
    fail "agent-facing.routing-eval.jsonl 只有 ${af_count} cases，需要 ≥ 25"
  fi

  # Schema validation: every line must have required fields
  missing_fields=0
  lineno=0
  while IFS= read -r line; do
    ((lineno++)) || true
    for field in "expected_args" "forbidden_tools" "forbidden_output_terms"; do
      if ! echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$field' in d" 2>/dev/null; then
        ((missing_fields++)) || true
      fi
    done
  done < "$AF_EVAL"
  if (( missing_fields == 0 )); then
    pass "每条 eval 用例都有 expected_args/forbidden_tools/forbidden_output_terms"
  else
    fail "有 ${missing_fields} 处缺少必需字段（expected_args/forbidden_tools/forbidden_output_terms）"
  fi

  # Per-category minimums
  cat_failures=()
  af_cat_mins="grounded_recall:4 content_recall:4 episodic_recall:4 discovery_digest:3 anti_pattern:5"
  for cm in $af_cat_mins; do
    cat="${cm%%:*}"
    min="${cm##*:}"
    hits=$(grep -c "\"category\": \"${cat}\"" "$AF_EVAL" 2>/dev/null) || hits=0
    if (( hits < min )); then
      cat_failures+=("${cat}: ${hits} < ${min}")
    fi
  done
  if (( ${#cat_failures[@]} == 0 )); then
    pass "所有 category 达到最低用例数（grounded≥4, content≥4, episodic≥4, discovery≥3, anti_pattern≥5）"
  else
    fail "category 不足: ${cat_failures[*]}"
  fi

  # Expected tool coverage (7 tools)
  af_tools=("deep_recall" "recall_episode" "read_discoveries" "run_discovery" "graph_query" "query" "summarize")
  missing_tools=()
  for tool in "${af_tools[@]}"; do
    tool_hits=$(grep -c "\"expected_tool\": \"${tool}\"" "$AF_EVAL" 2>/dev/null) || tool_hits=0
    if (( tool_hits < 1 )); then
      missing_tools+=("$tool")
    fi
  done
  if (( ${#missing_tools[@]} == 0 )); then
    pass "agent-facing eval 覆盖全部 7 个 expected_tool"
  else
    fail "agent-facing eval 缺少 expected_tool: ${missing_tools[*]}"
  fi

  # Grounded recall key params: grounded=true, detail=brief, limit=3
  grounded_ok=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "grounded_recall" ]] && continue
    args=$(echo "$line" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['expected_args']))" 2>/dev/null)
    if ! echo "$args" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('grounded')==True and d.get('detail')=='brief' and d.get('limit')==3" 2>/dev/null; then
      grounded_ok=false
      break
    fi
  done < "$AF_EVAL"
  if $grounded_ok; then
    pass "grounded_recall 用例全部有 grounded=true, detail=brief, limit=3"
  else
    fail "有 grounded_recall 用例的 expected_args 不符合 {grounded: true, detail: brief, limit: 3}"
  fi

  # Content recall key params: grounded=false, detail=normal, limit=3
  content_ok=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "content_recall" ]] && continue
    args=$(echo "$line" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['expected_args']))" 2>/dev/null)
    if ! echo "$args" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('grounded')==False and d.get('detail')=='normal' and d.get('limit')==3" 2>/dev/null; then
      content_ok=false
      break
    fi
  done < "$AF_EVAL"
  if $content_ok; then
    pass "content_recall 用例全部有 grounded=false, detail=normal, limit=3"
  else
    fail "有 content_recall 用例的 expected_args 不符合 {grounded: false, detail: normal, limit: 3}"
  fi

  # Discovery forbidden output terms coverage
  disc_forbidden=("score" "distance" "shared_neighbors" "debug" "_debug")
  disc_has_all=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "discovery_digest" ]] && continue
    for term in "${disc_forbidden[@]}"; do
      if ! echo "$line" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert '$term' in d.get('forbidden_output_terms', [])
" 2>/dev/null; then
        disc_has_all=false
        break 2
      fi
    done
  done < "$AF_EVAL"
  if $disc_has_all; then
    pass "discovery_digest 用例的 forbidden_output_terms 覆盖全部禁止词"
  else
    fail "有 discovery_digest 用例的 forbidden_output_terms 缺少 score/distance/shared_neighbors/debug 等禁止词"
  fi

  # Privacy: no real names in eval (use -e flags, not \| in regex)
  privacy_violations=0
  for pattern in "张三" "李四" "王磊" "星辰" "某制药" "东区" "有限公司" "科技" "集团" "公司"; do
    hits=$(grep -c "$pattern" "$AF_EVAL" 2>/dev/null) || hits=0
    privacy_violations=$((privacy_violations + hits))
  done
  if (( privacy_violations == 0 )); then
    pass "agent-facing eval 无隐私泄露"
  else
    fail "agent-facing eval 有 ${privacy_violations} 处疑似隐私泄露"
  fi
else
  fail "agent-facing.routing-eval.jsonl 不存在"
fi

# Discovery presentation rules: verify resolver docs mention the constraint
discovery_banned=("score" "distance" "shared_neighbors" "debug" "图距离" "共享邻居")
resolver_files=("$SKILLS_DIR/RESOLVER.md" "$SKILLS_DIR/recall-resolver.md")
banned_mentioned=0
for f in "${resolver_files[@]}"; do
  if [[ -f "$f" ]]; then
    for term in "${discovery_banned[@]}"; do
      if grep -q "$term" "$f" 2>/dev/null; then
        banned_mentioned=$((banned_mentioned + 1))
        break
      fi
    done
  fi
done
if (( banned_mentioned >= 1 )); then
  pass "resolver 文档包含 discovery 展示禁止规则"
else
  fail "resolver 文档缺少 discovery 展示禁止规则"
fi

# Verify acceptance doc exists
if [[ -f "$PROJECT_DIR/docs/product/agent-facing-routing-acceptance.md" ]]; then
  pass "agent-facing-routing-acceptance.md 存在"
else
  fail "docs/product/agent-facing-routing-acceptance.md 不存在"
fi

echo ""

# ── 6. Skill 层一致性 ──
echo "[6] Skill 层一致性"

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

  # Agentic research routing 闭环检查
  if grep -q '\[agentic_research' "$SKILLS_DIR/RESOLVER.md" 2>/dev/null; then
    if [[ -f "$SKILLS_DIR/query.md" ]] && grep -q '\[agentic_research\] Branch' "$SKILLS_DIR/query.md" 2>/dev/null; then
      pass "RESOLVER.md [agentic_research] → query.md branch 闭环"
    else
      fail "RESOLVER.md 有 [agentic_research] 路由，但 query.md 缺少 [agentic_research] Branch"
    fi
  fi

  # Agentic research 回答契约检查
  if [[ -f "$SKILLS_DIR/query.md" ]] && grep -q '回答契约' "$SKILLS_DIR/query.md" 2>/dev/null; then
    pass "query.md [agentic_research] 有回答契约"
  else
    fail "query.md [agentic_research] 缺少回答契约（answer_contract）"
  fi

  contract_doc="$PROJECT_DIR/docs/product/agentic-research-answer-contract.md"
  if [[ -f "$contract_doc" ]]; then
    fixture_count=$(grep -c '^### Fixture' "$contract_doc" 2>/dev/null || echo "0")
    if (( fixture_count >= 4 )); then
      pass "回答契约 smoke fixtures (${fixture_count} 个)"
    else
      fail "回答契约 smoke fixtures 只有 ${fixture_count} 个，需要 ≥ 4"
    fi
  else
    fail "docs/product/agentic-research-answer-contract.md 不存在"
  fi
fi

echo ""

# ── 7. 汇总 ──
echo "=== ${OK} OK, ${FAIL} FAIL, ${WARN} WARN ==="

if (( FAIL > 0 )); then
  echo "❌ 有 FAIL 项，必须修复才能发布"
  exit 1
else
  echo "✅ 全部通过（WARN 建议修复但非阻塞）"
  exit 0
fi
