# Ingest Skill

> Route incoming content to the right page type and format.

## Purpose

Content arrives in many forms. The ingest skill routes each piece to the correct type, adds metadata, and ensures proper indexing.

## Canonical Write Contract

- **新内容**使用 `ingest`，让 CBrain 完成去重、slug 校验、索引和 deferred NER。
- **已有页面**先用 `resolve_slugs` 确认 canonical slug，再使用 `put_page`；默认 patch 会追加正文、合并 tags、保留已有字段。
- **禁止使用 `write_file` 绕过 CBrain**。即使是超时补救，也不能直接写 vault；应返回明确失败或改走 `put_page`。
- 不确定页面是否存在时，先 `resolve_slugs`：存在走 update，不存在才走 create。

## Content Types

### Text (Plain)

Best for: Quick notes and raw observations. Entities are extracted asynchronously.

```
cbrain ingest --type text --title "记录A" --page-type record "一条新的匿名观察"
```

### Markdown

Best for: Compiled notes, structured content, content with `[[wiki-links]]`.

```markdown
---
title: 实体A
type: entity
tags: [人物, 产品]
---

实体A是产品经理，负责AI产品线。

关系：[[实体B]] 是他的直属上级。
```

## Routing Rules

| Input Source | Content Type | Page Type | Notes |
|:-------------|:-------------|:----------|:------|
| Chat extraction | text | record | NER creates or resolves entity pages |
| Article summary | markdown | source | With original URL in frontmatter |
| Meeting notes | markdown | event | Date in frontmatter |
| Raw observation | text | record | Auto-timestamped |
| Concept definition | text | record | NER/resolver derives the concept |

## Existing Page Update

```text
resolve_slugs({ queries: ["实体A"] })
put_page({ slug: "<resolved slug>", content: "补充内容" })
```

`put_page` 对已有页面默认使用 patch。只有用户明确要求完整替换时才传 `mode: "replace"`。

## Wiki-Link Convention

Use `[[target]]` to create graph edges:

- `[[实体A]]` → resolves to matching entity page
- `[[RAG]]` → resolves to matching concept page
- Unresolvable links → stored but no graph edge created

## Tags

- Add `tags` array in frontmatter (markdown) or `--tags` flag (CLI)
- Tags enable filtering and categorization
- Prefer specific tags: `AI/LLM` over just `AI`

## After Ingest

1. Content is written to vault as markdown
2. SQLite page record created
3. LanceDB chunks indexed for vector + FTS search
4. Wiki-links extracted → graph edges created
5. Mention counts incremented for linked entities

## Response Format

Both `ingest` and `ingest_dialogue` return a structured envelope:

```json
{
  "display": "已记住：标题。提取了 2 个实体、1 条关系。",
  "summary": {
    "status": "recorded",
    "title": "标题",
    "captured": { "entities": 2, "relations": 1, "events": 0 },
    "message": "已记住：标题。提取了 2 个实体、1 条关系。"
  },
  "raw": { ... }
}
```

### 字段说明

- **`display`** / **`summary.message`** — 用户可见的自然语言摘要
- **`summary.status`** — `recorded`（已记住）| `skipped`（无需记录）| `needs_review`（待确认）
- **`summary.captured`** — 提取的实体/关系/事件计数（NER 未运行时为 `null`）
- **`summary.title`** — 页面标题（对话模式为 `null`）
- **`raw`** — 完整内部结果（向后兼容 + 调试用）

### Hermes 展示规则

- ✅ 展示 `display` 或 `summary.message`
- ❌ 禁止展示 `raw` 里的 slug、stubsCreated、filtered、chunk id、source_id、NER details
- ❌ 禁止展示工具名、raw JSON、debug/trace 字段
- 失败时展示 `display` 中的自然降级文案，不暴露技术原因
