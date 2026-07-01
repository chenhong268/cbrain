# CBrain 使用指南

> **首次安装？** → [安装与上手指南](install-onboarding.md)

## 快速开始

### 1. 安装

```bash
git clone https://github.com/chenhong268/cbrain.git
cd cbrain
bun install
```

依赖：Bun >= 1.2，智谱 API Key（用于向量检索和 NER）

### 2. 初始化

```bash
cbrain init
```

会在当前目录创建 `cbrain.json` 配置文件和 `vault/` 目录。vault 目录结构：

```
vault/
├── raw/          # 你的原始文件（会议纪要、读书笔记等），CBrain 只读
│   ├── events/
│   └── records/
├── brain/        # CBrain 自动生成的内容，可读写
│   ├── entities/   # 人物、公司、组织
│   ├── concepts/   # 概念、方法论、原则
│   ├── events/     # 事件、会议、里程碑
│   ├── records/    # 文档、报告、方案
│   └── sources/    # 书籍、文章、参考资料
```

### 3. 录入第一批内容

```bash
# 录入一条人物
cbrain ingest --type text --title "人物A" --page-type entity "产品经理，负责AI产品线"

# 录入一篇文档
cbrain ingest --type markdown --title "周会纪要0401" --page-type record @meeting.md

# 用 @ 前缀从文件读取
cbrain ingest --type text --title "项目管理原则" --page-type concept @principles.txt
```

### 4. 搜索

```bash
# CLI 默认 strategy=all（全量混合：向量 + 全文 + 图谱）
# 注意：MCP 工具 query 默认 smart（FTS 优先，空则混合），与 CLI 不同
cbrain query "人物A的项目"

# 只看全文匹配
cbrain query "人物A" --strategy fts

# 只看语义相似
cbrain query "怎么优化性能" --strategy vector
```

---

## CLI 命令参考

### 大脑管理

| 命令 | 说明 |
|------|------|
| `cbrain init` | 新建一个大脑 |
| `cbrain status` | 看一眼统计：多少页、多少关系、按类型分布 |
| `cbrain dream` | 夜间全量维护：备份 → 同步 → 充实 → 学习 → 清理 → 体检 → 报告（带锁） |
| `cbrain config` | 查看当前配置 |
| `cbrain config --set key=value` | 修改配置（如 `ner.enabled=false`） |

### 内容操作

| 命令 | 说明 |
|------|------|
| `cbrain list` | 列出所有页面 |
| `cbrain list -t entity -l 20` | 只看实体，最多 20 条 |
| `cbrain show <slug>` | 查看一个页面的完整内容 |
| `cbrain delete <slug>` | 删除一个页面 |
| `cbrain ingest <内容>` | 录入新内容 |

### 搜索与关系

| 命令 | 说明 |
|------|------|
| `cbrain query "<内容>"` | 混合搜索 |
| `cbrain graph-query <slug>` | 图谱遍历（`--mode traverse\|backlinks\|related`） |

### 标签与时间线

| 命令 | 说明 |
|------|------|
| `cbrain tags <slug>` | 查看页面的标签 |
| `cbrain tags <slug> add "标签"` | 打标签 |
| `cbrain tags <slug> remove "标签"` | 去标签 |
| `cbrain timeline <slug>` | 查看时间线 |
| `cbrain timeline <slug> add --date 2024-03-01 --summary "事件描述"` | 添加时间线事件 |

### 版本管理

| 命令 | 说明 |
|------|------|
| `cbrain versions <slug>` | 查看修改历史 |
| `cbrain revert <slug> <版本号>` | 回滚到历史版本 |

### 维护与诊断

| 命令 | 说明 |
|------|------|
| `cbrain sync` | 把 vault 文件同步到索引 |
| `cbrain enrich` | 实体重要性升级 |
| `cbrain health` | 14 维度健康检查 |
| `cbrain doctor` | 快速诊断：数据库、文件、API |
| `cbrain doctor --first-run` | 2.0 首次运行全面检查（config → paths → DB → index → services） |
| `cbrain doctor --first-run --json` | 同上，JSON 输出（供 Agent 程序化读取） |
| `cbrain repair-fk [--execute]` | 检测/修复 derived 表孤儿 FK 引用（默认 dry-run；`--execute` 删孤儿行,不动 page/markdown）。serve 启动遇 FK 违规时用 |

