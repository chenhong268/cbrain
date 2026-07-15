# CBrain 2.0 安装与上手指南

> 从零开始，10 分钟跑起来。

## 你会得到什么

一个跑在本地的知识引擎：你把内容喂进去（文字、笔记、对话），它自动提取人名/组织/概念，建图谱，之后随时搜索、查关系、问 Agent。

持久数据全在本地（SQLite + Markdown + LanceDB）。但向量嵌入、NER、洞察生成会把你输入的文本连同 API Key 发往你配置的模型 provider（智谱/DeepSeek）。

## 前置条件

| 需要 | 版本 | 怎么装 |
|:-----|:-----|:-------|
| **Bun** | ≥ 1.2 | `curl -fsSL https://bun.sh/install \| bash` |
| **智谱 API Key** | — | [open.bigmodel.cn](https://open.bigmodel.cn) 注册 → 创建 API Key |
| **Git** | 任意 | macOS 自带，或 `xcode-select --install` |
| **DeepSeek API Key**（可选） | — | [platform.deepseek.com](https://platform.deepseek.com)，用于洞察生成 |
| **SearXNG**（可选） | — | 仅用于 `stub-enrich --web` 网页补充，不影响本地记忆检索 |

> 智谱是硬依赖——向量嵌入和实体提取都靠它。没有 API Key 跑不起来。

---

## 第一步：安装

### 方式 A：Bun 全局安装（推荐）

```bash
# 安装指定版本 — 始终锁定到明确 tag，不要用 main 或 latest
bun install -g github:chenhong268/cbrain#v2.0.7
```

安装完成后确认：

```bash
cbrain --version   # 应输出 2.0.7
```

**PATH 注意事项：** Bun 全局安装的命令放在 `~/.bun/bin/`。如果 `cbrain` 命令找不到，确认 Bun 的 bin 目录在你的 PATH 里：

```bash
# 检查 Bun bin 目录
bun pm bin -g
# 应输出类似：/Users/you/.bun/bin

# 如果不在 PATH，加到 shell 配置（.zshrc / .bashrc）：
export PATH="$HOME/.bun/bin:$PATH"
```

**升级：**

```bash
bun remove -g cbrain
bun install -g github:chenhong268/cbrain#v<新版本号>
```

**卸载：**

```bash
bun remove -g cbrain
```

> **注意：** 独立发行版二进制暂未提供。当前支持的路径是上面这条版本锁定的 Bun 全局安装命令。

### 方式 B：从源码（开发者 / 贡献者）

```bash
git clone https://github.com/chenhong268/cbrain.git /path/to/cbrain
cd /path/to/cbrain
bun install
```

之后所有命令用 `bun run src/cli/index.ts` 代替 `cbrain`。

为了方便，可以加个 alias：

```bash
alias cbrain='bun run /path/to/cbrain/src/cli/index.ts'
```

---

## 第二步：初始化

```bash
cbrain init --dir /path/to/mybrain
```

加 `--json` 输出机器可读的 JSON（供 Agent/脚本解析）：

```bash
cbrain init --dir /path/to/mybrain --json
# → { "status": "ok", "configPath": "...", "readinessState": "missing_creds", "nextAction": { ... } }
```

如果配置已存在，`init` 默认拒绝覆盖。加 `--force` 显式覆盖（保留 DB 和 vault 数据）：

```bash
cbrain init --dir /path/to/mybrain --force
```

这会创建：

```
/path/to/mybrain/
  cbrain.json          ← 配置文件
  brain.sqlite         ← SQLite 数据库
  vault/               ← 你的知识库（Markdown 文件）
    records/           ← 原始记录
    brain/
      entities/        ← 人物、组织等实体页
      concepts/        ← 概念页
      insights/        ← 自动生成的洞察
  runtime/             ← 运行时文件（日志、健康报告、索引缓存）
```

### Runtime 和 Vault 为什么要分开

**Vault 是你的知识库。** 你可能把它放进 Git、Obsidian、云同步。它需要干净、可迁移。

**Runtime 是运行时的产物。** 日志、临时锁文件、健康报告、缓存。这些东西不应该进入你的知识库，也不应该被 Git 跟踪。

如果 runtime 放进 vault 里：
- 日志和锁文件会被 Obsidian 索引，搜索结果全是垃圾
- 云同步会锁死 SQLite，导致数据库损坏
- Git 仓库膨胀

`cbrain doctor --first-run` 会检测这个问题并警告你。

> **规则：runtime 和 vault 不要放在同一个目录下。** `init` 默认就是分开的，别手动改到一起。

---

## 第三步：配置 API Key

两种方式，选一种。

### 方式 A：环境变量（推荐，最快）

```bash
export ZHIPU_API_KEY=your-zhipu-api-key
```

CBrain 启动时会自动读取。加到 `.bashrc` 或 `.zshrc` 里持久化。

### 方式 B：编辑配置文件

编辑 `/path/to/mybrain/cbrain.json`：

```json
{
  "vaultPath": "/path/to/mybrain/vault",
  "dbPath": "/path/to/mybrain/brain.sqlite",
  "lancePath": "/path/to/mybrain/lancedb",
  "embedding": { "provider": "zhipu", "apiKey": "your-zhipu-api-key" },
  "ner": { "enabled": true, "llm_api_key": "your-zhipu-api-key" }
}
```

如果需要 DeepSeek（用于 `reflect` 洞察生成），在 `cbrain.json` 里加：

```json
{
  "reflect": {
    "llm_provider": "deepseek",
    "llm_api_key": "your-deepseek-api-key"
  }
}
```

> **注意：** 配置文件（`cbrain.json`）仅保存在本地。调用 embedding/NER/reflect 时，API Key 会作为认证信息发送至你配置的 provider（智谱/DeepSeek），待处理文本一并发送。

### 可选：网页补充搜索

CBrain 的核心路径不需要 SearXNG。你不配置 `search` 时，`ingest`、`query`、`deep_recall`、图谱查询和本地维护都照常运行；薄 stub 充实时只使用 CBrain 内部上下文。

只有在你显式运行 `cbrain stub-enrich --web`，并且配置了 search provider 时，CBrain 才会调用网页搜索。当前内置 provider 是 SearXNG：

```json
{
  "search": {
    "provider": "searxng",
    "base_url": "http://127.0.0.1:8080"
  }
}
```

如果 SearXNG 未配置或不可达，stub enrichment 会降级为内部上下文，不会影响本地记忆系统。Brave Search、Tavily 等 API 型 provider 可以作为后续适配方向，但不是安装前置条件。

---

## 第四步：验证安装

```bash
cbrain doctor --first-run
```

这个命令跑 6 个类别的检查：

| 类别 | 检什么 |
|:-----|:-------|
| Config | `cbrain.json` 存在、路径配置完整 |
| Credentials | `ZHIPU_API_KEY` 已配置（环境变量或 config） |
| Paths | vault 存在、数据库目录可写、runtime 目录可写、runtime 不在 vault 里 |
| Database | SQLite 连接正常、WAL 模式激活、表结构完整 |
| Index | FTS5 全文索引就绪、LanceDB 向量库可连接 |
| Services | 检测残留的 PID 锁文件 |
| MCP Guidance | 打印 Agent 连接配置 |

全部通过会看到：

```
✓ Config       cbrain.json found, paths configured
✓ Credentials  ZHIPU_API_KEY available
✓ Paths        vault, db, runtime all accessible
✓ Database     SQLite connected, WAL active, schema ready
✓ Index        FTS5 built, LanceDB connected
✓ Services     No stale locks
✓ MCP          Ready

All checks passed.
```

如果用 Agent 做自动化检查，加 `--json`：

```bash
cbrain doctor --first-run --json
```

返回结构化 JSON，每项有 `status: pass|fail|warn`，还有 `readinessState`（`no_config` / `missing_creds` / `missing_index` / `service_active` / `ready`）、`recommendedNextAction`（string，向后兼容）和 `nextAction`（`{ id, command, message }` 结构化对象）。Agent 应优先解析 `nextAction`。

---

## 第五步：写入第一条知识

```bash
cbrain ingest --type text --title "关于实体A的备忘" "实体A是产品经理，向实体B汇报"
```

这会：
1. 创建一个 record 页面
2. 自动提取实体（实体A、实体B）
3. 在知识图谱里建立关系
4. 生成向量索引

验证写入：

```bash
cbrain query "实体A"           # 搜索
cbrain show brain/entities/person/shi-ti-a  # 查看实体详情（slug 会自动生成）
cbrain status                  # 查看整体统计
```

---

## 第六步：获取 Agent 连接配置

```bash
cbrain mcp-config
```

输出直接可用的 MCP 配置 JSON：

```json
{
  "mcpServers": {
    "cbrain": {
      "command": "<自动检测的命令>",
      "args": ["serve"],
      "env": {
        "CBRAIN_CONFIG": "/path/to/mybrain/cbrain.json"
      }
    }
  }
}
```

把这个 JSON 复制到你的 Agent 配置文件即可。`cbrain mcp-config` 自动检测当前安装方式（全局安装或源码运行），无需手动编辑命令路径。

> **注意：** 输出不含任何 API Key。凭证通过环境变量或 config 文件提供，不会泄露到 Agent 配置里。

### 上面是 stdio 配置——我该用 stdio 还是 HTTP？

两种传输方式，按拓扑选：

- **stdio（上面这个，默认）**：每个 Agent 自己 spawn 一个 `cbrain serve`。适合**单用户本地开发**——就你一个 Agent、没有常驻 serve、没有并发写。
- **HTTP（`--http`）**：所有 Agent / cron 共用一个常驻 `cbrain serve --http` 的 `/mcp`。适合 **Hermes 等多 Agent / 持久 serve 拓扑**——这是 single-writer 模型的正确姿势（见 [Hermes Integration](hermes-integration.md)）。给每个 Agent 各自 spawn stdio serve 会撞 single-writer gate 或并发写坏数据。

Hermes 日常 Agent 用 HTTP 配置：

```bash
cbrain mcp-config --http
```

```json
{
  "mcpServers": {
    "cbrain": {
      "url": "http://127.0.0.1:3399/mcp",
      "headers": { "X-CBrain-Tool-Profile": "agent" }
    }
  }
}
```

`agent` profile 让日常 session 只看到 recall / 读写 / 图谱等用户态工具，**摸不到** `sync`/`dream` 这些慢维护工具——这样一次慢调用不会毒化整个 MCP client 把记忆接口搞挂（#264）。可加 `--port`/`--host`/`--profile` 覆盖。timeout 边界与防毒化原理见 [Hermes Integration](hermes-integration.md)（「Daily Agent MCP config」段）。

---

## 第七步：验证 Hermes 技能包（可选）

如果你使用 Hermes Agent，CBrain 附带一套完整的技能文件（路由规则、评估数据、交互协议）。验证技能包是否完整：

```bash
cbrain skill-pack
```

输出包含版本号、文件路径、完整性状态：

```
  CBrain Skill Pack v2.0.7
    Pack:       /path/to/skills/
    Entrypoint: /path/to/skills/SKILL.md (2,807 chars)

    Required files: 33/33 present
    Status: PASS
```

把技能包部署到 Hermes 的技能目录（**必须按预检流程**，避免覆盖已有内容或嵌套安装）：

```bash
# 1. 取得技能包路径
cbrain skill-pack
# 输出中的 Pack: 行即为技能包绝对路径（记为 <pack-path>）

# 2. 安装前预检（必须）——根据返回的 target status 决定下一步：
cbrain skill-pack --target ~/.hermes/skills/brain-ops/cbrain
#   - missing   → 该路径不存在，继续 step 3 安装
#   - current   → 已是 canonical pack，无需安装，到此结束
#   - stale        → 同版本（packVersion + 文件清单一致）但某文件内容变化；
#   - incompatible → packVersion 或文件清单不同（旧版本 / 私有 skill / 损坏）；
#   - unverified   → canonical pack 自身无法作基线；
#     以上三类人工排查后再决定；不要直接覆盖

```

3. 安装（仅当 step 2 报 missing）。**方式 A / B 二选一，不要都执行**——连续执行会让 copy 沿 symlink 写回 canonical pack，产生嵌套副本。stale / incompatible / unverified 一律人工排查后再决定，**不提供覆盖命令**。

**方式 A：复制（默认推荐，用于稳定 Hermes）**

```bash
mkdir -p ~/.hermes/skills/brain-ops
cp -r "<pack-path>" ~/.hermes/skills/brain-ops/cbrain
```

- 优点：部署的是审核过的确定快照；文件落在 Hermes trusted root（`~/.hermes/skills`）内；CBrain checkout 后续修改不会自动进入真实 Agent。
- 代价：CBrain 升级后 canonical packVersion 变化，该副本会变成 incompatible，需重新人工备份旧 target、重新复制、再 `cbrain skill-pack --target` verification。

**方式 B：符号链接（仅开发/试验环境，非生产默认）**

```bash
mkdir -p ~/.hermes/skills/brain-ops
ln -s "<pack-path>" ~/.hermes/skills/brain-ops/cbrain
```

- 风险：当 symlink 解析后的目标落在 Hermes trusted directory（`~/.hermes/skills`）之外（如指向活跃 checkout），Hermes loader 的 resolved-path 信任检查可能记录安全告警；
- 风险：checkout 中的 skill 文件变化会立即影响 Hermes，把尚未发布的修改静默带进真实 Agent；
- 适合本地开发联调，不作为稳定生产 Agent 的默认安装方式。

4. 安装后验证（应报 current）：

```bash
cbrain skill-pack --target ~/.hermes/skills/brain-ops/cbrain
```

> **加载契约：** Hermes 扫描 `~/.hermes/skills/<dir>/SKILL.md` 找入口。上述命令把 pack 复制/链接到 `brain-ops/cbrain` 根，`SKILL.md` 直达 target root（不嵌套）。加载路径同源由 `cbrain skill-pack --target` 保证；Hermes 运行时是否读取 `SKILL.md` 见 `docs/known-issues.md`，真实 Hermes 加载 smoke 留作合并后 release gate。

> **注意：** Hermes 是目前主要验证的 Agent 运行时。其他 MCP 客户端（Claude Desktop、Cursor 等）可以连接 `cbrain serve`，但还没有同等的路由规则验证。

---

## 第八步：启动服务

### HTTP 模式（推荐用于 Hermes / 多 Agent / 常驻服务）

```bash
cbrain serve --http --port 3399
```

启动后：
- `http://localhost:3399/health` — 健康检查
- `http://localhost:3399/tools` — 列出所有工具
- `http://localhost:3399/tools/{tool_name}` — POST 调用任意工具

HTTP 模式会自动启动文件监听，vault 里的文件变化会实时同步到索引。

### MCP stdio 模式（单用户本地开发）

```bash
cbrain serve
```

Agent 配置用 `cbrain mcp-config` 生成（见第六步）。**仅限单 Agent 本地开发**——多 Agent / 持久 serve 场景用上面的 HTTP 模式 + `cbrain mcp-config --http`，否则会撞 single-writer gate（#208）。

> **提示：** `serve` 默认 MCP stdio 模式。加 `--http` 切到 HTTP 模式。两个模式不能同时跑（PID 锁保护）。

> **工具暴露面（profile）**：日常 Agent 不必面对全部 98 个工具。HTTP `/mcp` 支持按 session 选 profile（请求头 `X-CBrain-Tool-Profile: agent`），让 Agent 只看到 recall / 读写 / 图谱等用户态工具；stdio 模式用环境变量 `CBRAIN_MCP_TOOL_PROFILE=agent`。详见 [MCP 工具参考 · 工具暴露面 Profile](mcp-tools.md#工具暴露面-profile251)。Profile 是降噪音的人体工学边界，不是安全边界。

---

## 第九步：Smoke Test

跑完上面所有步骤后，用这个清单确认一切正常：

```bash
# 1. 写入
cbrain ingest --type text --title "smoke test" "测试组织B是一家科技公司"

# 2. 搜索（应该能搜到）
cbrain query "组织B"

# 3. 实体提取（应该自动创建了组织B的实体页）
cbrain list --type entity/company

# 4. 健康检查
cbrain doctor --first-run

# 5. HTTP 服务（可选）
cbrain serve --http &
curl http://localhost:3399/health
# 预期返回：{"ok":true,"tools":<正整数>}
kill %1
```

全部通过 → 你的 CBrain 已经就绪。

---

## 日常使用

> 下表是 CLI 手动操作；Agent 自然语言提问默认走 `cbrain_recall` 工具（前门，CBrain 内部分发）。

| 你想做什么 | 命令 |
|:-----------|:-----|
| 记一段话 | `cbrain ingest "内容" --title "标题"` |
| 记一个文件 | `cbrain ingest @/path/to/file.md --type markdown` |
| 搜东西 | `cbrain query "关键词"` |
| 查某个实体 | `cbrain show <slug>` |
| 查关系 | `cbrain graph-query <slug> --mode traverse` |
| 列出所有实体 | `cbrain list --type entity` |
| 看整体状态 | `cbrain status` |
| 检查健康 | `cbrain doctor --first-run` |

### 定期维护

```bash
# serve --http 正在运行时，定期维护必须经 single-writer wrapper 走 HTTP /mcp
CBRAIN_MCP_URL=http://127.0.0.1:3399/mcp bin/cbrain-maintenance.sh dream
```

裸 `cbrain dream` / `cbrain sync` / `cbrain enrich` 只用于离线一次性维护：先停掉常驻 `serve --http`，确认没有其他 writer 后再手动执行。

---

## 升级

### 全局安装用户

```bash
bun remove -g cbrain
bun install -g github:chenhong268/cbrain#v<新版本号>
cbrain doctor --first-run  # 验证升级后一切正常
```

### 源码用户

```bash
cd /path/to/cbrain
git pull
bun install              # 更新依赖
bun run dev doctor --first-run  # 验证升级后一切正常
```

数据库 schema 变更会自动迁移（`initSchema` 检测新表/新列，`config` 表防重复迁移）。

### 启动迁移说明

CBrain 在启动时自动执行数据库 schema 迁移。了解以下行为有助于排查问题：

**迁移在原 DB 内事务执行。** 表重建类迁移（pages、chunks、ontology）在 SQLite 事务内完成：CREATE new → INSERT → DROP old → RENAME。任何步骤失败，事务回滚，DB 保持迁移前状态。

**失败会回滚并阻止启动。** 如果迁移失败，CBrain 构造函数会关闭数据库连接并抛错。服务不会启动。修复冲突数据后重试即可（修复后再次 `cbrain serve` 或 `cbrain sync`）。

**迁移完成标记。** 每条迁移在 `config` 表写入 `migration_<name>=1` 标记。已完成的迁移不会重复执行。迁移前会验证 schema、行数、约束，验证失败同样回滚。

**不要手动干预。**

- ❌ 不要删除 `_new` 临时表（如 `pages_new`、`chunks_new`）— 如果同时存在生产表和临时表，迁移会自动清理
- ❌ 不要删除 `config` 表里的 `migration_*` 标记 — 会导致已完成迁移重新执行
- ⚠️ 迁移失败后先根据错误信息修复数据行（如删除冲突记录、修正非法字段值），然后重启。如果 schema 本身已畸形（表缺失、列错乱），应从备份恢复而非手动修补

**升级前保留备份。**

```bash
cbrain backup  # 升级前先备份
```

如果升级后遇到问题：

```bash
cbrain health --full      # 完整健康检查
cbrain doctor --first-run # 基础设施检查
cbrain backup             # 先备份再排查
```

---

## Troubleshooting

| 问题 | 原因 | 解决 |
|:-----|:-----|:-----|
| **`Permission denied` 写入 vault/runtime** | 目录权限不对 | `chmod 755 /path/to/vault /path/to/runtime`，确保当前用户有写权限 |
| **`duplicate title` 错误** | 同名页面已存在 | CBrain 的 title 是唯一的。用 `cbrain list` 查看现有页面，改名或用已有 slug |
| **`watcher lock` / PID 锁残留** | 上次进程非正常退出 | 先 `cbrain doctor` 确认无活动 serve 进程（`pgrep -f 'cbrain.*serve'`）；确认是 stale 残留锁后，删除 `<profile>/cbrain-http.pid` 或 `<profile>/cbrain-stdio.pid` 再重启。`cbrain serve --force` 会跳过 PID 检查、并发可能损坏索引，仅在你确定无活动进程时用 |
| **runtime 在 vault 里的警告** | `runtimePath` 配置指向 vault 内部 | 编辑 `cbrain.json`，把 `runtimePath` 改到 vault 外面（如 `/path/to/mybrain/runtime`） |
| **`Port 3399 already in use`** | 已有一个 HTTP 服务在跑 | `kill $(lsof -ti:3399)` 关掉旧进程，或用 `--port` 换端口 |
| **`FTS5: syntax error`** | 搜索词包含特殊字符 | 用空格分隔关键词，避免 `OR`、`AND`、引号等 FTS5 保留字 |
| **`LanceDB connection failed`** | 向量库损坏 | 先 `cbrain backup` 备份、`cbrain doctor` 诊断，再重建：单页 `cbrain sync --slug <slug> --reindex`，整库损坏 `cbrain sync --reindex-vectors`（watcher 隔离页等进阶场景见 [known-issues](known-issues.md)）。**切勿直接删除 `lancedb/`** |
| **`RESTORE_CLEANUP_INCOMPLETE`** | 数据库/vault 主恢复已经完成，但精确托管残留未能在有限重试后验证清除 | 保持所有 CBrain 服务停止；不要立刻重跑 restore。按下方步骤检查 residual，只在确认旧数据无需保留后手动清理，再重新执行 restore |
| **NER 提取不到实体** | API Key 未配置或余额不足 | 检查 `cbrain.json` 里 `ner.llm_api_key` 或环境变量 `ZHIPU_API_KEY`；到智谱控制台检查余额 |
| **`bun: command not found`** | Bun 未安装或不在 PATH | `curl -fsSL https://bun.sh/install \| bash`，然后重启终端 |

### `RESTORE_CLEANUP_INCOMPLETE` 处理步骤

1. 保持 HTTP/stdio server、watcher 和其他 CBrain writer 全部停止。
2. 根据当前 profile 的 `dbPath` / `vaultPath` 检查精确的 restore 托管残留。不要因为命令返回非零就覆盖或回滚当前数据库/vault：主恢复已经完成，新数据仍是 active 状态。
3. 先备份仍存在的 residual；确认其中旧数据无需保留后，才手动删除对应精确条目。
4. 重新运行 restore。`.pre-restore` 或 `.rollback` 仍存在时，preflight 会继续拒绝执行；WAL/SHM 清理失败也要求服务保持停止，但普通 WAL/SHM 文件本身不被当成上一轮 residual guard。

CBrain 只删除本轮 restore 自己创建/接管的 `.pre-restore` 和 `.rollback`。如果某个同名条目在 preflight 后才由 File Provider 或外部进程物化，本轮只会返回 cleanup-incomplete，不会删除或把它装成 active 数据。

递归删除可能在报错前已完成一部分，因此 residual 只代表“停止重试时尚存的内容”，不保证是旧 vault 的完整副本。若 File Provider/云盘生成了 `brain 2`、`records 2` 等编号目录，restore 不会扫描或自动删除它们；按 [Issue #341](https://github.com/chenhong268/cbrain/issues/341) 的 observability/人工清理边界处理，非空或未托管目录一律先人工核对。

---

## 目录结构速查

```
/path/to/mybrain/           ← 项目根目录
  cbrain.json               ← 配置（路径、API Key）
  brain.sqlite              ← SQLite 数据库
  lancedb/                  ← 向量索引（首次使用时创建）
  vault/                    ← 知识库（可 Git 跟踪、可 Obsidian 打开）
    records/                ← 原始记录
    brain/
      entities/             ← 实体页（人物/组织/...）
        person/             ← 人物
        company/            ← 组织
        ...
      concepts/             ← 概念
      events/               ← 事件
      insights/             ← 自动生成的洞察
  runtime/                  ← 运行时（不要 Git 跟踪）
    logs/                   ← 日志
    health/                 ← 健康报告
    *.pid                   ← 进程锁文件
```

---

## 更多文档

| 文档 | 内容 |
|:-----|:-----|
| [使用指南](usage.md) | CLI 命令详解、工作流示例 |
| [MCP 工具参考](mcp-tools.md) | 所有 MCP 工具的完整说明 |
| [Vault 文件规范](vault-spec.md) | Markdown + YAML frontmatter 格式 |
| [架构设计](design.md) | 内部架构和数据流 |
