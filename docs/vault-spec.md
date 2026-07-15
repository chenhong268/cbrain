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
| entity | `brain/entities/` | `brain/` | CBrain NER 自动抽取，或人工创建 | 人物a.md、组织a.md |
| concept | `brain/concepts/` | `brain/` | CBrain 从内容中提取，或人工创建 | 第一性原理.md、MVP.md |
| event | `raw/events/` | `raw/` | 人工创建 | 2026-02-02 季度复盘会议纪要.md |
| record | `raw/records/` | `raw/` | 人工创建 | 达利欧的工作原则.md |
| source | `raw/sources/` | `raw/` | 人工创建 | NKP客户报备制度.md |

## Slug 规则

Slug = 文件在 vault 内的相对路径（去掉 `.md` 后缀）。

**自动生成规则**：
- 中文标题：保留原文，去掉特殊符号
  - `"人物A"` → `brain/entities/人物a`
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

`[[人物A]]` → 按标题匹配，不区分目录层级。Obsidian 原生支持这个行为。

### 链接写入

CBrain 生成的链接使用完整 slug：
- `[[brain/entities/人物a]]`
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
| 图谱查询 | SQLite links 表 | "人物A关联了哪些实体" |

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
3. **WAL 一致性** — 使用 `VACUUM INTO` 生成一致性快照数据库，包含所有已提交的 WAL 数据（含其他连接的并发写入），不影响活跃连接。快照在 zip 内以正式 DB 文件名（如 `brain.sqlite`）存储，`cbrain restore` 可直接恢复
4. **保留双限制** — 最多 7 份 + 总大小不超过 500MB；单份超预算时保留最新并输出告警
5. **可随时清除** — 删除整个 `runtime/` 不影响知识库功能

### 路径解析

`resolveRuntimePath(config)` 决定运行时目录位置：
- 有 `config.runtimePath` → 使用显式配置
- 默认 → `dirname(resolve(config.dbPath)) + "/runtime"`

旧版 `vault/outputs/` 不再写入。已有数据可通过 `cbrain migrate-runtime` 迁移到新位置。

### 迁移策略

`cbrain migrate-runtime` 将 `vault/outputs/` 的旧数据迁入 `<runtimePath>/`：

- **目标为空** — 直接复制到 runtime 根目录
- **目标已有文件** — 当前 runtime 文件保留不动，旧数据迁入 `runtime/legacy-outputs-<timestamp>/` 子目录，不覆盖当前运行状态
- 迁移前建议停止运行中的服务（server/dream），避免并发写入问题

### 备份

#### 自动备份（DB-only）

`cbrain dream` 每次运行自动创建 SQLite 备份到 `runtime/backups/`：

- 使用 `VACUUM INTO` 生成一致性快照，包含所有 WAL 已提交数据
- 只备份 SQLite，不含 vault 或 LanceDB（向量索引可从 vault 重建）
- 保留上限：最多 7 份 + 总大小不超过 500MB

#### 手动全量备份（DB + vault）

```
cbrain backup -o <输出目录>
```

- 备份包含 SQLite 一致性快照 + vault 全部内容 + LanceDB（如存在）
- 输出 zip 文件，文件名含时间戳
- vault 和 LanceDB 通过符号链接打包，避免复制大文件

### 恢复

`cbrain restore <backup.zip> --force` 从备份恢复：

#### 恢复前检查（任一不通过则中止）

1. **活跃服务检测** — 检查 `cbrain-http.pid`、`cbrain-stdio.pid`、`.watcher.lock`，有活跃进程则拒绝
2. **数据库锁检测** — 尝试 `BEGIN IMMEDIATE`，被占用则拒绝
3. **残留文件检测** — 发现 `.rollback` 或 `vault.pre-restore`（上一轮恢复残留）则拒绝，提示用户手动检查后再试。检测使用精确目录项语义，断链 symlink 也视为残留，不能用 `existsSync` 的目标跟随结果绕过

#### 恢复流程

