#!/usr/bin/env bash
# bin/daily-patrol.sh — bounded daily patrol entrypoint (#223).
#
# daily 巡检只判"现网可用 + 退化信号"。full bun test/check 分离 nightly/release
# （见 docs/patrol.md）。single-writer + HTTP /mcp 拓扑下走 HTTP/MCP，不 spawn stdio CLI
# （不调 cbrain doctor / bun test / bun run check，见 #208）。
#
# 分区输出：runtime / mcp / perf / repo_gate / data_quality。
# #441：data_quality + summary 分行报告两个状态轴——运行健康（决定 exit code）与
# 最近完整知识体检（只读 status.lastFullHealth 标量，不重跑 full health）。
# repo_gate timeout = deferred（非 runtime unhealthy）。
#
# Usage:
#   CBRAIN_PORT=3399 CBRAIN_MCP_URL=http://127.0.0.1:3399/mcp ./daily-patrol.sh
#
# Exit codes: 0 = runtime healthy（repo_gate 可能 deferred）; 1 = runtime unhealthy

set -euo pipefail

CBRAIN_PORT="${CBRAIN_PORT:-3399}"
CBRAIN_MCP_URL="${CBRAIN_MCP_URL:-http://127.0.0.1:${CBRAIN_PORT}/mcp}"
BASE="${CBRAIN_MCP_URL%/mcp}"
PROTOCOL_VERSION="2025-11-25"
REPO_GATE_TIMEOUT_S="${REPO_GATE_TIMEOUT_S:-50}"

# Repo root：解析脚本位置（独立于 caller cwd），支持 CBRAIN_REPO_DIR 覆盖。
# 复制到 Hermes scripts 目录时需 export CBRAIN_REPO_DIR=<repo root>（见 docs/patrol.md）。
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${CBRAIN_REPO_DIR:-$DEFAULT_PROJECT_DIR}"

# 启动验证：PROJECT_DIR 必须是有效 CBrain repo（通用错误，不写真实路径）
if [[ ! -f "$PROJECT_DIR/package.json" || ! -f "$PROJECT_DIR/src/cli/index.ts" ]]; then
  echo "FAIL: PROJECT_DIR 不是有效的 CBrain repo（缺 package.json 或 src/cli/index.ts）。设置 CBRAIN_REPO_DIR 指向 CBrain repo root。" >&2
  exit 1
fi

# timeout 命令检测（Linux timeout / macOS gtimeout）；都没有则 gate 依赖自身 bounded
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout";
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"; fi

RUNTIME_FAIL=0
TOOL_COUNT="?"
ok()   { echo "  ✓ $1"; }
warn() { echo "  ⚠ $1"; }
fail() { echo "  ✗ $1"; RUNTIME_FAIL=$((RUNTIME_FAIL+1)); }
section() { echo ""; echo "=== $1 ==="; }

echo "CBrain Daily Patrol ($(date -u +%FT%TZ 2>/dev/null || date))"

# ── runtime health ──
section "runtime"
if curl -sf "${BASE}/health" >/dev/null 2>&1; then
  ok "HTTP /health（serve 运行中）"
else
  fail "HTTP /health（serve 未运行 ${BASE}）"
fi

# ── MCP health（/mcp initialize → tools/list，复用 #212 wrapper 模式）──
section "mcp"
SESSION=""
INIT_HEADERS="$(curl -s -o /dev/null -D - -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"${PROTOCOL_VERSION}\",\"capabilities\":{},\"clientInfo\":{\"name\":\"daily-patrol\",\"version\":\"1.0\"}}}" 2>&1 || true)"
SESSION="$(printf '%s\n' "$INIT_HEADERS" | awk -F': ' 'tolower($1)=="mcp-session-id"{gsub(/[\r\n]/,"",$2); print $2; exit}')"

_session_cleanup() {
  if [[ -n "${SESSION:-}" ]]; then
    curl -sf -X DELETE "$CBRAIN_MCP_URL" -H "mcp-session-id: $SESSION" >/dev/null 2>&1 || true
  fi
}
trap _session_cleanup EXIT

MCP_OK=0
if [[ -n "$SESSION" ]]; then
  curl -sf -o /dev/null -X POST "$CBRAIN_MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' 2>&1 || true
  TOOLS_LIST="$(curl -s -X POST "$CBRAIN_MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' 2>&1 || true)"
  if echo "$TOOLS_LIST" | grep -q '"tools"'; then
    TOOL_COUNT="$(printf '%s' "$TOOLS_LIST" | bun -e '
      const chunks = [];
      for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const jsonStart = text.indexOf("{");
      const payload = JSON.parse(jsonStart >= 0 ? text.slice(jsonStart) : text);
      const tools = payload?.result?.tools;
      if (!Array.isArray(tools)) throw new Error("missing tools array");
      console.log(tools.length);
    ' 2>/dev/null || printf '?')"
    ok "MCP /mcp tools/list（${TOOL_COUNT} tools 暴露）"
    MCP_OK=1
  else
    fail "MCP /mcp tools/list 无 tools 响应"
  fi
