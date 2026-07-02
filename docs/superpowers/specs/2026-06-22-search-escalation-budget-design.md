# Default Search Escalation Budget — Design

> 关联 issue: #222 `bug: default smart search can escalate into high-latency multi-LLM research`
> 日期: 2026-06-22
> 状态: Draft（待 review）

## Problem

v1.9.8 后真实 telemetry（匿名 7 天）：overall search p95 ~47s，`smart-decompose` p95 ~76s，慢 session 14-19 LLM calls。慢源 = `research` / `expand` / `rerank` / vector。简单 FTS/success 路径快——问题专门在 **automatic agentic escalation 路径**。违反 v2.0 UX（fast memory kernel by default）。

## Root Cause（复现审计）

两条独立 escalation：

1. **internal cron/discovery**：调用方传 `multiStep === undefined` → `src/core/retrieval/search.ts:193-194` auto 分支（`multiStep === undefined && this.llm && isMultiStepCandidate`）→ `searchMultiStep` → `ResearchManager`（默认 3 iterations × 3 follow-up + rerank）。
2. **MCP `smart-decompose`**：complex query → `mcp/tools/search.ts:59` `ctx.search.search(strategy:"all")` → `searchCore` decomposition path（`search.ts:237-282`）：`decomposeQuery`（1 LLM）→ N sub-query 各 `this.search(sq, {_skipDecompose:true, ...options})` → **sub-query 走 `searchWithExpansion` → `expandQuery`（LLM）+ 多路 vector**。**二次 expand** 是关键隐藏成本：3 sub-query 实际 = 1 decompose + 3 expand + 多组 vector。

## Design Decision

**gate + budget + sub-query `multiQuery:false` + degraded（不抛）。** 默认 recall bounded predictable；explicit `multiStep=true` / `agentic_research` 才允许重路径。

### 1. `multiStep` gate（核心，不妥协）

`src/core/retrieval/search.ts:193-194`：

```ts
const shouldMultiStep = options?.multiStep === true;
```

去掉 `multiStep === undefined && isMultiStepCandidate` auto 分支。**ResearchManager 只在 explicit `multiStep === true` 触发**。`isMultiStepCandidate` 函数保留（不删，避免破坏引用），只是不再驱动 auto。

### 2. decomposition budget（`searchCore:237-282`）

constants near `HybridSearch`：

```ts
/** Default decomposition budget — keeps default recall cheap (0-1 LLM calls).
 *  Explicit multiStep=true / agentic_research bypass these (走 ResearchManager). */
const MAX_DEFAULT_SUBQUERIES = 3;
const MAX_DEFAULT_LLM_CALLS = 3;
const MAX_DEFAULT_DECOMPOSE_MS = 8000;
```

budget 实现：
- `subQueries.slice(0, MAX_DEFAULT_SUBQUERIES)` — 直接 cap sub-query 数（最有效，直接 bound LLM calls）
- `trace.llm_calls` 检查 — decomposition 入口若 `trace.llm_calls >= MAX_DEFAULT_LLM_CALLS` 则 skip decompose（走 degraded）
- decompose 后 elapsed check — `(Date.now() - decomposeStart) >= MAX_DEFAULT_DECOMPOSE_MS` 则 skip sub-query 执行，走 degraded

### 3. sub-query `multiQuery:false`（关键，防二次 expand）

`searchCore:262-267` sub-query 调用显式传 `multiQuery: false`——decompose 已做语义扩展，sub-query 不应再 `expandQuery` / 多 vector：

```ts
const subResults = await Promise.all(
  subQueries
    .slice(0, MAX_DEFAULT_SUBQUERIES)
    .map((sq) =>
      this.search(sq, { ...(options ?? {}), _skipDecompose: true, multiQuery: false, _trace: trace })
        .catch(() => [] as SearchResult[]),
    ),
);
```

### 4. degraded（不抛错，确定性有界，零额外 LLM）

budget 超过时**不 throw**——返回**已获得的确定性结果**（已 collect 的 sub-results，或空数组 `[]`）。**严禁走 `searchWithExpansion`** —— 它内部 `searchSingleQuery` 触发 **vector embedding（LLM 调用）**，会让 budget 超限后又触发第二次 LLM，把 #222 问题重新引回来。

degraded fallback 必须**零额外 LLM**：不 `expandQuery`、不 embedding、不 `ResearchManager`。实现：budget guard 命中时直接 `return` 已有结果（或 `[]`），仅 `trace.degraded_reason = "decompose_budget_exceeded"`。

### 5. MCP 层

`query` / `deep_recall` 的 `multiStep` 已默认 `false`（不 ResearchManager）。**schema 不改**（非 breaking）。decomposition budget + sub-query `multiQuery:false` 解决 smart-decompose escalation。

## Budget 值（拍板）

`MAX_DEFAULT_SUBQUERIES = 3` / `MAX_DEFAULT_LLM_CALLS = 3` / `MAX_DEFAULT_DECOMPOSE_MS = 8000`。

原则：**默认 recall 不是 research，默认路径 0-1 LLM**。explicit `multiStep=true` / `agentic_research` 才允许更重。`5` 对默认搜索仍偏宽。

## Testing（fixture 匿名，无真实 query/人名/产品）

- complex query + LLM + default options → **不 invoke ResearchManager**（multiStep gate；mock/spy ResearchManager 构造）
- complex query + `multiStep=true` → **invoke ResearchManager**
- decomposition subqueries ≤ 3（mock `decomposeQuery` 返回 10 → 实际处理 ≤ `MAX_DEFAULT_SUBQUERIES`）
- **sub-query 不二次 expand**：complex + default decomposition 时，sub-query `search` 调用必须 `multiQuery===false`（spy `searchWithExpansion` / `expandQuery` 调用次数，或断言 sub-query call options）
- degraded metadata structured（`degraded_reason="decompose_budget_exceeded"` 可观测）+ 无 raw query 泄漏
- **degraded fallback 零额外 LLM**：budget 超限（`trace.llm_calls >= MAX_DEFAULT_LLM_CALLS`）后，不再触发 `expandQuery` 或 embedding provider `embed`（spy 计数，断言 degraded 路径 0 额外 LLM 调用）
- 现有 `agentic_research` 测试不回归

## Non-goals

- 不 remove `agentic_research`
- 不 rewrite ranking / RAG 架构
- 不加 LLM planner
- 不 tune private query strings / 不 commit real-world examples
- 不 breaking public schema 变更
- `decompose_budget_exceeded` 不实现成抛错（返回确定性结果 + trace）

## Acceptance Criteria（#222）

- [ ] `bun run check` 通过
- [ ] 现有 agentic_research 测试不回归
- [ ] complex + LLM + default → 不 multi-step research
- [ ] complex + `multiStep=true` → multi-step research
- [ ] MCP `query` default 保持 cheap/bounded（decomposition ≤ 3 subqueries，sub-query `multiQuery:false`）
- [ ] degraded/budget metadata structured + privacy-safe（不抛错）
- [ ] `cbrain perf-diagnose --days 7 --min-latency-ms 0 --json` read-only 仍能识别 smart-decompose / research 路径
