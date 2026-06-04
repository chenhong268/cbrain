# Query Skill

> Three-layer hybrid search + synthesis.

## Purpose

Search the brain using multiple strategies, fuse results, and return the most relevant knowledge.

## Default Behavior — 无 flag 时

当 RESOLVER 未指定任何 flag 时，**优先使用 deep_recall**，不是 query。

```
自然语言问题 → deep_recall({ query, detail: "normal", limit: 3 })
精确关键词/debug → query({ query, strategy: "fts" })
```

判断标准：
- 问题包含完整句子或自然语言描述 → deep_recall
- 问题只有 1-2 个关键词，且目的是定位 slug → query
- 不确定 → deep_recall（安全默认）

## [keyword] Branch — 精确关键词定位

RESOLVER 指定 `[keyword]` flag 时：

1. 调用 `query({ query, strategy: "fts" })`
2. 禁止用 `vector` 或 `all` 策略（关键词定位不需要语义搜索）
3. 返回结果只用于内部定位 slug，不直接展示给用户

## [discovery] Branch — 发现摘要

RESOLVER 指定 `[discovery]` flag 时：

1. 调用 `read_discoveries({ debug: false })`，如果用户说"跑检测"则用 `run_discovery({ debug: false })`
2. 展示规则：只使用返回的 `display`、`cards`、`summary`
3. 禁止暴露：score、distance、shared_neighbors、debug、_debug、candidate、filter

## [episodic] Branch — 情境找人

When loaded with `[episodic]` flag (from RESOLVER.md "Episodic Person Recall" section):

**执行协议：**
1. **优先调用 `recall_episode`**，从用户自然语言中提取线索：
   - `time_hint`: 时间线索（去年/上个月/2024年/...）
   - `topic_hint`: 主题线索（前端/项目管理/...）
   - `context_hint`: 场景线索（团建/聚餐/技术分享/...）
   - `event_hint`: 事件线索（项目上线/团队聚餐/...）
   - `relation_hint`: 关系线索（人物A的同事/组织E的人/...）
2. **禁止**：query、get_page、deep_recall、expand_entity、graph_query
3. **唯一的后续操作**：`recall_episode` 返回空候选且用户追问时，可 fallback 到 `query`

**适用条件（必须同时满足）：**
- 用户不记得人名（"那个人"、"叫什么来着"、"想不起名字"）
- 提供了情境线索（时间/地点/事件/主题/关系中的至少一个）

**不适用（应走 query 或 connect）：**
- 用户提到了具体人名（"人物A认识谁"）
- 纯关系查询（"A和B什么关系"）
- 已知实体的信息查询（"组织F团队的人"）

## [agentic_research] Branch — 复杂多步研究

When loaded with `[agentic_research]` flag (from RESOLVER.md "Agentic Research" section):

**执行协议：**
1. **直接调用 `agentic_research`**，传入用户原始问题：
   - `query`: 用户原始问题（不要改写、缩减或拆分）
   - `detail`: 从 RESOLVER 路由标记读取（brief/normal/full），默认 normal
   - `known_slugs`: 如果上下文中已有相关实体 slug，传入帮助定向搜索
   - `intent_hint`: 如果 RESOLVER 路由标记指定了 intent，传入
2. **禁止先跑普通搜索**：不要在调 `agentic_research` 之前先跑 query / deep_recall / get_page / graph_query 组合
3. **结果使用**：返回结构化 `PipelineResult`，包含 status / evidence_board / answer_context / trace_summary。直接基于 answer_context 回答用户，不需要二次调用工具
4. **降级**：如果 `agentic_research` 返回 status=insufficient 或 degraded，可补充一次 `deep_recall`，但不要替代 agentic 结果

**回答契约（answer_contract）：**

`agentic_research` 返回 `PipelineResult`。以下是 Hermes 必须遵守的回答规范。

可用字段（user-facing）：

