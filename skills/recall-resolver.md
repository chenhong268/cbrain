# Recall Resolver — Tool 层路由表

> 意图 → MCP 工具。与 skill 层 RESOLVER.md 互补：那个决定加载哪个 skill 文件，这个决定调哪个 MCP 工具。

## 决策树

```
用户提问涉及 CBrain 知识
│
├─ 最高优先A：核查确认意图
│   信号：讨论过吗、聊过吗、CBrain 里有吗、有没有遗漏
│         有没有依据、是不是真的、矛盾吗
│         为什么这么定、上次怎么定的
│   → deep_recall({ query, grounded: true, limit: 3, detail: "brief" })
│   → 答案是 yes/no 或 fact/candidate 分类，不需要全文
│   → 超时预算 20 秒，见下方「体验预算」
│   → 回答格式见下方「回答规范」
│
├─ 最高优先B：内容回忆意图
│   信号：当时怎么设计、为什么选、具体方案是什么、之前怎么讨论、怎么做的
│   → deep_recall({ query, detail: "normal", limit: 3 })
│   → 禁止 grounded=true，用户要的是内容本身
│   → ⚠️ 硬门控：if（用户没说"展开/原文/详细/继续" && recall没返回insufficient/low confidence）
│     { 禁止 get_page / expand_entity / get_timeline / query / session_search / 第二次deep_recall }
│   → get_page 触发条件：用户说"展开/原文/详细" OR recall返回insufficient OR recall返回"未找到相关实体"
│
├─ 情境找人（用户不记得人名，靠情境线索找人）？
│   强触发：那个人是谁、叫什么来着、想不起名字、忘了名字
│   条件触发：时间/地点/事件/场景/主题 + 见过/认识/遇到/一起做过 + 谁/那个人/人
│   ⎿示例：去年团建见过谁、上个月聚餐认识的那个、项目上线一起干的人、主题C相关的人
│   ⚠️ 不适用（走 query/connect）：
│     用户提到具体人名（"人物A认识谁"）
│     纯关系查询（"A和B什么关系"）
│     已知实体信息查询（"组织F团队的人"）
│   → recall_episode({
│       query: 原始问题,
│       time_hint: 提取时间线索（去年/上个月/2024年/...）,
│       topic_hint: 提取主题线索（前端/项目管理/...）,
│       context_hint: 提取场景线索（团建/聚餐/技术分享/...）,
│       event_hint: 提取事件线索（项目上线/团队聚餐/...）,
│       relation_hint: 提取关系线索（人物A的同事/组织E的人/...）,
│       limit: 5
│     })
│   → 区别于 query：用户不记得人名，靠情境信息找候选人
│   → 区别于 deep_recall：这是候选人推荐，不是内容回忆
│   → 结果包含候选人列表、匹配线索、证据，不返回全文
│
├─ "关于X的一切"？
│   信号：回忆、详细了解、深入了解、怎么样、什么来头、关于X的上下文
│   → deep_recall
│   → 遇到 stub → expand_entity 补充
│
├─ "给我一个全景"？
│   信号：总结、概览、全面、全貌、梳理、overview、帮我理一下
│   → summarize
│   → 遇到 stub → expand_entity 补充
│
├─ "结构化档案"？
│   信号：完整档案、dossier、RAGmap、信息表、详细档案
│   → dossier
│   → 区别：review 是叙事式，dossier 是结构化表格
│
├─ "帮我分析/推理"？
│   信号：分析、联想、知识缺口、cross-domain、背后逻辑、有什么联系
│   → brain_storm
│
├─ "XX和YY什么关系"？
│   信号：什么关系、怎么认识的、有什么联系、之间
│   → graph_query(mode=traverse, depth=2)
│   → 深度分析 → connect skill
│
├─ "最近有什么发现"？
│   信号：有什么发现、漏掉的、关联没注意到、洞察
│   → list_insights + read_discoveries
│
├─ "时间线/事件回顾"？
│   信号：时间线、发生了什么、历史记录、什么时候
│   → get_timeline
│
├─ "这两个重复了"？
│   信号：合并、重复页面、一样的
│   → merge_pages(source, target, dryRun=true)
│   → 注意：必须先 dryRun=true 预览
│
├─ "快速查找"？
│   信号：搜、找、有没有、查一下、谁在XX、XX认识谁
│   → query
│   → 需要完整信息？→ expand_entity
│
├─ 追问某个具体实体？
│   信号：多说说、展开、细节、详细看这个
│   → expand_entity（需先有 slug）
│
└─ 不确定
    → deep_recall（安全默认，不要退回 query）
```

