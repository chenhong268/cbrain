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

if [[ -f "$SKILLS_DIR/hierarchy.routing-eval.jsonl" ]]; then
  hier_count=$(wc -l < "$SKILLS_DIR/hierarchy.routing-eval.jsonl" | tr -d ' ')
  hier_pos=$(grep -c '"category": "org_hierarchy"' "$SKILLS_DIR/hierarchy.routing-eval.jsonl" 2>/dev/null || echo "0")
  hier_neg=$((hier_count - hier_pos))
  if (( hier_count >= 7 && hier_pos >= 5 && hier_neg >= 2 )); then
    pass "hierarchy.routing-eval.jsonl (${hier_count} cases: ${hier_pos} positive, ${hier_neg} negative)"
  else
    fail "hierarchy.routing-eval.jsonl ${hier_count} cases (需≥7, pos≥5, neg≥2), got pos=${hier_pos} neg=${hier_neg}"
  fi
  # Privacy: no real names
  hier_privacy=0
  for pattern in "张三" "李四" "王磊" "星辰" "某制药" "有限公司" "集团" "公司"; do
    hits=$(grep -c "$pattern" "$SKILLS_DIR/hierarchy.routing-eval.jsonl" 2>/dev/null) || hits=0
    hier_privacy=$((hier_privacy + hits))
  done
  if (( hier_privacy == 0 )); then
    pass "hierarchy eval 无隐私泄露"
  else
    fail "hierarchy eval 有 ${hier_privacy} 处疑似隐私泄露"
  fi
  # Verify hierarchy eval uses get_org_tree (not graph_query) for positive cases
  hier_old_tool=$(grep '"category": "org_hierarchy"' "$SKILLS_DIR/hierarchy.routing-eval.jsonl" 2>/dev/null | grep -c '"expected_tool": "graph_query"' 2>/dev/null || echo "0")
  hier_old_tool=$(echo "$hier_old_tool" | tr -d '[:space:]')
  hier_org_tree=$(grep -c '"expected_tool": "get_org_tree"' "$SKILLS_DIR/hierarchy.routing-eval.jsonl" 2>/dev/null || echo "0")
  if (( hier_old_tool == 0 )); then
    pass "hierarchy eval 正向用例已迁移到 get_org_tree"
  else
    fail "hierarchy eval 仍有 ${hier_old_tool} 处使用 graph_query（应改为 get_org_tree）"
  fi
  if (( hier_org_tree >= 5 )); then
    pass "hierarchy eval get_org_tree 用例 ≥ 5（当前 ${hier_org_tree}）"
  else
    fail "hierarchy eval get_org_tree 用例只有 ${hier_org_tree}（需 ≥ 5）"
  fi
else
  fail "hierarchy.routing-eval.jsonl 不存在"
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

if [[ -f "$SKILLS_DIR/provenance.routing-eval.jsonl" ]]; then
  prov_count=$(wc -l < "$SKILLS_DIR/provenance.routing-eval.jsonl" | tr -d ' ')
  prov_pos=$(grep -c '"expected_tool": "get_provenance"' "$SKILLS_DIR/provenance.routing-eval.jsonl" 2>/dev/null || echo "0")
  prov_neg=$(grep -c '"negative_provenance": true' "$SKILLS_DIR/provenance.routing-eval.jsonl" 2>/dev/null || echo "0")
  if (( prov_count >= 8 && prov_pos >= 4 && prov_neg >= 3 )); then
    pass "provenance.routing-eval.jsonl (${prov_count} cases: ${prov_pos} positive, ${prov_neg} negative)"
  else
    fail "provenance.routing-eval.jsonl ${prov_count} cases (需≥8, pos≥4, neg≥3), got pos=${prov_pos} neg=${prov_neg}"
  fi
else
  fail "provenance.routing-eval.jsonl 不存在"
fi

echo ""

# ── 2. 路由覆盖率 ──
echo "[2] 路由覆盖率"

