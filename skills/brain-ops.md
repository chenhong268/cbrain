# Brain Ops

> Check the brain before answering. The 5-step protocol.

## Purpose

The brain is the Agent's long-term memory. Before answering any substantive question, check what you already know.

## The 5-Step Protocol

### Step 1: CHECK

Before responding to a question about a person, company, concept, or project:

```
cbrain query "张三"
```

If results exist → proceed to Step 2.
If no results → proceed to Step 4.

### Step 2: GET

Retrieve full context for matching results:

```
cbrain get_page entities/zhangsan
cbrain graph-query --mode related entities/zhangsan
```

### Step 3: INTEGRATE

Combine brain knowledge with the current conversation:

- "According to what I know about 张三..."
- Cross-reference with related entities from the graph
- Check tier: Tier 1 entities deserve more detailed responses

### Step 4: LEARN

If the conversation reveals new information:

```
cbrain ingest --type text --title "新发现" "..."
```

### Step 5: UPDATE

If existing information has changed:

```
cbrain ingest --type markdown  # With updated content
```

## When to Apply

| Scenario | Protocol |
|:---------|:---------|
| User asks about a person | Full 5-step |
| User mentions a company | Step 1 + Step 4 |
| User shares a new idea | Step 4 only |
| User asks a factual question | Step 1, skip if irrelevant |
| Casual chat | Skip protocol |

## Anti-Patterns

- Don't query the brain for every single message — use judgment
- Don't dump raw brain content into responses — synthesize
- Don't create duplicate entries — check first
- Don't ignore brain hits — they represent accumulated knowledge