## 体验预算（Grounded Recall 专属）

| 阶段 | 时间 | 动作 |
|:---|:---|:---|
| 调用 deep_recall | 0-20s | 等待返回 |
| 超时未返回 | >20s | 立即回复短句（见降级策略） |
| 后台补查 | 20s+ | 可以后台继续查，但用户已收到回复 |

### 降级策略

```
if (grounded_recall 超过 20 秒无结果) {
  回复："我先查到这里：目前有/没有明确记录，我继续后台补查。"
}

if (grounded_recall 返回 confidence=low 且无 facts) {
  回复格式：
  "CBrain 里暂时没有足够记录。

  我能看到的线索是：
  - ...

  如果你想，可以从这个问题重新开始沉淀。"
}

if (grounded_recall 调用失败) {
  fallback → deep_recall(grounded: false)
  仍然 brief，不要全量综述
}
```

### 回答规范

grounded recall 返回后，首轮回答必须：

```md
讨论过。简要结论（1句）。

已确认：事实1、事实2
你的观点：观点1
待确认：候选1

证据不足：...
```

**硬约束：**
- **不超过 300 字**：超过就删。宁可少说，不可多说
- 不输出工具名、不输出 JSON
- **禁止追问**：末尾不许"需要我展开吗/要继续吗/要我查吗"。说完就停
- 不展开全文（grounded 模式已做合成，直接基于 answer 字段）
- candidates 必须标注"可能 / 待确认"
- 不让用户知道工具细节（"我查了 CBrain" 可以，"调了 deep_recall" 不行）

## expand_entity 触发条件

只有以下 3 种情况才能调 expand_entity：
1. 用户明确说"展开/详细/原文/继续"
2. deep_recall 返回 insufficient 或 low confidence
3. 用户问单一实体档案细节

首轮内容回忆（"当时怎么设计/为什么选/具体方案"）禁止自动 expand_entity。

## 回答长度预算

| 模式 | 长度 | 格式 | 说明 |
|:-----|:-----|:-----|:-----|
| grounded | ≤ 300 字 | 1句结论 + facts/candidates | 说完就停，禁止追问 |
| 内容回忆首轮 | 300-500 字 | 固定模板（见下方） | 禁止长报告式分层 |
| 用户要求"详细" | 无限制 | - | 用户主动触发 |

### 内容回忆首轮模板（槽位式压缩，不是自由摘要）

⚠️ 必须优先填满 5 个槽位，不是自由发挥摘要：

```md
根据 CBrain 摘要记录，可以先还原到这个层级：

总判断：[槽位1：核心设计对象 — 这是什么方案，1句]

设计方向：
- [槽位2：架构/机制 — 三层架构/角色分工/流程机制等，禁止"AI嵌入流程"等纯泛化]
- [槽位2续：如有第二条]

为什么这样选：
- [槽位3：约束条件和决策理由]
- [槽位3续：如有第二条]

当时审查：
- [槽位4：从 memory_skeleton 结构词中提取 1-2 条审查结论，如"缺记忆系统""缺失败恢复""1个薄Harness+6个Skills而非6个独立Agent""确定性/概率性任务未分界"]

另有后续组织变化可能影响方案适用范围。
```

**结构词硬保留**：deep_recall 返回的以下类型词汇必须原样保留，不能删：
- 架构层级名称（如"三层架构"）
- 角色数量（如"6个虚拟经理"）
- 技术名词（如"数据安全""数据主权""Harness""Skills""记忆""失败恢复"）
- 设计约束（如"确定性/概率性"）
- 阶段标记（如"试点"）
只能删修饰语和次要细节。禁止用纯泛化表达（"AI嵌入流程""新型人机协作""管理提升"）替代具体机制。