TOOLS=("deep_recall" "query" "summarize" "brain_storm" "expand_entity" "recall_episode" "agentic_research" "get_provenance" "graph_query" "get_org_tree")

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
  if [[ -f "$SKILLS_DIR/hierarchy.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/hierarchy.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
  fi
  if [[ -f "$SKILLS_DIR/provenance.routing-eval.jsonl" ]]; then
    eval_hits=$((eval_hits + $(grep -c "\"expected_tool\": \"$tool\"" "$SKILLS_DIR/provenance.routing-eval.jsonl" 2>/dev/null | tr -d '[:space:]' || echo "0")))
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

  # Expected tool coverage (five executable daily Agent tools used by this fixture)
  af_tools=("cbrain_recall" "recall_episode" "read_discoveries" "graph_query" "next_actions")
  missing_tools=()
  for tool in "${af_tools[@]}"; do
    tool_hits=$(grep -c "\"expected_tool\": \"${tool}\"" "$AF_EVAL" 2>/dev/null) || tool_hits=0
    if (( tool_hits < 1 )); then
      missing_tools+=("$tool")
    fi
  done
  if (( ${#missing_tools[@]} == 0 )); then
    pass "agent-facing eval 覆盖全部 5 个可执行 expected_tool"
  else
    fail "agent-facing eval 缺少 expected_tool: ${missing_tools[*]}"
  fi

  # Explicit discovery execution is a full-profile boundary, never a read-only substitute.
  if python3 - "$AF_EVAL" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
boundaries = [row for row in rows if row.get("expected_tool") is None]
assert len(boundaries) == 1
boundary = boundaries[0]
identity_rows = [row for row in rows if row.get("case_id") == "run_discovery_request"]
assert len(identity_rows) == 1
assert identity_rows[0] is boundary
assert boundary.get("case_id") == "run_discovery_request"
assert boundary.get("category") == "profile_boundary"
assert boundary.get("expected_tool") is None
assert boundary.get("expected_outcome") == "requires_full_profile"
assert boundary.get("required_profile") == "full"
assert {"run_discovery", "read_discoveries"}.issubset(boundary.get("forbidden_tools", []))
PY
  then
    pass "agent-facing eval 发现检测使用唯一 full-profile no-tool 边界"
  else
    fail "agent-facing eval 发现检测边界必须是 requires_full_profile/full，且禁止替代调用"
  fi

  # cbrain_recall key params: detail=brief for grounded_recall, detail=normal for content_recall
  brief_ok=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "grounded_recall" ]] && continue
    args=$(echo "$line" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['expected_args']))" 2>/dev/null)
    if ! echo "$args" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('detail')=='brief'" 2>/dev/null; then
      brief_ok=false
      break
    fi
  done < "$AF_EVAL"
  if $brief_ok; then
    pass "grounded_recall 用例 expected_args.detail == brief (cbrain_recall)"
  else
    fail "grounded_recall expected_args.detail 应为 brief"
  fi

  normal_ok=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "content_recall" ]] && continue
    args=$(echo "$line" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['expected_args']))" 2>/dev/null)
    if ! echo "$args" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('detail')=='normal'" 2>/dev/null; then
      normal_ok=false
      break
    fi
  done < "$AF_EVAL"
  if $normal_ok; then
    pass "content_recall 用例 expected_args.detail == normal (cbrain_recall)"
  else
    fail "content_recall expected_args.detail 应为 normal"
  fi

  # operational category + next_actions coverage (#334)
  op_hits=$(grep -c '"category": "operational"' "$AF_EVAL" 2>/dev/null) || op_hits=0
  if (( op_hits >= 3 )); then
    pass "operational 用例 ≥ 3（当前 ${op_hits}）"
  else
    fail "operational 用例只有 ${op_hits}（需 ≥ 3）"
  fi
  na_hits=$(grep -c '"expected_tool": "next_actions"' "$AF_EVAL" 2>/dev/null) || na_hits=0
  if (( na_hits >= 1 )); then
    pass "next_actions expected_tool 覆盖（${na_hits}）"
  else
    fail "agent-facing eval 缺少 next_actions expected_tool"
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

