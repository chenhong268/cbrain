# fsck — 只读存储一致性检查器（设计）

- **Issue**: #262 `feat(ops): add read-only fsck consistency checker`
- **Date**: 2026-07-01
- **Status**: Draft（待 review → writing-plans）
- **级别**: L（新功能从零设计，跨 4 个存储层）

## Context

CBrain 有 `health`（14 维度逻辑健康）、`doctor`（启动就绪）、各类 repair 命令，但**缺一个跨物理存储层的一致性体检**。运维需要一条安全命令回答：「vault 文件 / SQLite row / FTS 索引 / LanceDB 向量四层是否一一对应、哪些 FK 成了孤儿、下一步该跑哪个修复命令」。

`fsck` 填这个空：**只读、不修、建议命令不执行**。

调研确认 health 的所有维度（语义去重 / 孤岛 / 矛盾 / 空壳 / 标题冲突隔离…）都是**逻辑健康/质量类**，没有任何维度做跨物理层 row 对齐——所以 fsck 与 health **互补不重复**（issue non-goal："不重复 health repair planning"）。

## 定位与边界

用户心智里的递进：

```
doctor  →  fsck  →  health
能跑      数据对    内容好
(就绪)   (物理一致) (逻辑健康)
```

- `doctor`：config / 路径 / DB 连接 / services ——「能不能跑」
- `fsck`：vault ↔ SQLite ↔ FTS ↔ LanceDB 四层 row 一一对应 + FK 孤儿 ——「数据对不对」
- `health`：14 维度内容/语义/关系质量 ——「内容好不好」

唯一小重叠是 title collision：health 的「标题冲突隔离」查 quarantine **状态**（逻辑），fsck 的 title collision 查 DB 实际**重复 row**（物理）。角度不同，fsck 检测、引用 health 的隔离机制即可。

## 架构（分层 probe）

探测逻辑放 `src/core/fsck/`（业务核心，将来 MCP/HTTP 可复用），CLI 是薄入口。符合 CLAUDE.md「many small files」+ 现有 `health`/`entity-resolver` 的组织惯例。

```
src/cli/commands/fsck.ts          ← 编排：flag 解析、run probes、聚合、输出 human/json、exit code
src/core/fsck/
  types.ts                        ← 稳定数据契约（FsckSeverity/FsckOverallStatus/Finding/FsckReport）
  vault-probe.ts                  ← vault ↔ SQLite 对齐（检查 1/2/3）
  sqlite-probe.ts                 ← SQLite 内一致性 + FK 孤儿 + quarantine context（4/5/8/9/10/11）
  fts-probe.ts                    ← FTS5 覆盖（6）
  lance-probe.ts                  ← 向量覆盖，只读不建表/目录（7）
  report.ts                       ← 聚合 findings → FsckReport、匿名化、human markdown 渲染
tests/cli/fsck.test.ts            ← CLI 端到端 + exit code + 只读断言
tests/core/fsck/*.test.ts         ← 每个 probe 单测
```

CLI flag：`cbrain fsck [--json] [--layer vault|sqlite|fts|lance]`。`--layer` 限定只跑某层（快速定位）。

## 检查项（11 项 → probe → severity）

severity 4 级，运维语义（非 health 的质量语义）：
- `critical`：无法判定一致性或可能已不可恢复——**Phase 1 的 11 项 findings 不分配此级**（这类场景由 `fatalError` / exit 2 通道表达）；保留在 schema 供未来扩展
- `error`：需要修但不灾难（违反唯一性 / 索引缺口影响功能，内容仍可恢复）
- `warning`：轻微不一致 / 可自愈（FK 孤儿、覆盖小缺口）
- `info`：context，不计 failure（quarantine 状态）

| # | check id | probe | 检测逻辑 | severity | suggestedCommand |
|---|---|---|---|---|---|
| 1 | `vault.file_exists_db_missing` | vault | 扫 vault `.md`，frontmatter slug 对比 `db.getPageBySlug` | `error` | `cbrain sync --slug <slug> --reindex` |
| 2 | `vault.db_exists_file_missing` | vault | `getAllPages` → `file_path` → `existsSync` | `error` | `cbrain show <slug>`（确认 DB body 是否还在）|
| 3 | `vault.frontmatter_slug_mismatch` | vault | frontmatter slug vs DB slug + 实际 file_path | `warning` | `cbrain sync --slug <slug> --reindex` |
| 4 | `sqlite.title_collision` | sqlite | `GROUP BY title HAVING COUNT>1`（抓 `idx_pages_title_uniq` 之外漏网） | `error` | `cbrain doctor` |
| 5 | `sqlite.page_without_chunks` | sqlite | pages 有但 chunks 0 条 | `warning` | `cbrain sync --slug <slug> --reindex` |
| 6 | `fts.coverage_gap` | fts | chunks 总数 vs `chunks_fts` row 数 | `warning` | `cbrain sync --slug <slug> --reindex`（局部）/ `cbrain doctor`（全局）|
| 7 | `lance.vector_coverage_gap` | lance | `openChunksStrict` 聚合 pageSlug vs SQLite chunks | `error` | `cbrain sync --reindex-vectors` |
| 8 | `sqlite.orphan_links` | sqlite | `links` where from/to slug not in pages | `warning` | `cbrain repair-fk --execute` |
| 9 | `sqlite.orphan_timeline` | sqlite | `timeline` where page_id not in pages | `warning` | `cbrain repair-fk --execute` |
| 10 | `sqlite.orphan_aliases_profile` | sqlite | `aliases` / profile rows where page_id not in pages | `warning` | `cbrain repair-fk --execute` |
| 11 | `sqlite.quarantine_context` | sqlite | 读 quarantine / bulk-pause 状态表 | `info` | —（仅 context） |

