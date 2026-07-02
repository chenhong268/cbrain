# core 按功能域重组 实施计划 (#259)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/core/` 的 54 个 flat 文件迁入 5 个域子目录（ingestion/retrieval/graph/maintenance/safety），运行时行为 0 变化。

**Architecture:** 纯文件移动 + import 路径更新。每域一个 commit（Task 0 文档，Task 1-5b 迁移，Task 6 终态验证）。核心机制：`git mv` → `bun run lint`（tsc --noEmit）报所有断引 → 按统一规则改 → `bun run check` 绿 → grep 残留 → commit。根 cross-cutting（shared/logger/page/audit/jobs/provenance/version，7 文件）不动；已有子目录（agentic/fsck/knowledge-map/recall）不动。

**Tech Stack:** Bun, TypeScript strict (ESNext modules), bun:test, biome lint。门禁 `bun run check` = `bun run lint` + `bun test`。

**前置（已完成）:**
- worktree: `.claude/worktrees/259-core-domain-reorg`，branch `worktree-259-core-domain-reorg`，base = 本地 main `61ae93c`（已对齐 origin/main，无需 rebase）。
- `bun install` 完成（141 packages）。
- 基线 `bun run check` 绿：2985 pass / 0 fail。
- spec: `docs/superpowers/specs/2026-07-02-core-domain-reorg-design.md`。

## 通用 import 改写规则（每个迁移 Task 复用）

迁移 `src/core/<name>.ts` → `src/core/<domain>/<name>.ts` 后，**所有**引用该文件的 import 按引用方位置改写：

| 引用方所在位置 | 迁移前 import | 迁移后 import | 改? |
|:---|:---|:---|:---:|
| 同域文件（`src/core/<domain>/` 内） | `./<name>.js` | `./<name>.js` | 不变 |
| 跨域文件（`src/core/<other-domain>/` 内） | `./<name>.js` | `../<domain>/<name>.js` | 改 |
| core 根文件引该域文件 | `./<name>.js` | `./<domain>/<name>.js` | 改 |
| **该域文件**引根 cross-cutting（shared/logger/page/audit/jobs/provenance/version） | `./<shared>.js` | `../<shared>.js` | 改 |
| 外部消费者（`src/mcp/`, `src/cli/`, `src/storage/`） | `../../core/<name>.js` | `../../core/<domain>/<name>.js` | 改 |
| 已有子目录（`src/core/agentic/`, `knowledge-map/`） | `../<name>.js` | `../<domain>/<name>.js` | 改 |
| `tests/` 下测试文件 | 按其相对 `core/` 深度同理改 | 同理 | 改 |

**找断引的唯一机制**：`git mv` 后立即跑 `bun run lint`。tsc 列出**所有** TS2307 "cannot find module" 断引，覆盖 src/ + tests/ 全量。按上表逐个 `Edit` 改，重跑 lint 直到 0 TS2307。**这是 source of truth——不靠手 grep 预判。**

**tests/ 是改动大头**：实测 106 个测试文件、194 条 import 指向 core（~120 条指向迁移文件，指向根 cross-cutting 的不动）——比 src 外部 fan-in（84）还多。tsc 会全部报出，按规则表改即可。tests 多用 `../src/core/X.js` 或 `../../src/core/X.js`，迁移后改 `../src/core/<domain>/X.js`。

**增量副作用（预期）**：某些跨域引用会在两个 Task 里改两次。例：`search.ts` 引 `graph.ts`——Task 1 迁 graph 时 search 还在 core 根，改成 `./graph/graph.js`；Task 4 迁 retrieval（含 search）时 search 进 retrieval/，再改成 `../graph/graph.js`。每个 commit 都 green，这是 incremental 迁移的代价。

---

### Task 0: 提交 spec + plan（文档 commit 0）

**Files:**
- 已就位: `docs/superpowers/specs/2026-07-02-core-domain-reorg-design.md`
- Create: `docs/superpowers/plans/2026-07-02-core-domain-reorg.md`（本文件）

