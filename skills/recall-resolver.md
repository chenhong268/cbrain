# Recall Resolver — Tool 层路由表

> 意图 → MCP 工具。与 skill 层 RESOLVER.md 互补：那个决定加载哪个 skill 文件，这个决定调哪个 MCP 工具。
> **默认前门是 `cbrain_recall`**：自然语言回忆/核查/找人/层级/总结/关系/判断首选它，由 CBrain 内部分发到 grounded_recall / content_recall / episodic / hierarchy / overview / relationship / reasoning / debug_search。
> `deep_recall` 是 **advanced escape hatch**：仅当需要精细参数（`grounded` / `detail` / `limit`）或前门无法表达意图时直调，不是默认首选。
> 启动速查版：`hermes-cbrain-brief.md`（~1200 字，Agent 启动时优先加载）。

## 决策树

```
用户提问涉及 CBrain 知识
│
├─ 默认：先走 cbrain_recall 前门
│   自然语言回忆/核查/找人/层级/总结/关系/判断
│   → cbrain_recall({ query, detail: "brief" | "normal" | "full" })
│   cbrain_recall 内部分发：grounded_recall / content_recall / episodic
│     / hierarchy / overview / relationship / reasoning / debug_search
│   detail: brief=首轮短答, normal=标准, full=展开
│
├─ advanced escape hatch：需要精细参数时直调 deep_recall（非常规）
│   仅当 cbrain_recall 不足以表达意图，或明确需要精细参数时直调：
│   - 核查确认需 grounded 证据板 → advanced escape hatch：deep_recall({ query, grounded: true, limit: 3, detail: "brief" })（默认走 cbrain_recall）
│   - 内容回忆需 detail=normal 完整上下文 → advanced escape hatch：deep_recall({ query, detail: "normal", limit: 3 })（默认走 cbrain_recall）
│   ⚠️ 区分 grounded vs provenance：
│     "有依据吗/是不是真的/讨论过吗" → grounded（问有没有）
│     "依据从哪来/来源是什么/谁说的" → provenance（问来源），跳到下方 provenance 分支
│   → 答案是 yes/no 或 fact/candidate 分类，不需要全文
│   → 超时预算 20 秒，见下方「体验预算」
│   → 回答格式见下方「回答规范」
│   → 硬门控：if（用户没说"展开/原文/详细/继续" && recall没返回insufficient/low confidence）
│     { 禁止 get_page / expand_entity / get_timeline / query / session_search / 第二次 deep_recall }
│   → get_page 触发条件：用户说"展开/原文/详细" OR recall返回insufficient OR recall返回"未找到相关实体"
│
├─ 来源追踪（provenance）？
│   信号：这条信息哪来的、来源是什么、证据来源是什么
│         这个关系是谁说的、谁告诉你的、这条依据从哪来
│         这件事有证据吗、这个结论确认过吗
│         这条记忆可靠吗、可信吗、这个来源可靠吗
│   → 已知 target_id：get_provenance({ target_type, target_id })
│   → 未知 target，定位路径：
│     - 关系来源 → graph_query / link(action="list", ... )（debug 工具）拿 link_id → get_provenance({ target_type: "link", target_id })
│     - 事件来源 → get_timeline 拿到 timeline_id → get_provenance({ target_type: "timeline", target_id })
│     - 不确定指哪条 → cbrain_recall（advanced escape hatch：deep_recall / query 做上下文发现，找到相关 link/timeline 条目后拿 ID）
│   → 找不到具体 target：如实告知，禁止编造 provenance
│   ⚠️ 这是解释已有记忆的来源，不是搜索新内容
│   ⚠️ 不适用：普通内容回忆 → cbrain_recall(detail: "normal")
│   ⚠️ 不适用：核查确认 → cbrain_recall（内部 grounded_recall）
│   回答格式：来源分类（中文）+ 信任状态（中文）+ 证据摘要 + 纠正历史
│   禁止：输出 target_id、confidence、slug、JSON、工具名
│
├─ 情境找人（用户不记得人名，靠情境线索找人）？
│   强触发：那个人是谁、叫什么来着、想不起名字、忘了名字
│   条件触发：时间/地点/事件/场景/主题 + 见过/认识/遇到/一起做过 + 谁/那个人/人
│   关系事件组合：已知人物 + 共同事件/活动 + 忘名信号 + 找另外的人
│   ⎿示例：去年团建见过谁、上个月聚餐认识的那个、项目上线一起干的人、主题C相关的人
│   ⎿示例（关系事件）：想不起名字了和人物A一起旅行的另外几个人、忘了叫什么和人物A一起做项目的那个
│   ⚠️ 不适用（走 cbrain_recall 前门或 advanced 直调）：
│     用户提到具体人名（"人物A认识谁"）→ cbrain_recall（内部 relationship）/ graph_query
│     纯关系查询（"A和B什么关系"）→ cbrain_recall（内部 relationship）/ connect
│     已知组织查团队（"组织F团队的人"）→ cbrain_recall（内部 hierarchy）/ get_org_tree
│     已知人物+共同事件+问经历内容（"人物A和人物B一起做过什么"）→ cbrain_recall(detail:"normal")
│   → cbrain_recall（内部 recall_episode 分发）；advanced escape hatch 直调 recall_episode({
│       query: 原始问题,
│       time_hint: 提取时间线索（去年/上个月/2024年/...）,
│       topic_hint: 提取主题线索（前端/项目管理/...）,
│       context_hint: 提取场景线索（团建/聚餐/技术分享/...）,
│       event_hint: 提取事件线索（项目上线/团队聚餐/一起旅行/...）,
│       relation_hint: 提取关系线索（人物A的同事/和人物A一起/组织E的人/...）,
│       limit: 5
│     })
│   → 区别于 query（debug 工具）：用户不记得人名，靠情境信息找候选人
│   → 区别于内容回忆：这是候选人推荐，不是内容回忆
│   → 关系事件组合判定：已知人名出现在 relation_hint，不是查询目标
│   → 结果包含候选人列表、匹配线索、证据，不返回全文
│
├─ "关于X的一切"？
│   信号：回忆、详细了解、深入了解、怎么样、什么来头、关于X的上下文
│   → cbrain_recall（内部 overview/content 分发）
│   → 遇到 stub → expand_entity 补充
│
├─ "给我一个全景"？
│   信号：总结、概览、全面、全貌、梳理、overview、帮我理一下
│   → cbrain_recall（内部 overview 分发）
│   → advanced escape hatch：summarize（仅 full profile；当前门不足以表达深度时直调）
│   → 遇到 stub → expand_entity 补充
│
├─ "结构化档案"？
│   信号：完整档案、dossier、RAGmap、信息表、详细档案
│   → cbrain_recall（默认前门）
│   → advanced escape hatch：dossier（debug/internal profile 工具）
│   → 区别：review 是叙事式，dossier（debug/internal 工具）是结构化表格
│
├─ "帮我分析/推理"？
│   信号：分析、联想、知识缺口、cross-domain、背后逻辑、有什么联系
│   → cbrain_recall（内部 reasoning 分发）
│   → advanced escape hatch：brain_storm（debug/internal profile 工具）
│
├─ 复杂多步研究（EXPERIMENTAL）？
│   信号：A和B的差异/取舍/哪个更适合、我还遗漏了什么/盲区
│         A、B、C之间有什么内在联系、这个结论依据够不够
│         需要多步推理和交叉验证的复杂复盘
│   → cbrain_recall（默认前门）
│   → advanced escape hatch：agentic_research({ query, detail: "normal", known_slugs, intent_hint })（EXPERIMENTAL，debug/internal）
│   → 多步管道：规划 → 执行 → 评估 → (一次补充) → 结构化结果
│   → detail: brief=快速, normal=标准, full=深度
│   → ⚠️ 不适用场景（走 cbrain_recall 前门）：
│     单一实体查找 → cbrain_recall
│     精确关键词定位/debug → cbrain_recall（内部 debug_search）；直调 query 仅显式 debug/full profile
│     核查确认 → cbrain_recall（内部 grounded_recall）
│     情境找人 → cbrain_recall（内部 recall_episode）
│     内容回忆 → cbrain_recall(detail: "normal")
│     两人关系 → cbrain_recall（内部 relationship）/ graph_query / connect
│   → 回答契约见下方「agentic_research（EXPERIMENTAL）回答规范」
│
├─ "XX和YY什么关系"？
│   信号：什么关系、怎么认识的、有什么联系、之间
│   → cbrain_recall（内部 relationship 分发）；advanced escape hatch：graph_query(mode=traverse, depth=2)
│   → 深度分析 → connect skill
│
├─ "组织层级 / 汇报关系"？
│   信号：下属、上级、汇报线、谁向谁汇报、组织架构、
│         组织结构、团队有哪些人、直属、管谁、向谁汇报
│   → cbrain_recall（内部 hierarchy 分发）；advanced escape hatch：get_org_tree({ query: 种子实体名, direction: "both" })
│   → 多候选 → 让用户澄清
│   → 有结果 → 按层级呈现（树形/缩进列表）
│   → 无结果 → fallback cbrain_recall(detail:"normal")（advanced escape hatch：deep_recall(detail=normal)）
│   → 种子无法解析 → "无法确定你指的是哪个实体，能说得更具体一些吗？"
│   ⚠️ 层级查询直接走 cbrain_recall（内部 get_org_tree 分发）或直调 get_org_tree；禁止用 query / graph_query 手动拼层级
│   注意：两人关系（"A和B什么关系"）走上面的 connect 分支，不走这里
│
├─ "最近有什么发现"？
│   信号：有什么发现、漏掉的、关联没注意到、洞察
│   → read_discoveries
│   → 展示规则：只使用返回的 display、cards、summary
│   → 禁止暴露：score、distance、shared_neighbors、debug、_debug、
│     candidate、filter、图距离、跳、桥接、候选、过滤、hops
│   → 用户明确要求运行检测：说明需要 full profile；daily 不调 run_discovery，
│     也不以 read_discoveries 冒充新运行
│   → 如需标记已读：update_discovery_status
│
├─ Compounding Review（未来能力，暂不实现）
│   定义：CBrain 主动呈现基于累积记忆的结构化观察
│   条件：Evidence≥3 + Persistence≥2时间点 + Novelty + Action Value + Trust Risk 全达标
│   ⚠️ 不达标时必须沉默，不是降级呈现
│   ⚠️ 已拒绝的观察不重复提议
│   ⚠️ 社交情境内容需隐私审查，禁止主动建议联系某人
│   验收标准：docs/product/compounding-review-acceptance.md
│   评分维度：evidence / persistence / novelty / action_value / trust_risk
│   用户动作：accept / reject / defer / disable
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
├─ "导出/保存/分享结果"？
│   信号：导出、保存结果、分享、生成报告、存下来、HTML
│   → export_grounded_artifact({ result_json, title, ... })
│   ⚠️ 只在用户明确要求时调用
│   ⚠️ 社交/情境内容需要用户确认隐私审查（privacy_reviewed=true）
│   ⚠️ anonymize 仅隐藏来源标识；分享前仍需用户完成隐私审查
│
├─ "快速查找"？
│   信号：搜、找、有没有、查一下
│   ⚠️ 大部分"快速查找"是自然语言 → cbrain_recall({ query, detail: "brief", limit: 3 })（默认前门）
│   ⚠️ daily 精确关键词仍走 cbrain_recall（内部 debug_search）
│   → cbrain_recall（默认）；advanced escape hatch：deep_recall（精细参数）/ query（仅显式 debug/full profile）
│   → 降级链：cbrain_recall 空 → advanced escape hatch deep_recall → debug/full profile 可 query(缩减关键词) → 告知用户
│
├─ 追问某个具体实体？
│   信号：多说说、展开、细节、详细看这个
│   → expand_entity（追问已知实体，需先有 slug）
│
└─ 不确定
    → cbrain_recall（安全默认前门，不要退回 query）
```