else
  fail "MCP /mcp initialize 未返回 mcp-session-id"
fi

# ── perf（readonly SQLite，不 spawn 写 runtime）──
section "perf"
PERF_JSON="$((cd "$PROJECT_DIR" && bun "$PROJECT_DIR/src/cli/index.ts" perf-diagnose --days 7 --min-latency-ms 0 --json) 2>/dev/null || true)"
if [[ -n "$PERF_JSON" ]]; then
  ok "perf-diagnose（readonly，JSON 详情省略）"
else
  warn "perf-diagnose 无输出（可能无 search_log 数据，非 unhealthy）"
fi

# ── repo gate（timeout bounded；timeout/fail = deferred，非 runtime unhealthy）──
section "repo_gate"
GATE_STATUS=0
if [[ -n "$TIMEOUT_CMD" ]]; then
  (cd "$PROJECT_DIR" && $TIMEOUT_CMD "$REPO_GATE_TIMEOUT_S" bun run gate:v2-preflight) >/dev/null 2>&1 || GATE_STATUS=$?
else
  (cd "$PROJECT_DIR" && bun run gate:v2-preflight) >/dev/null 2>&1 || GATE_STATUS=$?
fi
if [[ "$GATE_STATUS" -eq 0 ]]; then
  ok "gate:v2-preflight pass"
elif [[ "$GATE_STATUS" -eq 124 ]]; then
  warn "gate:v2-preflight timeout（${REPO_GATE_TIMEOUT_S}s）→ deferred（非 runtime unhealthy；full suite 见 nightly）"
else
  warn "gate:v2-preflight 非 0（repo gate 问题，非 runtime unhealthy；full suite 见 nightly）"
fi

# ── data quality（读取最近完整知识体检快照，只读，不跑 full health/dream/scan）──
# #441：运行健康与最近完整知识体检是两条独立状态链。本 section 在既有 MCP
# session 内调用 status，只读其 lastFullHealth 标量快照（availability/checkedAt/
# overallStatus/totalIssueCount/freshness，36h 新鲜度）。缺失/旧格式/损坏/过期一律
# 显示"未验证/已过期"，绝不输出"数据健康"；也不把知识体检结论计入 exit code。
section "data_quality"
LAST_HEALTH="最近完整知识体检：未验证（无法读取）"
if [[ "$MCP_OK" -eq 1 ]]; then
  ok "MCP 暴露 ${TOOL_COUNT} tools（汇总，不跑 full health/dream）"
  STATUS_JSON="$(curl -s -X POST "$CBRAIN_MCP_URL" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION" \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}' 2>&1 || true)"
  LAST_HEALTH="$(printf '%s' "$STATUS_JSON" | bun -e '
    const chunks = [];
    for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const jsonStart = text.indexOf("{");
    const payload = JSON.parse(jsonStart >= 0 ? text.slice(jsonStart) : text);
    const snapText = payload?.result?.content?.[0]?.text;
    const snap = snapText ? JSON.parse(snapText).lastFullHealth : undefined;
    const lines = [];
    if (snap && snap.availability === "available" && snap.freshness === "fresh") {
      const verdict = snap.overallStatus === "pass" ? "通过" : snap.overallStatus === "warn" ? "警告" : "失败";
      lines.push(`最近完整知识体检：${verdict}（检查时间 ${snap.checkedAt}，共 ${snap.totalIssueCount} 条信号）`);
      if (snap.overallStatus === "fail") {
        lines.push("注：知识体检失败不等于服务或检索不可用。");
      }
    } else if (snap && snap.availability === "available" && snap.freshness === "stale") {
      lines.push(`最近完整知识体检：已过期（检查时间 ${snap.checkedAt}，超过 36 小时，不作为当前保证）`);
    } else if (snap && snap.availability === "missing") {
      lines.push("最近完整知识体检：未验证（尚无完整 health 记录）");
    } else {
      lines.push("最近完整知识体检：未验证（记录缺失必要字段或已损坏）");
    }
    console.log(lines.join("\n"));
  ' 2>/dev/null || true)"
else
  warn "data_quality 跳过（MCP 不可用）"
fi
if [[ -z "$LAST_HEALTH" ]]; then
  LAST_HEALTH="最近完整知识体检：未验证（无法读取）"
fi
printf '%s\n' "$LAST_HEALTH" | sed 's/^/  /'

# ── summary（两个状态轴分行报告：运行健康决定 exit code；知识体检只报告）──
echo ""
echo "=== summary ==="
if [[ "$RUNTIME_FAIL" -gt 0 ]]; then
  echo "运行健康：异常"
  printf '%s\n' "$LAST_HEALTH" | sed 's/^/  /'
  echo "RESULT: runtime unhealthy（runtime/mcp section fail，见上 ✗）"
  exit 1
fi
echo "运行健康：正常"
printf '%s\n' "$LAST_HEALTH" | sed 's/^/  /'
echo "RESULT: runtime healthy（perf/repo_gate/data_quality 可能 deferred，非 unhealthy）"
exit 0
