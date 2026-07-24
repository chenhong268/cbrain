# #386 — Page Writer Provenance (record 创建者溯源)

> Issue-REQUIRED spec/plan。随 feature 分支 commit。本文档反映**经 3 轮 review 修订后的最终实现**（初始任务分解见文末，部分被 review 推翻）。

## Context

新建 `record` 页面没有不可伪造的创建者溯源。`ingest_log` 是可变操作日志（改名 UPDATE、删页 DELETE、无 FK），不能当创建归属真相源。现有 `ProvenanceManager`/`SqliteProvenanceStore` 管的是 link/timeline 信任状态，跟"页面创建者"是两回事，不复用。

目标：给新建 `record` 页面一个 **durable / unforgable / 可安全查询** 的创建者归属。外部文件只能标 `unknown_writer`；历史数据不回填（缺行 = 早于追踪期/未追踪，诚实留白）；新写入绝不混入历史缺口。

## 锁定边界

- **v1 只覆盖 `type=record` 的页面创建**。entity/concept/insight 及 dialogue 自动提取页是后续扩展，本轮不碰。
- **actor 不进 `ToolContext`**——它是"一次具体写入"的属性，由适配层（MCP/CLI/watcher）显式传给核心写入接口。放全局 context 会把后台/间接写入错误归因给当前会话。
- **`RecordWriterContext` 只存在于内部 `IngestInput`/`CreatePageInput`，绝不进 MCP 公开 zod input schema**（防调用方自报伪造 actor）。
- **不在 `upsertPage()` 内统一自动写 provenance**；由上层明确写入边界发射。
- 归属表：MCP `ingest`/`put_page` → `agent`；CLI `cbrain ingest` → `operator`（无 origin，CLI 非真实 session）；watcher/sync 首次发现外部 record 文件 → `unknown_writer`；dream/job 暂不发射 `system`；无上下文 → 默认 `unknown_write_path/unknown_writer/unattributed_internal_create` 不猜。

## 三条 record 创建路径

| 路径 | DB 方法 | 入口 | v1 归属 |
|:---|:---|:---|:---|
| MCP `put_page`（新页）/ `ingest` | `insertPage` | `PageManager.create()` → `db.insertPage()` | `agent`（writeMode `put_page`/`ingest`） |
| CLI `cbrain ingest` | `insertPage` | content.ts → `IngestManager.ingest()` → `pages.create()` | `operator`（writeMode `ingest`，无 origin） |
| sync 首次发现 vault record 文件 | `upsertPage`（INSERT ON CONFLICT） | sync.ts **两处创建发射点**（batch syncAll + 单页 sync） | `unknown_writer`（writeMode `external_direct_write`） |

> sync 还有第三处 `upsertPage` 在 `compensateSyncFailure`（失败回滚补偿器，只处理已存在页），**不是创建路径，不发射 provenance**。dialogue（dialogue.ts 也走 upsertPage）→ 本轮不写。sync 已有页更新 → 不新增/不覆盖。

## 最终保证（4 条不变量，均在 DB / 适配层强制，非方法约定）