### agentic_research 回答规范

`agentic_research` 返回 `PipelineResult`。Hermes 回答时必须基于 `answer_context` 和 `evidence_board`，禁止暴露内部字段。

**可用**：`status`、`answer_context.topClaims`、`answer_context.gaps`、`answer_context.confidence`、`answer_context.sourceSlugs`（用人名）、`evidence_board.facts`、`evidence_board.user_thoughts`、`evidence_board.candidates`（标注"可能"）、`evidence_board.conflicts`。

**禁止**：`plan`、`execution`、`critic`、`follow_up_*`、`trace_summary`、`intent`、预算字段、步骤列表、工具名、JSON、slug ID、分数。

**status 回答模板：**

```md
# ok（≤ 400 字）
[判断，1-2 句]
支持证据：
- 事实1
- 事实2
- 你的观点：...
（如有缺口 → 以下是尚未覆盖的角度：...）
```

```md
# partial（≤ 600 字）
[有支撑的判断，1-2 句]
已确认：事实1、事实2
待确认：候选1（可能）、候选2（可能）
不确定的部分：...
以下是尚未覆盖的角度：...
```

```md
# insufficient（≤ 300 字）
CBrain 目前证据不足以回答这个问题。
已搜索的角度：角度1、角度2、角度3
建议：[一句方向性建议，或"可以从XX开始沉淀"]
```

