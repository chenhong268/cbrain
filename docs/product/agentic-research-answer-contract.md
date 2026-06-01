# Agentic Research — 回答契约验收标准

> 验收 #92 的 agentic_research 回答契约。防止 Hermes 把 trace/debug 字段倒给用户。

## 适用范围

用户提出复杂比较、盲区分析、跨主题关联、证据充分性等问题，Agent 调用 `agentic_research` 后的回答。

## PipelineResult 字段分级

### 可用（user-facing）

| 字段 | 用途 |
|:-----|:-----|
| `status` | ok / partial / insufficient / degraded |
| `answer_context.topClaims` | 核心事实（最多 10 条） |
| `answer_context.gaps` | 缺口/未覆盖角度（最多 5 条） |
| `answer_context.confidence` | high / medium / low |
| `answer_context.sourceSlugs` | 贡献实体（用人名，不输出 slug） |
| `evidence_board.facts` | 已验证证据 |
| `evidence_board.user_thoughts` | 用户之前的观点 |
| `evidence_board.candidates` | 未验证主张（标注"可能/待确认"） |
| `evidence_board.conflicts` | 矛盾点（必须显式呈现） |

### 禁止暴露（internal-only）

`plan`、`execution`、`critic`、`follow_up_execution`、`follow_up_critic`、`trace_summary`、`answer_context.intent`、预算字段、步骤列表、工具名、JSON 片段、slug ID、分数。

## UX Smoke Fixtures

### Fixture 1: comparison positive (status: ok)

**用户意图**：实体A和方案B的差异是什么，哪个更适合当前场景

**PipelineResult 状态**：`status: "ok"`, `confidence: "high"`, `topClaims` 有 5 条, `gaps` 有 1 条

**期望回答形态**：
- 开头 1-2 句判断（推荐哪个 + 一句理由）
- 2-4 条支持证据（来自 facts）
- 1 条缺口（来自 gaps）
- 总长 ≤ 400 字

**禁止出现**：
- "agentic_research 返回..." / "PipelineResult..." / "trace_summary..."
- slug ID 如 "entities/xxx"
- JSON 片段
- 分数数字如 "0.85"
- 末尾追问"需要我继续查吗"

**字段映射**：
- 判断 ← `answer_context.topClaims[0]` + `answer_context.confidence`
- 证据 ← `evidence_board.facts`
- 缺口 ← `answer_context.gaps[0]`

### Fixture 2: gap-analysis positive (status: ok)

**用户意图**：这个判断有什么盲区

**PipelineResult 状态**：`status: "ok"`, `confidence: "medium"`, `topClaims` 有 3 条, `gaps` 有 3 条, `user_thoughts` 有 1 条

**期望回答形态**：
- 开头 1 句总结（你的判断在 XX 方向有支撑）
- 列出 2-3 个盲区（来自 gaps）
- 附用户之前的观点（来自 user_thoughts，用"你之前认为"引出）
- 总长 ≤ 400 字

**禁止出现**：
- "critic 说 insufficient" / "执行了 2 个 pass"
- 步骤列表如 "Step 1: resolve, Step 2: search"
- `budgetUsed` 信息

### Fixture 3: cross-theme partial (status: partial)

**用户意图**：实体A、主题B和组织C之间有什么内在联系

**PipelineResult 状态**：`status: "partial"`, `confidence: "medium"`, `topClaims` 有 3 条, `candidates` 有 2 条, `gaps` 有 2 条, `followUpPerformed: true`

**期望回答形态**：
- 开头说"基于 CBrain 现有记录，可以确认以下联系"
- 已确认的联系（来自 facts）
- 待确认的联系标注"可能"（来自 candidates）
- 明确说"以下方面尚不确定"（来自 gaps）
- 总长 ≤ 600 字

**禁止出现**：
- "follow_up 执行了..." / "第二轮补充搜索..."
- "passCount: 2"
- `execution.status` / `critic.sufficient`

### Fixture 4: evidence-sufficiency positive (status: ok)

**用户意图**：这个结论依据够不够，有哪些证据和缺口

**PipelineResult 状态**：`status: "ok"`, `confidence: "high"`, `facts` 有 4 条, `conflicts` 有 1 条, `gaps` 有 1 条

**期望回答形态**：
- 开头说"依据基本充分，有 X 条证据支撑"
- 列出关键证据（来自 facts）
- 显式呈现矛盾点（来自 conflicts）
- 1 条缺口（来自 gaps）
- 总长 ≤ 400 字

**禁止出现**：
- 回避 conflicts（矛盾必须显式说）
- 把 candidate 当 fact 说

### Fixture 5: insufficient result (status: insufficient)

**用户意图**：帮我全面复盘事件E

**PipelineResult 状态**：`status: "insufficient"`, `confidence: "low"`, `topClaims` 为空, `gaps` 有 4 条

**期望回答形态**：
- 开头说"CBrain 目前没有足够证据回答这个问题"
- 列 2-3 个已搜索角度（来自 gaps，不暴露搜索步骤细节）
- 一句方向性建议（如"可以从XX角度开始补充记录"）
- 总长 ≤ 300 字

**禁止出现**：
- "planner 生成了 3 个步骤但全部 skipped"
- "executor 返回空 evidence board"
- 长篇分析（insufficient 就是不够，不要假装够了）

### Fixture 6: degraded result (status: degraded)

**用户意图**：组织D和组织E的方案取舍，各自优劣势对比

**PipelineResult 状态**：`status: "degraded"`, `confidence: "low"`, `topClaims` 有 2 条, `gaps` 有 3 条

**期望回答形态**：
- 开头给有限结果（来自 topClaims）
- 明确说"注意：本次搜索未完整执行，以上结论基于部分证据"
- 不过度声称
- 总长 ≤ 300 字

**禁止出现**：
- "budget exhausted" / "max_searches exceeded"
- "degraded 状态"
- 把有限结果包装成完整答案

## 验收断言

对 agentic_research 调用后的回答：

1. 不包含任何 internal-only 字段名（plan, execution, critic, trace_summary, budget, pass, step, slug, score）
2. candidates 有"可能/待确认"标注
3. conflicts 被显式呈现
4. 末尾无追问
5. 长度在对应 status 预算内