总字数 350-500。禁止输出置信度/score/source id/chunk id/工具字段名。
用词规则：明确记录 → "记录显示"；用户想法 → "你当时认为/你当时审查指出"；不确定 → "待确认/可能"
隐私规则：验证文档中人名用"某人/Person A"替代，项目名用"某项目/Project X"替代，禁止输出真实姓名和具体 BU 名称

### 首轮禁止句式

```
❌ "需要看原文才能准确还原"
❌ "deep_recall 返回的是摘要级信息"
❌ "我需要看一下讨论稿原文"
❌ "要看原文吗？"
❌ "需要我展开吗？"
❌ "我可以继续查"
❌ "如果你愿意..."
❌ 任何暴露工具局限或追问用户的表达
```

## Proactive Hints 硬规则

- **grounded=true**：禁止展示任何 hint
- **普通 recall**：默认不展示。只有 hint 直接改变当前判断时写成一句"另有后续变化可能影响方案适用范围"，禁止展开日期、人名、组织名、BU名
- **禁止**：使用"💡 主动提示"标题、逐条列出 hints、展开 hint 细节（除非用户追问）

## 禁止模式

```
❌ query + get_page + get_links + get_timeline 连调 → deep_recall 一次搞定
❌ 总结类请求用 query → summarize
❌ 无 slug 直接调 expand_entity → 先 query/deep_recall/summarize 拿 slug
❌ deep_recall 连调多次 → 一次搞定，limit 调大
❌ 核查意图先调 query → 必须 deep_recall(grounded: true) 优先
❌ 内容回忆意图用 grounded → 禁止。"当时怎么设计的"→ deep_recall(detail: normal)
❌ 内容回忆首轮调 get_page / expand_entity / get_timeline — 硬门控：
   用户没说"展开/原文/详细" 且 recall没返回insufficient → 禁止
❌ 让用户等超过 20 秒无反馈 → 超时先回短句
❌ grounded recall 输出 proactive hints → 禁止
❌ grounded recall 后追 expand_entity/get_page → 证据板就是答案，禁止任何追加 CBrain 调用
❌ 把 candidate 当事实说 → 必须标注"待确认"
❌ 回答超过 500 字 → 删条目，不要压缩成密句
❌ 说"需要看原文才能准确还原" / "返回的是摘要级信息" → 基于当前摘要给出有限但稳定的回答
❌ 首轮追问用户"要看原文吗/需要我展开吗/我可以继续查" → 停在结论
❌ 使用"💡 主动提示"标题展示 hints → 禁止
❌ 逐条展开 proactive hints → 禁止。默认不展示，判断改变时压成一句
```

## 验收断言

对"当时怎么设计/为什么选那个方向"类问题，工具调用序列必须严格等于：
```
[deep_recall]
```
不允许出现 get_page / expand_entity / get_timeline / query / session_search。

## 工具能力速查

| 工具 | 返回内容 | 适用场景 |
|------|---------|---------|
| deep_recall(grounded) | 证据板（facts/candidates/conflicts/must_not_claim）+ 合成回答 | 回忆/核查/事实核查，**最高优先级** |
| deep_recall | body + links + timeline + tags + related + insights | 需要完整上下文 |
| summarize | 图遍历 + 结构化概览 + 可配置深度 | 需要全局鸟瞰 |
| dossier | 结构化档案（基本信息 + 关系 + 时间线 + 洞察） | 需要表格化档案 |
| brain_storm | LLM 推理 + 缺口分析 + 跨域关联 | 需要分析和推理 |
| graph_query | 关系遍历（traverse/backlinks/related） | 查两个人/公司关系 |
| list_insights | 系统自动生成的洞察列表 | 发现漏掉的关联 |
| read_discoveries | 跨域关联发现 | 深度发现 |
| get_timeline | 按时间排列的事件流 | 时间线回顾 |
| merge_pages | 合并结果预览 + 执行 | 合并重复页面（先 dryRun） |
| query | slug + title + snippet | 快速搜索，轻量（**最后手段，不是默认**） |
| expand_entity | 单实体的详细信息 | 追问已知实体 |
| recall_episode | 候选人列表 + 匹配线索 + 证据 + 诊断 | 情境找人：不记得名字，靠时间/主题/事件/关系线索召回候选人 |
