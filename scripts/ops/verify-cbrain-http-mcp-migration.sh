#!/bin/bash
# verify-cbrain-http-mcp-migration.sh
# 只读验证 CBrain phase-3 HTTP MCP 迁移状态。不修改任何东西,不 kill 进程,
# 不打印 secrets,不打印本地 profile 名/路径(只匿名 config[i] label)。
# 退出码 = 失败数(0 = 全过)。
#
# Config 路径参数化(不硬编码本地 profile 名):
#   CBRAIN_REQUIRED_MCP_CONFIGS  冒号分隔的必需 Hermes config(必须全指向 cbrain HTTP url)
#                               默认: $HOME/.hermes/config.yaml
#   CBRAIN_OPTIONAL_MCP_CONFIGS  冒号分隔的可选 config(有则查,无则跳过;默认空)
#
# 依赖: curl、lsof、launchctl、python3+PyYAML。
# 用法:
#   bash scripts/ops/verify-cbrain-http-mcp-migration.sh
#   CBRAIN_REQUIRED_MCP_CONFIGS="$HOME/.hermes/config.yaml:$HOME/.hermes/profiles/<secondary>/config.yaml" \
#   CBRAIN_OPTIONAL_MCP_CONFIGS="$HOME/.hermes/profiles/<optional>/config.yaml" \
#   bash scripts/ops/verify-cbrain-http-mcp-migration.sh

set -uo pipefail

CBRAIN_URL="http://127.0.0.1:3399"
DEFAULT_REQUIRED="$HOME/.hermes/config.yaml"
REQUIRED_CONFIGS="${CBRAIN_REQUIRED_MCP_CONFIGS:-$DEFAULT_REQUIRED}"
OPTIONAL_CONFIGS="${CBRAIN_OPTIONAL_MCP_CONFIGS:-}"

PASS=0
FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

if ! python3 -c "import yaml" 2>/dev/null; then
  echo "ABORT: python3 PyYAML 不可用 — pip install pyyaml" >&2
  exit 99
fi

# 读 cbrain 子配置字段。$1 是 shell 已展开的绝对路径(不是 ~),open() 直接用。
cbrain_field() { # $1=config-path $2=field
  python3 -c "
import yaml
d=yaml.safe_load(open('$1')) or {}
cb=((d.get('mcp_servers') or {}).get('cbrain')) or {}
v=cb.get('$2')
print('' if v is None else v)
" 2>/dev/null
}

IFS=':' read -ra REQ <<< "$REQUIRED_CONFIGS"
OPT=()
if [ -n "$OPTIONAL_CONFIGS" ]; then IFS=':' read -ra OPT <<< "$OPTIONAL_CONFIGS"; fi

echo "=== 1. launchd: ai.cbrain.serve 唯一 CBrain HTTP owner ==="
if [ "$(launchctl list 2>/dev/null | grep -c 'ai.cbrain.serve' || true)" -eq 1 ]; then
  ok "ai.cbrain.serve loaded"
else
  fail "ai.cbrain.serve not loaded exactly once"
fi
if [ "$(launchctl list 2>/dev/null | grep -c 'ai.cbrain.http' || true)" -eq 0 ]; then
  ok "ai.cbrain.http (legacy dist plist) not loaded"
else
  fail "ai.cbrain.http still loaded — legacy, should be removed"
fi

echo "=== 2. 端口 3399 只有一个 listener ==="
L=$(lsof -nP -iTCP:3399 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN || true)
[ "$L" -eq 1 ] && ok "listeners=$L" || fail "listeners=$L (expected 1)"

echo "=== 3. CBrain writer 进程数 = 1 ==="
W=$(ps -eo command | grep -i 'cbrain.*serve' | grep -v grep | grep -v 'verify-cbrain' | wc -l | tr -d ' ')
[ "$W" -eq 1 ] && ok "cbrain serve processes=$W" || fail "cbrain serve processes=$W (expected 1 — single writer)"

