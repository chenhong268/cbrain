# Graph-Aware Query Decomposition — Design Spec

> CBrain Agentic Search Phase 1: 查询分解
> Branch: `feat/agentic-search`
> Date: 2026-05-25

## Goal

让 HybridSearch 自动检测复杂查询，利用知识图谱上下文将其分解为 2-5 个子查询，并行检索后合并。对 Agent 完全透明。

## Architecture

### Data Flow

```
query → HybridSearch.search()
    │
    ├─ 1. 精确标题匹配（已有，不变）
    │
    ├─ 2. isComplexQuery(query)
    │      ├── 简单 → expandQuery()（已有）→ 四路检索 → merge → return
    │      └── 复杂 → decompose 路径 ↓
    │
    ├─ 3. graphPrefetch(query)
    │      提取已知实体 → 拉取直接邻居 → 组装 graphContext
    │
    ├─ 4. decomposeQuery(query, graphContext)
    │      LLM 分解 → 2-5 个子查询
    │
    ├─ 5. 并行检索（每个子查询走四路检索，_skipDecompose=true 防递归）
    │
    ├─ 6. mergeRankedResults()（RRF 合并所有子查询结果）
    │
    └─ 7. return SearchResult[]
```

decompose 路径和 expand 路径**互斥**。

### Complexity Detection — `isComplexQuery(query, knownSlugs)`

纯启发式，不用 LLM：

| Signal | Condition |
|--------|-----------|
| 多实体 | 2+ 已知实体 slug |
| 连接词 | 包含 "和"、"与"、"跟"、"的"、"以及" |
| 复合问句 | 多个 "什么"/"哪些"/"怎么" |
| 长度 | > 15 字（辅助信号，不单独触发） |

未知实体（DB 里没有）→ 走 expand 路径。等 NER 入库后下次会走 decompose。

### Graph Prefetch — `graphPrefetch(query)`

1. 从 query 提取候选词（分词 + 已知实体名匹配）
2. `db.resolveSlugs(candidates)` 验证已知实体
3. 对每个已知实体调 `graph.getRelatedEntities(slug, 5)`
4. 组装 GraphContext：

```
已知实体:
- 张三 (entity/person) → 邻居: ABC项目(co-founded), 李四(collaborated)
关系链:
- 张三 --co-founded--> ABC项目 --led--> 李四
```

找不到实体 → graphContext 为空 → 退化纯文本分解，不报错。

### LLM Decomposition — `decomposeQuery(query, graphContext)`

Prompt 要点：
- 把复杂查询拆成 2-5 个独立可检索的子查询
- 利用图谱已知关系指导拆分方向
- 有直接关系的实体可合并为一个子查询
- 输出 `[{ "sub_query": "...", "intent": "..." }]`

Constraints:
- 子查询上限 5，超了截断
- LLM 超时 10s → fallback 到 expandQuery
- graphContext 最大 2000 字符

### Sub-query Retrieval

`Promise.all(subQueries.map(sq => this.search(sq, { strategy: "all", limit, _skipDecompose: true })))`

**递归保护**: 内部参数 `_skipDecompose` 跳过子查询的复杂度检测。

### Merge

所有子查询的 SearchResult[] 合并为一个大数组，交给 `mergeRankedResults()`。RRF 自动去重并叠加分数——被多个子查询同时命中的实体排名更高。

### Error Handling

| Scenario | Behavior |
|----------|----------|
| LLM 分解失败（超时/格式错误） | fallback 到 expandQuery |
| 部分子查询检索失败 | 用成功的，忽略失败的 |
| 所有子查询都失败 | fallback 到原始 query 直接检索 |
| graphPrefetch 失败 | graphContext 为空，纯文本分解 |
| resolveSlugs 无匹配 | 同上 |

### Latency

- graphPrefetch: ~5ms（SQLite + 一跳邻居）
- LLM 分解: ~500-1500ms
- 并行检索: ~200-500ms
- 总增量: ~700-2000ms（仅复杂 query 触发）

## Code Changes

### Modified: `src/core/search.ts`

New functions:
- `isComplexQuery(query: string, knownSlugs: string[]): boolean`
- `graphPrefetch(query: string): Promise<GraphContext>`
- `decomposeQuery(query: string, context: GraphContext): Promise<string[]>`

Modified:
- `HybridSearch.search()` — 加 decompose 分支 + `_skipDecompose` 参数

New interface:
- `GraphContext` — 实体 + 邻居 + 关系链摘要

### Unchanged

- `src/mcp/tools/recall.ts` — 透明受益
- `src/mcp/tools/search.ts` — 透明受益
- `src/core/graph.ts` — 只调现有 API
- `src/llm/` — 只调现有 `chat()` 接口
- `src/storage/sqlite.ts` — 无新表/新查询

### New: `src/core/search.decompose.test.ts`

Coverage:
- `isComplexQuery`: simple/complex/edge cases
- `graphPrefetch`: with entities / no entities / partial match
- `decomposeQuery`: normal / LLM failure fallback / timeout
- `search()` integration: auto decompose / skip for simple / recursion guard

Estimated: ~150-200 lines new code + ~200 lines tests, all in `search.ts`.

## Out of Scope (Future Phases)

- 多轮反思闭环（decompose → retrieve → reflect → re-decompose）
- 跨源检索（外部 API/Web）
- Agent 侧 decomposition MCP 工具
- LLM fine-tuning for decomposition