> severity 分配为建议，实现/review 时可调。`suggestedCommand` 全部**只打印不执行**。

**`detail` 模板约定**（不能误导 operator 以为某命令会自动修复）：
- #2 `db_exists_file_missing`：detail 明确「DB body 仍在 → 从 backup 恢复 / re-ingest / manual writeback」；`cbrain show <slug>` 仅用于确认 DB 内容是否还在，**不是修复命令**。
- #4 `title_collision`：detail 明确 `cbrain doctor` 是「诊断 / 隔离入口」，不自动修复 collision。
- #6 `fts.coverage_gap`：detail 明确这是 **FTS 索引**缺口，走 `cbrain sync`（重建 chunks 顺带重建 FTS），**不是** `--reindex-vectors`（那是 LanceDB 向量重建路径）。

**复用**：`db.getAllLinks` / `getAllPages` / `getPage` / `getPageBySlug` 等 public 方法。新写**只读 SELECT**（参考 `src/storage/sqlite.ts:847` `deleteOrphanRows` 的 WHERE 条件，去掉 DELETE）。**全程零写方法**。

## 数据契约（稳定 schema，下游 Agent 解析）

```ts
export type FsckSeverity = "critical" | "error" | "warning" | "info";
export type FsckOverallStatus = "pass" | "warn" | "fail";
export type FsckLayer = "vault" | "sqlite" | "fts" | "lance";
export type FsckLanceState = "ok" | "missing" | "corrupt" | "unchecked";

export interface FsckFinding {
  check: string;            // 稳定 id，如 "vault.file_exists_db_missing"
  layer: FsckLayer;
  severity: FsckSeverity;
  count: number;
  sampleSlugs: string[];    // ≤5，匿名化（见下）
  detail: string;           // 固定模板 + count，不拼用户内容
  suggestedCommand: string; // 如 "cbrain repair-fk --execute"，不执行
}

export interface FsckReport {
  version: 1;               // schema 版本，稳定契约
  timestamp: string;        // ISO 8601，fsck 入口处 new Date().toISOString()
  overallStatus: FsckOverallStatus;
  counts: { critical: number; error: number; warning: number; info: number };
  lanceState: FsckLanceState;
  fatalError?: string;      // 仅 exit 2：检查器自身故障原因
  findings: FsckFinding[];
}
```

### severity → overallStatus → exit code

| 最高 severity 出现 | overallStatus | exit code |
|---|---|---|
| `critical` 或 `error` | `fail` | 1 |
| `warning`（无 critical/error） | `warn` | 1 |
| 仅 `info` 或无 finding | `pass` | 0 |
| —（fsck 自身故障：DB 打不开 / 配置无效 / probe 崩） | `fail`（`fatalError` 填充） | 2 |

**overallStatus 计算规则**：`fatalError` 存在时强制 `fail`（检查未完成 = 不可判定 = 不能算 pass）；否则按已收集 findings 的最高 severity 映射。这样「跑到一半崩」时已有 findings 仍反映部分真相，`fatalError` 独立说明未完成原因。

**exit code 语义**（cron/Hermes 友好）：
- `0` = CBrain 一致性 OK
- `1` = 检查跑通，发现一致性问题（warning/error/critical），需报告/建议修复
- `2` = 检查器自身没跑成（运维故障，要报警 fsck 本身）

exit 2 时仍输出合法 `FsckReport` JSON（`fatalError` 填原因、findings 可能为部分/空），下游解析不会因 exit 2 崩。

## LanceDB 只读探测协议（技术核心）

issue 硬要求：「Missing/corrupt LanceDB is reported safely and does not create tables/directories」。

风险点（已调研 `src/storage/lancedb.ts`）：
- `connect(path)`（L95）→ `lancedb.connect(path)` **会创建目录**
- `getOrCreateTable`/`warmup`（L101/L129）→ `createTable(mode:"create")` **会建表**

