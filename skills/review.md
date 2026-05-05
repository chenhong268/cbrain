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

### Step 1: Broad Search

Search the topic with hybrid strategy to catch everything:

```
cbrain query "<topic>" --strategy all --limit 10
```

Also check for name variants (中文/English, full/abbreviated, 别名).

### Step 2: Gather Full Context

For the top 3-5 results, pull complete pages:

```
cbrain show <slug>        # Full body + frontmatter
cbrain tags <slug>         # What tags are on this
cbrain versions <slug>     # How many times it's been updated
```

### Step 3: Map Relationships

```
cbrain graph-query <slug> --mode traverse --depth 1   # Who/what is connected
cbrain graph-query <slug> --mode backlinks             # Who references this
```

### Step 4: Check Timeline

```
cbrain timeline <slug>     # Key events in chronological order
```

### Step 5: Synthesize

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

- ❌ 只搜一次就下结论 — 可能遗漏别名、关联实体
- ❌ 编造关系 — "可能与 Y 有合作" 改成 "目前未记录与 Y 的关联"
- ❌ 把查询结果当正文 — 需要用自己的话重新组织，不是复制粘贴
- ❌ 每个 section 都强行输出 — 没数据就跳过
- ❌ 忘记查 timeline — 时间线往往包含最重要的动态信息
