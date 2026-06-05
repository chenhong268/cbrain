# Signal Router

> Decide where each incoming signal goes before touching any tool.

## Purpose

Not every signal belongs in CBrain. Before calling `ingest_dialogue` or `update_profile`, route each signal to the right destination:

- **`cbrain_memory`** — durable compounding memory that changes future recall, judgment, or knowledge structure
- **`agent_profile`** — confirmed preferences and operating rules that affect Agent behavior
- **`action_loop`** — short-term tasks, reminders, follow-ups — belongs in Agent scheduling, not CBrain
- **`no_store`** — no expected reuse value; remain silent and do not store

## Four Destinations

| Destination | 触发条件 | 工具调用 | 用户感知 |
|:------------|:---------|:---------|:---------|
| `cbrain_memory` | 含实体/关系/事件/决策/观点演变，且会改变未来召回、判断、关系理解、知识结构或用户思考演化；或用户明确要求长期记忆/保存为资料/以后参考 | `ingest_dialogue` / `ingest` | 可选"已记录" |
| `agent_profile` | 用户要求设偏好/规则/以后都这样 | `update_profile` / `reload_profile` | 确认偏好已生效 |
| `action_loop` | 用户要求提醒/待办/下次检查/安排 | Agent 内部 scheduler，不调 CBrain | 确认已安排 |
| `no_store` | 纯确认/闲聊/一次性信息 | 无 | 静默 |

## Decision Tree

按顺序判断，第一个 YES 即停止：

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

优先级：`action_loop` > `agent_profile` > 明确记忆意图 > 内容复利分析。

Q1-Q3 是意图判断，Q4 是内容价值判断。

### 关键区分

- "记得下周提醒我" → Q1 `action_loop`（"记得"是口语化的"提醒"，不是存储意图）
- "一会儿找人物A吃饭" → `no_store`（含实体但无复利价值，一次性安排）
- "人物A在组织B换了职位" → Q4 `cbrain_memory`（实体+关系变化，改变知识结构）

## cbrain_memory Subclassification

`cbrain_memory` 选定后，内部分类（不暴露给用户）：

| 子分类 | 信号特征 | CBrain page type |
|:------|:---------|:----------------|
| `content_memory` | 材料/笔记/摘要 | source / record |
| `fact_memory` | 事实/关系/事件 | entity / concept / event |
| `episodic_memory` | 经历/对话场景（时间+地点+人物+主题） | event |
| `thought_memory` | 观点/原则/反思/观点演变 | record |
| `collaboration_memory` | 协作偏好固化（从 profile 升华为持久记忆） | record |

不做新 storage table，复用现有 CBrain page type。

## Tool Mapping

| Destination | 调什么工具 |
|:-----------|:----------|
| `cbrain_memory` | `ingest_dialogue({ text, mode: "auto" })` 或 `ingest({ content, type, title, pageType })` |
| `agent_profile` | `update_profile({ type, category, content })`，必要时 `reload_profile()` |
| `action_loop` | Agent 内部 scheduler / reminder 工具（不调 CBrain） |
| `no_store` | 无操作 |

## Compound Signals

一条消息可能含多个目的地。拆分规则：

1. 按决策树逐条判断每个语义片段
2. 每个目的地独立处理
3. 同一消息只拆一次，不做递归拆分

示例：

| 输入 | 拆分 |
|:-----|:-----|
| "任务E完成了，下周提醒我检查" | `cbrain_memory`（完成事实有复利价值）+ `action_loop`（提醒） |
| "以后回复短一点，另外记一下人物A换了职位" | `agent_profile`（偏好）+ `cbrain_memory`（实体变化） |

## Anti-patterns

- ❌ 把 `action_loop` 内容喂给 `ingest_dialogue`
- ❌ 把 `no_store` 信号调 `query` 做"以防万一"检查
- ❌ 对用户暴露子分类名称（`fact_memory`、`episodic_memory` 等）
- ❌ "记得" 一律当存储意图（"记得提醒我"是待办，不是记忆）
- ❌ 含实体就进 `cbrain_memory`（"一会儿找人物A吃饭"是 `no_store`）
- ❌ 把 `agent_profile` 内容存进 CBrain vault（profile 是独立存储）
