# Default Smart Recall Latency / Degraded Split — Design

- **Issue**: #250 (bug)
- **State**: OPEN
- **Status**: Design — pending review
- **Date**: 2026-06-29

---

## 设计原则（置顶，不可违背）

> **Degraded 判定以结果质量为主，不以耗时为主。** 一个"慢但完整"的召回不是 degraded；
> 一个"快但空/低相关/向量失败"的召回才是 degraded。耗时超阈值只是 warning，不是降级。

每一条实现决策回退到这句话。冲突时以此为准、牺牲"快"。

---

## 背景与根因

Hermes 报告默认 smart recall **67.7% degraded**（`latency_budget_exceeded`，>2000ms）。`perf-diagnose` 显示 `smart-hybrid` p95 7231ms degraded 100%、`smart-decompose` p50 4293ms max 51063ms——LLM expand/decompose 主导了默认路径的延迟。

三条默认叠加成根因（探索验证）：

1. **`deep_recall` smart 无 FTS-first 短路**（`recall.ts:96` 直接全 hybrid，不像 query 工具 `search.ts MCP:smart-fts` 有 FTS 够就返回）。
2. **`multiQueryEnabled` 默认 `true`** → `searchWithExpansion` **总调 `expandQuery` LLM**（`search.ts:523`），且 expandQuery **无 timeout/call-count guard**（decompose 有 #222 guard，expand 没有）。
3. **`computeSearchDegraded` 把 `latencyMs > 2000` 当 degraded**（`search-diagnostics.ts:189`），把"慢但完整"和"真残缺"混为同一严重度。

## 目标

默认 recall 快且可预测。LLM expansion/decomposition 不再是普通记忆查找默认降级的主因。慢但完整的结果不再被打成 degraded。

---

## 范围

### In scope

- 门控默认路径的 `expandQuery` LLM（复杂 OR FTS 不足才调）。
- 拆分 latency 分类：latency-only → warning，不 degraded。
- 给 `expandQuery` 补 budget guard（类比 #222 decompose guard）。
- `perf-diagnose` 分 `degraded_rate` 与 `latency_warning_rate`。

### Out of scope（不做）

- 不调 #230 `RECALL_MIN_SCORE`（`search.ts:241`）。
- 不 reintroduce #222 之外的多步 escalation；#222 decompose guards（`MAX_SUBQUERIES`/`MAX_DEFAULT_LLM_CALLS`/`MAX_DEFAULT_DECOMPOSE_MS`，`search.ts:318-320`）**不动**，只给 expand **补**同款。
- 不改 DB schema（latency_warning 进现有 `details_json`/`summary_json`）。
- 不改全局 ranking；这个 issue 是砍不必要 LLM 慢路径，不是重调 ranking。
- 不删 vector search。
- 不把"提高 latency 阈值"当主修法（那只掩盖症状）。

---

## 三件套设计

### 1. expandQuery 门控（治本，砍 LLM 慢路径）

改 `searchWithExpansion`（`search.ts:521-547`）。现状 `useMultiQuery = (multiQuery ?? this.multiQueryEnabled) && !!this.llm`（:523）无 gate。改为：

```
shouldExpand = !!this.llm && (isComplexQuery(query) || ftsResultsInsufficient)
```

- **bounded FTS probe 先跑**（复用 query 工具 `search.ts MCP:smart-fts` 的 FTS-first 模式）。
- **FTS sufficient = `ftsResults.length >= 3`**（一期阈值，复用 query 工具既有数；不臆造 score 阈值。若后续要加 strong score，复用 `LOW_SCORE_THRESHOLD` 等现有常量，不新增体系）。
- FTS sufficient → **跳过 expandQuery**，trace 记 `expand_skipped_fts_sufficient`。
- 复杂 query（`isComplexQuery`，`search.ts:95-122`）OR FTS 不足/空 → 调 expandQuery。
- **decomposeQuery 不动**（沿用 `isComplexQuery` gate，不扩大）。
- `multiQueryEnabled` 保持 `true`，但实际调用由 gate 决定。

### 2. latency 分类（防误标）

- `computeSearchDegraded`（`search-diagnostics.ts:183-193`）：**latency-only 不再强制 degraded**。移除 `latencyMs > latencyThreshold` 直判 degraded 这条 OR；latency 只有在**同时**有 retrieval-degraded reason 时才计入 degraded。
- `DEGRADED_REASON_CODES` set（:171-181）**移除 `latency_budget_exceeded`**（保留 code 做可观测，但不触发 status）。
- 加 `latency_warning`：latency 超阈值 且 无 retrieval-degraded → status 仍 success/ok，trace/summary 带 `latency_warning: true`。
- retrieval 真 degraded（`vector_timeout` / `low_score` / `fts_empty` / `budget_exhausted` / 降级版 `parser_fallback`）照常 degraded。

### 3. expandQuery budget guard（补 #222 对 expand 的缺失）

现状 expandQuery 无 timeout/call-count guard。补：
- expandQuery 复用 `trace.llm_calls` 计数（已有，`search.ts:529-530`）+ 加 timeout（类比 `MAX_DEFAULT_DECOMPOSE_MS`，`Promise.race`）。
- 超预算 → **不整体 degraded**（守原则），保留已有 FTS/vector 结果 + `latency_warning`。