| 字段 | 用途 |
|:-----|:-----|
| `status` | ok / partial / insufficient / degraded |
| `answer_context.topClaims` | 核心事实（最多 10 条，已截断 100 字） |
| `answer_context.gaps` | 缺口/未覆盖角度（最多 5 条） |
| `answer_context.confidence` | high / medium / low |
| `answer_context.sourceSlugs` | 贡献实体（用人名，不输出 slug） |
| `evidence_board.facts` | 已验证证据 |
| `evidence_board.user_thoughts` | 用户之前的观点 |
| `evidence_board.candidates` | 未验证主张 — 必须标注"可能/待确认" |
| `evidence_board.conflicts` | 矛盾点 — 必须显式呈现 |

禁止暴露字段（internal-only）：`plan`、`execution`、`critic`、`follow_up_execution`、`follow_up_critic`、`trace_summary`、`answer_context.intent`、预算字段、步骤列表、工具名、JSON 片段、slug ID、分数。

按 status 的回答模板：

- **`ok`** — 判断 + 2-4 条关键证据 + 1 条缺口（如有）。≤ 400 字。
- **`partial`** — 回答有支撑的部分，明确标注哪些不确定。≤ 600 字。
- **`insufficient`** — 说 CBrain 证据不足，列 2-3 个已搜索角度。≤ 300 字。
- **`degraded`** — 给有限结果，不过度声称。≤ 300 字。

硬规则：
- 不输出工具名、JSON、slug ID、分数、trace 字段
- candidates 必须标注"可能/待确认"
- conflicts 必须显式呈现，不能回避
- 禁止末尾追问（"需要我继续查吗"）——说完就停
- 缺口不是失败，呈现为"以下是尚未覆盖的角度"
- 答案长度见上方各 status 预算，超标就删条目

**适用条件（满足任一）：**
- 比较取舍："A 和 B 的差异/取舍/哪个更适合"
- 盲区/遗漏："我还遗漏了什么/这个判断有什么盲区"
- 跨主题关联："A、B、C 之间有什么内在联系"
- 证据充分性："这个结论依据够不够/有哪些证据和缺口"
- 复杂复盘：需要多步推理和交叉验证

**不适用（走现有路由）：**
- 简单事实回忆 → deep_recall(detail=normal)
- 单一实体查找 → deep_recall
- 核查确认 → deep_recall(grounded=true)
- 情境找人 → recall_episode
- 两人关系 → graph_query / connect
- 简单关键词搜索 → query

## [provenance] Branch — 来源追踪

When loaded with `[provenance]` flag (from RESOLVER.md "Source Tracking / Provenance" section):

**执行协议：**

1. **已有 target**：如果上下文中已有具体的关系 ID 或事件 ID（来自之前回答暴露的 link/timeline 条目），直接调用：
   ```
   get_provenance({ target_type: "link"|"timeline", target_id })
   ```

2. **无 target，自然语言指代**：用户用自然语言描述某条信息/关系/事件，但没有给出 ID：
   - **关系来源**：`graph_query` 或 `get_links` 拿到 link_id → `get_provenance({ target_type: "link", target_id })`
   - **事件来源**：`get_timeline` 拿到 timeline_id → `get_provenance({ target_type: "timeline", target_id })`
   - **不确定指哪条**：`deep_recall` / `query` 做上下文发现，找到相关 link 或 timeline 条目后拿 ID
   - 如果找不到具体 target → 如实告知"CBrain 有相关记忆但无法定位到具体的溯源条目"，**禁止编造来源**

3. **无法定位**：如果搜索后仍无法确定用户指的具体是哪条信息：
   - 回复："目前 CBrain 有相关记忆，但我无法确定你指的是哪一条。可以说得更具体一些吗？比如提到的人名或关系。"
   - 禁止编造 provenance 或猜测 target_id

