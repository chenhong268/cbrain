# Agent-Facing Routing Acceptance

> 为什么验收自然对话路由，而不是只测 MCP tool。

## 背景

CBrain 的 MCP tool 层已有完整的单元测试（`tests/mcp/`）。但 Agent（Hermes）在自然对话中做意图识别 + 工具路由时，可能：

1. **选错工具**：核查确认意图走了 `query` 而不是 `deep_recall(grounded: true)`
2. **泄露内部字段**：把 `score`、`distance`、`shared_neighbors` 等图算法指标直接展示给用户
3. **过度调用**：`deep_recall` 一次能搞定的，连调 4 个工具

MCP tool 测试验证的是"工具本身正确"，不验证"Agent 在对话中是否选对了工具、展示了正确内容"。

## Routing Matrix

| 用户意图 | 信号词 | 路由到 | 禁止 |
|:---------|:-------|:-------|:-----|
| 核查确认 | 讨论过吗、有结论吗、有没有遗漏 | `deep_recall(grounded: true)` | `query`、`agentic_research` |
| 内容回忆 | 当时怎么设计、为什么选、具体怎么说的 | `deep_recall(detail: normal)` | 首轮禁止 `expand_entity`、禁止 `grounded=true` |
| 情境找人 | 叫什么来着、想不起名字、认识的那个人 | `recall_episode` | `query`（有忘名信号时）、`agentic_research` |
| 关系查询 | A 和 B 什么关系、怎么认识的 | `graph_query` / `connect` | `agentic_research` |
| 快速查找 | 搜一下、有没有、查一下 | `query` | 无 |
| 全景总结 | 总结、概览、全面 | `summarize` | `query` |
| 发现摘要 | 最近有什么发现、漏掉的关联 | `read_discoveries` | `list_insights`（过时） |
| 发现检测 | 跑一次检测 | `run_discovery` | 无 |
| 深度推理 | A vs B 取舍、盲区分析 | `agentic_research`（非默认） | 简单查找、核查确认 |

## Presentation Rules

### Discovery Digest 展示规则

**只用**：`display`、`cards`、`summary` 三个字段。

**禁止展示**：

| 禁止字段 | 说明 |
|:---------|:-----|
| `score` | 图算法相关性分数 |
| `distance` / `图距离` | 实体间跳数 |
| `shared_neighbors` / `共享邻居` | 共享邻居数 |
| `hops` / `跳` | 路径长度 |
| `debug` / `_debug` | 调试信息 |
| `candidate` / `候选` | 过滤前的候选 |
| `filter` / `过滤` | 过滤原因 |
| `bridge` / `桥接` | 检测类型内部名 |
| `promote_discovery` / `insight` | 内部操作 |

### Grounded Recall 展示规则

- 不超过 300 字
- 禁止追问（"需要我展开吗"）
- 不输出工具名、不输出 JSON
- candidates 标注"待确认"

### Content Recall 首轮规则

- 使用槽位式压缩（5 槽位）
- 首轮禁止自动 `expand_entity`
- 300-500 字

## Eval 文件

`skills/agent-facing.routing-eval.jsonl` — 26 条匿名用例，覆盖：

| Category | 用例数 | 说明 |
|:---------|:-------|:-----|
| `grounded_recall` | 4 | 核查确认 → `deep_recall(grounded: true)` |
| `content_recall` | 4 | 内容回忆 → `deep_recall(detail: normal)` |
| `episodic_recall` | 4 | 情境找人 → `recall_episode` |
| `discovery_digest` | 5 | 发现摘要 → `read_discoveries` / `run_discovery` |
| `relationship` | 1 | 关系查询 → `graph_query` |
| `search` | 1 | 快速查找 → `query` |
| `overview` | 1 | 全景总结 → `summarize` |
| `anti_pattern` | 6 | 错误路由 + 展示违规 |

所有用例使用占位符（`人物A`、`组织B`、`主题C`、`事件D`、`项目E`），不包含真实人名、公司名、组织名、产品名或地点。

## Manual Hermes 验收标准

每次更改 discovery 或 recall 路由后，手动验收以下场景：

1. **"最近有什么发现"** → Agent 调用 `read_discoveries`，只展示 `display`/`cards`/`summary`，不暴露 `score`/`distance`
2. **"讨论过吗"** → Agent 调用 `deep_recall(grounded: true)`，不是 `query`
3. **"当时怎么设计的"** → Agent 调用 `deep_recall(detail: normal)`，首轮不自动 `expand_entity`
4. **"叫什么来着"** → Agent 调用 `recall_episode`，不是 `query`
5. **"帮我跑一次检测"** → Agent 调用 `run_discovery`，输出用户可读摘要，不展示内部报告

## 自动化检查

`bin/check-resolver-pilot.sh` 第 5 节自动校验：

- eval 文件存在且 ≥ 25 条用例
- 每条用例都有 `expected_args`/`forbidden_tools`/`forbidden_output_terms` 字段
- 5 个核心 category 各达最低用例数（grounded≥4, content≥4, episodic≥4, discovery≥3, anti_pattern≥5）
- 7 个 expected_tool 全部覆盖
- grounded_recall 全部含 `grounded: true, detail: brief, limit: 3`
- content_recall 全部含 `grounded: false, detail: normal, limit: 3`
- discovery_digest 的 forbidden_output_terms 覆盖 score/distance/shared_neighbors/debug 等
- 无隐私泄露（真实人名/公司名）
- resolver 文档包含 discovery 展示禁止规则
- acceptance 文档存在
