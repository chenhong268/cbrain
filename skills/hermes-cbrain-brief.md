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

展示规则：只用 `display`、`cards`、`summary`。禁止暴露 score/distance/debug/candidate/filter 等内部字段。直接展示，不二次格式化。

## 5. 其他路由

- 关系查询（A和B什么关系） → `graph_query`
- 快速查找（搜一下/有没有） → `query`
- 全景总结（总结/概览） → `summarize`
- 深度推理（A vs B取舍/盲区） → `agentic_research`（非默认，仅复杂多步推理）

## 6. 来源追踪 → `get_provenance`

信号：哪来的、来源是什么、谁说的、可靠吗、可信吗

```
get_provenance({ target_type: "link"|"timeline", target_id })
```

有 target → 直接调。无 target：关系→`graph_query`/`get_links` 拿 link_id；事件→`get_timeline` 拿 timeline_id；不确定→`deep_recall` 发现上下文。找不到→如实说，**禁止编造**。禁止输出 target_id/confidence/slug/JSON。

## 7. 用户回答红线

面向用户的回答中：
- 不输出工具名（除非客户端 UI 已显示）、raw JSON、slug/source id/chunk id、debug/trace 字段
- 不说"deep_recall 返回了…"等工具过程描述

## 8. 硬禁止

- ❌ query+get_page+get_links+get_timeline 连调 → deep_recall 一次搞定
- ❌ 总结用 query → summarize | 核查用 query/agentic_research → deep_recall(grounded:true)
- ❌ 首轮自动 expand_entity | 情境找人用 agentic_research → recall_episode
- ❌ discovery 暴露 score/distance/debug | 回答超 500 字 | 末尾追问
