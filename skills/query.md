# Query Skill

> Three-layer hybrid search + synthesis.

## Purpose

Search the brain using multiple strategies, fuse results, and return the most relevant knowledge.

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