```md
# degraded（≤ 300 字）
[基于有限结果的判断]
注意：本次搜索未完整执行，以上结论基于部分证据。
```

**硬规则**：
- candidates 必须标注"可能/待确认"
- conflicts 必须显式呈现
- 禁止末尾追问（"需要我继续查吗"）
- 缺口不是失败，呈现为"尚未覆盖的角度"
- 不输出工具名、JSON、slug、分数

## 体验预算（Grounded Recall 专属）

| 阶段 | 时间 | 动作 |
|:---|:---|:---|
| 调用 cbrain_recall（grounded 分发）/ advanced escape hatch deep_recall | 0-20s | 等待返回 |
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
  fallback → advanced escape hatch deep_recall(grounded: false)
  仍然 brief，不要全量综述
}
```

### 前门未命中降级链

```
cbrain_recall / advanced escape hatch deep_recall 返回空结果（无相关实体/chunks）
│
├─ 第一步：显式 debug/full profile 才用 query(缩减关键词)
│   去掉修饰词，只留核心实体名
│   示例（debug 降级链）："组织A 主题B 活动C 日期D" → query("组织A")
│   示例（debug 降级链）："人物A在项目B的技术方案" → query("人物A")
│   每次缩减一级：去掉时间 → 去掉场景 → 只留核心实体
│
├─ 第二步：query 仍未命中
│   告知用户 CBrain 无记录（附诊断：搜了哪些关键词、扫了多少实体）
│   "CBrain 里没找到。我搜了 '组织A'、'组织A 主题B'，都没有匹配。"
│
└─ 禁止：
    ❌ 未命中后直接跳 web_search / session_search
    ❌ 不做 CBrain 内重试就放弃
    ❌ 用完整原句重试 query（必须缩减关键词）
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
- 不让用户知道工具细节（"我查了 CBrain" 可以，"调了 deep_recall/cbrain_recall" 不行）

