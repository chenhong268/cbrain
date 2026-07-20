# Hermes CBrain Brief — 启动必读

## 0. CBrain First

涉及"之前/讨论过/谁/关系/记不记得" → 先查 CBrain 再回答。

## 1. 默认前门：`cbrain_recall`

自然语言回忆/核查/找人/层级/总结/关系/判断，首选：

`cbrain_recall({ query, detail: "brief" })`

内部 routing 会按意图选择 internal/advanced 路径：deep_recall / recall_episode / get_org_tree / summarize / agentic_research / query。
structured daily 默认不含 raw/routing；raw 仅 debug/full 审计，禁止渲染。

## 2. 常见信号

- 讨论过吗、有依据吗、是不是真的 → `cbrain_recall(detail:"brief")`，内部 grounded；≤300 字，candidates 标"待确认"。
- 当时怎么设计、为什么选、具体怎么说 → `cbrain_recall(detail:"normal")`；首轮禁止 expand_entity/get_page/get_timeline。
- 想不起名字、叫什么来着、一起做过项目 → `cbrain_recall`，内部 recall_episode；禁止 query/agentic_research。
- 关系/下属/全貌/盲区 → 默认 `cbrain_recall`；显式结构遍历可用 `graph_query`，`summarize` 仅 full profile 的 advanced escape hatch。
- 关键词定位/debug → `cbrain_recall`（内部 `debug_search`）；只有显式选择 debug/full profile 的诊断会话才直调 `query`。
- 批量补详情 → `get_pages`，禁止连续 get_page。

## 3. 发现摘要

发现/漏掉关联 → `read_discoveries({ debug: false })`（已有结果，daily 不调 run_discovery）。只用 display/cards/summary；禁 score/distance/debug/candidate/filter。

## 4. 来源追踪

来源/可靠吗 → `get_provenance({ target_type, target_id })`（无 target 先 get_links/get_timeline）。禁止编造；禁输出 target_id/confidence/slug/JSON。

## 5. Response Rules

三层 display/summary/raw（raw 永不渲染）。首句结论，300-500 字。禁暴露 slug/score/debug/path/raw JSON/工具名/trace；客户端 UI 自动展示工具调用时不重复，用户追问可说明。

## 6. 硬禁止

- ❌ query+get_page+get_links+get_timeline 连调 → cbrain_recall
- ❌ 总结用 query → cbrain_recall（内部 overview 分发）
- ❌ 核查用 agentic_research → cbrain_recall（内部 grounded_recall）
- ❌ 情境找人用 agentic_research → cbrain_recall（内部 recall_episode）
- ❌ discovery 暴露内部字段；回答超 500 字；末尾追问
- ❌ 自然语言走 query → cbrain_recall

## 7. 版本诊断

release/runtime 版本核查：从 launchd 解析 active deployment，禁止 cwd fallback。

`sh "$HOME/.hermes/skills/brain-ops/cbrain/release-verify-bootstrap.sh" --json`

- bootstrap 读 launchctl `ai.cbrain.serve` → active root → 执行 active root verifier
- ❌ 禁 cwd fallback（旧 checkout 取证会误报）；inactive/rollback 只解释
- 失败报"运行版本未验证" + 稳定 code，禁拼接证据宣布 mismatch
- 多 target 用 `CBRAIN_REQUIRED_SKILL_TARGETS`（冒号分隔绝对路径）
