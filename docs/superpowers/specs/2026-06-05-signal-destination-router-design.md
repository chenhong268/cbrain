# #147 — Incoming Signal Destination Router Design

> Date: 2026-06-05
> Status: Draft

## Problem

CBrain 的 `signal-detector.md` 只做"要不要 ingest"的二选一决策。Hermes 收到信号后，第一个问题应该是"这个信号去哪里"，而不是"要不要存到 CBrain"。

## Scope

纯 skill 文档变更。CBrain 源码零改动。

| 文件 | 操作 | 说明 |
|------|------|------|
| `skills/signal-router.md` | 新建 | 四路分流决策协议 |
| `skills/signal-detector.md` | 修改 | Step 3 Route 加 signal-router.md 引用 |
| `skills/RESOLVER.md` | 修改 | Inventory 加 #12，Signal Detection 加路由引用 |
| `skills/signal-router.routing-eval.jsonl` | 新建 | 静态匿名 eval |

## Four Destinations

| Destination | 触发条件 | 工具调用 | 用户感知 |
|:------------|:---------|:---------|:---------|
| `cbrain_memory` | 含实体/关系/事件/决策/观点演变，且会改变未来召回、判断、关系理解、知识结构或用户思考演化；或用户明确要求长期记忆/保存为资料/以后参考 | `ingest_dialogue` / `ingest` | 可选"已记录" |
| `agent_profile` | 用户要求设偏好/规则/以后都这样 | `update_profile` / `reload_profile` | 确认偏好已生效 |
| `action_loop` | 用户要求提醒/待办/下次检查/安排 | Hermes 内部 scheduler，不调 CBrain | 确认已安排 |
| `no_store` | 纯确认/闲聊/一次性信息 | 无 | 静默 |

## Decision Tree

Hermes 在 `signal-detector.md` Step 3 Route 之后、调工具之前执行：

```
Q1: 是否提醒/待办/安排/下次检查？
    → YES: action_loop（跳过后续）

Q2: 是否偏好/规则/以后都这样？
    → YES: agent_profile（跳过后续）

Q3: 是否明确要求长期记忆/保存为资料/以后参考？
    → YES: cbrain_memory（跳过后续）

Q4: 信号是否含长期复利价值（会改变未来召回、判断、关系理解、
    知识结构或用户思考演化的实体/关系/事件/决策/观点演变）？
    → YES: cbrain_memory
    → NO:  no_store
```

优先级：action_loop > agent_profile > 明确记忆意图 > 内容复利分析。
Q1-Q3 是意图判断，Q4 是内容价值判断。
Q3 和 Q4 的区别：Q3 是用户主动要求，Q4 是 Hermes 从信号内容判断。

## cbrain_memory Subclassification

`cbrain_memory` 选定后，CBrain 内部子分类（Hermes 不暴露给用户）：

| 子分类 | 信号特征 | 说明 |
|:------|:---------|:-----|
| `content_memory` | 材料/笔记/摘要 | 用户主动分享的内容 |
| `fact_memory` | 事实/关系/事件 | 客观知识变化 |
| `episodic_memory` | 经历/对话场景 | 时间+地点+人物+主题 |
| `thought_memory` | 观点/原则/反思 | 用户判断和思维变化 |
| `collaboration_memory` | 协作偏好固化 | 从 profile 升华为持久记忆 |

子分类映射到现有 CBrain page type：`fact_memory` → entity/concept/event，`episodic_memory` → event，`thought_memory` → record，`content_memory` → source/record，`collaboration_memory` → record。不做新 storage table。

## Edge Cases

| 输入 | Destination | 理由 |
|:-----|:-----------|:-----|
| "今天收到 8 条消息" | `no_store` | 低价值流水账 |
| "今天在事件B见了人物A，讨论了主题C" | `cbrain_memory` / episodic | 经历含实体+主题，改变关系理解 |
| "我越来越觉得主题D应该用原则E处理" | `cbrain_memory` / thought | 观点演变，改变未来判断 |
| "任务E完成了，下周提醒我检查" | `action_loop` + `cbrain_memory` | 提醒走 scheduler（Q1），完成事实有复利价值（Q4） |
| "以后在这个 workspace 回复短一点" | `agent_profile` | 行为偏好（Q2） |
| "人物A在组织B换了职位" | `cbrain_memory` / fact | 实体+关系变化，改变知识结构 |
| "嗯"、"好的"、"收到" | `no_store` | 纯确认 |
| "提醒我下周检查主题F" | `action_loop` | 纯待办（Q1） |
| "记得下周提醒我和人物A吃饭" | `action_loop` | "记得"是口语化的"提醒"，不是存储意图（Q1 优先） |
| "一会儿找人物A吃饭" | `no_store` | 含实体但无复利价值，一次性安排 |