echo "=== 4. /health ==="
H=$(curl -s -o /dev/null -w '%{http_code}' "$CBRAIN_URL/health" 2>/dev/null || echo 000)
[ "$H" = "200" ] && ok "/health 200" || fail "/health -> $H"

echo "=== 5. /mcp initialize / listTools / call status ==="
INIT=$(curl -s -D /tmp/cbrain-v-h -o /dev/null -w '%{http_code}' -X POST "$CBRAIN_URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}' 2>/dev/null || echo 000)
SID=$(grep -i '^mcp-session-id:' /tmp/cbrain-v-h 2>/dev/null | tr -d '\r' | awk '{print $2}')
if [ -n "$SID" ] && [ "$INIT" = "200" ]; then ok "initialize (session acquired)"; else fail "initialize http=$INIT sid=${SID:-<none>}"; fi
if [ -n "$SID" ]; then
  LT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CBRAIN_URL/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $SID" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 2>/dev/null || echo 000)
  [ "$LT" = "200" ] && ok "tools/list" || fail "tools/list -> $LT"
  CALL=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CBRAIN_URL/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $SID" \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}' 2>/dev/null || echo 000)
  [ "$CALL" = "200" ] && ok "tools/call status" || fail "tools/call status -> $CALL"
  curl -s -o /dev/null -X DELETE "$CBRAIN_URL/mcp" -H "mcp-session-id: $SID" 2>/dev/null || true
fi
rm -f /tmp/cbrain-v-h

echo "=== 6. 必需 Hermes configs: cbrain 无 stdio command/args/env ==="
i=0
for cfg in "${REQ[@]}"; do
  i=$((i+1))
  if [ ! -f "$cfg" ]; then fail "config[$i] missing"; continue; fi
  CMD=$(cbrain_field "$cfg" command)
  URL=$(cbrain_field "$cfg" url)
  if [ -z "$CMD" ] && [ -n "$URL" ]; then ok "config[$i]: HTTP (no command)"; \
     else fail "config[$i]: still stdio (command present) or missing url"; fi
done

echo "=== 7. 必需 Hermes configs 指向 http://127.0.0.1:3399/mcp ==="
i=0
for cfg in "${REQ[@]}"; do
  i=$((i+1))
  [ -f "$cfg" ] || { fail "config[$i] missing"; continue; }
  URL=$(cbrain_field "$cfg" url)
  [ "$URL" = "$CBRAIN_URL/mcp" ] && ok "config[$i]: url correct" || fail "config[$i]: url='${URL:-<none>}'"
done

echo "=== 8. 可选 config(无 cbrain 放行;有 cbrain 必须 HTTP,同 required 校验) ==="
if [ "${#OPT[@]}" -eq 0 ]; then
  ok "no optional configs specified (skipped)"
else
  j=0
  for cfg in "${OPT[@]}"; do
    j=$((j+1))
    if [ ! -f "$cfg" ]; then ok "optional[$j]: absent (ok, not required)"; continue; fi
    HAS=$(python3 -c "
import yaml
d=yaml.safe_load(open('$cfg')) or {}
print('yes' if ((d.get('mcp_servers') or {}).get('cbrain')) else 'no')
" 2>/dev/null || echo "?")
    if [ "$HAS" != "yes" ]; then
      ok "optional[$j]: no cbrain (ok)"
      continue
    fi
    # 有 cbrain → 与 required 同样严格:必须 no command + url 正确,否则该 profile
    # 启动会 spawn stdio writer,重新制造多 writer(违反 #208)。
    CMD=$(cbrain_field "$cfg" command)
    URL=$(cbrain_field "$cfg" url)
    if [ -z "$CMD" ] && [ "$URL" = "$CBRAIN_URL/mcp" ]; then
      ok "optional[$j]: cbrain HTTP (no command, url correct)"
    else
      fail "optional[$j]: cbrain present but NOT migrated — would spawn stdio writer"
    fi
  done
fi

echo
echo "=== SUMMARY: $PASS passed, $FAIL failed ==="
exit "$FAIL"
