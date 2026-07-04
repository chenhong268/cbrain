# Skip Decompose When FTS-Sufficient (#272)

> 状态：设计已确认（宏哥选方案 1：FTS hits ≥3 only），待 writing-plans 拆实现计划
> Issue: #272
> 日期: 2026-07-04

## Context

#250 / #268 / #269 收敛了主要 runaway 路径，但 `perf-diagnose` 仍显示 smart 搜索延迟与降级偏高：

- 7 天 `perf-diagnose`：`latency_warning_rate=0.76`，`degraded_rate=0.653`。
- post-2026-07-03 切片：4 个 smart session，`decompose` avg ~5.1s、max ~8.0s。
- 一个 fresh session 仍 `degraded`（`decompose_budget_exceeded` / `budget_exhausted`）；成功的 session 也带 `latency_budget_exceeded`，被 `decompose_ms` 主导。

根因：`decompose`（LLM 调用）在 FTS-sufficient fast path **之前**跑。#250 把 `expandQuery` gate 到 FTS sufficiency 之后，但 decompose 分支没有这个 gate——complex query 一律进 decompose，哪怕确定性 FTS 证据已经足够。

代码事实（`src/core/retrieval/search.ts`，行号基于当前 main）：

- `decomposeQuery` 唯一调用点：`search.ts:441`，在 `searchCore` 的 `if (complex)` 块（`408-482`）内。
- 当前 decompose gate：`this.llm && !options._skipDecompose && complex`（`search.ts:408, 423`）——**无 FTS sufficiency 检查**。
- #250 已有的可复用模式：`ftsProbe.length >= FTS_SUFFICIENT_RESULTS`（=3，常量 `search.ts:327`），probe 复用为 `initialFts` 避免双查（`search.ts:488-493, 504, 594`）。
- budget guards：call-count budget（`search.ts:425-428`）+ `Promise.race` timeout 8000ms（`search.ts:432-454`）+ weak/empty sub-results bounded fallback（`search.ts:461-481`）。
- `SearchTrace`（`search.ts:35-50`）已有 `expand_skipped?: string`（值 `"fts_sufficient"` / `"budget_exhausted"`）——`decompose_skipped` 的现成模板，自动进 `summaryJson`，**不需改 `search-trace.ts`**。

## Goal

默认 smart 搜索：当原 query 的 FTS 探针已足够（≥3 命中）时，**skip decompose**，降 latency / 降级率，**不降 recall**、不重新引入无界 LLM fanout。

## Design

### Sufficiency gate（方案 1，宏哥已选）

- **判定标准**：`ftsSufficient = ftsProbe.length >= FTS_SUFFICIENT_RESULTS`（=3）。只看 FTS，**不纳入 `knownSlugs`**。
- 理由：复用 #250 已验证口径，不引入第二套判断；`knownSlugs≥2` 现在是 `isComplexQuery` 的**触发**条件，若同时当 sufficient 信号，会把"对比 A 和 B / A 和 B 什么关系"这类真正需要拆解的问题误判为足够（recall 回退风险 > 收益）。
- issue 的 `where practical` 留白即此处——`knownSlugs` 本期不复用。

### 目标 control flow（`searchCore`）

把 `ftsProbe` **hoist 到 decompose 分支与 #250 gate 之前**，complex 与非 complex 路径共用同一个 probe，避免第二次 FTS 查询：

```
searchCore(query, limit, options):
  if empty → return []
  vector/fts/graph strategy fast-paths
  exact-title fast path (getPageByTitle) → return   # 不变

  # hints 解析（knownSlugs, candidates, complex = isComplexQuery）hoist 到 ftsProbe 前
  # HOIST：所有路径共用一次 FTS 探针
  ftsProbe   = await timedFtsSearch(query, limit, trace).catch(() => [])   # 复用 #250 的 timedCall + fts_ms
  ftsSufficient = ftsProbe.length >= FTS_SUFFICIENT_RESULTS

  if (complex && this.llm && !options._skipDecompose):
    if (ftsSufficient):
      trace.decompose_skipped = "fts_sufficient"      # 新：记录 skip 原因
      # 不 return，fall through 到 #250 gate（复用 ftsProbe）
    else:
      ...原 decompose 流程（#222 call-count budget + #268 timeout + weak-fallback），return...

  # #250 expand gate（不再重跑 ftsProbe，复用 hoisted）
  shouldExpand = multiQueryAllowed && !!this.llm && (isComplex || !ftsSufficient)
  if (trace && this.llm && !shouldExpand && ftsSufficient):
    trace.expand_skipped = "fts_sufficient"           # 不变
  return searchWithExpansion(query, limit, shouldExpand, trace, ftsProbe)   # 复用 ftsProbe
```

关键点：

1. **hoist ftsProbe 一次**：decompose sufficiency 判定 + #250 expand gate + `searchWithExpansion` 的 `initialFts` 全部复用同一个 probe；`searchSingleQuery` 第一查询也复用（`search.ts:594` 现有模式）。**FTS 调用次数 = 1**，无第二次查询（对抗审查重点验）。
2. **skip = fall through，不是 return**：complex + ftsSufficient 时**不调 decompose**，落到 #250 gate 走正常 hybrid + 可能的 expand（`shouldExpand` 仍按 `(isComplex || !ftsSufficient)` 算——complex query 即使 ftsSufficient，expand 仍可能跑，这与 #250 现有测试 `search-latency-gate.test.ts:70-84` 一致，不变）。
3. **net 成本**：complex query 多一次 FTS 探针（同步 `db.ftsSearch`，便宜），换掉 ~5s LLM decompose。非 complex query 探针位置从 `488` 挪到 hoisted，**次数不变**（仍 1 次）。

