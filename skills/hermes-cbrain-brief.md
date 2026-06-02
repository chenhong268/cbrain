# Hermes CBrain Brief — 启动必读

> Agent 启动或 cron 加载时的 CBrain 交互速查。不是完整 resolver，是关键规则的骨架。

## 0. CBrain First

用户问任何涉及"之前/讨论过/谁/什么关系/记不记得"的问题 → **先查 CBrain，再回答**。不要凭记忆编造。

## 1. 核查确认 → `deep_recall(grounded: true)`

信号：讨论过吗、有结论吗、有没有遗漏、有依据吗、是不是真的

```
deep_recall({ query, grounded: true, detail: "brief", limit: 3 })
```

回答 ≤300 字。禁止追问。candidates 标注"待确认"。禁止调 `query`、`agentic_research`。

## 2. 内容回忆 → `deep_recall(detail: "normal")`

信号：当时怎么设计、为什么选、具体怎么说的、是什么来着

```
deep_recall({ query, detail: "normal", limit: 3 })
```

禁止 `grounded: true`。首轮 **禁止** 自动调 `expand_entity` / `get_page` / `get_timeline`。用户说"展开/原文/详细"时才能追查。

## 3. 情境找人 → `recall_episode`

信号：叫什么来着、想不起名字、认识的那个人、一起做过项目的那个

```
recall_episode({ query, time_hint, topic_hint, event_hint, relation_hint, limit: 5 })
```

用户不记得人名，靠情境线索找人。禁止用 `query`、`agentic_research`。

## 4. 发现摘要 → `read_discoveries` / `run_discovery`

信号：最近有什么发现、有没有漏掉的关联

```
read_discoveries({ debug: false })
run_discovery({ debug: false })
```

展示规则：只用 `display`、`cards`、`summary`。禁止暴露 `score`、`distance`、`shared_neighbors`、`hops`、`debug`、`_debug`、`candidate`、`filter`、图距离、共享邻居、候选、过滤。直接展示，不二次格式化。

## 5. 其他路由

- 关系查询（A和B什么关系） → `graph_query`
- 快速查找（搜一下/有没有） → `query`
- 全景总结（总结/概览） → `summarize`
- 深度推理（A vs B取舍/盲区） → `agentic_research`（非默认，仅复杂多步推理）

## 6. 用户回答红线

面向用户的回答中：
- 不输出工具名（如 `deep_recall`），除非客户端 UI 已单独显示工具调用
- 不输出 raw JSON
- 不输出 slug、source id、chunk id
- 不输出 debug / trace / internal 字段
- 不说"deep_recall 返回了…"、"我调了…"等工具过程描述

## 7. 硬禁止

- ❌ `query` + `get_page` + `get_links` + `get_timeline` 连调 → `deep_recall` 一次搞定
- ❌ 总结类请求用 `query` → `summarize`
- ❌ 核查确认用 `query` 或 `agentic_research` → `deep_recall(grounded: true)`
- ❌ 内容回忆首轮自动 `expand_entity`
- ❌ 情境找人用 `agentic_research` → `recall_episode`
- ❌ discovery 输出暴露 `score`/`distance`/`debug`
- ❌ 回答超过 500 字 → 删条目
- ❌ 末尾追问"需要我展开吗/要继续吗"
