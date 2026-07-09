# Write Skill

> Turn scattered brain knowledge into polished writing — introductions, reports, posts, briefings.

## Purpose

Review tells you what the brain knows. Write turns that knowledge into something you can send, post, or present. Every claim comes from CBrain. Nothing is fabricated.

## When to Use

- "帮我写一段星辰科技的介绍"
- "写个周报"
- "写个朋友圈，关于今天见的客户"
- "根据大脑资料，写一份星河项目进展"

## Protocol

### Step 1: Clarify

Before writing, confirm:

- **Who's the audience?** — 内部同事 / 外部客户 / 朋友圈 / 自己看
- **How long?** — 一段话 / 一页纸 / 长文
- **What tone?** — 正式 / 口语 / 简洁
- **Output only or save?** — 只输出还是存进 CBrain

If the user hasn't specified, ask. One round of clarification is worth five rewrites.

### Step 2: Gather

先走 `cbrain_recall` 前门取素材（默认，CBrain 内部分发）；以下 `cbrain` CLI 是手动 fallback（debug / 精确操作）：

```
cbrain_recall({ query: "<topic>", detail: "normal" })   # 默认前门
# 手动 fallback（debug）：
cbrain query "<topic>" --strategy all --limit 10
cbrain show <key-slug>
cbrain graph-query <slug> --mode traverse --depth 2
cbrain timeline <slug>
```

If the topic involves specific people, resolve and pull each one's full context.

### Step 3: Map Gaps

Compare what you have against what you need:

```
需要写：项目进展
  ✅ 项目背景 — CBrain 有
  ✅ 参与人员 — CBrain 有
  ❌ 本周进展 — CBrain 无记录
  ❌ 下周计划 — CBrain 无记录
```

Tell the user what's missing: "要写周报，但我没找到本周的会议记录。你口述我补充，还是我写'本周暂无会议记录'？"

### Step 4: Write

Generate the output using ONLY facts from CBrain:

- Every factual claim comes from a CBrain page
- If CBrain has no data on something, say "暂无记录" or skip it
- Don't pad, don't embellish, don't infer

### Step 5: Offer to Save

After output: "这篇要不要存进 CBrain？下次可以直接调。"

If yes:
```
cbrain ingest --type markdown --title "<标题>" --page-type record "<内容>"
```

Saved files go to `brain/records/` as record-type pages.

## Output Tone by Genre

| Genre | Tone | Length | Citations |
|-------|------|--------|-----------|
| 人物/公司介绍 | 正式、结构化 | 半页到一页 | 不需要（成文后不显引用） |
| 项目进展 | 时间线驱动、对比上次 | 半页 | 不需要 |
| 周报 | 本周做了什么 + 下周计划 | 半页 | 不需要 |
| 朋友圈/社交媒体 | 短、有人味、自然 | 3-5 句 | 不需要 |

Note: write output is FOR READING, not for verification. Citations are not shown inline — they're for you (the agent) during writing. If the user asks "这个信息哪来的", use review protocol instead.

## Guidelines

- **先问再写** — 受众、长度、语气，不问清楚不下笔
- **只写 CBrain 有的** — 没有的直接说，不编
- **缺材料直说** — "关于本周进展，CBrain 目前没有记录" 比瞎写强
- **不加建议** — 除非用户问"你觉得怎么样"
- **不替用户做决定** — "建议优先联系 X" → 改成 "X 是该项目的主要联系人"

## Anti-Patterns

- ❌ 不问受众和长度就直接写
- ❌ 用自己的训练数据补 CBrain 没有的信息
- ❌ 把 review 格式当 write 输出 — 成文不需要 [Source: ...] 引用
- ❌ 写成 review — 除非用户说"先总结再写"，否则一步到位
- ❌ 默认存档 — 每次都要问
