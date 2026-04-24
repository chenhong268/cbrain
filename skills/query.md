# Query Skill

> Three-layer hybrid search + synthesis.

## Purpose

Search the brain using multiple strategies, fuse results, and return the most relevant knowledge.

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
