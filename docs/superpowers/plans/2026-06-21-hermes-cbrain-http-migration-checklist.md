# Hermes CBrain HTTP MCP 迁移 checklist（#213 phase 3）

> **dry-run 产物**：本文 + `scripts/ops/verify-cbrain-http-mcp-migration.sh` 是迁移包，审核通过后选停机窗口按 checklist 执行。**本文不执行任何现网变更。**
>
> 前置：cbrain main 已含 #208（single-writer gate）+ #213（/mcp）。现网 HTTP serve 跑源码（launchd `ai.cbrain.serve` → `<repo>/bin/cbrain-serve-http.sh`），重启即加载 /mcp。
>
> **匿名化约定**（可识别信息不进公开 repo）：`default profile` = Hermes default；`secondary profile` = 另一个必需 cbrain 的 profile；`optional profile` = 不强制 cbrain 的 profile。真实 profile 名 / 路径 / lock-id / env value 只在执行者本地命令里，本文用占位符 `<repo>`、`<profile-home>`、`<secondary>`、`<optional>`、`<lock-id>`、`<redacted>`。

## 架构决策

- **CBrain HTTP runtime 唯一 owner**：launchd `ai.cbrain.serve`（跑源码，重启即 /mcp + gate）。
- **Hermes gateway 不再 spawn CBrain stdio**。
- `default profile` + `secondary profile` 的 `mcp_servers.cbrain` 从 stdio 改 HTTP url。
- `optional profile` 无 cbrain 配置，不改。
- 不使用 `CBRAIN_UNSAFE_ALLOW_MULTI_WRITER`（emergency rescue 才用）。

## Config diff 草案（形状；真实路径/lock-id 在本地）

> 两个必需 profile 的 stdio 入口可能不同（直接 `<runner> <repo>/src/cli/index.ts serve` 或 `<repo>/bin/cbrain-serve.sh`），但改 HTTP 后都去掉 `command/args/env` 换 `url`，入口差异不再相关。

### `<profile-home>/config.yaml`（default profile 与 secondary profile 同形状）

```diff
 mcp_servers:
   cbrain:
     enabled: true
-    command: <runner>            # e.g. bun 或 <repo>/bin/cbrain-serve.sh
-    args: [...]                  # e.g. run --smol <repo>/src/cli/index.ts serve（或 []）
-    env:
-      CBRAIN_CONFIG: <repo>/cbrain.json
-      CBRAIN_LOCK_ID: <lock-id>  # per-profile
-      ZHIPU_API_KEY: <redacted>
+    url: http://127.0.0.1:3399/mcp
+    timeout: 300
+    connect_timeout: 60
```

### optional profile

默认无 cbrain 配置，不改。**但如果某个 optional profile 实际配了 `mcp_servers.cbrain`，也必须迁移到 HTTP `/mcp`（不能保留 stdio command）** —— 否则该 profile 一旦启动会 spawn stdio writer，重新制造多 writer，违反 #208。验证脚本对存在的 optional cbrain 配置执行与 required 相同的校验（no command + 正确 url 才 pass）。

## 停机迁移 checklist

### 迁移前

- [ ] 备份 config：`cp <profile-home>/config.yaml <profile-home>/config.yaml.bak-$(date +%Y%m%d)`（default + secondary 都备份）
- [ ] 确认 cbrain main 含 #208+#213：`git -C <repo> log --oneline -8`
- [ ] 确认 launchd 跑源码（重启即 /mcp）：`grep 'exec bun' <repo>/bin/cbrain-serve-http.sh`
- [ ] 确认无 dream.lock 卡：`sqlite3 <data-dir>/brain.sqlite "SELECT value FROM config WHERE key='dream.lock';"`（空才继续；非空先 `DELETE`）

### 停机窗口（逐个 profile；profile 是全局参数放在 gateway 前；**不用 `--all`**）