协议：
```
1. existsSync(lancePath)?
     否 → lanceState="unchecked"，跳过 #7，绝不 connect（不建目录）
2. 是 → 调 openChunksStrict()（L225，注释明确「never creates it」）：
     - 抛 LanceTableMissingError → lanceState="missing"，#7 计 0
     - 抛其他异常 → lanceState="corrupt"，#7 计 0
     - 成功 → query().where().toArray() 只读按 pageSlug 聚合，对比 SQLite chunks
3. 全程禁用 connect / getOrCreateTable / warmup / createTable
```

`lanceState` 独立字段（不混进 findings），因为 LanceDB 缺失 ≠ CBrain 数据 critical——它只让 #7 无法检测。

## 匿名化规则（issue 硬要求）

输出「no absolute paths, credentials, stack traces, raw content, or private fixture examples」：
- `sampleSlugs`：≤5 个；slug 是派生 ID 非真名，但长 slug 截断到固定长度
- `detail`：固定模板字符串 + count，**不拼接** vault 内容 / page body / 用户文本
- 路径：用相对占位（`<vault>/records/foo.md`），绝不输出绝对路径（`/Users/...`）
- 无 stack trace（异常捕获后转成固定文案）
- 无凭证（fsck 不读 API key，但 config 解析时也不输出）
- 测试 fixture 用合成 sentinel（memory: public-tests-anonymous-placeholders）

## 只读保证

- SQL：仅 `SELECT` / `COUNT`，无 `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE`
- LanceDB：仅 `openChunksStrict` + `query()`，无 `createTable`/`add`/`delete`/`merge_insert`
- 文件系统：仅 `readFileSync`/`readdirSync`/`existsSync`，无 `writeFileSync`/`unlink`/`mkdir`
- 测试断言：fsck 前后快照 DB 文件 hash + vault 文件树（路径+mtime）+ LanceDB 目录文件列表，全部不变

## 测试策略

1. **每 probe 单测**（`tests/core/fsck/*.test.ts`）：匿名 fixture 注入已知不一致（缺文件 / 缺 DB row / FK 孤儿 / 向量缺口），断言 findings 的 check/severity/count。
2. **只读断言**（acceptance）：fsck 前后 DB hash + vault 文件树 + LanceDB 目录 mtime 全不变。
3. **LanceDB 缺失场景**：lancePath 指向不存在目录 → `lanceState="missing"`、断言目录仍未被创建、exit 不因 lance 挂。
4. **exit code 矩阵**：构造 pass / warn / fail / 自身故障四类场景，断言 0/1/1/2。
5. **匿名化测试**：fixture 含「诱惑性」真名/路径占位，断言输出里不出现。
6. **JSON schema 稳定性**：zod 校验 `--json` 输出符合 `FsckReport`。
7. **`--layer` 过滤**：只跑指定 probe。

## Non-goals（issue + 本设计）

- 不自动修复（Phase 1 无 write 路径）
- 不调 LLM
- 不重复 health 的逻辑维度检查
- 不执行 suggestedCommand（只打印）
- 不做 schema 迁移
- 不改 runtime 默认
- MCP 工具暴露留待后续（Phase 1 CLI only；JSON schema 已为将来 MCP 稳定）

## Open questions（实现时确认）

1. **`remove_orphans` 是 CLI 命令还是仅 MCP 工具**？影响 #8/9/10 的 suggestedCommand 是否能写 `cbrain remove_orphans`，还是只能写 `cbrain repair-fk --execute`。实现时 grep 确认。
2. **quarantine 状态存哪张表/字段**？#11 需要定位存储位置（`pages` 的某个标志列，还是独立 `quarantine` 表）。实现时查 schema。
3. **profile 孤儿**（#10）：profile 表的外键结构需确认（`src/profile/` 或 sqlite.ts 的 profile 表定义）。
4. **`cbrain repair-fk --execute` 覆盖范围**：确认它是否清理 `aliases` 和 profile 表的 FK 孤儿（不只 links/timeline）。若不覆盖，#10 必须拆成 `orphan_aliases` 和 `orphan_profile` 两个独立 check，各自给可达的 suggestedCommand——避免 suggestedCommand 说了做不到。

## 验证（实现完成的标志）

- `bun run check` 通过（lint + 全量 test）
- `cbrain fsck` 在干净库上 exit 0、overallStatus=pass
- `cbrain fsck --json` 输出过 zod 校验
- 注入不一致后 fsck 报告对应 finding + 正确 suggestedCommand + 正确 exit code
- 只读断言通过（前后 DB/vault/LanceDB 不变）
- LanceDB 目录不存在时 fsck 不创建它
