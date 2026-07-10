# Brain Ops

> Check the brain before answering. The 5-step protocol. First, route to the right skill.

## Purpose

The brain is the Agent's long-term memory. Before answering any substantive question, check what you already know.

## Step 0: Route First

Before executing any protocol, check RESOLVER.md (`skills/RESOLVER.md`) to see if the user's intent matches a specific skill:

| User says | Route to | Why |
|:----------|:---------|:----|
| 总结/梳理/review/全面了解/什么来头 | review.md | Deep topic review, not simple search |
| 有什么关系/A和B有什么联系 | connect.md | Relationship explanation |
| 清理/去重/该删什么 | cleanup.md | Guided cleanup wizard |
| 帮我写/写段介绍/写周报 | write.md | Knowledge-based writing |
| CBrain 当前痛点/异常/该处理什么 | query.md [operations] | Read-only attention queue, not semantic recall |

If no specific skill matches, proceed with the 5-step protocol below.

## The 5-Step Protocol

### Step 1: CHECK

Before responding to a question about a person, company, concept, or project:

调用 `cbrain_recall({ query, detail: "normal" })`。

If results exist → proceed to Step 2.
If no results → if the original intent is a deep review, re-route to review.md; otherwise use the bounded fallback below.
Only declare "not in brain" after the single bounded fallback defined in query.md.

### Step 2: GET

首轮结果不足时只允许 query.md 定义的一次 bounded fallback。不要默认串联 page、graph、timeline；深度复盘和关系分析应在 Step 0 路由到专用 skill。

### Step 3: INTEGRATE

Combine brain knowledge with the current conversation:

- Synthesize into your own words, don't copy-paste
- Cross-reference graph evidence only when a dedicated review/connect route returned it
- Check tier: Tier 1 entities deserve more detail
- Add source labels in review flows; ordinary conversational recall stays natural and compact
- If a section has no data, say so honestly — don't fabricate

### Step 4: LEARN

如果对话产生**新内容**，使用 `ingest`。

### Step 5: UPDATE

如果**已有页面**发生变化，先 `resolve_slugs`，再使用 `put_page` 默认 patch。禁止把已有页面再次交给 `ingest` 创建副本。

## When to Apply

| Scenario | Protocol |
|:---------|:---------|
| User asks for deep review / summary | Step 0 → review.md protocol |
| User asks about a person/company | Full 5-step |
| User asks about relationships | Step 0 → connect.md protocol |
| User mentions a company | Step 1 + Step 4 |
| User shares a new idea | Step 4 only |
| User asks a factual question | Step 1, skip if irrelevant |
| User wants to clean up | Step 0 → cleanup.md protocol |
| Casual chat | Skip protocol |

## Anti-Patterns

- Don't query the brain for every single message — use judgment
- Don't dump raw brain content into responses — synthesize
- Don't create duplicate entries — check first
- Don't ignore brain hits — they represent accumulated knowledge
- Don't give up after one query miss — graph and timeline often have the answer
- Don't jump to web search when CBrain has related information
