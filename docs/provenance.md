# 来源与信任（Provenance）

> 每条关系和事件都带着「从哪来」「能信多少」的标签。Provenance 让你能查来源、纠正错误、审计变更——不用改任何数据模型，只是把 CBrain 已有能力讲清楚。

## 为什么需要 Provenance

CBrain 里的知识有两种出身：

- **你直接给的** —— 手写的笔记、录入的对话、确认过的事实
- **CBrain 推断的** —— NER 自动提取的实体关系、Agent 推理的结论、从对话里抽取的信息

两种出身可信度不同。如果一视同仁，Agent 推断出来的错误关系会和你的笔记一样被当成事实——这很危险。

Provenance 给每条**关系**（link）和**事件**（timeline entry）打上三样东西：

1. **来源** —— 这条知识最初怎么进来的
2. **信任状态** —— CBrain 现在信它多少
3. **纠正历史** —— 它被改过几次、每次为什么

## 两类对象

Provenance 只挂在两种对象上：

| target_type | 对象 | 例子 |
|:------------|:-----|:-----|
| `link` | 实体之间的关系 | 实体A → 任职于 → 组织B |
| `timeline` | 实体上的事件 | 实体A 于 2024-03 加入组织B |

> 页面正文、标签这些不挂（关系/事件）provenance。只有「关系」和「事件」这种容易被推断错、又容易过时的结构化事实，才需要来源追踪。
>
> 注意：**页面「由谁创建」是另一套独立系统**（`page_write_provenance`，#386），与本节的信任 provenance 不是一回事——见下方 [页面创建者溯源](#页面创建者溯源386)。

## 页面创建者溯源（#386）

记录「一个 record 页面是谁、通过什么路径创建的」，独立于上面的关系/事件信任 provenance。

- **存储**：`page_write_provenance` 表，append-only（`page_slug` 唯一主键，写一次不可改），FK→pages ON DELETE CASCADE。
- **和 `ingest_log` 的区别**：`ingest_log` 是可变操作日志（改名 UPDATE、删页 DELETE、无 FK），不能当创建归属真相源。
- **归属由适配层决定，调用方不能自报**：MCP `ingest`/`put_page` → `agent`；CLI `cbrain ingest` → `operator`；watcher/sync 首次发现外部文件 → `unknown_writer`；dream/job 暂不发射 `system`。actor 字段只存在于内部 `IngestInput`/`CreatePageInput`，绝不进 MCP 公开 input schema（防伪造）。
- **查询**：`cbrain writer-audit` 列出缺溯源的 record 页；`cbrain show-writer <slug>` 看单页归属。

### v1 范围（务必遵守）

**只覆盖 `type=record` 的页面创建。** entity / concept / insight 页面，以及 dialogue 自动提取的页面，本轮**不写** page creation provenance——它们的归属语义（自动提取 vs 显式、session 绑定、回滚合同）需要单独定义，不能借 record 这轮改动顺手纳入。

**缺行 = 诚实留白**（早于 #386 追踪期 / 走了未追踪路径 / 非 record 类型），**绝不回填虚构**。未来扩展 dialogue/entity 时，应单独定义其可信语义，不复用本次 sync/ingest 的发射点。

## 来源模型

### 来源分类（source_category）

这条知识最初怎么进入 CBrain 的：

| 内部值 | 用户向说法 | 怎么产生的 |
|:-------|:----------|:----------|
| `explicit_input` | 你直接录入的 | 手动 ingest / put_page 写入的关系 |
| `imported_content` | 从笔记导入的 | 解析 vault 里已有的 wiki link |
| `dialogue_extraction` | 从对话提取的 | `ingest_dialogue` 抽取的关系 |
| `agent_inference` | Agent 推断的 | NER 实体提取 / Agent 推理 / 双向修正 |
| `user_confirmation` | 你确认过的 | 你用 `confirm_evidence` 确认后 |
| `correction` | 纠正记录 | 你纠正后产生的新状态 |

### 信任状态（trust_state）

CBrain 当前对这条知识信多少：

| 内部值 | 用户向说法 | 含义 |
|:-------|:----------|:-----|
| `trusted` | 已确认 | 可信事实，可放心引用 |
| `user_thought` | 你的想法 | 你表达的观点，尚未核实 |
| `candidate` | 待确认 | Agent 推断的，未经你确认 |
| `rejected` | 已否决 | 你明确否定，不应再引用 |
| `superseded` | 已更新 | 被更新的信息取代 |

**默认规则**：你直接录入的、从笔记导入的 → `trusted`；NER / Agent 推断的、对话抽取的 → `candidate`。所以一条新知识进来的瞬间，出身就决定了它的初始信任状态。

### 其他字段

- **evidence** —— 证据摘要（如有）
- **纠正历史** —— 每次信任状态变更都记一笔：旧状态 → 新状态、变更分类、原因、时间

> **置信度（confidence）是内部数值**，CBrain 用它做辅助判断（比如置信度低于阈值时，即使来源可靠也会标为 `candidate`）。文档和面向用户的回答**不展示这个数值**——它是机器内部信号，直接给用户容易误导。

