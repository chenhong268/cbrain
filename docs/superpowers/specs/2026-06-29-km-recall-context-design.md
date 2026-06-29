# Knowledge Map as Optional Recall Context — Design

- **Issue**: #245 (experiment, behind option)
- **Parent roadmap**: #239
- **Depends on**: #240–#244 (all merged)
- **Status**: Design — pending review
- **Date**: 2026-06-29

---

## 设计原则（置顶，不可违背）

> Knowledge Map context is supplemental evidence navigation, not recall ranking.
> It may help Hermes decide what to explore next, but it must not change what
> CBrain claims as the answer to the user's current query.

每一条实现决策都要能回退到这句话。冲突时，以这句话为准、牺牲功能。

---

## 背景与目标

#239 把 Knowledge Map 建成 CBrain 的元认知层（域、成熟度、桥接、孤立）。#240–#244 已落地分析器、报告、Dream 周期、MCP 读路径、Discovery surface。#245 是这条链的**实验性收尾**：让稳定的 KM domain 作为**可选**的 recall context，验证它能否帮 Hermes 更好地"探索下一步"，同时**绝不**改变主召回给用户的答案。

KM 的 community 由确定性 label propagation 产出（同图同结果），所以叫"stable domain"。但它每次由 `analyzeKnowledgeMap(db)` 现算、无持久化缓存。

---

## 范围

### In scope（一期）

- 在 `deep_recall` 的 **supplemental 层**注入同知识域节点。
- 一个默认 **off** 的 explicit option `knowledge_map_context`。
- 进程内缓存 analysis（带图指纹失效），摊薄 flag-on 时的全图计算成本。
- trace 元数据进 raw，display 只出自然语言 title。

### Out of scope（一期不做，留 Phase 2）

- search 核心 rerank / `mergeRankedResults` / `searchCore` —— **任何主排序改动**。
- `summarize` / `agentic_research` integration。
- bridge / cross-domain exploration。
- 任何 DB / Discovery 写入。
- 任何 LLM 调用。
- `auto` 模式（auto 要 LLM 判 query 意图，违反"不引 LLM"）。
- env var 全局开关（无先例，YAGNI）。

---

## 架构总览

flag-on 时，`deep_recall` 在**主结果 enrichment 之后**插入一个纯计算的 KM context pass：

1. 取主结果 top-N slug。
2. 用缓存的 analysis 查每个 slug 的 `communityId`。
3. 对每个命中的 mature community，挑不在主结果中的高 `weightedDegree` 节点作 supplemental。
4. 孤立节点（degree 0）从 supplemental 排除并计数。
5. supplemental 挂进响应（compact 自然语言摘要 + raw trace）。

**主排序、`mergeRankedResults`、`HybridSearch.searchCore` 全程不动。** flag-off 时整条 pass 不执行，KM 零调用。

---

## 组件

### 新增 `src/core/recall/km-context.ts`（纯函数核心）

```ts
export interface KmSupplementalNode {
  slug: string;
  title: string;
  type: string;
  communityId: string;
  weightedDegree: number;
}

export interface KmContextResult {
  matchedDomains: CommunitySummary[];     // 主结果命中的 mature community
  supplemental: KmSupplementalNode[];      // 同域补充节点（已 cap）
  excludedIsolatesCount: number;           // 被排除的孤立节点数
  reason: "same_domain_context" | "no_mature_domain" | "km_unavailable";
}

export interface KmContextOptions {
  maxPerDomain?: number;  // 默认 3
  totalCap?: number;      // 默认 5
}

export function buildKnowledgeMapContext(
  analysis: KnowledgeMapAnalysis,
  primarySlugs: string[],
  options?: KmContextOptions,
): KmContextResult;
```

- 纯函数，零 DB / LLM 依赖，可独立单测。
- **直接 `import { isCommunityMature }`**（`src/core/knowledge-map-report.ts:180`）——它是 size/internal-edge/density 阈值的**单一来源**（#241 报告 + #242 brief 共用）。**禁止在 km-context.ts 复制阈值。**（宏哥修正 #4）

### 新增 `src/core/recall/km-context-cache.ts`（进程内缓存）

```ts
export class KnowledgeMapContextCache {
  getAnalysis(db: CBrainDB): KnowledgeMapAnalysis;
  // 指纹命中 → 返回缓存；否则调 analyzeKnowledgeMap(db) 并缓存
}
```

- 挂在 `ToolContext`（实现时定位注入点），进程级单例。
- 指纹与失效策略见下节。可一行关闭退化为"每次算"。

### 改动 `src/mcp/tools/recall.ts`（最小）