# #326: pairwise relationships use the bounded shortest-path contract, while
# single-entity neighborhood queries keep the legacy traversal route.
if python3 - "$AF_EVAL" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
pairwise = [r for r in rows if r.get("category") == "relationship"]
assert len(pairwise) >= 2
assert all(
    r.get("expected_tool") == "graph_query"
    and r.get("expected_args", {}).get("mode") == "shortest_path"
    and isinstance(r.get("expected_args", {}).get("slug"), str)
    and isinstance(r.get("expected_args", {}).get("target"), str)
    and r.get("expected_args", {}).get("depth") == 4
    and r.get("required_sequence") == ["resolve_slugs", "graph_query"]
    and r.get("fallback_only_on") == ["empty", "no_path"]
    for r in pairwise
)
assert any(
    r.get("category") == "relationship_single"
    and r.get("expected_tool") == "graph_query"
    and r.get("expected_args", {}).get("mode") == "traverse"
    and "target" not in r.get("expected_args", {})
    for r in rows
)
PY
then
  relationship_eval_contract=true
else
  relationship_eval_contract=false
fi

if $relationship_eval_contract \
  && grep -q 'mode: "shortest_path"' "$SKILLS_DIR/connect.md" \
  && grep -q 'target:' "$SKILLS_DIR/connect.md" \
  && grep -q 'empty/no_path' "$SKILLS_DIR/connect.md" \
  && grep -q 'resolve_slugs' "$SKILLS_DIR/connect.md" \
  && grep -q '待确认关系线索' "$SKILLS_DIR/connect.md" \
  && grep -q '不得作为确定事实' "$SKILLS_DIR/connect.md"; then
  pass "pairwise relationship contract uses graph shortest_path"
else
  fail "pairwise relationship contract must use graph shortest_path"
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

# ── 5b. Hermes CBrain Brief ──
echo ""
echo "[5b] Hermes CBrain Brief"

