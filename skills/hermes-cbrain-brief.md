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

最近有什么发现/漏掉的关联 → `read_discoveries({ debug: false })` 读取已有结果。明确要求运行检测时说明需要 full profile；当前 daily 会话不调 `run_discovery`，也不以 `read_discoveries` 冒充新运行。只用 display/cards/summary；禁暴露 score/distance/debug/candidate/filter。

## 4. 来源追踪

哪来的、谁说的、可靠吗 → daily 默认 `cbrain_recall(detail:"brief")`，只基于可见证据回答。显式 debug/full 溯源会话才可用 `get_provenance({ target_type:"link"|"timeline", target_id })`；无 target 时关系先 `link({ action:"list", ... })`，事件先 `get_timeline`。找不到如实说，禁止编造；禁输出 target_id/confidence/slug/JSON。

## 5. Response Rules

三层：display 给用户，summary 供路由，raw 仅调试/审计/展开追查，永不渲染。首句给结论，300-500 字，先摘要后展开。禁暴露 slug/score/debug/path/raw JSON/工具名/trace。客户端 UI 自动展示工具调用时不重复，用户追问可说明。

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

bootstrap 读 launchctl `ai.cbrain.serve` → active root verifier。完整 target 集合（所有 CBrain-enabled Agent 的 skill 路径，冒号分隔绝对路径）由部署在 `CBRAIN_REQUIRED_SKILL_TARGETS` 配置；未配置则返回 `TARGET_SET_EMPTY`，报告"运行版本未验证"，绝不误报一致。禁 cwd fallback；失败报 code，禁拼接证据宣布 mismatch。