## 五个常见工作流

### 1.「这条信息哪来的？」

用户问来源时，Agent 调 `get_provenance`。

- 上下文里已有具体关系 / 事件 ID → 直接查
- 用户只用自然语言描述（「实体A 和组织B 的关系」）→ 先 `graph_query` / `get_links`（关系）或 `get_timeline`（事件）拿到 ID，再查
- 实在定位不到 → **如实说找不到，禁止编造来源**

```
get_provenance({ target_type: "link", target_id: 123 })
```

返回来源分类、信任状态、证据摘要、纠正历史。

### 2.「这是确认过的，还是只是 Agent 猜的？」

看返回的信任状态：

- `trusted` / `user_thought` → 可信事实，或你的原话
- `candidate` → Agent 推断，告诉用户时要标「待确认」
- `rejected` / `superseded` → 已被否决或更新，不应再当成事实引用

### 3.「这条过时了 / Agent 推断错了，否掉它」

```
set_trust_state({
  target_type: "link",
  target_id: 123,
  new_state: "rejected",                        // 只能 candidate / rejected / superseded
  reason: "实体A 已于 2025 年离开组织B"           // 必填
})
```

**关键约束**：

- `set_trust_state` **只能降级**（→ `candidate` / `rejected` / `superseded`），不能升级为 `trusted`
- `reason` 必填 —— 每次纠正都要留原因，写进纠正历史
- 想升级为可信？看下一个工作流

### 4.「我确认这条是对的」

升级到 `trusted` 走单独的入口 `confirm_evidence`，它要求**证据可验证**：

```
confirm_evidence({
  target_type: "link",
  target_id: 123,
  confirmation_record_slug: "records/recordD",   // vault 里已存在的页面
  excerpt: "实体A 在 2024 年 3 月正式加入组织B",   // 该页面正文里的真实片段
  new_state: "trusted"                            // 默认 trusted，可选 user_thought
})
```

**为什么这么严**：系统会验证 `confirmation_record_slug` 这个页面在 vault 里确实存在，且 `excerpt` 真的出现在该页面正文中。这样每条「可信事实」都能追溯到一条你写的原始记录，不会凭空升级。**这是唯一能把信任状态升到 `trusted` 的路径。**

### 5.「这条之前被改过吗？」

`get_provenance` 的返回里带纠正历史——每次 old → new、变更分类、原因、时间。一条知识被纠错过几次、每次为什么，都可审计。

## Agent 什么时候该用 provenance

### 该走 provenance 的信号

用户问：

- 「这条信息哪来的 / 来源是什么 / 证据来源」
- 「这个关系是谁说的 / 谁告诉你的」
- 「这件事可靠吗 / 可信吗 / 确认过吗 / 有证据吗」

### 不该走 provenance（走别的路由）

| 用户其实想问 | 该用 |
|:------------|:-----|
| 当时的内容 / 怎么设计的 | `deep_recall`（detail: normal） |
| 讨论过这个吗（核查是否发生过） | `deep_recall`（grounded: true） |
| A 和 B 什么关系（查关系本身） | `graph_query` / `connect` |
| 帮我总结 / 全貌 | `summarize` |

> provenance 不是内容回忆工具。它只回答「这条结构化事实从哪来、信不信」，不回答「当时聊了什么」。

### 面向用户的措辞（硬规则）

回答最终用户时：

- 说「来源：从对话提取的 / Agent 推断的 / 你确认过的」，**不吐** `source_category` 枚举值
- 说「已确认 / 待确认 / 已否决 / 已更新」，**不吐** `trust_state` 枚举值
- **不输出**：`target_id`、`source_type`、`source_page_slug`、`confidence` 数值、raw JSON、工具名
- `candidate` 必须标「待确认」，不能当成事实陈述
- 找不到具体目标就说找不到，**禁止编造来源**

## 三个工具速查

| 工具 | 做什么 | 关键约束 |
|:-----|:------|:--------|
| `get_provenance` | 读来源 + 信任状态 + 纠正历史 | 需要 `target_id`；没有 ID 时先 `get_links` / `get_timeline` 拿 |
| `set_trust_state` | 降级或纠正 | 只能 `candidate` / `rejected` / `superseded`；`reason` 必填 |
| `confirm_evidence` | 升级为 `trusted` / `user_thought` | 必须引用 vault 页面 + `excerpt` 原文验证 |

## 示例对话（匿名）

**用户**：实体A 和组织B 的「任职于」关系，是确认过的吗？还是 Agent 推断的？

**Agent**：（先 `get_links` 拿到关系 ID → `get_provenance`）

> 这条是 Agent 推断的，目前是「待确认」状态。来源是 2024-05 的一次对话提取。要我帮你确认或否决吗？

**用户**：否掉它，实体A 早不在组织B 了。

**Agent**：（`set_trust_state` → `rejected`，reason 记录原因）

> 已标记为「已否决」。

**用户**：实体A 和组织C 的关系我确认过，是我上周会议记录里写的。

**Agent**：（`confirm_evidence`，引用会议记录页 + 原文片段）

> 已确认。
