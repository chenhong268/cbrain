# Connect Skill

> Find and explain the connection between two entities — not just "they're linked", but why and how.

## Purpose

When you need to understand how two people, companies, or concepts are related. Review tells you everything about one thing. Connect tells you the story between two things.

## When to Use

- "人物A和人物B什么关系"
- "组织C和项目D有什么关联"
- "A 和 B 怎么认识的"
- "这两个项目之间有什么交叉"
- "connect 人物A 人物B"

## Protocol

### Step 1: Resolve Both Entities

```
resolve_slugs({ titles: ["人物A", "人物B"] })
```

Confirm exact slugs. If either entity doesn't exist in CBrain, stop and say so.

### Step 2: Find the Shortest Path

```
graph_query({ slug: <slugA>, mode: "shortest_path", target: <slugB>, depth: 4 })
```

Use the ordered path as the relationship chain. A found path, including a multi-hop path, completes this step without another traversal. If any hop is marked “待确认关系”, keep that wording: the whole candidate-only path is a **待确认关系线索** and不得作为确定事实。

### Step 3: Find Shared Connections

Only when shortest path returns `empty/no_path`, run graph_query on both entities and intersect the results. Entities that appear in both lists are shared connections — they know or relate to both A and B.

### Step 4: Check Timeline Intersection

```
cbrain timeline <slugA>
cbrain timeline <slugB>
```

Look for events where A and B appear together, or events on the same date/topic.

### Step 5: Get Full Context for Key Nodes

For the most important connecting entities, pull full pages:

```
cbrain show <key-slug>
```

### Step 6: Explain

Synthesize into a narrative: how A and B are connected, through whom, since when, and what the relationship means. Preserve “待确认” on every candidate hop in the final narrative; do not upgrade it to a fact.

## Output Format

```
## A ↔ B 关联分析

### 直接关系
<如果 CBrain 里有直接链接，描述之；candidate 必须写成“待确认关系线索”> [Source: slug]

### 通过谁连接
A → [中间人1] → [中间人2] → B
每个中间节点一句话说明 [Source: slug]

### 共同关联
A 和 B 都关联到：
- X — 说明 [Source: slug]
- Y — 说明 [Source: slug]

### 时间线交集
YYYY-MM-DD  共同事件描述 [Source: slug]

### 关系总结
<2-3 句话总结 A 和 B 的关系性质、强度、背景；待确认线索不得作为确定事实>
```

## Guidelines

- **最短路径优先** — 如果 A→X→B，不需要遍历 A→X→Y→Z→B
- **空段跳过** — 没找到直接关系就说"CBrain 未记录直接关系"，不编
- **间接关系也有价值** — A 和 B 没直接链接，但有共同熟人也是关系
- **区分关系强弱** — 直接 knows/works_at > 间接通过一个中间人 > 间接通过两个中间人
- **不加判断** — 不说"他们关系好"或"可能有冲突"，只说事实

## Anti-Patterns

- ❌ 只返回 graph_query 原始结果 — 需要翻译成人话
- ❌ A 或 B 不在 CBrain → 直接上网搜 — 应该先告知"XX 不在 CBrain 中"
- ❌ 路径深度太大 (>4) — 超过 4 跳的关系通常不再适合作为首轮解释
- ❌ 已找到最短路径仍继续 traverse — 只有 `empty/no_path` 才进入共同关联回退