### 服务

| 命令 | 说明 |
|------|------|
| `cbrain serve` | 启动 MCP Server（供 AI Agent 调用） |

---

## 常见工作流

### 日常：录入 + 搜索

```
1. 开会记了笔记 → cbrain ingest @notes.md
2. 想查之前的信息 → cbrain query "关键词"
3. 不确定有没有 → cbrain list -t entity | grep 关键词
```

### 定期维护

定期维护走 single-writer wrapper（HTTP /mcp），不裸跑 CLI —— compact/dream/enrich/sync 等会与 serve 抢写（#234，见 docs/hermes-integration.md）：

```
# 维护：dream 内含 sync/enrich/compact/cleanup，经 wrapper 走 /mcp
CBRAIN_MCP_URL=http://127.0.0.1:3399/mcp bin/cbrain-maintenance.sh dream
```

### 离线一次性维护

如确需离线跑（先停 serve），下列命令可单独执行（非 cron 场景）：

```
cbrain sync
cbrain enrich
cbrain health
```

### 实体热度如何理解

`cbrain enrich` 会更新实体 tier，也会计算 `hotness_score`。tier 表示长期重要性：tier 1 是核心实体，tier 2 是活跃实体，tier 3 是观察实体。hotness 则是一个 0-1 左右的综合信号，用来给检索排序提供小幅加成，并帮助 `deep_recall` 折叠低价值 stub。

hotness 由五类信号组成：提及次数、图谱连接数、最近活动、当前 tier、正文丰富度。当前权重固定在代码中，设计目标是让最近活跃、连接充分、内容较完整的实体略微靠前，同时避免空壳 stub 和核心实体被同等对待。权重配置化是后续选项；当前版本只文档化含义，不改变行为。

### 清理重复/孤立内容

```
# 先扫描
cbrain health

# 对 AI Agent 说"帮我清理大脑"（Agent 会走 cleanup 协议）
```

### 深入了解一个主题

```
# 对 AI Agent 说"帮我全面了解组织A"（Agent 会走 review 协议）
# 或手动：
cbrain query "组织A" --strategy all
cbrain show brain/entities/组织a
cbrain graph-query brain/entities/组织a --mode traverse
cbrain timeline brain/entities/组织a
```

### 了解两个人/公司的关系

```
# 对 AI Agent 说"人物C和组织A什么关系"
# 或手动：
cbrain graph-query brain/entities/人物c --mode traverse
cbrain graph-query brain/entities/组织a --mode traverse
# 交叉比对共同关联
```

### 基于知识库写作

```
# 对 AI Agent 说"帮我写一段组织A的介绍"
# Agent 会先搜 CBrain 素材，再写，最后问你要不要存档
```

---

## 配合 Obsidian 使用

CBrain 的 vault 就是 Obsidian vault。所有 `.md` 文件都可以在 Obsidian 中打开、编辑、链接。

- **CBrain 管理**：CLI 命令和 MCP 工具操作 vault
- **人工编辑**：在 Obsidian 中直接改 markdown 文件
- **双向同步**：改完跑 `cbrain sync`，索引更新

Obsidian 中的 `[[wikilink]]` 会被 CBrain 识别为知识图谱链接。

---

## 配置文件

`cbrain.json`（项目根目录）：

```json
{
  "vaultPath": "./vault",
  "dbPath": "./brain.sqlite",
  "lancePath": "./lancedb",
  "embedding": {
    "provider": "zhipu",
    "apiKey": "your-api-key"
  },
  "ner": {
    "enabled": true,
    "llm_model": "glm-4-flash"
  }
}
```

环境变量（推荐）：`ZHIPU_API_KEY` —— 优先用环境变量，避免把密钥写进可能被同步或分享的配置文件；config 里的 `embedding.apiKey` / `ner.llm_api_key` 仍可作为备选。可选的 DeepSeek（reflect）目前只能走 config 字段 `reflect.llm_api_key`，尚无环境变量快捷方式。

### 可选 search provider

`search` 配置只服务于网页补充场景，不是本地记忆检索的依赖。默认不写 `search` 即为关闭：