- [ ] `hermes --profile <secondary> gateway stop`
- [ ] `hermes --profile <optional> gateway stop`
- [ ] `hermes gateway stop`（default，无 `--profile`）
- [ ] 等 2–3 秒，确认 Hermes spawn 的 cbrain stdio 退出：
  - `ps -eo pid,ppid,command | grep 'cbrain.*serve' | grep -v grep`
  - 应只剩 launchd 的 HTTP serve（PPID=1），**无 stdio**

### 应用 config diff

- [ ] 编辑 default profile 的 config：`mcp_servers.cbrain` 按 diff 改 url
- [ ] 编辑 secondary profile 的 config：同
- [ ] yaml 校验（**注意 Python `open()` 不展开 `~`，用 pathlib**）：
  - `python3 -c "import yaml, pathlib; yaml.safe_load(open(pathlib.Path.home()/'.hermes/config.yaml'))"`
  - secondary profile config 同样校验，把路径替换为该 profile 的 config

### 重启 ai.cbrain.serve（加载 #213 /mcp）

- [ ] `launchctl kickstart -k "gui/$(id -u)/ai.cbrain.serve"`
- [ ] 等 3 秒，`curl -s http://127.0.0.1:3399/health` → `{"ok":true,...}`
- [ ] 确认 /mcp：POST `http://127.0.0.1:3399/mcp` initialize → 200 + `mcp-session-id`
- [ ] 确认 gate 没挡（此刻无 stdio writer，gate 应放行）：HTTP serve stderr 无 `refused to start`

### 启动 Hermes gateways（逐个，profile 在 gateway 前；**不用 `--all`**）

- [ ] `hermes gateway start`（default，无 `--profile`）
- [ ] `hermes --profile <optional> gateway start`
- [ ] `hermes --profile <secondary> gateway start`
- [ ] 等 3 秒

### 验证

- [ ] 跑验证脚本（传入真实 profile config 路径；输出匿名 `config[i]`）：
  ```bash
  CBRAIN_REQUIRED_MCP_CONFIGS="$HOME/.hermes/config.yaml:$HOME/.hermes/profiles/<secondary>/config.yaml" \
  CBRAIN_OPTIONAL_MCP_CONFIGS="$HOME/.hermes/profiles/<optional>/config.yaml" \
  bash <repo>/scripts/ops/verify-cbrain-http-mcp-migration.sh
  ```
  → 全 ✓（SUMMARY 0 failed）
- [ ] `hermes gateway status` → 所有 profile ✓
- [ ] 手动：让 default + secondary profile 的 Agent 调 read-only（`status`）+ write（测试性 `ingest`），确认正常返回、无多 writer 错误
- [ ] Hermes 日志无报错：`tail -100 ~/.hermes/logs/gateway.log` 无 `ClosedResourceError` / `database is locked` / `Too many concurrent writers`
- [ ] 观察 30 秒，无新 cbrain stdio 被 spawn：`ps -eo pid,ppid,command | grep 'cbrain.*serve' | grep -v grep`（只有 1 个 HTTP）

### Rollback（出问题时）

- [ ] 停 gateways（逐个，profile 在 gateway 前）
- [ ] 恢复 config：`cp <profile-home>/config.yaml.bak-* <profile-home>/config.yaml`（每个 profile）
- [ ] `launchctl kickstart -k "gui/$(id -u)/ai.cbrain.serve"`
- [ ] 启 gateways（逐个）
- [ ] 注：rollback 回到多 writer stdio（临时止血），随后排查 gate / config 问题再重试

### 禁止

- ⚠️ 不用 `CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1`（除非 emergency rescue，且记录原因）
- ⚠️ 不 `hermes gateway restart --all`（有 bug）
- ⚠️ profile 参数必须 `hermes --profile <name> <command>`，**不是** `hermes <command> --profile <name>`
- ⚠️ 不手动 `cbrain serve`（多进程重叠）
- ⚠️ 不用 `gateway stop --all` / `start --all`（逐个 profile）
- ⚠️ 不在迁移完成前 push cbrain main / release / close #208 #213