复合信号（一个消息含多个目的地）：按优先级拆分，每个目的地独立处理。上表中"任务E完成了，下周提醒我检查" = `cbrain_memory`(完成事实) + `action_loop`(提醒)。

## signal-router.md Structure

```markdown
# Signal Router

> Decide where each incoming signal goes before touching any tool.

## Four Destinations
(上表)

## Decision Tree
(上述 Q1-Q4)

## cbrain_memory Subclassification
(上述子分类)

## Tool Mapping
- cbrain_memory → ingest_dialogue({ mode: "auto" }) / ingest()
- agent_profile → update_profile() / reload_profile()
- action_loop → Hermes scheduler (不调 CBrain 工具)
- no_store → 无操作

## Compound Signals
拆分规则 + 示例

## Anti-patterns
- 不要把 action_loop 内容喂给 ingest_dialogue
- 不要把 no_store 信号调 query 做"以防万一"检查
- 不要暴露子分类名称给用户
```

## RESOLVER.md Changes

1. Signal Detection 部分加一行：`信号路由、目的地判断 → signal-router.md`
2. Skill Inventory 加第 12 项：`signal-router.md | Incoming signal destination routing | After signal-detector.md`

## signal-detector.md Changes

Step 3 Route 开头加一句：

```
⚠️ 在调用 ingest 工具之前，先执行 signal-router.md 判断信号目的地。
```

## Evals

`skills/signal-router.routing-eval.jsonl` — 匿名静态 eval，覆盖 issue acceptance criteria 全部 7 个正例 + 5 个反例。

格式沿用现有 `.routing-eval.jsonl`：

```jsonl
{"input": "...", "category": "signal_routing", "expected_destination": "...", "expected_subclass": "..." | null, "forbidden_destinations": [...], "rationale": "..."}
```

正例（14 条）：
1. "今天收到 8 条消息" → `no_store`
2. "以后回答短一点" → `agent_profile`
3. "人物A在组织B换了职位" → `cbrain_memory` / `fact_memory`
4. "今天在事件B见了人物A，讨论了主题C" → `cbrain_memory` / `episodic_memory`
5. "我越来越觉得主题D应该用原则E处理" → `cbrain_memory` / `thought_memory`
6. "提醒我下周检查主题F" → `action_loop`
7. "嗯" → `no_store`
8. "保存为资料，以后参考" → `cbrain_memory`（Q3 明确意图）
9. "以后讨论技术方案时先列要点" → `agent_profile`
10. "下周三提醒我和人物A确认方案" → `action_loop`
11. "任务E完成了，下周提醒我检查" → `cbrain_memory` + `action_loop`（复合）
12. "这段文章摘要帮我存一下" → `cbrain_memory` / `content_memory`
13. "记得下周提醒我和人物A吃饭" → `action_loop`（"记得"≠存储，Q1 优先）
14. "一会儿找人物A吃饭" → `no_store`（含实体但无复利价值）

反例（7 条）：
1. "今天收到 8 条消息" 禁止走 `cbrain_memory`
2. "以后回答短一点" 禁止走 `cbrain_memory`
3. "提醒我下周检查主题F" 禁止走 `cbrain_memory`
4. "嗯" 禁止走 `cbrain_memory` 或 `agent_profile`
5. "人物A在组织B换了职位" 禁止走 `no_store` 或 `action_loop`
6. "记得下周提醒我和人物A吃饭" 禁止走 `cbrain_memory`（"记得"是口语化"提醒"）
7. "一会儿找人物A吃饭" 禁止走 `cbrain_memory`（含实体但无复利价值）

## Non-goals

- 不加 `daily_log` 路由
- 不加新 CBrain storage table
- 不加 `route_signal` MCP tool
- 不在 CBrain 源码做任何改动

## Verification

```bash
# 验证 skill 文件存在且格式正确
ls skills/signal-router.md
ls skills/signal-router.routing-eval.jsonl

# 验证 RESOLVER.md 引用正确
grep signal-router skills/RESOLVER.md

# 验证 signal-detector.md 引用正确
grep signal-router skills/signal-detector.md

# bun run check 不受影响（纯文档变更）
bun run check
```
