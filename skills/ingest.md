# Ingest Skill

> Route incoming content to the right page type and format.

## Purpose

Content arrives in many forms. The ingest skill routes each piece to the correct type, adds metadata, and ensures proper indexing.

## Content Types

### Text (Plain)

Best for: Quick notes, extracted entities, raw observations.

```
cbrain ingest --type text --title "张三" --page-type entity "产品经理，负责AI产品线"
```

### Markdown

Best for: Compiled notes, structured content, content with `[[wiki-links]]`.

```markdown
---
title: 张三
type: entity
tags: [人物, 产品]
---

张三是产品经理，负责AI产品线。

关系：[[李四]] 是他的直属上级。
```

## Routing Rules

| Input Source | Content Type | Page Type | Notes |
|:-------------|:-------------|:----------|:------|
| Chat extraction | text | entity | Signal detector output |
| Article summary | markdown | source | With original URL in frontmatter |
| Meeting notes | markdown | event | Date in frontmatter |
| Raw observation | text | record | Auto-timestamped |
| Concept definition | text | concept | Title = concept name |

## Wiki-Link Convention

Use `[[target]]` to create graph edges:

- `[[张三]]` → resolves to `entities/zhangsan`
- `[[RAG]]` → resolves to `concepts/rag`
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