BRIEF="$SKILLS_DIR/hermes-cbrain-brief.md"
if [[ -f "$BRIEF" ]]; then
  pass "hermes-cbrain-brief.md 存在"

  # Key tool names present
  brief_tools=("deep_recall" "recall_episode" "read_discoveries" "run_discovery" "graph_query" "query" "summarize" "agentic_research" "get_org_tree")
  missing_brief_tools=()
  for bt in "${brief_tools[@]}"; do
    if ! grep -q "$bt" "$BRIEF" 2>/dev/null; then
      missing_brief_tools+=("$bt")
    fi
  done
  if (( ${#missing_brief_tools[@]} == 0 )); then
    pass "brief 覆盖全部 8 个关键工具名"
  else
    fail "brief 缺少工具名: ${missing_brief_tools[*]}"
  fi

  # Discovery guardrails present
  disc_guardrails=("debug: false" "display" "cards" "summary")
  missing_guardrails=()
  for g in "${disc_guardrails[@]}"; do
    if ! grep -q "$g" "$BRIEF" 2>/dev/null; then
      missing_guardrails+=("$g")
    fi
  done
  if (( ${#missing_guardrails[@]} == 0 )); then
    pass "brief 包含 discovery 展示 guardrails"
  else
    fail "brief 缺少 discovery guardrail: ${missing_guardrails[*]}"
  fi

  # Discovery banned terms present
  disc_banned_brief=("score" "distance" "debug")
  missing_banned=()
  for b in "${disc_banned_brief[@]}"; do
    if ! grep -q "$b" "$BRIEF" 2>/dev/null; then
      missing_banned+=("$b")
    fi
  done
  if (( ${#missing_banned[@]} == 0 )); then
    pass "brief 包含 discovery 禁止词（score/distance/debug）"
  else
    fail "brief 缺少 discovery 禁止词: ${missing_banned[*]}"
  fi

  # User-facing output guardrails: no tool names, raw JSON, slug, debug/trace
  output_guardrails=("工具名" "raw JSON" "slug" "trace")
  missing_output=()
  for og in "${output_guardrails[@]}"; do
    if ! grep -q "$og" "$BRIEF" 2>/dev/null; then
      missing_output+=("$og")
    fi
  done
  if (( ${#missing_output[@]} == 0 )); then
    pass "brief 包含用户输出红线（工具名/raw JSON/slug/trace）"
  else
    fail "brief 缺少用户输出红线关键词: ${missing_output[*]}"
  fi

  # Verify "unless client UI" exception for tool name display
  if grep -q "客户端 UI" "$BRIEF" 2>/dev/null || grep -q "client UI" "$BRIEF" 2>/dev/null || grep -q "客户端" "$BRIEF" 2>/dev/null; then
    pass "brief 包含工具名展示例外（客户端 UI 已显示）"
  else
    fail "brief 缺少工具名展示例外（应有'除非客户端 UI'等价表达）"
  fi

  # Privacy: no real names
  brief_privacy=0
  for pattern in "张三" "李四" "王磊" "星辰" "某制药" "东区" "有限公司" "集团" "公司"; do
    hits=$(grep -c "$pattern" "$BRIEF" 2>/dev/null) || hits=0
    brief_privacy=$((brief_privacy + hits))
  done
  if (( brief_privacy == 0 )); then
    pass "brief 无隐私泄露"
  else
    fail "brief 有 ${brief_privacy} 处疑似隐私泄露"
  fi

  # Brief is compact: ≤ 3000 bytes (~1200 Chinese chars)
  brief_size=$(wc -c < "$BRIEF" | tr -d ' ')
  if (( brief_size <= 3000 )); then
    pass "brief 足够短（${brief_size} bytes，上限 3000）"
  else
    fail "brief 过长（${brief_size} bytes，上限 3000 / ~1200 中文字）"
  fi

  # RESOLVER.md references brief
  if grep -q "hermes-cbrain-brief" "$SKILLS_DIR/RESOLVER.md" 2>/dev/null; then
    pass "RESOLVER.md 引用 hermes-cbrain-brief.md"
  else
    fail "RESOLVER.md 未引用 hermes-cbrain-brief.md"
  fi
else
  fail "skills/hermes-cbrain-brief.md 不存在"
fi

echo ""

# ── 5c. Query Demotion ──
echo "[5c] Query Demotion"

SEARCH_TS="$PROJECT_DIR/src/mcp/tools/search.ts"
if [[ -f "$SEARCH_TS" ]]; then
  # Query description must brand as debug/底层
  if grep -qE '底层|调试|debug|仅限' "$SEARCH_TS" 2>/dev/null; then
    pass "query tool description 包含底层/调试标记"
  else
    fail "query tool description 缺少底层/调试标记"
  fi

  # Query description must mention deep_recall as preferred
  if grep -q 'deep_recall' "$SEARCH_TS" 2>/dev/null; then
    pass "query tool description 提及 deep_recall 优先"
  else
    fail "query tool description 未提及 deep_recall"
  fi
else
  fail "src/mcp/tools/search.ts 不存在"
fi

# RESOLVER catch-all must route to deep_recall
if [[ -f "$SKILLS_DIR/RESOLVER.md" ]]; then
  if grep -q '\[deep_recall\]' "$SKILLS_DIR/RESOLVER.md" 2>/dev/null || grep -q '\[keyword\]' "$SKILLS_DIR/RESOLVER.md" 2>/dev/null; then
    pass "RESOLVER.md 区分自然语言路由和关键词路由"
  else
    fail "RESOLVER.md 未区分自然语言和关键词路由（需要 [deep_recall] 或 [keyword] 标记）"
  fi
fi

# recall-resolver must mark query as 底层/调试
if [[ -f "$SKILLS_DIR/recall-resolver.md" ]]; then
  if grep -qE '底层|调试|debug|仅限.*关键词' "$SKILLS_DIR/recall-resolver.md" 2>/dev/null; then
    pass "recall-resolver.md 标记 query 为底层工具"
  else
    fail "recall-resolver.md 未标记 query 为底层工具"
  fi
fi

# agent-facing routing eval must have query demotion anti-patterns
if [[ -f "$SKILLS_DIR/agent-facing.routing-eval.jsonl" ]]; then
  af_query_demo=$(grep -c '"category": "anti_pattern"' "$SKILLS_DIR/agent-facing.routing-eval.jsonl" 2>/dev/null | tr -d ' ')
  if (( af_query_demo >= 7 )); then
    pass "agent-facing eval anti_pattern 用例 ≥ 7（当前 ${af_query_demo}）"
  else
    fail "agent-facing eval anti_pattern 用例只有 ${af_query_demo}（需 ≥ 7，含 query demotion）"
  fi

  # Query demotion: no daily Agent-facing eval case may expect the query tool.
  af_bad_query=0
  while IFS= read -r line; do
    tool=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('expected_tool',''))" 2>/dev/null)
    if [[ "$tool" == "query" ]]; then
      af_bad_query=$((af_bad_query + 1))
    fi
  done < "$SKILLS_DIR/agent-facing.routing-eval.jsonl"
  if (( af_bad_query == 0 )); then
    pass "agent-facing eval 无 expected_tool: query 残留"
  else
    fail "agent-facing eval 有 ${af_bad_query} 处用例期望 query（daily profile 应改为 cbrain_recall）"
  fi
fi

# Same check for recall.routing-eval.jsonl
if [[ -f "$SKILLS_DIR/recall.routing-eval.jsonl" ]]; then
  recall_bad_query=0
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('category',''))" 2>/dev/null)
    tool=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('expected_tool',''))" 2>/dev/null)
    # keyword_debug and anti_pattern (where query is the correct fallback) are OK
    [[ "$cat" == "keyword_debug" ]] && continue
    [[ "$cat" == "anti_pattern" ]] && continue
    if [[ "$tool" == "query" ]]; then
      recall_bad_query=$((recall_bad_query + 1))
    fi
  done < "$SKILLS_DIR/recall.routing-eval.jsonl"
  if (( recall_bad_query == 0 )); then
    pass "recall eval 无自然语言→query 残留（仅 keyword_debug 允许 query）"
  else
    fail "recall eval 有 ${recall_bad_query} 处非 keyword_debug 用例期望 query"
  fi
fi

# Same check for episodic.routing-eval.jsonl
if [[ -f "$SKILLS_DIR/episodic.routing-eval.jsonl" ]]; then
  epi_bad_query=0
  while IFS= read -r line; do
    tool=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('expected_tool',''))" 2>/dev/null)
    if [[ "$tool" == "query" ]]; then
      epi_bad_query=$((epi_bad_query + 1))
    fi
  done < "$SKILLS_DIR/episodic.routing-eval.jsonl"
  if (( epi_bad_query == 0 )); then
    pass "episodic eval 无 expected_tool: query 残留"
  else
    fail "episodic eval 有 ${epi_bad_query} 处期望 query（应改为 deep_recall/graph_query/get_org_tree）"
  fi
fi

# Same check for agentic.routing-eval.jsonl
if [[ -f "$SKILLS_DIR/agentic.routing-eval.jsonl" ]]; then
  ago_bad_query=0
  while IFS= read -r line; do
    tool=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('expected_tool',''))" 2>/dev/null)
    if [[ "$tool" == "query" ]]; then
      ago_bad_query=$((ago_bad_query + 1))
    fi
  done < "$SKILLS_DIR/agentic.routing-eval.jsonl"
  if (( ago_bad_query == 0 )); then
    pass "agentic eval 无 expected_tool: query 残留"
  else
    fail "agentic eval 有 ${ago_bad_query} 处期望 query（应改为 deep_recall）"
  fi
fi

# ── 5d. Response Contract Eval ──
echo ""
echo "[5d] Response Contract Eval"

RC_EVAL="$SKILLS_DIR/response-contract.routing-eval.jsonl"
if [[ -f "$RC_EVAL" ]]; then
  rc_count=$(wc -l < "$RC_EVAL" | tr -d ' ')
  if (( rc_count >= 12 )); then
    pass "response-contract.routing-eval.jsonl (${rc_count} cases, 需要 ≥ 12)"
  else
    fail "response-contract.routing-eval.jsonl 只有 ${rc_count} cases，需要 ≥ 12"
  fi

  # Forbidden set coverage — issue #197 contract: score/source_id/reason_codes/raw/slug/trace/vector
  rc_forbidden=("score" "source_id" "reason_codes" "raw" "slug" "trace" "vector")
  rc_missing=()
  for term in "${rc_forbidden[@]}"; do
    if ! grep -q "\"$term\"" "$RC_EVAL" 2>/dev/null; then
      rc_missing+=("$term")
    fi
  done
  if (( ${#rc_missing[@]} == 0 )); then
    pass "response-contract eval forbidden set 全覆盖（score/source_id/reason_codes/raw/slug/trace/vector）"
  else
    fail "response-contract eval forbidden set 缺少: ${rc_missing[*]}"
  fi

  # Privacy: no real names
  rc_privacy=0
  for pattern in "张三" "李四" "王磊" "星辰" "某制药" "有限公司" "集团" "公司"; do
    hits=$(grep -c "$pattern" "$RC_EVAL" 2>/dev/null) || hits=0
    rc_privacy=$((rc_privacy + hits))
  done
  if (( rc_privacy == 0 )); then
    pass "response-contract eval 无隐私泄露"
  else
    fail "response-contract eval 有 ${rc_privacy} 处疑似隐私泄露"
  fi
else
  fail "skills/response-contract.routing-eval.jsonl 不存在"
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

# ── 8. UX 合同 / 隐私 ──
echo "── 8. UX contract / privacy ──"

# 8a. UX contract doc exists
if [[ -f "docs/product/cbrain-2.0-ux-contract.md" ]]; then
  echo "  ✅ UX contract doc exists"
  ((OK++))
else
  echo "  ❌ docs/product/cbrain-2.0-ux-contract.md 不存在"
  ((FAIL++))
fi

# 8b. No real email addresses in tests/evals
EMAIL_HITS=$(grep -rE '[a-z]+@[a-z]+\.(com|cn|org)' tests/ skills/*.jsonl docs/product/ 2>/dev/null | grep -v node_modules | grep -v '.sqlite' | head -5 || true)
if [[ -z "$EMAIL_HITS" ]]; then
  echo "  ✅ No real email addresses in tests/evals/docs"
  ((OK++))
else
  echo "  ❌ Found potential real email addresses:"
  echo "$EMAIL_HITS"
  ((FAIL++))
fi

# 8c. No real phone numbers in tests/evals
# Boundary: the candidate must start at BOL or a non-digit and end at EOL or a
# non-digit, so a longer run of digits (e.g. a large integer literal in the
# test suite) is not sliced into a false phone candidate.
PHONE_PATTERN='(^|[^0-9])1[3-9][0-9]{9}($|[^0-9])'
PHONE_HITS=$(grep -rE "$PHONE_PATTERN" tests/ skills/*.jsonl docs/product/ 2>/dev/null | grep -v node_modules | head -5 || true)
if [[ -z "$PHONE_HITS" ]]; then
  echo "  ✅ No real phone numbers in tests/evals/docs"
  ((OK++))
else
  echo "  ❌ Found potential real phone numbers:"
  echo "$PHONE_HITS"
  ((FAIL++))
fi

# 8d. No iCloud vault paths in product docs
ICLOUD_HITS=$(grep -r 'iCloud~md~obsidian' docs/product/ 2>/dev/null | head -5 || true)
if [[ -z "$ICLOUD_HITS" ]]; then
  echo "  ✅ No iCloud vault paths in product docs"
  ((OK++))
else
  echo "  ❌ Found iCloud vault paths in product docs:"
  echo "$ICLOUD_HITS"
  ((FAIL++))
fi

echo ""

# ── 9. 汇总 ──
echo "=== ${OK} OK, ${FAIL} FAIL, ${WARN} WARN ==="

if (( FAIL > 0 )); then
  echo "❌ 有 FAIL 项，必须修复才能发布"
  exit 1
else
  echo "✅ 全部通过（WARN 建议修复但非阻塞）"
  exit 0
fi