### Trace

- 加 `decompose_skipped?: string` 到 `SearchTrace`（`search.ts:47`，紧挨 `expand_skipped`）。
- 唯一写入点：skip 时 `trace.decompose_skipped = "fts_sufficient"`。
- 自动进 `summaryJson`（`tools/search.ts:115` 的 spread），**不需改 `search-trace.ts`**（`traceToSteps` 只持久化 timing 字段；string 字段 ride along `summaryJson`）。
- `perf-diagnose` 若要统计 skip 率，直接聚合 `summary_json.decompose_skipped`（与 `degraded_reason` 同模式，`perf-diagnose.ts:169,304`）。本期**不新增** `DegradedReasonCode`（skip 非降级）。

### 保留不变（precedence）

按 #250 `expand_skipped` 现有顺序：

1. `_skipDecompose: true`（递归 guard，永不 decompose）——不变。
2. `multiStep: true`——已绕过 `searchCore` 去 `ResearchManager`，不受影响。
3. **新**：`ftsSufficient` → skip decompose + `trace.decompose_skipped`。
4. 否则（complex + LLM + 不 sufficient）→ 原 decompose 流程，含 #222 call-count budget + #268 timeout + weak-results bounded fallback，全部不变。

### Non-goals（issue）

- 不改 ranking / 不调 relevance 阈值 / 不做 schema migration / 不引入新 LLM planner。
- 不改 #250 latency-warning 语义。
- `knownSlugs` 不纳入本期 sufficiency。
- 无私密 fixture（测试只用 `实体A` / `实体B` / `主题C` 等匿名占位）。

## Acceptance Criteria

1. **complex + FTS≥3**：`decomposeQuery` 不被调用；`trace.decompose_skipped === "fts_sufficient"`；结果仍非空返回（走 hybrid + 可能 expand）。
2. **complex + FTS<3**：`decomposeQuery` 仍可在 budget 下被调用（行为同现状）。
3. **对抗（宏哥要求）**：多实体 / relationship / comparison query（`knownSlugs≥2`）+ FTS<3 → **仍允许 decompose**（验证 `knownSlugs` 不误 skip）。
4. **decompose timeout**：仍 fail closed 到 bounded fallback（`searchWithExpansion(query, limit, false, trace)`），不无界等待。
5. **无双查**：对**原 query** 的 `db.ftsSearch` 调用 = 1（hoisted probe 被 decompose gate + #250 gate + `searchWithExpansion` 共用；`488` 旧 probe 删除，不重跑原 query）。expand 生成的子查询各自跑 ftsSearch，**不计入**此约束。
6. **现有测试**：#222 / #250 / #268 search tests 全过。
7. `bun run check` 过。
8. **对抗审查**：recall regression / hidden double-FTS cost / trace correctness / private fixture leakage / explicit decompose & multiStep 行为变化。

## Test Plan

模板：`tests/core/search-latency-gate.test.ts`（#250），复用其 `seedFtsHits(n, content)` helper（seed `chunks_fts` 行使探针真返回 ≥3）。匿名 fixture（`实体A` / `实体B`）。

新增 case（建议放 `search-latency-gate.test.ts` 或新建 `search.decompose-skip.test.ts`，plan 阶段定）：

- complex query + FTS≥3 → `decomposeQuery` NOT called + `trace.decompose_skipped === "fts_sufficient"` + 非空结果。
- complex query + FTS<3（empty probe）→ `decomposeQuery` 被调用（budget 下）。
- 多实体 query（`knownSlugs≥2`，如 "实体A 和 实体B 的关系"）+ FTS<3 → **仍 decompose**（对抗 #3）。
- `_skipDecompose: true` + FTS≥3 → 不调 decompose（precedence #1）。
- skip 路径对**原 query** 的 `db.ftsSearch` 调用 = 1（对抗 double-FTS cost #5）——mock `db.ftsSearch` 计数，区分原 query vs expand 子查询。
- skip 后 `expand_skipped` / `shouldExpand` 行为不变（complex + ftsSufficient 仍可能 expand，与 #250 `:70-84` 一致）。

## Files

- `src/core/retrieval/search.ts`：hoist `ftsProbe` + 新增 sufficiency gate + `trace.decompose_skipped` 写入 + `SearchTrace` 加字段。
- `tests/core/`：新增/扩展 decompose-skip 测试（匿名 fixture）。
- 不改：`search-trace.ts`、`tools/search.ts`、`search-diagnostics.ts`、`sqlite.ts`、ontology、#250 常量。

## Risks / 对抗审查关注

- **recall regression**：skip decompose 后，complex query 靠 hybrid + expand 召回。FTS≥3 是强信号（词在索引匹配到内容），但多跳/relationship 查询可能需拆解——`knownSlugs` 不纳入 precisely 防这个。
- **hidden double-FTS cost**：hoist 必须确保 `ftsProbe` 被 `searchWithExpansion` / `searchSingleQuery` 复用，`488` 的旧 probe 要删/改，不能残留第二次 `ftsSearch`。测试 #5 锁死。
- **flow refactor 回归**：`searchCore` 流程调整不能破 exact-title fast path、sub-query 搜索（sub-query 用自己的 FTS，不复用原 query probe）、weak-results fallback。
- **trace correctness**：`decompose_skipped` 只在真 skip 时写；decompose 被调用时不写。
- **explicit path**：`_skipDecompose` / `multiStep` / `multiQuery:false` 行为不变（测试锁）。