## expand_entity 触发条件

只有以下 3 种情况才能调 expand_entity：
1. 用户明确说"展开/详细/原文/继续"
2. cbrain_recall / advanced escape hatch deep_recall 返回 insufficient 或 low confidence
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

**结构词硬保留**：cbrain_recall / advanced escape hatch deep_recall 返回的以下类型词汇必须原样保留，不能删：
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
❌ "返回的是摘要级信息"
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
- **代码执行**：`applyProactiveBudget` 限制最多 1 条。grounded 模式不生成 hints。

## 禁止模式

```
❌ query + get_page + get_links + get_timeline 连调 → cbrain_recall 一次搞定
❌ 连续多次 get_page → get_pages(slugs) 批量搞定
❌ get_org_tree 后逐个 get_page → get_pages 批量补摘要
❌ cbrain_recall 返回多实体后逐个 get_page → get_pages 批量补摘要
❌ 总结类请求用 query → cbrain_recall（内部 overview 分发）
❌ 无 slug 直接调 expand_entity → 先 cbrain_recall 拿 slug
❌ 绕过 cbrain_recall 前门直调 deep_recall 当默认 → cbrain_recall 是默认；deep_recall 仅 advanced escape hatch（精细参数时直调）
❌ 核查意图先调 query → 必须 cbrain_recall 优先（内部 grounded_recall）
❌ 内容回忆意图用 grounded → 禁止。"当时怎么设计的"→ cbrain_recall(detail: "normal")
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
❌ 前门未命中后直接跳 web_search/session_search → daily 停在 bounded fallback；显式 debug/full profile 才用 query(缩减关键词) 重试
❌ 简单实体查找用 agentic_research → cbrain_recall 一步搞定
❌ 核查确认用 agentic_research → 必须 cbrain_recall（内部 grounded_recall）
❌ 情境找人用 agentic_research → 必须 cbrain_recall（内部 recall_episode）
❌ 两人关系用 agentic_research → 必须 cbrain_recall（内部 relationship）/ graph_query / connect
❌ discovery 输出暴露 score/distance/shared_neighbors/debug → 只展示 display/cards/summary
❌ daily 会话调用 run_discovery，或用 read_discoveries 冒充新运行 → 明确说明需要 full profile
❌ read_discoveries 后暴露 _debug 字段 → 除非用户明确说 debug=true
❌ provenance 用于普通内容回忆 → provenance 只解释已有记忆来源，内容回忆走 cbrain_recall
❌ 找不到 target 时编造 provenance → 如实告知无法定位，禁止猜测
```