```json
{
  "vaultPath": "./vault",
  "dbPath": "./brain.sqlite",
  "lancePath": "./lancedb",
  "embedding": { "provider": "zhipu", "apiKey": "your-api-key" }
}
```

启用 SearXNG 后，`cbrain stub-enrich --web` 可以在内部上下文不足时补充网页片段：

```json
{
  "search": {
    "provider": "searxng",
    "base_url": "http://127.0.0.1:8080"
  }
}
```

未配置或连接失败时，CBrain 会继续使用内部上下文；不会影响 `ingest`、`query`、`deep_recall` 或 MCP 本地记忆工具。Brave Search、Tavily 等 API provider 可作为未来适配方向，目前无需安装。

---

## 完整 CLI 命令索引

由 `cbrain --help` 自动生成，勿手改（运行 `bun bin/check-docs-consistency.ts --update` 刷新）。

<!-- cbrain:auto-gen cli-commands:start -->
共 45 个 CLI 命令（`cbrain --help`）。

| 命令 | 说明 |
|------|------|
| `backfill` | Backfill structured facts for existing entities (dry-run by default) |
| `backup` | Create a backup of vault + DB (zip archive) |
| `batch-delete` | Delete entities from a file of slugs (one per line) |
| `clean-shells` | Remove entity/concept pages with 0 mentions, 0 links, and 0 aliases |
| `clean-timeline` | Fix timeline entries with NULL, partial, or malformed dates; deduplicate |
| `compact` | Compact LanceDB files; refuses while serve/watcher is active — use the maintenance wrapper for cron |
| `config` | View or update brain configuration |
| `dedup` | Find and merge duplicate entities using LLM |
| `dedup-types` | Find and merge same-name entities that exist under different types |
| `delete` | Delete a page from the brain |
| `diagnose-insight` | Diagnose insight candidate pool and scoring (no LLM calls) |
| `discover` | Run discovery pipeline to detect structural anomalies in knowledge graph |
| `doctor` | 基础设施就绪检查 |
| `dossier` | Generate or update a structured dossier for an entity |
| `dream` | Nightly full pipeline: sync → enrich → cleanup → health → insight archive |
| `enrich` | Run entity enrichment (tier promotion) |
| `graph-query` | Query the knowledge graph |
| `health` | Run 14-dimension health check and write report |
| `health-debt` | Plan health-debt repairs as a dry-run grouped queue (no execute, no delete, no merge, no LLM) |
| `hierarchy` | Manage entity hierarchy (reports_to) |
| `index` | Generate Obsidian index files |
| `ingest` | Ingest content (text or markdown) |
| `init` | Initialize a new brain (creates config + vault dirs) |
| `knowledge-map` | 生成知识图谱报告（只读）：领域、成熟度、桥接节点、孤立/弱连接条目。不写 vault。 |
| `list` | List all pages in the brain |
| `mcp-config` | Output MCP server configuration JSON for Agent integration |
| `migrate-runtime` | Migrate vault/outputs to runtime directory (uses resolveRuntimePath) |
| `perf-diagnose` | Read-only diagnostics: where time/query budget is spent across recent search journeys (no writes). |
| `query` | Search the brain |
| `reflect` | Run reflect stage: synthesize entities, infer relations, generate insights |
| `relocate` | Fix misplaced pages in records/ by scanning file frontmatter and moving to correct directories |
| `repair-fk` | Detect/repair orphan FK references in derived tables (dry-run by default; --execute to delete) |
| `restore` | Restore from a backup zip file |
| `revert` | Revert a page to a previous version |
| `serve` | Start MCP server (stdio transport) |
| `show` | Display a page's full content |
| `similar-entities` | Detect likely-duplicate entity/concept pages for review (no auto-merge) |
| `skill-pack` | Verify and report Hermes skill pack status |
| `status` | Show brain statistics at a glance |
| `stub-enrich` | Enrich thin stub pages with LLM-generated summaries (single slug or all candidates) |
| `sync` | Sync vault files to indexes |
| `tags` | Manage tags on a page |
| `timeline` | View or add timeline events on a page |
| `versions` | Show version history of a page |
| `wakeup-diff` | Generate wake-up diff: cognitive changes since last snapshot |
<!-- cbrain:auto-gen cli-commands:end -->
