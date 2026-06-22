#!/usr/bin/env bash
# bin/cbrain-maintenance.sh — Hermes script-dir-safe CBrain maintenance wrapper.
#
# 走 HTTP /mcp（single-writer serve 持有 writer），不裸调 CLI `cbrain dream`
# （dream 不过 single-writer gate，serve 在跑时并发写损坏数据，见 #208）。
#
# 放到 Hermes scripts 目录（policy 要求 script 在 scripts dir），crontab 调本脚本。
# 详见 docs/hermes-integration.md。
#
# Usage:
#   CBRAIN_MCP_URL=http://127.0.0.1:3399/mcp ./cbrain-maintenance.sh [dream]
#
# Exit codes: 0 = dream 已提交; 1 = runtime/protocol 错误; 2 = unsupported task

set -euo pipefail

CBRAIN_MCP_URL="${CBRAIN_MCP_URL:-http://127.0.0.1:3399/mcp}"
BASE="${CBRAIN_MCP_URL%/mcp}"
PROTOCOL_VERSION="2025-11-25"

TASK="${1:-dream}"
if [[ "$TASK" != "dream" ]]; then
  echo "unsupported task: $TASK (only 'dream' supported)" >&2
  exit 2
fi

# 1. health check — serve 必须在跑（它是唯一 writer）
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "FAIL: cbrain HTTP serve 未运行 (${BASE})。先启动 launchd ai.cbrain.serve。" >&2
  exit 1
fi

# 2. MCP initialize → mcp-session-id (从 response header 取，取不到就 fail)
INIT_HEADERS="$(curl -s -o /dev/null -D - -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"${PROTOCOL_VERSION}\",\"capabilities\":{},\"clientInfo\":{\"name\":\"cbrain-maintenance\",\"version\":\"1.0\"}}}" 2>&1)"

SESSION="$(printf '%s\n' "$INIT_HEADERS" | awk -F': ' 'tolower($1)=="mcp-session-id"{gsub(/[\r\n]/,"",$2); print $2; exit}')"

if [[ -z "$SESSION" ]]; then
  echo "FAIL: initialize 未返回 mcp-session-id header" >&2
  exit 1
fi

# 注册 session cleanup：脚本退出时（成功或失败）DELETE /mcp 释放 session，
# 不依赖 serve idle-TTL。cleanup 失败只 warning，不覆盖原始退出码
# （if 包裹，set -e 不触发；trap 不改退出码除非内部 exit）。
_session_cleanup() {
  if [[ -n "${SESSION:-}" ]]; then
    if ! curl -sf -X DELETE "$CBRAIN_MCP_URL" -H "mcp-session-id: $SESSION" >/dev/null 2>&1; then
      echo "WARN: MCP session cleanup (DELETE /mcp) 失败；session 将由 serve idle-TTL 清理" >&2
    fi
  fi
}
trap _session_cleanup EXIT

# 3. notifications/initialized
if ! curl -sf -o /dev/null -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' 2>&1; then
  echo "FAIL: notifications/initialized 失败" >&2
  exit 1
fi

# 4. tools/call dream (async, 返回 job；dream inputSchema 为空，自带循环锁)
if ! curl -sf -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dream","arguments":{}}}'; then
  echo "FAIL: tools/call dream 失败" >&2
  exit 1
fi

echo
echo "OK: dream 已通过 /mcp 提交（响应见上）。用 dream_status 查询进度。"