---

## 宏哥复审 5 点（必须落实）

### 点 1：FTS probe 结果复用，避免双查

smart 路径为判 `ftsResultsInsufficient` 跑的 FTS probe，**必须作为 `initialFtsResults` 传入后续 expansion/search flow**，主搜索不重复跑同样 FTS。否则砍了 LLM 却多一次 DB 查询，收益打折。

### 点 2：parser_fallback 不天然 degraded

FTS parser fallback（`fts_parser_fallback`）只是"查询语法被降级处理"。分类：
- `parser_fallback` + 结果质量足够（`length >= 3` 且 top score 非 low）→ **warning**，不 degraded。
- `parser_fallback` + 空/low score → **degraded**。

否则 degraded rate 会被非质量问题污染。`classifyDegradedReasons`（:85-157）的 `fts_parser_fallback` 分支按此细化。

### 点 3：expand timeout 不可取消语义

`Promise.race` timeout 可以，但 LLMProvider 若不支持 `AbortSignal`，**只能丢弃结果、不能真正中断请求**（同 NER）。expandQuery 是**纯读、不写 DB**，可接受。spec 明写：timeout 后不等待 expand 结果、不做后台写入、不影响主结果（主结果用已收集的 FTS/vector）。

### 点 4：latency_budget_exceeded 从 degraded reason 移到 warning reason

`perf-diagnose` 不再把 `latency_budget_exceeded` 放 `by_degraded_reason` 主表。输出分两张表：
- `by_degraded_reason`（retrieval-degraded only）
- `by_latency_warning_reason`（`latency_budget_exceeded` 进这里）

兼容：raw 可保留旧字段，但 display/report 必须区分。

### 点 5：degraded 判定规则（结果质量为主）

明确规则表：

| 场景 | status |
|---|---|
| 足够主结果 + expand/evidence/supplemental 超时 | `ok` + `latency_warning` |
| 主结果为空 / 低相关 / 向量失败 / FTS 失败且无可靠 fallback | `degraded` |
| LLM expansion 失败但 FTS/vector 已足够 | `ok` + `latency_warning` |
| LLM expansion 失败且主结果不足 | `degraded` |

---

## perf-diagnose 改动（`src/release/perf-diagnose.ts`）

- `degraded_rate`（:243）仅计 retrieval-degraded（status 由新 `computeSearchDegraded` 决定）。
- 新增 `latency_warning_rate`（latency-warning 占比），独立报告。
- `by_degraded_reason`（:267-280）移除 `latency_budget_exceeded`；新增 `by_latency_warning_reason`，`latency_budget_exceeded` 归此。
- raw 兼容旧字段；display/report 区分。

---

## 不变约束（守质量门）

- #230 `RECALL_MIN_SCORE = 0.01`（`search.ts:241`）不动。
- #222 decompose guards 不动；只给 expand 补同款。
- 不改 DB schema。
- 不改全局 ranking。

---

## 测试计划（匿名 fixture：实体A / 主题B / 组织C）

### 新增

- **expandQuery 门控**：
  - 简单精确 query + FTS 充分（>=3）→ **不调** expandQuery（spy `this.llm.expandQuery` 证 0 次）。
  - 简单 query + FTS 空/不足 → 调 expandQuery。
  - 复杂 query（isComplexQuery）→ 调 expandQuery（即使 FTS 充分）。
  - expandQuery 跳过 → trace `expand_skipped_fts_sufficient`。
- **latency 分类**：
  - latency-only slow（mock 慢但结果好）→ `latency_warning`、status **非** degraded。
  - retrieval degraded（vector timeout / low_score / fts_empty）→ 仍 degraded。
  - parser_fallback + 好结果 → warning；parser_fallback + 空/low → degraded。
- **budget guard**：expandQuery 超时/超计数 → 不 degraded、latency_warning、主结果保留。
- **perf-diagnose**：`degraded_rate` 与 `latency_warning_rate` 独立；`by_latency_warning_reason` 含 `latency_budget_exceeded`，`by_degraded_reason` 不含。

### 必须原样过

- #222 escalation-budget 现有测试（`tests/core/search.escalation-budget.test.ts`）。
- `tests/mcp/recall-quality.test.ts`（#230）。
- `tests/core/search-diagnostics.test.ts`。
- `bun run check`。

---

## 验收标准

1. latency-only slow 结果报 `latency_warning`，**不**单独设 status=degraded（有测试证）。
2. 默认 `deep_recall`/smart 简单记忆查找**不调** LLM expansion（spy 证）。
3. 显式 multiStep/agentic 流仍能走 LLM 路径（不破坏）。
4. perf-diagnose 测试证 `degraded_rate` 与 `latency_warning_rate` 独立。
5. #222 escalation 现有测试不变。
6. `bun run check` 通过。

---

## 执行方式

M 级 worktree + inline TDD。涉及 search 核心（`search.ts`/`search-diagnostics.ts`/`perf-diagnose.ts`）+ trace 消费者，契约细节密，集中在一个上下文做、每段 RED→GREEN→REFACTOR、每段 `bun run lint` + 相关测试。不分 subagent。

这是 #250 的正确第一阶段：先把"慢路径"从"结果降级"里拆出来，并让简单查询默认不进 LLM expansion。