1. **Durable（原子）**：`PageManager.create()` 把 `insertPage + tags + provenance` 放进**同一 SQLite 事务**（`CBrainDB.runInTransaction`），全成或全回滚——不存在"有页无 provenance"。vault 文件先写；DB 回滚后删文件，**文件清理失败抛结构化 `CleanupIncompleteError`（保留 primaryError + cleanupErrors，不吞）**。sync 两处创建点的 `upsertPage + provenance` 同样用短事务。
2. **Unforgable（DB 级不可变，堵死全部三个改归属向量）**：三个 trigger。① `BEFORE UPDATE OF (write_mode, actor_class, creation_reason, origin_kind, origin_ref, created_at)` → ABORT（直接 UPDATE 字段改归属）。② `BEFORE DELETE`：父页仍存在→ABORT（阻断 DELETE+INSERT 改归属）；仅删页的 FK CASCADE（父页已没）放行。③ `BEFORE UPDATE OF page_slug`：OLD 父页仍存在→ABORT（阻断把 A 的 provenance 转给 B）；仅 movePage（先改 pages.slug，旧父页已没）放行。`recordPageWriteProvenance` 是 check-then-insert（**非 INSERT OR IGNORE**）：同内容幂等返 false、不同归因抛 `PageWriteProvenanceConflictError`、其它约束错照常抛。orphan 行由 `repair-fk` 修复（已加白名单）。
3. **No-leak（DB 级 UUID/ULID 强制 + 摘要化展示）**：`BEFORE INSERT` trigger 在 DB 层强制 `origin_kind/origin_ref` 成对 + 非空 `origin_ref` 必须 GLOB 匹配 UUID（8-4-4-4-12 hex）或 ULID（首字符 0-7 防 128-bit overflow）——直接 SQL 插凭据/路径/不成对 tuple 都被 ABORT，`getPageWriteProvenance` 永不返回原始 secret（方法层 `validateOriginRef` 仅作 backup）。读层 `redactOriginRefForDisplay` **永远摘要化**（sha256 前 12 位）作 defense-in-depth。
4. **Honest audit（区分状态 + 单快照）**：`show-writer` 先验页存在——`not_found`（页不存在，exit 1）/ `untracked`（页存在无行，exit 0）/ `tracked`（exit 0）。`writer-audit --json` 的 list+total 走**单一只读事务**（`listAndCountRecordPagesWithoutWriteProvenance`），带 `total` + `truncated`（total>limit），并发写不会让 count/total/truncated 自相矛盾。

## 架构

新表 `page_write_provenance`：`page_slug TEXT PRIMARY KEY`（append-only）、`write_mode/actor_class/creation_reason`（CHECK 枚举）、`origin_kind/origin_ref`、`created_at`，FK→pages(slug) ON DELETE CASCADE + 不可变 trigger + `idx_page_write_provenance_actor`。类型/helper 在 `src/core/page-write-provenance.ts`（`forIngest/forPutPage/forVaultDiscovery/forUnattributed` + `validateOriginRef/redactOriginRefForDisplay/provenanceMatchesRow/toConflictFields` + `PageWriteProvenanceConflictError`）。

## 查询面（CLI，本轮不加 MCP 工具）

- `cbrain writer-audit [--json] [--limit N(1..1000)]` — 列缺溯源 record 页；JSON 带 `missing/count/total/limit/truncated`。
- `cbrain show-writer <slug> [--json]` — `not_found`(exit 1) / `untracked`(exit 0) / `tracked`(exit 0)；origin_ref 脱敏输出。

## 验证

```bash
bun run lint                              # tsc src+tests + biome
bun run check:docs                        # usage.md/README count 同步
bun test tests/storage/page-write-provenance.test.ts
bun test tests/core/page-write-provenance-create.test.ts
bun test tests/core/sync-write-provenance.test.ts
bun test tests/cli/writer-audit-cli.test.ts
bun run check                             # 全量
```

测试含失败注入：provenance 写失败+文件删失败 → recovery 错且 DB 干净；rawDb 直 UPDATE 归属 → trigger ABORT；orphan pwp 行 + 不同归属 create → 前置 Conflict（无 cascade）；40-hex/路径 origin → 写拒/读脱敏。

改完 CBrain 代码必须重启 `cbrain serve`（known issue #16）。

---

## 初始任务分解（历史，已被 review 部分推翻）

原始 4-task 分解（schema+DB / 显式创建 / sync / CLI+docs）作为实施骨架，但以下点被 review 修正，**以本文档上方"最终保证"为准**：

- ~~`recordPageWriteProvenance` 用 `INSERT OR IGNORE`~~ → check-then-insert + 冲突异常（P2-5）。
- ~~CLI ingest 写 `origin:{kind:'session',ref:'cli'}`~~ → 无 origin（CLI 非真实 session，P1-4）。
- ~~sync 三处创建型 upsert~~ → 两处创建发射点；第三处是 `compensateSyncFailure` 补偿路径。
- 补充（review 新增）：创建用真事务非补偿删除（P1-1）、trigger 强制 immutable（P1-2）、复用 sanitizeForLog（P1-3）、not_found/untracked 区分 + 截断标注（P2-4）。
