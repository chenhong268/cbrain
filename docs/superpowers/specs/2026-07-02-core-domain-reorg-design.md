# Design: core 按功能域重组 (#259)

> **日期**: 2026-07-02
> **关联**: [issue #259](https://github.com/…/issues/259) — `refactor(core): reorganize core modules by domain without behavior changes`
> **级别**: L（架构变更，多子系统联动）
> **状态**: 已对齐 design，待写实施 plan

## Problem

`src/core/` 已膨胀成 61 个 flat `.ts` 文件（19000+ 行），混杂 ingest、retrieval、maintenance、graph、safety、discovery 等不相关关注点。导航和贡献成本高。已有 4 个子目录（`agentic/`、`fsck/`、`knowledge-map/`、`recall/`）证明项目正朝域分组演进，但 flat 层迟迟未拆。

## Goal

把 flat core 文件迁入域子目录，**不改任何运行时行为**。

## 数据依据（重组前实测）

- **外部 src fan-in**: 84 条 import 指向 flat core（mcp 78 + cli 4 + storage 2），**全是深路径**（`../../core/<name>.js`），零 barrel 使用。
- **tests fan-in**: 106 个测试文件、194 条 import 指向 core（抽样：`reflect`/`entity-resolver`/`graph`/`hierarchy`/`sync` 等），大头指向迁移文件——比 src 外部 fan-in 还多，是改动大头。
- **内部耦合**: 82 条 flat 间 import 边。hub 文件（内部 fan-in）：`logger.ts`(17)、`shared.ts`(12 内 + 5 外)、`page.ts`(16)、`ner.ts`(8)、`pipeline.ts`(8)。
- **现有 barrel 约定**: 仅 `knowledge-map/index.ts` 有 barrel 且消费不一致；`agentic/`、`fsck/` 全深路径。**项目无强 barrel 约定，深路径是 norm。**
- **跨切面文件**: `shared/logger/page/audit/jobs/provenance/version` 被所有域引用，不属于任何业务域。

## 最终结构

```
src/core/
  # 根：7 个 cross-cutting（被全域引用，留 flat，0 改动）
  shared.ts  logger.ts  page.ts  audit.ts  jobs.ts  provenance.ts  version.ts

  ingestion/      # 写入流水线（13）
  retrieval/      # 搜索·召回·应答（16）
  graph/          # 图结构（3）
  maintenance/    # 后台维护（17）
  safety/         # 安全写入（5）

  agentic/        # 已有，不动（5）
  knowledge-map/  # 已有，不动（6）
  fsck/           # 已有，不动（6）
  recall/         # 已有，不动（1）
```

### 域文件清单（共 54 文件迁入域 + 7 留根 = 61）

| 域 | 文件 |
|:---|:---|
| **根 cross-cutting** (7) | shared, logger, page, audit, jobs, provenance, version |
| **ingestion/** (13) — 写入流水线: ingest→NER→entity-resolve→structured-facts | ingest, pipeline, ner, ner-backfill, content-classifier, personal-tag-classifier, structured-facts, structured-facts-backfill, extract, dialogue, entity-resolver, name-similarity, similar-entity-detector |
| **retrieval/** (16) — 搜索·召回·应答 | search, query-router, research, evidence, evidence-completion, grounded-answer, artifact, episodic-recall, recall-intent, search-trace, search-diagnostics, proactive, dossier, key-points, birthday, frontdoor-router |
| **graph/** (3) — 图结构 | graph, hierarchy, knowledge-write |
| **maintenance/** (17) — 后台维护（含 onboarding/doctor） | sync, dream, watcher, health, health-debt, enrich, seal, stub-enrich, wakeup, insight, learn, indexes, reflect, compounding-review, discovery, discovery-digest, first-run |
| **safety/** (5) — 安全写入 | page-delete-safety, sync-index-safety, atomic-move, merge-workflow, writeback |

### 关键归属裁决

- **cross-cutting 留根**（而非建 `core/shared/`）：`logger`(17 内)、`shared`(12 内+5 外)、`page`(16 内) 等被十几个跨域文件引用，移入任何子域都制造反向耦合。留根 = 这 7 文件 0 改动 + 语义正确（logger 不属任何域）。
- **entity 组进 ingestion**（而非单独 `entity/` 或进 graph）：entity-resolver 紧耦 `ner.ts`+`pipeline.ts`，是写入流水线一环。跨域 import 最少（仅 `discovery` 从 maintenance 跨来）。不新增第 6 个域。
- **pipeline.ts 进 ingestion**（虽被 sync/dream/reflect 引用）：它是 NER 处理流水线核心，maintenance 域跨域引用可接受（跨域 import 不是错，只记录）。
- **extract.ts 进 ingestion**（虽被 health.ts 用）：主消费者是 pipeline；health 跨域引用。
- **version.ts 留根**（紧耦 page.ts，84 行）。
- **first-run.ts 进 maintenance**（而非根或 ingestion）：onboarding/doctor/readiness 检查，语义与 health/fsck 接近，属后台维护与健康检查范畴。

## Import 策略：全深路径，不建 barrel

- **不给新域建 `index.ts`**。理由：84 外部 import 全深路径是项目 norm；knowledge-map 半吊子 barrel 是反例；加 barrel 是纯增量工作且制造 barrel/深路径混用不一致。
- **同域互引 0 改动**：`./name.js` 在同目录迁入后仍成立。
- **要改的 import**（四类）：
  1. 跨域内部边（`./pipeline` → `../ingestion/pipeline`），约 18 条。
  2. 外部 src fan-in 指向已迁文件的（`../../core/search` → `../../core/retrieval/search`），约 55 条（指向根 cross-cutting 的 ~29 条不动）。
  3. 子目录回引变深：`agentic/executor`(6 条)、`knowledge-map/schedule`(2 条)。
  4. **tests/ 引用**：106 个测试文件、194 条 import 指向 core，其中 ~120 条指向已迁文件（指向根 cross-cutting 的不动）。
- **合计 ~200 处机械改动**。tsc 覆盖 src + tests 全量，自动报所有断引，不靠手 grep 预判。

## 批次策略：按域一域一 commit，每 commit 必 green

顺序从小到大，先在小域验 pattern：

| # | commit | 文件数 | 备注 |
|:--|:---|:---:|:---|
| 1 | `refactor(core): move graph modules to graph/` | 3 | graph, hierarchy, knowledge-write |
| 2 | `refactor(core): move safety modules to safety/` | 5 | page-delete-safety, sync-index-safety, atomic-move, merge-workflow, writeback |
| 3 | `refactor(core): move ingestion modules to ingestion/` | 13 | ingest pipeline + NER + entity |
| 4 | `refactor(core): move retrieval modules to retrieval/` | 16 | search + recall + answer |
| 5a | `refactor(core): move maintenance modules (sync/dream/health/doctor cluster)` | ~11 | sync, dream, watcher, health, health-debt, enrich, seal, stub-enrich, wakeup, reflect, first-run |
| 5b | `refactor(core): move maintenance modules (discovery/insight cluster)` | ~6 | insight, learn, indexes, compounding-review, discovery, discovery-digest |

**每个 commit 内容**：`git mv` 该域文件 + 改全部受影响 import（跨域边 + 外部 fan-in + 子目录回引）+ `bun run check` 绿。**绝不留中间态坏代码**——mv 和 import 改动同 commit。

maintenance 拆 2 commit 因 17 文件 + dream.ts/reflect.ts 高跨域出度，单 commit diff 过大不利于 review。

## Git history：`git mv` 保留 rename 检测

- 用 `git mv`（非 rm+add）。内容 0 改动时 GitHub diff 显示 "file moved"，`git log --follow` 可追溯。
- import 行改动是消费方文件的唯一 diff，集中在引用方，review 时清晰隔离。
- 提交信息用 `refactor(core):` 前缀（conventional commits）。

## Verification

**每个 commit 后**:
- `bun run lint`（tsc --noEmit + biome lint 两层门禁）
- 受影响范围的 `bun test`

**全部完成后终态**:
- `bun run check`（lint + 全量 test）绿
- 残留扫描：`grep -rnE "core/(ingest|pipeline|ner|search|sync|dream|health|graph|hierarchy|evidence|episodic-recall|reflect|discovery|artifact|grounded-answer|dossier|first-run|...)\.js" src/` 指向**已迁文件**的旧深路径必须 0 命中（指向根 cross-cutting 的合法保留）。
- 抽查 `git log --follow src/core/maintenance/sync.ts` 能追到迁移前历史。
- diff 抽查：确认纯文件移动 + import 路径改动，无任何逻辑/类型/导出改动。

**文档同步**（行为不变，但路径引用会过时）:
- grep `docs/`、`README.md`、`CLAUDE.md` 内 `core/<name>` 路径引用，**按实际命中**更新（如 `CLAUDE.md` 架构章节、`docs/usage.md`、`docs/mcp-tools.md` 及命中的具体 docs）。注意 `docs/usage.md`/`docs/mcp-tools.md` 命令表 auto-gen，改 `.description()` 不手改表——本次不涉及工具描述，仅可能的路径示例。

## Worktree 隔离

- L 级，按 CLAUDE.md 走 worktree：`.claude/worktrees/259-core-domain-reorg`
- **base 必须 rebase 到本地 main**（memory 警告：EnterWorktree 默认 origin/main，本地未 push 的 commit 会缺）。
- 重组前确认 main 干净、无并行 feature 改同批 core 文件。
- **commit 顺序**：commit 0 = 本 spec + 实施 plan（文档）；commit 1–6 = 按域迁移。spec/plan 不提交到 main，留在 #259 worktree 作为第一个文档 commit。

## 风险

| 风险 | 缓解 |
|:---|:---|
| `dream.ts`/`reflect.ts`/`sync.ts` 跨引 ingestion 最密集，commit 5 改动最重 | maintenance 拆 2 commit；先改 import 再跑 check 验证 |
| `agentic/executor.ts` 6 条回引变深（`../search`→`../retrieval/search`） | 预期行为，属域边界正常跨引 |
| issue 警告"别在大 feature branch 活跃时跑" | **执行前 gate**：重查 `gh pr list` + 本地 worktree/分支状态，确认无并行改 core 同批文件（本次 review 时 open PR=0，但执行前必须重查，不作为长期事实）|
| 80 处 import 改动有遗漏 | 终态 grep 残留扫描兜底 + tsc 会抓断引 |
| 改 ontogy 相关连锁 | 本次不碰 ontology.yaml、不碰 NER prompt、不碰 `resolveTypePriority`/`areTypesAffine` |

## Non-goals（复述 issue + 补充）

- ❌ 无行为变更（运行时语义 100% 不变）
- ❌ 无 schema 变更
- ❌ 无 tool/API 变更
- ❌ 无顺手 refactor（不改函数签名、不拆大文件、不改命名）
- ❌ 不在并行大 feature 活跃时执行

## Acceptance criteria

- [ ] 文件按小批次可 review 迁移（6 个 commit）
- [ ] 全部 import 更新，无断引
- [ ] `bun run check` 绿
- [ ] Git history 可读（rename 检测生效，`--follow` 可追溯）
- [ ] 无公开 docs/tests 使用 private 路径示例
- [ ] 文档路径引用同步更新

## 后续

spec approve → `writing-plans` 出逐步实施 plan → worktree 执行 → `finishing-a-development-branch`。
