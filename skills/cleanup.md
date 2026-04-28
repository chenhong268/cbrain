# Cleanup Skill

> Guided cleanup wizard — find what's stale, duplicated, or broken. List first, confirm, then clean.

## Purpose

Knowledge bases accumulate cruft over time: auto-extracted stubs that were never filled in, pages that nobody links to, near-duplicate entries. Cleanup finds these problems and lets the user decide what to do — nothing is deleted without confirmation.

## When to Use

- "帮我清理一下大脑"
- "有什么该删的"
- "清理/去重/整理"
- 定期维护（建议每月一次）

## Protocol

### Step 1: Scan

```
cbrain health
```

The health report covers 10 dimensions. For cleanup, focus on these:

| Dimension | What to Look For |
|-----------|-----------------|
| 疑似重复 | `王强` vs `王强-1` — same title, different slugs |
| 孤岛页面 | Pages with zero incoming and zero outgoing links |
| 内容薄弱的 stub | Auto-extracted pages with only 1-2 lines of content |
| 断链 | Links to pages that don't exist |

### Step 2: Find Duplicates

```
cbrain list -t entity
```

Scan the output for patterns like `王强` and `王强-1` — these are likely the same entity.

For each suspected duplicate pair, check:
```
cbrain show <slugA>
cbrain show <slugB>
```

Then present to user: "CBrain 里有`王强`和`王强-1`，看起来是同一个人。合并吗？"

### Step 3: Find Orphans

Pages with no relations are likely dead entries:

```bash
# Identify pages with zero links
cbrain graph-query <slug> --mode related
cbrain graph-query <slug> --mode backlinks
# If both return empty → orphan
```

Present: "以下页面没有任何关联，可能是孤立的。删除还是保留？"

### Step 4: Find Stale Stubs

Auto-extracted stubs that were created long ago but never enriched:

```bash
# These are typically tier 3, tagged "auto-extracted", with short bodies
cbrain list -t entity | grep "tier 3"
cbrain show <slug>  # Check if body is just "> Auto-extracted from..."
```

Present: "以下 stub 是自动生成的，内容为空。补充内容还是删除？"

### Step 5: Confirm and Execute

For each category, present findings as a numbered list. Wait for user confirmation before any action.

```
发现了以下问题：

🔗 疑似重复 (2组)
  1. 王强 / 王强-1 → 建议合并到 王强
  2. CM / CM-1 → 建议合并到 CM

👻 孤岛页面 (3个)
  3. brain/entities/某实体 — tier 3, 无人引用
  4. brain/concepts/某概念 — tier 3, 无人引用
  5. ...

📄 空壳 stub (5个)
  6. ...

你想怎么处理？可以：
- "全部处理" — 执行所有建议
- "处理 1 2 3" — 只处理指定项
- "跳过 4" — 保留某些项
```

### Step 6: Execute

For confirmed merges:
```
cbrain merge <source-slug> <target-slug>
```

For confirmed deletions:
```
cbrain delete <slug>
```

### Step 7: Final Sync

```
cbrain sync
```

Clean up any DB orphans created by the deletions.

## Output Format (Final Report)

```
🧹 清理报告

合并：2 组
  ✓ 王强-1 → 王强
  ✓ CM-1 → CM

删除：3 个
  ✓ brain/entities/某实体
  ✓ brain/concepts/某概念
  ✓ ...

保留：5 个（用户选择不处理）

运行 sync 完成，大脑已整理。
```

## Guidelines

- **先列后删** — 永远先展示问题列表，等确认再执行
- **合并优先** — 疑似重复先合并，不直接删除
- **可以跳过** — 用户说"跳过"就不动，不问为什么
- **保留数据** — 合并时 links/timeline/tags 全部迁移，不丢信息
- **不碰 raw/** — raw/ 下的文件只读，清理只针对 brain/ 目录

## Anti-Patterns

- ❌ 不展示就直接删除 — 这是大忌
- ❌ 合并前不确认是同一个人还是不同人 — 同名不同人很常见
- ❌ 删除有关系的页面 — 只删孤立无关联的
- ❌ 清理后不 sync — 会留 DB 残留
- ❌ 建议删除 raw/ 下的任何文件