1. 解压到临时目录
2. 验证备份数据库有效性（检查 pages 表存在）
3. **原子安装数据库** — 先复制到 `.restoring` 临时文件并验证，再 `rename` 原子切换到正式路径。DB-only 回滚名用排他 hard-link claim，若同名 `.rollback` 在 preflight 后出现则安装失败关闭，绝不以 `rename` 覆盖它
   - 若目标文件系统不支持 hard link，DB-only restore 会在主 swap 前安全失败；不得降级为可能覆盖未托管 `.rollback` 的方案
   - staging copy / validation / rename 在主 swap 前失败时，原数据库始终留在 active 路径；失败清理只处理本轮 `.restoring` 和 owned rollback claim，绝不 unlink/rename active DB
4. **DB-only 备份**：只恢复数据库，完成后清理 WAL/SHM
5. **Full 备份**（含 vault）：
   - VACUUM INTO 当前数据库到 `.rollback` 快照（包含所有 WAL 已提交数据）
   - 安装备份数据库（同上原子方式）
   - 原子替换 vault（rename 旧 vault → `.pre-restore`，rename 备份 vault → 正式路径）
   - **vault 成功** → 进入显式 finalization，删除并验证 `.rollback`、`.pre-restore`、WAL 和 SHM 的精确目录项
   - **vault 失败** → 从 `.rollback` 快照回滚数据库，恢复旧 vault，确保数据一致

#### Finalization 与成功语义

- 清理最多执行三个全局轮次，每轮只处理仍存在的托管项；稳定等待固定为 50 ms、150 ms、300 ms，总等待不超过 500 ms
- 每轮后使用 `lstat` 重新扫描完整适用项集合；只有 `ENOENT` 代表已清理，断链 symlink、等待期间新物化的条目和无法判定的权限错误都按仍存在处理
- Full restore 验证 `.pre-restore`、`.rollback`、`-wal`、`-shm`；DB-only restore 验证适用的数据库项
- `.pre-restore` / `.rollback` 只有在本轮 restore 实际创建或接管后才允许删除；若它们在 preflight 后才出现，本轮只验证并 fail-closed，绝不删除、接管或装成 active 数据库
- 只有主安装成功且所有适用项已验证不存在，restore 才打印成功并退出 0
- 如果主安装成功但 finalization 未闭环，命令输出固定的 `RESTORE_CLEANUP_INCOMPLETE`、退出非 0，并且不打印普通成功或 `cbrain sync` 指令。此时新数据库和新 vault 保持生效，不回滚已完成的主交换
- 固定诊断不包含用户路径、vault 正文、文件名样例、stack trace 或 credential；操作员应保持 CBrain 服务停止，按 runbook 检查残留，仅在确认无需保留后手动清理
- 递归删除可能在文件系统报错前已经删除一部分子项。失败后 CBrain 保留停止时尚存的 residual，但不承诺旧 vault 的字节级完整副本

Restore 只管理上述精确事务项，不扫描、不判断、也不自动删除父目录下的编号或错位兄弟目录。此类文件系统卫生问题由 [Issue #341](https://github.com/chenhong268/cbrain/issues/341) 的 observability/人工清理流程处理；非空或未托管目录永远不能由 restore 自动删除。

#### 安全保障

- **进程崩溃安全**：数据库安装使用 staging temp + rename，崩溃不会产生半写入文件
- **WAL 数据保留**：VACUUM INTO 快照包含所有 WAL 已提交数据，回滚不丢失
- **数据不自动删除**：上一轮残留文件由用户决定是否删除
- **清理失败关闭**：主交换完成不等于生命周期完成；finalization 未验证时返回非零，避免假成功

#### 典型流程

```
# 自动备份恢复（DB-only）
cbrain dream              # 自动创建备份
# ... 数据库出了问题 ...
cbrain restore runtime/backups/auto-2026-05-28-00-00.zip --force
cbrain sync               # 重建 LanceDB 索引

# 全量恢复（DB + vault）
cbrain backup -o ~/backups
# ... 需要回滚 ...
cbrain restore ~/backups/cbrain-backup-2026-05-28-12-00.zip --force
```
