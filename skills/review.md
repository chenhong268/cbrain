# Review Skill

> Deep topic review — gather everything the brain knows about X and synthesize it into a coherent picture.

## Purpose

Search returns fragments. Review returns understanding. When you need to know everything about a person, company, project, or concept — not just the top hit, but the full story with relationships, timeline, and gaps.

## When to Use

- "帮我总结一下组织A的情况"
- "关于 主题D 我们知道什么"
- "review 实体A"
- "整理一下 项目B的所有信息"
- "这个客户什么来头"

## Protocol

### 先区分概览与深度复盘

`cbrain_recall` 是 MCP tool（不是 CLI 命令）。其 overview 路径提供检索片段与关系/时间线数量，**不等于全文、关系明细或事件明细，也不代表已完成深度复盘**。`detail: "full"` 不能替代缺少的取证步骤。

用户只要简短概览时，可用 `cbrain_recall` 返回的实际资料概述，并标明覆盖范围。用户要求全面了解、复盘、所有信息或完整档案时，必须完成下面 5 步，不以一次 overview 收尾。

### 深度复盘：5 步取证

1. **搜索**：先 `cbrain_recall({ query: "全面了解主题D", detail: "normal" })`，再按结果中的真实名称补查关键词、别名及中英文变体；不要猜别名。daily profile 继续使用前门，直调 `query` 仅限显式 debug/full profile。
2. **全文**：对相关页面用 `get_page({ slug, include_full_body: true })` 读取全文，并确认正文成功返回，先覆盖最相关的 3–5 页。`get_page` 默认截断正文；`get_pages` 只返回 200/500 字摘要，可筛选页面但不能替代全文。检索片段不能代替全文；更多页面未读时说明覆盖限制。
3. **关系**：对已确认实体调用 `graph_query` 的 `traverse` 与 `backlinks`，核对关系方向、来源及确认状态。数量不是关系证据，candidate 只能写为待确认。
4. **时间线**：调用 `get_timeline` 读取事件明细及来源，区分事件日期与文件名/更新时间。无事件也要记录这一步的空结果。
5. **合成**：只使用已取得的证据，每条事实标明来源；明确未覆盖或互相矛盾之处。前 4 步均执行且仍无信息，才能转向网上搜索；工具不可用或报错时说明复盘未完成，不能说大脑里没有资料。

CLI 手动等价操作（debug/离线，不是 daily MCP 首选）：`cbrain query`（关键词及变体）→ `cbrain show <slug>` → `cbrain graph-query <slug> --mode traverse` 与 `--mode backlinks` → `cbrain timeline <slug>` → 合成。

### Synthesize

Combine everything into the output format below. **Do not fabricate.** If a section has no data, skip it.

## Output Format

```
## <topic> — 知识总览

<1-2 句整体描述，基于实际找到的内容>

### 基本信息
- 类型：实体/概念/事件
- 最近更新：DATE
- 标签：tag1, tag2

### 关键事实
- 从 body 和 frontmatter 提取的核心信息，每条一行的要点列表
- 每条要点来自具体页面

### 关系网络
- 与 A 的关系：关联描述 [Source: slug]
- 与 B 的关系：关联描述 [Source: slug]

### 时间线
YYYY-MM-DD  事件描述 [Source: slug]
YYYY-MM-DD  事件描述 [Source: slug]

### 知识盲区
- 列出应该知道但目前缺乏的信息（例如：没有联系方式、不知道当前职位）
- 这不是缺陷，这是诚实 — 告诉用户大脑里缺什么
```

## Guidelines

- **先搜再写** — 不要凭记忆回答，必须从 CBrain 取最新数据
- **每条事实有出处** — `[Source: slug, updated DATE]`
- **诚实报告盲区** — "目前大脑里没有记录 X 的联系方式" 比编造更好
- **3-5 行/人/公司** — 这是全貌，不是档案。细节太多反而没法用
- **关系只说有记录的** — 图谱里查不到的关联不要编
- **不加建议** — review 只整理信息，不替用户做判断

## Anti-Patterns

- ❌ 把 overview 的片段或统计数量写成“已完成全文、关系、时间线核查”
- ❌ 只搜一次就下结论 — 可能遗漏别名、关联实体
- ❌ 编造关系 — "可能与 Y 有合作" 改成 "目前未记录与 Y 的关联"
- ❌ 把查询结果当正文 — 需要用自己的话重新组织，不是复制粘贴
- ❌ 每个 section 都强行输出 — 没数据就跳过
- ❌ 忘记查 timeline — 时间线往往包含最重要的动态信息
