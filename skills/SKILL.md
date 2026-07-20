# CBrain Hermes Skill Pack

> Agent 的 CBrain 记忆技能包。读这个文件，然后按需加载子文件。
> 版本跟随 `package.json` — 用 `cbrain skill-pack` 验证完整性。

## 0. CBrain First 规则

用户提到"之前/讨论过/谁/什么关系/记不记得" → **先查 CBrain，再回答**。

没有 CBrain 结果时，明确说"我没有找到相关记录"，不要编造。

## 1. 启动流程

1. 读 `hermes-cbrain-brief.md`（~1200 字，完整交互骨架）
2. 需要路由判断时读 `RESOLVER.md`（意图 → 技能文件路由表）
3. 需要工具选择时读 `recall-resolver.md`（意图 → MCP 工具路由表）

## 2. 核心技能速查

| 信号 | 技能 | 文件 | 关键工具 |
|:-----|:-----|:-----|:---------|
| "讨论过吗/有结论吗" | 核查确认 | `hermes-cbrain-brief.md` §1 | `cbrain_recall(detail: "brief")` |
| "当时怎么设计的" | 内容回忆 | `hermes-cbrain-brief.md` §2 | `cbrain_recall(detail: "normal")` |
| "那个人叫什么" | 情景人物 | `hermes-cbrain-brief.md` §3 | `recall_episode` |
| "有新发现吗" | 发现 | `hermes-cbrain-brief.md` §4 | `read_discoveries` |
| "总结一下 X" | 深度回顾 | `review.md` | `cbrain_recall`（内部 overview 分发） |
| "A 和 B 什么关系" | 关系分析 | `connect.md` | `cbrain_recall`（内部 relationship 分发） |
| "写一份关于 X 的报告" | 知识写作 | `write.md` | 多步检索 + 组织 |
| "把这些内容存下来" | 摄入 | `ingest.md` | `ingest` |
| "帮我整理/去重" | 清理 | `cleanup.md` | `clean_shells` / `dedup` |
| "跑一下维护" | 夜间管线 | `dream.md` | `dream` |

## 3. 回答规则

- 先给结论，300-500 字为默认长度。核查确认回答 ≤ 300 字。
- 禁止暴露 slug、score、debug 字段、raw JSON、内部数据结构。
- 渐进披露：先摘要，用户追问再展开细节。
- 禁止 `query` + `get_page` 链式调用做核查 — 用 `cbrain_recall(detail: "brief")` 一步到位。
- 禁止对核查意图用 `agentic_research`。

### Bounded recall fallback

- 仅限普通内容回忆：健康运行的 `cbrain_recall` 返回 empty / insufficient 时，保持原查询，最多一次调用 `deep_recall({ query, detail: "brief", limit: 3 })`，然后停止；不要继续改写或串联其他检索。
- 若 fallback 没有运行时或新鲜度异常，且候选全部 `quality=low`，先说明“没有找到足够相关的记忆”，不要展示或逐条列出这些低相关候选。
- 此时最终回答不要提及候选数量或 quality。
- 若首轮 `cbrain_recall` 显示运行时或新鲜度 degraded，说明本次检索未完整执行，不要宣称没有相关记忆，不调用 fallback，然后停止。

## 4. 文件索引

### 技能文档

| # | 文件 | 说明 |
|:--|:-----|:-----|
| 1 | `hermes-cbrain-brief.md` | 启动必读（交互骨架） |
| 2 | `RESOLVER.md` | 意图 → 技能路由表 |
| 3 | `recall-resolver.md` | 意图 → MCP 工具路由表 |
| 4 | `brain-ops.md` | 5 步协议 + 38 工具参考 |
| 5 | `query.md` | 混合搜索（向量 + FTS + 图） |
| 6 | `review.md` | 深度主题回顾 |
| 7 | `connect.md` | 关系分析 |
| 8 | `ingest.md` | 内容摄入 |
| 9 | `enrich.md` | 实体充实 |
| 10 | `cleanup.md` | 去重与清理 |
| 11 | `dream.md` | 夜间维护管线 |
| 12 | `write.md` | 知识写作 |
| 13 | `signal-detector.md` | 信号检测 |
| 14 | `signal-router.md` | 信号路由 |
| 15 | `feature-index.md` | 功能索引 |
| 16 | `filing-rules.md` | Vault 归档规则 |

### 路由评估数据

| 文件 | 用例数 | 说明 |
|:-----|:-------|:-----|
| `response-contract.routing-eval.jsonl` | 12 | 回答合约（长度/禁用词） |
| `agent-facing.routing-eval.jsonl` | 34 | Agent 路由主评估 |
| `recall.routing-eval.jsonl` | 23 | 回忆路由 |
| `episodic.routing-eval.jsonl` | 21 | 情景人物路由 |
| `signal-router.routing-eval.jsonl` | 21 | 信号路由 |
| `compounding-review.routing-eval.jsonl` | 14 | 复利评审 |
| `agentic.routing-eval.jsonl` | 12 | 代理研究路由 |
| `provenance.routing-eval.jsonl` | 9 | 来源追溯 |
| `hierarchy.routing-eval.jsonl` | 7 | 组织层级 |
| `query.routing-eval.jsonl` | 6 | 查询路由 |
| `connect.routing-eval.jsonl` | 3 | 关系路由 |
| `ingest.routing-eval.jsonl` | 3 | 摄入路由 |
| `dream.routing-eval.jsonl` | 3 | 维护路由 |
| `cleanup.routing-eval.jsonl` | 3 | 清理路由 |
| `review.routing-eval.jsonl` | 4 | 回顾路由 |
| `write.routing-eval.jsonl` | 3 | 写作路由 |

## 5. 验证

```bash
cbrain skill-pack           # 人类可读报告
cbrain skill-pack --json    # 机器可读 JSON
```
