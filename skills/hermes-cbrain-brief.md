# Hermes CBrain Brief — 启动必读

> Agent 启动/cron 的 CBrain 交互速查。关键规则骨架。

## 0. CBrain First

涉及"之前/讨论过/谁/关系/记不记得" → **先查 CBrain 再回答**。

## 1. 核查确认 → `deep_recall(grounded: true)`

信号：讨论过吗、有结论吗、有依据吗、是不是真的

`deep_recall({ query, grounded: true, detail: "brief", limit: 3 })`

回答 ≤300 字，禁止追问，candidates 标"待确认"。禁 `query`、`agentic_research`。

## 2. 内容回忆 → `deep_recall(detail: "normal")`

信号：当时怎么设计、为什么选、具体怎么说

`deep_recall({ query, detail: "normal", limit: 3 })`

禁 `grounded: true`。首轮禁止 `expand_entity`/`get_page`/`get_timeline`，用户说“展开/原文/详细”才追查。

## 3. 情境找人 → `recall_episode`

信号：叫什么来着、想不起名字、一起做过项目

`recall_episode({ query, time_hint, topic_hint, event_hint, relation_hint, limit: 5 })`

靠情境线索找人。禁 `query`、`agentic_research`

## 4. 发现摘要 → `read_discoveries` / `run_discovery`

信号：最近有什么发现、有没有漏掉的关联

`read_discoveries({ debug: false })` / `run_discovery({ debug: false })`

只用 `display`/`cards`/`summary`，禁暴露 score/distance/debug/candidate/filter。自然捕获同理。

## 5. 其他路由

- 关系（A和B什么关系） → `graph_query`
- 组织层级（下属/上级/汇报线） → `get_org_tree`，fallback `deep_recall`
- 关键词定位/debug → `query`（底层工具）
- 批量补详情 → `get_pages`
- 全景总结 → `summarize`
- 深度推理（A vs B/盲区） → `agentic_research`

## 6. 来源追踪 → `get_provenance`

信号：哪来的、谁说的、可靠吗

`get_provenance({ target_type: "link"|"timeline", target_id })`

有 target 直接调；无 target：关系→`get_links`，事件→`get_timeline`。找不到如实说，**禁止编造**。禁输出 target_id/confidence/slug/JSON。

## 7. Response Rules

**三层：`display` 给用户，`summary` 供路由，`raw` 仅调试/审计/展开追查——永不渲染。** 首句给结论，300-500 字，先摘要后展开。禁暴露 slug/score/debug/path/raw JSON/工具名/trace。详见 `docs/product/agent-response-contract.md`。客户端 UI 自动展示工具调用时不重复，用户追问可说明。

## 8. 硬禁止

- ❌ query+get_page+get_links+get_timeline 连调 → deep_recall
- ❌ 连续 get_page → get_pages | 总结用 query → summarize
- ❌ 核查用 agentic_research → deep_recall(grounded:true)
- ❌ 首轮 expand_entity | 情境找人用 agentic_research → recall_episode
- ❌ discovery 暴露内部字段 | 回答超 500 字 | 末尾追问
- ❌ 自然语言走 query → deep_recall
