# Signal Detector

> Extract entities and ideas from every message the Agent receives.

## Purpose

Every conversation contains signals — names, companies, concepts, events, relationships. The signal detector scans incoming messages and decides what's worth remembering.

## Protocol

### Step 1: Scan

On each user message, check for:

- **Named entities**: People (人物A, 人物B), companies (组织A, 组织B), products (产品A, 产品B)
- **Concepts**: Technologies (技术A, 技术B), methods (方法A, 方法B), frameworks (框架A, 框架B)
- **Events**: Meetings, deadlines, launches, milestones
- **Relationships**: "A 在 B 工作", "C 投资了 D", "E 和 F 合作"
- **Ideas/Observations**: "也许我们应该...", "注意到一个趋势..."

### Step 2: Classify

For each signal, classify its type：

| Signal Type | Examples | Notes |
|:------------|:---------|:------|
| New person/org/concept | 人物A、组织B、主题C | 只标记为潜在信号，不创建 |
| Event/date | 事件D、时间E | 交给 signal-router 判断目的地 |
| Relationship | 人物A 属于 组织B | 只有 `cbrain_memory` 才进入 ingest |
| Idea/Observation | 用户观点/反思 | 可能是 `thought_memory`，也可能 `no_store` |

### Step 3: Route

每 3-5 轮对话，按以下流程处理：

1. **先路由**：读取 **signal-router.md**，对最近对话中的每个信号判断目的地（`cbrain_memory` / `agent_profile` / `action_loop` / `no_store`）
2. **仅 ingest 记忆信号**：只对目的地为 `cbrain_memory` 的片段调用 `ingest_dialogue`
   ```
   ingest_dialogue({ text: "仅 cbrain_memory 片段", mode: "auto" })
   ```
   检查返回的 `decision` 字段：
   - `"recorded"` → 可以简短告知用户"已记录"（可选，别每次都说）
   - `"skipped"` → 静默忽略
3. **非记忆信号走各自通道**：
   - `agent_profile` → 仅当用户明确陈述偏好或规则时，使用完整字段更新：
     ```text
     profile({ action: "update", entries: [{
       id: "response-length-short",
       type: "preference",
       category: "communication",
       scope: "open",
       content: "回复保持简洁",
       source: "explicit"
     }] })
     ```
   - `action_loop` → Agent 内部 scheduler（不调 CBrain）
   - `no_store` → 静默跳过

- 明确长期记录意图 → 仍先走 signal-router；若为 `cbrain_memory`，可用 `mode: "manual"`（行为更宽松）
- New entities / relationships / ideas → 只作为信号，不直接 ingest
- Duplicate check 只在 `cbrain_memory` 路由成立后执行（通过 `ingest_dialogue` 内部去重）

## MCP Tool Usage

```
1. signal-router.md → 判断每个信号的目的地
2. cbrain_memory → ingest_dialogue({ text: "仅记忆片段", mode: "auto" })
3. explicit long-term save → ingest_dialogue({ text, mode: "manual" })
4. agent_profile → 仅对用户明确陈述调用 profile({ action: "update", entries: [{ id: "response-length-short", type: "preference", category: "communication", scope: "open", content: "回复保持简洁", source: "explicit" }] })
5. action_loop / no_store → 不调 CBrain ingest
```

## Guidelines

- **Route first; store only when the signal has compounding value** — forgetting low-value noise is intentional
- **Chinese names**: Use full names (人物A, not abbreviated)
- **Context matters**: "人物A说技术B不错" extracts both 人物A (entity) and 技术B (concept)
- **Don't over-extract**: Articles like "一个" or "这个" are not signals
- **Profile persistence is explicit-only**: 只有用户明确说出的偏好或规则才能写入；不要根据行为、语气或历史模式猜测
