# CBrain Vault 编译规范

> 权威版本，代码仓库维护。Vault 里的 CLAUDE.md 是精简版。

## 目录结构

```
vault/
├── raw/              # 人工输入 — 只进不出
│   ├── events/         # 会议、行程、里程碑
│   ├── records/        # 读书笔记、材料、文章摘要
│   └── sources/        # 原始素材（文章、视频转录等）
└── brain/           # CBrain 编译产物（AI 维护）
    ├── entities/       # 人物、公司、产品、项目
    └── concepts/       # 方法论、术语、框架、原则
```

### 核心规则

1. **`raw/`** — 人写的，CBrain 只读不写
2. **`brain/`** — CBrain 生成的，人可以编辑补充

> **运行时产物**（日志、健康报告、索引、dream 报告、备份）存放在 `<profileDir>/runtime/`，与内容 vault 完全分离。详见下方「运行时目录」。

## 页面类型

| type | 目录 | 前缀 | 谁创建 | 示例 |
|:-----|:-----|:-----|:-------|:-----|
| entity | `brain/entities/` | `brain/` | CBrain NER 自动抽取，或人工创建 | 张三.md、星辰科技.md |
| concept | `brain/concepts/` | `brain/` | CBrain 从内容中提取，或人工创建 | 第一性原理.md、MVP.md |
| event | `raw/events/` | `raw/` | 人工创建 | 2026-02-02 季度复盘会议纪要.md |
| record | `raw/records/` | `raw/` | 人工创建 | 达利欧的工作原则.md |
| source | `raw/sources/` | `raw/` | 人工创建 | NKP客户报备制度.md |

## Slug 规则

Slug = 文件在 vault 内的相对路径（去掉 `.md` 后缀）。

**自动生成规则**：
- 中文标题：保留原文，去掉特殊符号
  - `"张三"` → `brain/entities/张三`
  - `"季度复盘会议纪要"` → `raw/events/季度复盘会议纪要`
- 英文标题：小写 + 短横线
  - `"First Principles"` → `brain/concepts/first-principles`
  - `"Weekly Sync"` → `raw/events/weekly-sync`

**手动指定**：frontmatter 里的 `slug` 字段优先。如果人写了 `slug: my-custom-path`，就用这个。

## Frontmatter 格式

所有 CBrain 管理的文件必须包含 frontmatter。

### raw 页面（人工创建）

```yaml
---
title: "页面标题"
type: event | record | source
created: YYYY-MM-DD
tags:
  - 标签1
  - 标签2
---
```

可选字段：`source`、`status`、`rating`、`aliases`、`meeting`、`category`。

`raw/` 页面不一定有 `slug` 字段——CBrain 自动从文件路径推导。

### brain 页面（CBrain 生成）

```yaml
---
title: "实体名或概念名"
type: entity | concept
slug: "brain/entities/实体名"
tags:
  - auto-extracted        # NER 自动抽取的标记
tier: 1 | 2 | 3
created_at: "ISO 8601"
updated_at: "ISO 8601"
---
```

### Tier 说明

| tier | 含义 | 条件 |
|:-----|:-----|:-----|
| 1 | 核心节点 | 提及次数 ≥ 5 或手动标记 |
| 2 | 重要节点 | 提及次数 ≥ 2 |
| 3 | 普通节点 | 默认，NER 抽取的 stub |

## Wiki Link 规范

CBrain 使用 Obsidian `[[双链]]` 语法。

### 链接解析

`[[张三]]` → 按标题匹配，不区分目录层级。Obsidian 原生支持这个行为。

### 链接写入

CBrain 生成的链接使用完整 slug：
- `[[brain/entities/张三]]`
- `[[raw/events/2026-02-02 季度复盘会议纪要]]`

### 自引用禁止

页面不能链接到自己。

## NER 实体 Stub 规则

NER 从 `raw/` 内容中自动提取实体时：

1. **查重**：先按标题搜索，已存在则复用，不创建重复 stub
2. **创建 stub**：新实体自动创建到 `brain/entities/`
3. **stub 内容**：
   ```markdown
   > Auto-extracted from [[来源页面slug]]

   ## Known Relations
   - works_at → [[关联实体]]
   - ← student_of from [[关联实体]]
   ```
4. **mention_count 自增**：每次被链接引用时 +1

## 编译流程

```
人写 raw/ 内容
  → cbrain sync 扫描变更
  → chunk + embed 写入 LanceDB
  → FTS 索引写入 SQLite
  → NER 提取实体/关系/事件
  → 自动创建 brain/ stubs
  → links 表记录关系
  → timeline 表记录事件
```

### hash 去重

每个文件计算 SHA-256 前 16 位作为 content_hash。sync 时 hash 不变则跳过。强制重新索引：删除 brain.sqlite 中对应 page 的 content_hash。

## 搜索

| 方式 | 引擎 | 适用场景 |
|:-----|:-----|:---------|
| 语义搜索 | LanceDB (向量 ANN) | "找跟创新方法相关的内容" |
| 全文搜索 | SQLite FTS5 (trigram) | "找包含'项目管理'的页面" |
| 图谱查询 | SQLite links 表 | "张三关联了哪些实体" |

## 版本控制

- `brain/` — 建议纳入 git（CBrain 产物，可追溯）
- `raw/` — 由用户自行决定

brain.sqlite 和 lancedb/ 是索引层，可随时从 vault 文件重建。

## 运行时目录

运行时产物存放在 `<profileDir>/runtime/`（profileDir = brain.sqlite 所在目录），与内容 vault 完全分离：

```
runtime/
├── backups/          # 自动备份（SQLite only，最多 7 份，500MB 总预算）
├── dream/            # dream 日报
├── health/           # 健康检查报告
├── indexes/          # 生成的索引文件
└── logs/             # 运行日志
```

核心设计原则：

1. **vault 只放内容** — `raw/` 和 `brain/` 是用户可见的知识内容，运行产物不应污染
2. **LanceDB 不备份** — 向量索引可从 vault 完全重建，备份只含 SQLite
3. **WAL 一致性** — 备份前执行 `PRAGMA wal_checkpoint(TRUNCATE)`，确保 zip 内的 `.sqlite` 文件包含所有已提交写入
4. **保留双限制** — 最多 7 份 + 总大小不超过 500MB；单份超预算时保留最新并输出告警
5. **可随时清除** — 删除整个 `runtime/` 不影响知识库功能

### 路径解析

`resolveRuntimePath(config)` 决定运行时目录位置：
- 有 `config.runtimePath` → 使用显式配置
- 默认 → `dirname(resolve(config.dbPath)) + "/runtime"`

旧版 `vault/outputs/` 不再写入。已有数据可通过 `cbrain migrate-runtime` 迁移到新位置。迁移冲突时，已有的目标目录会被重命名为 `runtime.pre-migrate-<timestamp>` 归档。
