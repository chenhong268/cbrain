# Review Skill

> Deep topic review — gather everything the brain knows about X and synthesize it into a coherent picture.

## Purpose

Search returns fragments. Review returns understanding. When you need to know everything about a person, company, project, or concept — not just the top hit, but the full story with relationships, timeline, and gaps.

## When to Use

- "帮我总结一下星辰科技的情况"
- "关于 RAG 我们知道什么"
- "review 张三"
- "整理一下 ABC 项目的所有信息"
- "这个客户什么来头"

## Protocol

### ⚡ 优先用 deep_recall（一步搞定）

`deep_recall` 是 MCP tool（不是 CLI 命令），Agent 通过 `deep_recall` tool 调用。一次返回 body + links + timeline + tags + related + insights，等价于下面 4 步连调：
- query（搜索）+ get_page（取全文）+ graph-query（关系）+ timeline（时间线）

**只在 deep_recall 不可用时才退回以下步骤。**

### Fallback: 手动 4 步

1. `cbrain query "<topic>" --strategy all --limit 10` — 搜索 + 别名变体
2. `cbrain show <slug>` — 取 top 3-5 结果全文（MCP tool: `get_page`）
3. `cbrain graph-query <slug> --mode traverse --depth 1` — 关系网络
4. `cbrain timeline <slug>` — 时间线

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

- ❌ deep_recall 可用却手动 query+get_page+graph+timeline 连调 — deep_recall 一步搞定
- ❌ 只搜一次就下结论 — 可能遗漏别名、关联实体
- ❌ 编造关系 — "可能与 Y 有合作" 改成 "目前未记录与 Y 的关联"
- ❌ 把查询结果当正文 — 需要用自己的话重新组织，不是复制粘贴
- ❌ 每个 section 都强行输出 — 没数据就跳过
- ❌ 忘记查 timeline — 时间线往往包含最重要的动态信息