- [ ] **Step 1: 确认两文档在工作区（untracked）**
Run: `git status --short`
Expected:
```
?? docs/superpowers/plans/2026-07-02-core-domain-reorg.md
?? docs/superpowers/specs/2026-07-02-core-domain-reorg-design.md
```

- [ ] **Step 2: 提交文档 commit**
Run:
```bash
git add docs/superpowers/specs/2026-07-02-core-domain-reorg-design.md docs/superpowers/plans/2026-07-02-core-domain-reorg.md
git commit -m "docs(core): spec + plan for #259 core domain reorg"
```

- [ ] **Step 3: 验证**
Run: `git log -1 --oneline`
Expected: `<hash> docs(core): spec + plan for #259 core domain reorg`

---

### Task 1: 迁移 graph/ 域（3 文件）

**Files (git mv):**
- `src/core/graph.ts` → `src/core/graph/graph.ts`
- `src/core/hierarchy.ts` → `src/core/graph/hierarchy.ts`
- `src/core/knowledge-write.ts` → `src/core/graph/knowledge-write.ts`

**已知跨域引用（Explore 实测，执行时以 tsc 为准）：**
- `graph.ts` 被 `search.ts`(retrieval)、`entity-resolver.ts`(ingestion)、`hierarchy.ts`/`knowledge-write.ts`(同域) 引。
- `hierarchy.ts` 被 `knowledge-write.ts`(同域) 引；外部 mcp 引 4 次。
- `knowledge-write.ts` 引根 `page.ts`/`shared.ts` + ingestion 的 `pipeline.ts`。
- 外部 `src/mcp/` 引 graph/hierarchy/knowledge-write 约 10+ 次（深路径）。