**适用条件（满足任一）：**
- 用户问"这条信息哪来的"、"来源是什么"、"证据来源是什么"
- 用户问"这个关系是谁说的"、"谁告诉你的"、"这条依据从哪来"
- 用户问"这件事有证据吗"、"这个结论确认过吗"
- 用户问"这条记忆可靠吗"、"可信吗"、"这个来源可靠吗"

**不适用（走现有路由）：**
- 普通内容回忆（"当时怎么设计的"）→ deep_recall(detail: normal)
- 核查确认（"讨论过吗"）→ deep_recall(grounded: true)
- 关系查询（"A和B什么关系"）→ graph_query / connect

**用户回答格式（硬规则）：**

```md
来源：[来源分类，中文]
可信度：[信任状态，中文]
[证据摘要，如有]
[纠正历史，如有]
```

**来源分类映射：**

| 内部值 | 用户看到 |
|:-------|:---------|
| ingestion | 导入内容 |
| ner_extraction | 自动提取 |
| user_confirmation | 用户确认 |
| user_thought | 你的想法 |
| correction | 纠正记录 |
| inference | 推理得出 |
| system_default | 系统默认 |

**信任状态映射：**

| 内部值 | 用户看到 |
|:-------|:---------|
| trusted | 已确认 |
| candidate | 待确认 |
| user_thought | 你的想法 |
| rejected | 已否决 |
| superseded | 已更新 |

**硬禁止：**
- 不输出 target_id、source_type、source_page_slug
- 不输出 confidence 数值
- 不输出 raw JSON 或工具名
- 不编造 provenance — 找不到 target 就说找不到
- 不把 provenance 用于普通内容回忆

## [graph_first] Branch — 组织层级查询（已迁移到 get_org_tree）

> **已迁移**：组织层级查询现在直接调 `get_org_tree`，不再经过此分支。
> RESOLVER.md 已更新路由规则。
>
> **兼容逻辑**（如果 RESOLVER 仍路由到此分支）：
> 1. 调用 `get_org_tree({ query: 解析到的实体名, direction: "both" })`
> 2. 有结果 → 按层级呈现（树形/缩进列表），用实体 title（不是 slug）
> 3. 多候选 → 让用户澄清
> 4. 无结果 → fallback `deep_recall({ query: "原始查询", detail: "normal", limit: 5 })`
> 5. 种子无法解析 → 提示用户提供更具体的名称
>
> **硬禁止**：
> - 禁止先跑 `deep_recall` / `query` / `graph_query` 再拼层级
> - 不输出 slug、link_id、edge_id、raw JSON 或工具名
> - 种子无法解析时**禁止**静默返回空

## Search Strategies

### Vector Search

Best for: Semantic similarity, "find things like this"

```
cbrain query "怎么优化RAG性能" --strategy vector
```

### Full-Text Search (FTS)

Best for: Exact keyword matching, Chinese term search

```
cbrain query "张三" --strategy fts
```

### Graph Search

Best for: Relationship traversal, "who knows whom"

```
cbrain graph-query --mode traverse entities/zhangsan --depth 2
cbrain graph-query --mode backlinks entities/zhangsan
cbrain graph-query --mode related entities/zhangsan
```

### Hybrid (Default)

All three strategies combined with RRF fusion (k=60):

```
cbrain query "张三的项目" --strategy all
```

## Result Format

```json
[
  {
    "slug": "entities/zhangsan",
    "score": 0.85,
    "snippet": "张三是产品经理，负责AI产品线...",
    "source": "hybrid"
  }
]
```

## Synthesis Protocol

When answering user questions:

1. **Query** the brain with the user's question
2. **Get context** — for top results, use `get_page` for full content
3. **Traverse graph** — follow related entities for richer context
4. **Synthesize** — combine brain knowledge with current conversation
5. **Cite** — mention which pages/entities informed the answer

## Guidelines

- Start with `all` strategy, narrow down if needed
- For entity lookups, FTS is most precise
- For exploratory questions, vector search finds unexpected connections
- Graph traversal adds relationship context that search alone misses