## 验收断言

对"当时怎么设计/为什么选那个方向"类问题，默认工具调用是：
```
[cbrain_recall]
```
（cbrain_recall 内部按 intent 分发到 content_recall / grounded_recall 等。）
仅当明确需要 deep_recall 精细参数（grounded 证据板 / detail=normal 完整上下文）这一 advanced escape hatch 场景时，序列才是 `[deep_recall(...)]`。
不允许出现 get_page / expand_entity / get_timeline / query / session_search。

## 工具能力速查

| 工具 | 返回内容 | 适用场景 |
|------|---------|---------|
| cbrain_recall | display/summary/raw（内部按 intent 分发 grounded/content/episodic/hierarchy/overview/relationship/reasoning） | **默认前门，最高优先级** — 自然语言回忆/核查/找人/层级/总结/关系/判断首选 |
| deep_recall(grounded)（advanced escape hatch） | 证据板（facts/candidates/conflicts/must_not_claim）+ 合成回答 | advanced：需 grounded 证据板时直调；默认走 cbrain_recall（内部 grounded_recall） |
| deep_recall（advanced escape hatch） | body + links + timeline + tags + related + insights | advanced：需完整上下文 / 精细 detail 参数时直调；默认走 cbrain_recall |
| agentic_research（debug/internal） | 多步管道：规划→执行→评估→(补充)→结构化结果 | EXPERIMENTAL，非默认；复杂比较/盲区分析/跨主题关联（默认走 cbrain_recall reasoning 分发） |
| summarize（full-only advanced escape hatch） | 图遍历 + 结构化概览 + 可配置深度 | 仅 full profile；默认走 cbrain_recall（overview 分发） |
| dossier（debug/internal） | 结构化档案（基本信息 + 关系 + 时间线 + 洞察） | debug/internal profile 工具；默认走 cbrain_recall |
| brain_storm（debug/internal） | LLM 推理 + 缺口分析 + 跨域关联 | debug/internal profile 工具；默认走 cbrain_recall（reasoning 分发） |
| graph_query | 关系遍历（traverse/backlinks/related） | 查两个人/公司关系（cbrain_recall relationship 分发的 advanced 直调） |
| get_org_tree | 组织层级树（向上/向下/双向） | 组织架构、下属、上级、汇报线 — 一次调用返回完整树（cbrain_recall hierarchy 分发的 advanced 直调） |
| insight(action="list") | 系统自动生成的洞察列表 | 发现漏掉的关联 |
| read_discoveries | 跨域关联发现（用户可读摘要） | 深度发现，只展示 display/cards/summary |
| get_timeline | 按时间排列的事件流 | 时间线回顾 |
| merge_pages | 合并结果预览 + 执行 | 合并重复页面（先 dryRun） |
| query | slug + title + snippet | **底层调试工具**。仅显式 debug/full profile 直调；daily 关键词定位走 cbrain_recall 内部 debug_search。 |
| expand_entity | 单实体的详细信息 | 追问已知实体 |
| get_pages | 批量页面摘要（slug+title+excerpt+tags） | cbrain_recall / get_org_tree 后批量补详情，**禁止连续 get_page** |
| recall_episode | 候选人列表 + 匹配线索 + 证据 + 诊断 | 情境找人：不记得名字，靠时间/主题/事件/关系线索召回候选人（cbrain_recall episodic 分发的 advanced 直调） |
| get_provenance | 来源分类 + 信任状态 + 证据 + 纠正历史 | 解释已有记忆的来源和可信度（需要 target_type + target_id） |