- [ ] **Step 1: git mv 三文件到 graph/**
Run:
```bash
mkdir -p src/core/graph
git mv src/core/graph.ts src/core/graph/graph.ts
git mv src/core/hierarchy.ts src/core/graph/hierarchy.ts
git mv src/core/knowledge-write.ts src/core/graph/knowledge-write.ts
```

- [ ] **Step 2: 跑 lint 收集所有断引**
Run: `bun run lint 2>&1 | grep -E "error TS2307|cannot find module" | head -60`
Expected: 列出所有引用 graph/hierarchy/knowledge-write 的断引（src/core/*.ts 内部 + src/mcp/ + tests/）。

- [ ] **Step 3: 按"通用 import 改写规则"逐个 Edit 改断引**
对 tsc 报的每个断引 `Edit` 改。例：
- `src/core/search.ts` 里 `from "./graph.js"` → `from "./graph/graph.js"`（search 还在根）
- `src/core/graph/knowledge-write.ts` 里 `from "./page.js"` → `from "../page.js"`；`from "./pipeline.js"` → `from "../ingestion/pipeline.js"`（pipeline 此刻仍在根，tsc 会接受 `../pipeline.js`？——否：knowledge-write 在 graph/，pipeline 在 core 根，正确写法是 `../pipeline.js`。Task 3 迁 pipeline 后再改 `../ingestion/pipeline.js`）
- `src/mcp/tools/X.ts` 里 `from "../../core/graph.js"` → `from "../../core/graph/graph.js"`
改完重跑 `bun run lint`，直到 0 TS2307。

- [ ] **Step 4: 全量 check 绿**
Run: `bun run check 2>&1 | tail -5`
Expected: `0 fail`，test 数不降（降了说明有测试漏改 import）。

- [ ] **Step 5: 残留扫描 graph 文件旧深路径**
Run: `grep -rnE "core/(graph|hierarchy|knowledge-write)\.js" src/ tests/ --include="*.ts"`
Expected: 0 命中。若有命中回到 Step 3。

- [ ] **Step 6: 抽查 rename 历史可追溯**
Run: `git log --follow src/core/graph/graph.ts --oneline | head -3`
Expected: 能看到迁移前的历史 commit（git mv 保留了 rename）。

- [ ] **Step 7: commit**
Run:
```bash
git add -A
git commit -m "refactor(core): move graph modules to graph/ (#259)

graph, hierarchy, knowledge-write → src/core/graph/.
Pure file move + import path updates. No behavior change."
```

---

### Task 2: 迁移 safety/ 域（5 文件）

**Files (git mv):**
- `src/core/page-delete-safety.ts` → `src/core/safety/page-delete-safety.ts`
- `src/core/sync-index-safety.ts` → `src/core/safety/sync-index-safety.ts`
- `src/core/atomic-move.ts` → `src/core/safety/atomic-move.ts`
- `src/core/merge-workflow.ts` → `src/core/safety/merge-workflow.ts`
- `src/core/writeback.ts` → `src/core/safety/writeback.ts`

**已知跨域引用：**
- `atomic-move.ts` 被 `page.ts`(根)、`merge-workflow.ts`(同域) 引。
- `sync-index-safety.ts` 被 `pipeline.ts`(ingestion)、`sync.ts`(maintenance)、`knowledge-map/schedule.ts`(子目录) 引。
- `page-delete-safety.ts` 引根 `page.ts`/`shared.ts`。
- 子目录 `knowledge-map/schedule.ts` 引 `sync-index-safety`：`../sync-index-safety.js` → `../safety/sync-index-safety.js`。

- [ ] **Step 1: git mv 五文件到 safety/**
Run:
```bash
mkdir -p src/core/safety
git mv src/core/page-delete-safety.ts src/core/safety/page-delete-safety.ts
git mv src/core/sync-index-safety.ts src/core/safety/sync-index-safety.ts
git mv src/core/atomic-move.ts src/core/safety/atomic-move.ts
git mv src/core/merge-workflow.ts src/core/safety/merge-workflow.ts
git mv src/core/writeback.ts src/core/safety/writeback.ts
```

- [ ] **Step 2: 跑 lint 收集断引**
Run: `bun run lint 2>&1 | grep -E "error TS2307|cannot find module" | head -60`

- [ ] **Step 3: 按规则改断引**
特别注意子目录回引：`src/core/knowledge-map/schedule.ts` 的 `../sync-index-safety.js` → `../safety/sync-index-safety.js`。改完重跑 lint 到 0 TS2307。

- [ ] **Step 4: 全量 check 绿**
Run: `bun run check 2>&1 | tail -5`
Expected: `0 fail`。

- [ ] **Step 5: 残留扫描**
Run: `grep -rnE "core/(page-delete-safety|sync-index-safety|atomic-move|merge-workflow|writeback)\.js" src/ tests/ --include="*.ts"`
Expected: 0 命中。

- [ ] **Step 6: commit**
Run:
```bash
git add -A
git commit -m "refactor(core): move safety modules to safety/ (#259)

page-delete-safety, sync-index-safety, atomic-move, merge-workflow, writeback → src/core/safety/.
Pure file move + import path updates. No behavior change."
```

---

### Task 3: 迁移 ingestion/ 域（13 文件）

**Files (git mv):**
```
src/core/ingest.ts                  → src/core/ingestion/ingest.ts
src/core/pipeline.ts                → src/core/ingestion/pipeline.ts
src/core/ner.ts                     → src/core/ingestion/ner.ts
src/core/ner-backfill.ts            → src/core/ingestion/ner-backfill.ts
src/core/content-classifier.ts      → src/core/ingestion/content-classifier.ts
src/core/personal-tag-classifier.ts → src/core/ingestion/personal-tag-classifier.ts
src/core/structured-facts.ts        → src/core/ingestion/structured-facts.ts
src/core/structured-facts-backfill.ts → src/core/ingestion/structured-facts-backfill.ts
src/core/extract.ts                 → src/core/ingestion/extract.ts
src/core/dialogue.ts                → src/core/ingestion/dialogue.ts
src/core/entity-resolver.ts         → src/core/ingestion/entity-resolver.ts
src/core/name-similarity.ts         → src/core/ingestion/name-similarity.ts
src/core/similar-entity-detector.ts → src/core/ingestion/similar-entity-detector.ts
```

**已知跨域引用（量大，tsc 为准）：**
- `pipeline.ts` 被 `sync.ts`/`dream.ts`/`reflect.ts`(maintenance)、`stub-enrich.ts`(maintenance)、`knowledge-write.ts`(graph，Task 1 已迁) 引。
- `ner.ts` 被 `pipeline.ts`/`structured-facts.ts`(同域) 引；hub。
- `entity-resolver.ts` 引 `ner.ts`(同域)、被 `dialogue.ts`(同域) 引。
- `extract.ts` 被 `health.ts`(maintenance) 引（跨域）。
- `name-similarity.ts` 被 `discovery.ts`(maintenance)、`similar-entity-detector.ts`(同域) 引。
- 外部 `src/mcp/` 引 ingest/ner/entity-resolver 等多个（深路径）。

- [ ] **Step 1: git mv 13 文件到 ingestion/**
Run:
```bash
mkdir -p src/core/ingestion
for f in ingest pipeline ner ner-backfill content-classifier personal-tag-classifier structured-facts structured-facts-backfill extract dialogue entity-resolver name-similarity similar-entity-detector; do
  git mv "src/core/$f.ts" "src/core/ingestion/$f.ts"
done
```

- [ ] **Step 2: 跑 lint 收集断引**
Run: `bun run lint 2>&1 | grep -E "error TS2307|cannot find module" | head -100`
Expected: 断引较多（13 文件 × 内部 hub + 外部 mcp）。

- [ ] **Step 3: 按规则改断引**
同域互引（ner↔pipeline↔entity-resolver 等）`./X.js` 不变。重点改：
- ingestion 文件引根（page/shared/logger/version）：`./X.js` → `../X.js`
- ingestion 文件引他域：`./X.js` → `../<domain>/X.js`（如 Task 1 后 `knowledge-write` 在 graph/，若 ingestion 引它——实测 pipeline 不引 knowledge-write，但 tsc 会报任何断引）
- maintenance 文件（sync/dream/reflect，还在根）引 ingestion：`./pipeline.js` → `./ingestion/pipeline.js`
- graph/ 文件（已迁）引 ingestion：Task 1 时 `knowledge-write` 引 pipeline 改成了 `../pipeline.js`，现在 pipeline 进 ingestion/，`../pipeline.js` 断 → `../ingestion/pipeline.js`（tsc 报）
- 外部 `src/mcp/`：`../../core/ner.js` → `../../core/ingestion/ner.js` 等
改完重跑 lint 到 0 TS2307。

- [ ] **Step 4: 全量 check 绿**
Run: `bun run check 2>&1 | tail -5`
Expected: `0 fail`。

- [ ] **Step 5: 残留扫描**
Run: `grep -rnE "core/(ingest|pipeline|ner|ner-backfill|content-classifier|personal-tag-classifier|structured-facts|structured-facts-backfill|extract|dialogue|entity-resolver|name-similarity|similar-entity-detector)\.js" src/ tests/ --include="*.ts"`
Expected: 0 命中。

- [ ] **Step 6: commit**
Run:
```bash
git add -A
git commit -m "refactor(core): move ingestion modules to ingestion/ (#259)

ingest pipeline + NER + entity resolution (13 files) → src/core/ingestion/.
Pure file move + import path updates. No behavior change."
```

---

### Task 4: 迁移 retrieval/ 域（16 文件）

**Files (git mv):** search, query-router, research, evidence, evidence-completion, grounded-answer, artifact, episodic-recall, recall-intent, search-trace, search-diagnostics, proactive, dossier, key-points, birthday, frontdoor-router

**已知跨域引用：**
- `search.ts` 引 `graph/graph.ts`（Task 1 后 search 在根引 `./graph/graph.js`，本 Task 后改 `../graph/graph.js`）。
- `artifact.ts` 引 `agentic/pipeline.ts`（子目录）。
- 外部 `src/mcp/` 大量引 search/grounded-answer/episodic-recall 等；`provenance.ts` 在根不动。

- [ ] **Step 1: git mv 16 文件到 retrieval/**
Run:
```bash
mkdir -p src/core/retrieval
for f in search query-router research evidence evidence-completion grounded-answer artifact episodic-recall recall-intent search-trace search-diagnostics proactive dossier key-points birthday frontdoor-router; do
  git mv "src/core/$f.ts" "src/core/retrieval/$f.ts"
done
```

- [ ] **Step 2: lint 收集断引**
Run: `bun run lint 2>&1 | grep -E "error TS2307|cannot find module" | head -120`

- [ ] **Step 3: 按规则改断引**
重点：
- `search.ts`（retrieval/）引 graph：`./graph/graph.js`（Task1 后的写法）→ `../graph/graph.js`
- retrieval 文件引根（shared/logger/page/provenance）：`./X.js` → `../X.js`
- `artifact.ts` 引 `agentic/pipeline.ts`：原本 `./agentic/pipeline.js`，retrieval/ 下改 `../agentic/pipeline.js`
- 外部 `src/mcp/`：`../../core/search.js` → `../../core/retrieval/search.js` 等（`provenance` 在根不动）
改完重跑 lint 到 0 TS2307。

- [ ] **Step 4: 全量 check 绿**
Run: `bun run check 2>&1 | tail -5`

- [ ] **Step 5: 残留扫描**
Run: `grep -rnE "core/(search|query-router|research|evidence|evidence-completion|grounded-answer|artifact|episodic-recall|recall-intent|search-trace|search-diagnostics|proactive|dossier|key-points|birthday|frontdoor-router)\.js" src/ tests/ --include="*.ts"`
Expected: 0 命中。

- [ ] **Step 6: commit**
Run:
```bash
git add -A
git commit -m "refactor(core): move retrieval modules to retrieval/ (#259)

search + recall + answer (16 files) → src/core/retrieval/.
Pure file move + import path updates. No behavior change."
```

---

### Task 5a: 迁移 maintenance/ 第一批（11 文件：sync/dream/health/doctor cluster）

**Files (git mv):** sync, dream, watcher, health, health-debt, enrich, seal, stub-enrich, wakeup, reflect, first-run

**已知跨域引用（最密集，dream.ts 14 出度）：**
- maintenance 引 ingestion（pipeline/ingest/ner-backfill）、graph（knowledge-write/hierarchy）、safety（sync-index-safety）、retrieval（search 等）。
- `dream.ts` 引子目录 `knowledge-map/schedule.ts`。
- `extract.ts`(ingestion) 被 `health.ts` 引（已在 Task 3 处理方向）。
- 子目录 `agentic/executor.ts` 引 search(graph→Task4 后 retrieval)/page(根)/evidence(retrieval)/graph——Task 4 已把 search/evidence 改成 `../retrieval/X.js`，本 Task 不碰 agentic，除非有 maintenance→agentic 引用。

- [ ] **Step 1: git mv 11 文件到 maintenance/**
Run:
```bash
mkdir -p src/core/maintenance
for f in sync dream watcher health health-debt enrich seal stub-enrich wakeup reflect first-run; do
  git mv "src/core/$f.ts" "src/core/maintenance/$f.ts"
done
```

- [ ] **Step 2: lint 收集断引**
Run: `bun run lint 2>&1 | grep -E "error TS2307|cannot find module" | head -120`

- [ ] **Step 3: 按规则改断引**
重点：
- maintenance 文件引根（shared/logger/page/audit/version）：`./X.js` → `../X.js`
- maintenance 引 ingestion：`./pipeline.js` → `../ingestion/pipeline.js`
- maintenance 引 graph：`./X.js` → `../graph/X.js`
- maintenance 引 safety：`./sync-index-safety.js` → `../safety/sync-index-safety.js`
- maintenance 引 retrieval：`./search.js` → `../retrieval/search.js`
- `dream.ts` 引 `knowledge-map/schedule.ts`：`./knowledge-map/schedule.js` → `../knowledge-map/schedule.js`
- 第一批 maintenance 文件之间互引（dream→sync/enrich/health 等）：同域 `./X.js` 不变
- 外部 `src/mcp/` 引 health/dream/sync 等
改完重跑 lint 到 0 TS2307。

- [ ] **Step 4: 全量 check 绿**
Run: `bun run check 2>&1 | tail -5`

- [ ] **Step 5: 残留扫描**
Run: `grep -rnE "core/(sync|dream|watcher|health|health-debt|enrich|seal|stub-enrich|wakeup|reflect|first-run)\.js" src/ tests/ --include="*.ts"`
Expected: 0 命中。

- [ ] **Step 6: commit**
Run:
```bash
git add -A
git commit -m "refactor(core): move maintenance modules batch 1 to maintenance/ (#259)

sync/dream/health/doctor cluster (11 files) → src/core/maintenance/.
Pure file move + import path updates. No behavior change."
```

---

### Task 5b: 迁移 maintenance/ 第二批（6 文件：discovery/insight cluster）

**Files (git mv):** insight, learn, indexes, compounding-review, discovery, discovery-digest

**已知跨域引用：**
- `discovery.ts` 引 ingestion 的 `name-similarity`/`similar-entity-detector`。
- 第一批 maintenance 文件（已迁）若引第二批：Task 5a 时它们在 maintenance/ 引根的 `discovery.js` 是 `../discovery.js`（discovery 还在根），本 Task discovery 进 maintenance/ 后 `../discovery.js` 断 → `./discovery.js`（tsc 报，按规则改）。

- [ ] **Step 1: git mv 6 文件到 maintenance/**
Run:
```bash
for f in insight learn indexes compounding-review discovery discovery-digest; do
  git mv "src/core/$f.ts" "src/core/maintenance/$f.ts"
done
```

- [ ] **Step 2: lint 收集断引**
Run: `bun run lint 2>&1 | grep -E "error TS2307|cannot find module" | head -80`

- [ ] **Step 3: 按规则改断引**
重点：
- `discovery.ts` 引 ingestion 的 name-similarity/similar-entity-detector：`./X.js` → `../ingestion/X.js`
- 这些文件引根（shared/logger）：`./X.js` → `../X.js`
- 第一批 maintenance 文件引第二批：`../discovery.js` → `./discovery.js`（同域）
- 外部 mcp 引 discovery/discovery-digest
改完重跑 lint 到 0 TS2307。

- [ ] **Step 4: 全量 check 绿**
Run: `bun run check 2>&1 | tail -5`

- [ ] **Step 5: 残留扫描**
Run: `grep -rnE "core/(insight|learn|indexes|compounding-review|discovery|discovery-digest)\.js" src/ tests/ --include="*.ts"`
Expected: 0 命中。

- [ ] **Step 6: commit**
Run:
```bash
git add -A
git commit -m "refactor(core): move maintenance modules batch 2 to maintenance/ (#259)

discovery/insight cluster (6 files) → src/core/maintenance/.
Pure file move + import path updates. No behavior change."
```

---

### Task 6: 终态验证 + 文档同步

**Files:**
- Verify: 全量 `bun run check`、残留 grep、rename 历史、根目录结构
- Modify: `CLAUDE.md`、`README.md`、`docs/usage.md`、`docs/mcp-tools.md`（按 grep 命中）

- [ ] **Step 1: 全量门禁**
Run: `bun run check 2>&1 | tail -5`
Expected: `0 fail`，test 数 = 基线 2985（不降）。

- [ ] **Step 2: 全域残留扫描（所有 54 已迁文件）**
Run:
```bash
grep -rnE "core/(ingest|pipeline|ner|ner-backfill|content-classifier|personal-tag-classifier|structured-facts|structured-facts-backfill|extract|dialogue|entity-resolver|name-similarity|similar-entity-detector|search|query-router|research|evidence|evidence-completion|grounded-answer|artifact|episodic-recall|recall-intent|search-trace|search-diagnostics|proactive|dossier|key-points|birthday|frontdoor-router|graph|hierarchy|knowledge-write|sync|dream|watcher|health|health-debt|enrich|seal|stub-enrich|wakeup|insight|learn|indexes|reflect|compounding-review|discovery|discovery-digest|first-run|page-delete-safety|sync-index-safety|atomic-move|merge-workflow|writeback)\.js" src/ tests/ --include="*.ts"
```
Expected: 0 命中。（根 cross-cutting shared/logger/page/audit/jobs/provenance/version 不在列表，其 `core/<name>.js` 引用合法保留。）

- [ ] **Step 3: 验证根只剩 7 cross-cutting + 4 已有子目录 + 5 新域**
Run: `ls src/core/*.ts`
Expected:
```
src/core/audit.ts
src/core/jobs.ts
src/core/logger.ts
src/core/page.ts
src/core/provenance.ts
src/core/shared.ts
src/core/version.ts
```
Run: `ls -d src/core/*/`
Expected: `agentic/ fsck/ graph/ ingestion/ knowledge-map/ maintenance/ recall/ retrieval/ safety/`

- [ ] **Step 4: 抽查 rename 历史可追溯（抽样大文件）**
Run:
```bash
git log --follow src/core/maintenance/sync.ts --oneline | head -3
git log --follow src/core/retrieval/search.ts --oneline | head -3
git log --follow src/core/ingestion/ner.ts --oneline | head -3
```
Expected: 每个都能看到迁移前的历史 commit。

- [ ] **Step 5: 文档路径同步**
Run:
```bash
grep -rnE "core/(ingest|pipeline|ner|search|sync|dream|health|graph|hierarchy|evidence|episodic-recall|reflect|discovery|grounded-answer|dossier|first-run|watcher|enrich|seal|extract|dialogue|artifact|research|proactive|birthday|key-points|page-delete-safety|atomic-move|merge-workflow|writeback|sync-index-safety|structured-facts|content-classifier|ner-backfill|stub-enrich|wakeup|insight|learn|indexes|compounding-review|discovery-digest|entity-resolver|name-similarity|similar-entity-detector|query-router|evidence-completion|recall-intent|search-trace|search-diagnostics|frontdoor-router|personal-tag-classifier|structured-facts-backfill)\.js" docs/ README.md CLAUDE.md 2>/dev/null
```
对每个命中更新为新路径 `core/<domain>/<name>.js`。注意：
- `docs/usage.md` / `docs/mcp-tools.md` 命令表是 auto-gen（memory `docs-consistency-autogen-rules`）——本次不涉及 `.description()` 工具文本，只改路径示例；若命中命令表，确认是否需 `--update` 重生而非手改。
- `CLAUDE.md` 架构章节的 `src/core/` 目录树图按新结构更新。

- [ ] **Step 6: diff 抽查纯移动**
Run: `git diff main --stat | tail -20`
Expected: 绝大多数文件标 `=>`（rename），改动行集中在 import 引用方。无大段逻辑改动。

- [ ] **Step 7: 提交文档同步**
Run:
```bash
git add -A
git commit -m "docs(core): sync core path references after #259 reorg"
```

- [ ] **Step 8: 收尾**
分支 `worktree-259-core-domain-reorg` 共 8 个 commit（0 文档 + 1-5b 迁移 + 6 验证/文档）。交 `superpowers:finishing-a-development-branch` 决定 merge/PR/cleanup。issue 要求的执行前 gate（open PR 重查）在多 session 时每个 Task 前复核。

---

## Self-Review

- **Spec 覆盖**: spec 的 6 commit 批次 → Task 0-5b 全覆盖；spec 的验证/文档同步/残留扫描/根目录结构 → Task 6 全覆盖；spec 的通用规则 → "通用 import 改写规则"节。
- **Placeholder 扫描**: 无 TBD/TODO。每个 Task 给确切 git mv 清单 + 确切 grep/lint 命令 + 确切 commit message + 确切残留扫描正则。
- **一致性**: 域名/文件名在所有 Task 一致（ingestion/retrieval/graph/maintenance/safety）；maintenance 17 文件拆 5a(11)+5b(6) 与 spec 批次表一致。
- **机制可靠**: 不预填 ~80 行 import（易过时），用 tsc 断引 + 规则表，执行时 source of truth。