- `inputSchema` 新增参数（宏哥修正 #1）：

  ```ts
  knowledge_map_context: z.enum(["on", "off"]).optional().default("off")
    .describe("开启后在主召回之外补充同一知识域的相关节点作为探索线索；不改变主结果排序，不作为事实依据。")
  ```

  参数名**必须**是 `knowledge_map_context`，不叫 `km` / `context` 等泛名。描述必须写清"补充线索、非主召回排序"。

- handler：`knowledge_map_context === "on"` **且主结果非空**时 → `ctx.kmContextCache.getAnalysis(db)` → `buildKnowledgeMapContext(analysis, primarySlugs)` → 结果进 `raw.knowledge_map_context`（仅 `include_raw=true` / full raw 路径）+ compact `summary.related_context`。
- `off` → **完全不调 KM**（零开销，行为 byte-for-byte 不变）。

### 改动 `src/mcp/tools/recall-compact.ts`

- `summary` 增 `related_context`：自然语言 title 摘要（见输出层次契约）。不塞进 entity 投影、不破 char budget。

### 改动 `ToolContext`（定位文件待实现）

- 注入 `kmContextCache: KnowledgeMapContextCache`。

---

## 数据流

```
query
  → search(完全不变: RRF 四通道融合 mergeRankedResults)
  → 主结果 top-N + exact/grounded 路径(不变)
  → [flag on] ctx.kmContextCache.getAnalysis(db)
  → buildKnowledgeMapContext(analysis, primarySlugs)
  → supplemental slugs → enrich 成 title/type
  → raw.knowledge_map_context (include_raw) + compact summary.related_context
```

主结果 score / 排序 / entity projection 在整条链路上**只读不写**。

---

## 参数与 flag

- `knowledge_map_context: "on" | "off"`，默认 `"off"`。
- 工具描述（中文）：见上 recall.ts 改动。核心是"探索线索、非主召回、非事实"。
- **不加 `auto`**：auto 要判 query 意图，没 LLM 做不到，做了就违反"不引 LLM"。
- **不加 env var**：codebase 无行为 flag 的 env 先例（现有 env 全是基建配置），YAGNI。
- 先例模板：#232 `evidence: z.enum(["auto","on","off"]).default("auto")`（`recall.ts:70-71` → `recall-intent.ts:41-46`），本参数去掉 auto 即可。

---

## cache 策略（宏哥修正 #2 —— 核心防跑偏点）

### 为什么需要

`analyzeKnowledgeMap(db)` 是全图 label propagation（coarse 6 / default 10 / fine 14 轮），flag-on 每次重算成本不可忽略。Hermes 高频 opt-in 时会抖。

### 指纹（pages 强 + links 弱）

- **pages**：`COUNT(*) + MAX(updated_at)`，scope 限定 KM 分析范围（`entity/%` + `concept/%`）。
  - `pages.updated_at` 在 tier / mention_count / content_hash 任何变更时都刷新（`sqlite.ts:1463/1475/1481/1487`），是**强指纹**。
- **links**：`MAX(id) + SUM(weight)`（全表，单行聚合）。
  - `links` 表**无 `updated_at`**（`sqlite.ts:207-219`，只有 `created_at` + 自增 `id` + `weight` + `strength`）。
  - `MAX(id)` 抓增删；`SUM(weight)` 抓权重批量变更。
- 命中：指纹与缓存一致 → 复用 analysis；否则重算并刷新缓存。

### 已知盲区（spec 必须写明）

单条 link 的 `weight`/`strength` UPDATE 不改 `id`，靠 `SUM(weight)` 兜；若未来新增"不改 weight 的 links 字段变更"，指纹会 stale。这是**可接受的弱指纹**——最坏情况是缓存多存活一轮（stale community），不是错缓存导致主结果错。

### 逃生口（宏哥原话约束）

> 若实现复杂，就第一版不要 cache，每次 flag-on 才算。因为默认 off，成本可控。**不要为了 cache 引入错缓存。**

实现决策：一期**默认带最薄缓存**（上述两条单行聚合指纹，远比 analysis 便宜）；指纹逻辑封装在 `KnowledgeMapContextCache` 内，**留一行开关可退化为"每次算"**。若实测指纹查询成本 ≈ analysis，或 review 发现 stale 风险，直接关开关退回无缓存。

---

## supplemental 挑选规则

- 只对 **mature community** 补（`isCommunityMature`，复用 #241 阈值）——稀疏域不补，避免噪声。
- 每域挑 `maxPerDomain = 3` 个**不在 `primarySlugs`** 的节点，按 `weightedDegree` 降序。
- 总 `totalCap = 5`。
- 排除 `highMentionIsolates` + degree-0 节点，计入 `excludedIsolatesCount`。
- bridge / cross-domain：**一期不处理**（Phase 2）。
- 命中域为空 / 全部非 mature → `reason: "no_mature_domain"`，supplemental 为空但仍返回（trace 透明）。

---

## 输出层次契约（宏哥修正 #3 —— 钉死）

| 层 | 允许内容 | 禁止出现 |
|---|---|---|
| `display` | 自然语言 title：「同知识域还涉及：{A}、{B}」 | slug / community_id / weight / source_type / score / modularity |
| `summary.related_context` | 同上自然语言 title | 同上禁止项 |
| `raw.knowledge_map_context` | `{ matched_domains[], supplemental_slugs[], excluded_isolates_count, reason }` | 仅 `include_raw=true` 或 full raw 路径返回 |

- display 措辞固定为「同知识域还涉及…」一类；**严禁**「因为同域所以相关 / 为真」（**context ≠ truth**，守 guardrail）。
- `DISPLAY_BANNED_TERMS`（`format-result.ts`）已含 `score`/`weight`/`distance`/`trace` 等；`community_id` 不进 display，靠"只渲染 title、不渲染结构化字段"保证，并补测断言。

---

## 错误处理与降级

- `analyzeKnowledgeMap` 抛错 / 空图 / 无节点 → `buildKnowledgeMapContext` 返回 `reason: "km_unavailable"`，**不抛**，主结果不受影响（守 roadmap"不阻塞普通 recall"）。
- 缓存计算失败 → 同上降级，不污染主召回。
- 主结果为空 → 不调 KM。
- 所有降级路径都要在测试里覆盖。

---

## guardrail 自检（实现完成前逐条确认）

- [ ] 主 `searchResults` 排序 / score 不动。
- [ ] 不改 `mergeRankedResults` / `HybridSearch.searchCore`。
- [ ] 不影响 exact match / grounded recall。
- [ ] 不写 DB / Discovery。
- [ ] 不引 LLM。
- [ ] display 无 slug / community_id / weight / source_type / score。
- [ ] community 是 context 不是 truth（措辞自检）。
- [ ] `off` 时**零调用** `analyzeKnowledgeMap`（spy 证，不是结果一样就够）。

---

## 测试计划（匿名 fixture：Entity A / Concept B / Domain C / Organization D / Topic E）

### 新增

**`tests/core/recall/km-context.test.ts`**（纯函数）
- 同一 mature domain → 补充该域非主结果节点。
- 稀疏 / 非 mature domain → 不补。
- 孤立节点 → 排除 + `excludedIsolatesCount` 正确。
- `totalCap` / `maxPerDomain` 生效。
- `primarySlugs` 内的节点不重复补。
- 空 analysis / 空图 → `reason: "km_unavailable"`，不抛。
- 全域非 mature → `reason: "no_mature_domain"`。

**`tests/core/recall/km-context-cache.test.ts`**
- 指纹命中 → 复用缓存（`analyzeKnowledgeMap` 只调一次）。
- `pages.updated_at` 变 → 重算。
- `links.id` / `SUM(weight)` 变 → 重算。
- 关闭开关 → 退化为每次算。

**`tests/mcp/recall-km-context.test.ts`**（集成）
- **`off` 时 spy `analyzeKnowledgeMap` 断言零调用**（宏哥修正 #5）。
- `off` 时主结果排序 / score / entity projection **byte-for-byte 不变**。
- `on` 时 supplemental 出现在 `raw.knowledge_map_context` + `summary.related_context`。
- `on` 时主结果顺序不变；**exact match 顺序不变**。
- `on` 时 display 只出 title，无 slug/community_id/weight。
- grounded recall 不受影响。

### 必须原样过（不得回归）

- `tests/mcp/recall-quality.test.ts`（#230）
- `tests/mcp/recall-payload-budget.test.ts`（#231）
- `tests/mcp/recall-evidence.test.ts`（#232）
- `tests/release/frontdoor-dialogue-gate.test.ts`（#200）
- `tests/release/first-recall-gate.test.ts`

---

## 验收标准

1. `knowledge_map_context="off"` 路径**不调** `analyzeKnowledgeMap`（spy 证零开销），现有测试不变。
2. `on` 时同域 supplemental 只在 flag/option 下加入。
3. exact match + grounded recall 行为不变。
4. raw/debug 能解释 domain-context 决策，且不泄露进 display。
5. `bun run lint` 通过。
6. 相关 recall + release gate 测试通过。
7.（#5 强化）`off` 时 `analyzeKnowledgeMap` 零调用；主结果排序 / score / entity projection 完全不变。

---

## 执行方式

M 级 worktree + **inline TDD**（不分 subagent）。理由：cache/指纹 + compact/raw 边界最容易错，集中在一个上下文里做、每段 RED→GREEN→REFACTOR、每段 `bun run lint` + 相关测试。文件不多但契约细节密。

完成本实验后，观察 Hermes 是否真会消费 `related_context`；有价值再开 #245 Phase 2（Agent 追问 / 扩展时显式请求 KM domain context）。
