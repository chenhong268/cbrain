# Agent Output Trust Boundary — Design

> 关联 issue: #327 `security(display): define a cross-tool untrusted-content boundary`
> 日期: 2026-07-11（**rev2**，按 Codex spec review 修正）
> 状态: **Draft — 待 Codex 二复审。未明确 APPROVE 前不进入 writing-plans 或实现。**
> 范围: **Phase 0 spec only。** 本文件不改任何运行时代码、测试、MCP schema、tool handler 或 formatter。

---

## 0. 立场（rev2 修正：CBrain 单边不解决 prompt injection）

rev1 把"text vs `structuredContent` 字段划分"当成 prompt-injection 隔离手段，**这是错的**。实测 Hermes（`~/.hermes/hermes-agent/tools/mcp_tool.py:3428-3439`，§3.2）：它把 `content`（text）与 `structuredContent` **都拼进同一段给模型的 JSON** —— `{"result": <text>, "structuredContent": <structured>}`。因此把 vault data 从 `content.text` 挪到 `structuredContent` **不会把它移出 Agent 上下文**，只是换了 JSON 字段名。

真正成立的三句话：

1. **CBrain 单边能确定做的**：在 structured 输出合同中实施 L1 deterministic guard（凭据/绝对路径永不输出；slug/id/internal/SQL 不进 `display`/`data`，仅在显式 opt-in 且脱敏后的 `audit` 中可见）+ raw 收缩（减少 internal 诊断字段进上下文的量）+ envelope 收口（可维护性/可观测性）。这些是"减少暴露面"和"可治理"，**不是 prompt-injection 安全边界**。迁移期 `legacy` 是保持 main 行为的显式例外，不得被描述为已满足该合同。
2. **CBrain 单边做不到的**：把 untrusted vault 文本与系统指令在模型上下文里真正隔离——这取决于 Hermes（host）如何投射 tool result，而 Hermes 当前是合并拼接，不分隔。
3. **真正的隔离需要 Hermes host-side contract**（跨 repo decision gate）：让 host 在拼进模型 JSON 前，对 trusted copy / untrusted data / audit 三类内容做结构标记或分隔渲染。CBrain 不得单边宣称完成。

本 spec 因此**降级目标**：从 rev1 的"建立跨工具 trust boundary"降为"**建立跨工具输出标注与暴露面收敛，并为未来 host-side 隔离铺路**"。后者仍是有价值、可验证、低风险的；前者在 Hermes 改造前不可宣称。

---

## 1. Problem

CBrain 的 MCP tool handler 把 `{ display, summary, raw }` 用 `JSON.stringify` 一次性塞进 `content: [{ type: "text" }]`：

- `display` 是中文自然语言文案，**直接拼接 vault-derived 文本**（实体标题、关系 context、timeline event summary、graph 节点 title、discovery card title）。
- `summary.message` 也常含 vault-derived 文本。
- `raw` 是完整 payload，含 `slug / id / score / distance / debug / trace / degraded_reason / reason_codes / latency_ms / _stub / source_page_slug / trust_state` 等 internal 诊断字段，**默认进入首轮响应**。
- 还有一批 tool 完全不经过 envelope，直接 `JSON.stringify` 任意 payload（jobs / insights / ops / search chunks / expand / knowledge / aliases）。

现有安全层主要拦内部字段、路径、凭据和少数危险模式，**无法用有限关键词判断任意自然语言是否会被 Agent 当指令**。#326 的对抗审查再次证明：为单个 formatter 追加同义词黑名单不可完备，且误杀正常标题。sanitizer 已分散成 4 套规则源，覆盖不一致。

**降级后的本 spec 目标**（可由 CBrain 单边达成、可验证）：(a) 统一 deterministic guard 单一来源；(b) 收缩 raw 默认暴露；(c) envelope 收口到单点 builder + 字段分类标注 + 稳定 schema；(d) 为 Hermes 未来 host-side 隔离提供结构化前提。**不在本 spec 解决**：模型上下文内 vault 文本与系统指令的真隔离（§3.2、§5.5 G1）。

## 2. 现状审计（Task 1）

### 2.1 序列化层：没有统一 envelope→text 收口

`src/mcp/register.ts` 只串联 36 个 `registerXxxTools`，**没有共享 result builder**。每个 tool handler 各自手写 `content: [{ type: "text", text: JSON.stringify({ display, summary, raw, ...legacy }, null, 2) }]`。后果：**无单点可插信任边界或统一标注**，任何策略都得改几十个调用点。这是结构性根因。

### 2.2 Sanitizer 四层分散（覆盖不一致）

| 层 | 位置 | 过滤内容 | 强度 | 用在哪 |
|:---|:---|:---|:---|:---|
| `sanitizeDisplay` | `format-result.ts:137` | slug path + 14 个内部术语 | 最弱 | 大多数 envelope 的 display |
| `DISPLAY_UNSAFE_PATTERNS` | `core/safety/display-safety.ts:8` | 凭据/绝对路径/slug/SQL/internal | 中（deterministic guard） | `sanitizeDisplayText`（非 throw）+ `assertSafeActionDisplay`（throw）；graph `safeGraphPathField`、action-candidate |
| `GRAPH_PATH_FIELD_UNSAFE_PATTERNS` | `format-result.ts:774` | 唯一尝试拦自然语言 injection（中英文指令/bidi/Cf/mixed-script） | 高（非完备） | **仅 graph path** |
| `isSlugLike` + 内联 fallback | `format-result.ts:1135` 等 | slug 形状启发式 | 弱、零散 | timeline title 等 |

**关键论断：** 唯一尝试拦自然语言 injection 的规则只覆盖 graph path 一个 surface。其余 surface 的 vault-derived display 文本只过最弱的 `sanitizeDisplay`，对自然语言指令式注入实质裸奔。

### 2.3 Surface 审计表（5 类优先 surface + legacy）

图例：`D`=display / `S`=summary.message / `R`=raw（默认随 text 返回）/ `L`=legacy top-level。

| Surface | tool / formatter | trusted 固定文案（D） | untrusted vault-derived 字段（行号） | 过的 sanitizer | internal 诊断字段（R） | 位置 | 默认 raw | 范围 |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| **graph path** | `formatGraphPathEnvelope` `format-result.ts:840` | depth/路径提示 | 节点 title（:921/:932）、relation label（:923） | `safeGraphPathTitle`+`GRAPH_PATH_FIELD_UNSAFE_PATTERNS`+`sanitizeDisplayText` | fromTitle/toTitle/reason/hops/maxDepth | D+S+R | 是 | Phase 1 |
| **graph query / links** | `formatGraphEnvelope` `:955` / `formatLinksEnvelope` `:1018` | "找到 N 条关系" | title（:982/:983/:1041）、`link.context`（:985/:1045）、relation | 仅 `sanitizeDisplay` | slug/trust_state/context | D+S+R | 是 | Phase 1 候选 |
| **recall** | `formatRecallEnvelope` `:289` / `formatGroundedRecallEnvelope` `:346` | "CBrain 里有 N 条相关记忆" | topNames/title（:312-316）、query、grounded facts | 仅 `sanitizeDisplay` | score/distance/_stub/degraded_reason/latency_ms | D+S+R | 视路径（#231） | Phase 2 |
| **timeline** | `formatTimelineEnvelope` `:1083` | "X 的时间线（N 个事件）" | `event.summary`（:1113）、title（:1089） | 仅 `sanitizeDisplay`+`isSlugLike` | id/date/source/source_category/trust_state/source_page_slug/evidence | D+S+R | 是 | Phase 1 |
| **discovery** | `formatDiscoveriesEnvelope` `format-result.ts:661` + `core/maintenance/discovery-digest.ts:128` | 模板标题（"潜在关联：X 与 Y" `:140`） | card title 内 `resolveTitle` | `safeTitle`→`DISPLAY_UNSAFE_PATTERNS` | slug/filter_reasons/type/eventDate | D+S+R | 是 | Phase 3 |
| **action-candidate** | `action-candidates.ts:74` + `core/maintenance/action-candidates.ts:304` | fallback 文案 | `displayTitle`/`displayReason`（持久化 UNTRUSTED meta） | core `safeDisplayText`；MCP 层 `String(meta.display_title)`（:41，未再过 sanitize） | slug/score/weight/reason_codes | D+S+R | 视路径 | Phase 3 |
| **legacy JSON-only** | pages aliases（`pages.ts:133/:392/:405`）、jobs、insights、ops、search chunks（`search.ts:195`）、expand、knowledge、compounding-review | 无固定文案 | **整个 payload 直接 stringify**（含 vault body/chunk/slug/score） | 无 | 全部裸露 | L | 是 | Phase 4 |

**审计 surface 数量：** 5 类优先（graph/recall/timeline/discovery/action-candidate，约 12 个 formatter）+ 1 类 legacy JSON-only（~8 个文件、50+ 序列化点）。

### 2.4 raw 默认泄漏清单

默认带 raw 的序列化点：`search.ts:182`（query）、`pages.ts:110/:118/:371/:609`、`versions.ts:18/:34`、`recall.ts:238/:257/:284/:546`、`discoveries.ts:190/:306`、`action-candidates.ts:135`、`ops.ts`/`knowledge-map.ts:46`/`project-state.ts:24`。

**正面先例（已 compact-by-default，默认无 raw）：** `recall.ts:246/:265/:294/:555`（#231）、`action-candidates.ts:155`、`discoveries.ts:382`。#231 是已验证的 raw 收缩合同，recall 域必须沿用。

### 2.5 graph / timeline 当前**没有** raw opt-in 入参（HIGH 2 证据）

读 `src/mcp/tools/graph.ts:82-91` 与 `src/mcp/tools/timeline.ts:102-108` 的 inputSchema：

- graph_query：`slug/mode/target/depth/limit/minWeight/source_type/session_id` — **无 `include_raw`、无 `debug`**。
- timeline / get_timeline：`action/slug/summary/eventDate/source` — **无 `include_raw`、无 `debug`**。

但二者的 envelope **默认带 raw 进 text**：`graph.ts:22/121/178`、`timeline.ts:50`（envelope 的 `raw` 字段含 slug/id/source_page_slug/evidence 等）。

**结论：** graph/timeline 当前"raw 默认在 text、且无参数可关"。任何"默认隐藏 raw + 可显式获取 + 老客户端不变 + 字段移入 data"四条同时成立的写法都是假的（HIGH 2）。修正见 §5.2、§6。

### 2.6 现有测试依赖 `JSON.parse(content[0].text).raw`（HIGH 2 证据）

- `tests/release/frontdoor-dialogue-gate.test.ts:166/169` —— `JSON.parse(result.content[0].text)` 后断言 `data.raw.routing.chosen_route`。
- `tests/mcp/recall-evidence.test.ts:87/94` —— `JSON.parse(result.content[0].text)` 后断言 `data.raw.evidence_pack`。
- `tests/core/knowledge-map-report.test.ts:186` —— `expect(def.raw).toBeUndefined()`（依赖 raw 字段存在性）。

**结论：** "JSON.parse 行为不变"是不真实表述。移 raw 或改字段名会破这些测试。**graph/timeline 是否有同类测试依赖，需在 Phase 1 开工前 grep 核实**（属 recall/frontdoor 的已确认，graph/timeline 待确认）。

---

## 3. MCP 能力核实 + Hermes 实测（Task 2）

### 3.1 SDK 1.29.0 能力（只读证据）

| 结论 | 证据（文件:行） |
|:---|:---|
| `CallToolResult.content` **required**，`ContentBlock[]` | `node_modules/.../spec.types.d.ts:1039` |
| `CallToolResult.structuredContent` **optional**，`{ [key:string]: unknown }` | `spec.types.d.ts:1739` |
| `Tool.outputSchema` optional，描述 structuredContent 形状；root 限 `type:"object"` | `spec.types.d.ts:1195-1208` |
| content 与 structuredContent **并存**（非互斥） | 同接口 |
| `outputSchema` 本项目**当前未使用** | `src/mcp/register.ts` + 各 tool |

**关键约束：** `content` required、`structuredContent` optional → 不能只返回 structuredContent 而省略 content。

### 3.2 Hermes 实测（G1 答案 — MEDIUM 1 核实，不再是"未知"）

读 `~/.hermes/hermes-agent/tools/mcp_tool.py:3392-3440`（Hermes 用官方 `mcp.ClientSession`，CBrain 走这条普通 tool 路径）：

```python
result = await server.session.call_tool(tool_name, arguments=args)
parts = [block.text for block in (result.content or []) if hasattr(block, "text")]
text_result = "\n".join(parts)
structured = getattr(result, "structuredContent", None)
if structured is not None:
    return json.dumps({"result": text_result, "structuredContent": structured}, ensure_ascii=False)
return json.dumps({"result": text_result}, ensure_ascii=False)
```

**结论（确定）：**
- Hermes **同时消费** `content` 与 `structuredContent`，拼成**同一段 JSON** 进 Agent 模型上下文。注释自述（:3429-3431）"content is the primary payload; structuredContent supplements it"。
- 唯一例外是 `computer_use`（`cua_backend.py:846` 专门提取 `structuredContent.elements`），与 CBrain 无关。

**推论（推翻 rev1 的 A/B 终态假设）：**
- 把 untrusted data 从 `content.text` 移到 `structuredContent`，**对 Hermes 不产生隔离效果**——模型上下文仍含 data，只是字段名不同。
- 因此 **A 终态（data 移出 text 进 structuredContent）在 Hermes 未改造前无安全意义**；B 形态（data 留 text）与 A 形态在"是否隔离"上**等价（都不隔离）**。
- **G1 由"未知"变为已答**：Hermes 当前不提供 text/structuredContent 隔离；要隔离必须改 Hermes（跨 repo gate，§5.5 G1）。

> **不需要 Phase 0.5 capability probe**：已直接读 Hermes 源码确定普通 tool 路径的投射行为（`mcp_tool.py:3392-3440`）。probe 仅在 Hermes 升级后、或为锁定行为加回归测试时才需要。

### 3.3 transport

`structuredContent` 是 `CallToolResult` 协议字段，与 transport 无关。stdio 与 HTTP（`src/http/`）走同一 `registerAllTools`（`register.ts:39`）。HTTP server 若自行 stringify 需同步走统一 builder（Phase 4 核实）。

---

## 4. 三方案比较（Task 3，rev2 降级 A 宣称）

### 方案 A — 结构化标注（**不再是"协议层硬隔离"**）

`content[0].text` 放固定 trusted 文案 + 结构化分栏；`structuredContent` 放 `{summary, data, audit}`。**rev2 修正：** 据 §3.2，Hermes 把 content 与 structuredContent 都拼进模型 JSON，所以 A 在 Hermes 改造前**只是"标注"，不是"隔离"**。它的真实价值：给未来 host-side 隔离提供结构前提 + 给非 Hermes consumer（如直接读 structuredContent 的脚本）结构化数据。

### 方案 B — 兼容 envelope（迁移载体）

保留 `content: text JSON` 协议，引入统一 builder 收口，分栏 `{display(trusted), summary, data(untrusted), audit(opt-in raw)}`。**rev2 定位：** B 是"可维护性 + raw 收缩 + 字段分类标注"的载体，**不是安全边界**。

### 方案 C — deterministic guard（底座）

`DISPLAY_UNSAFE_PATTERNS` 作 L1 单一来源（凭据/绝对路径/slug/internal/SQL）。**rev2 强调：** 这是 CBrain 单边**唯一能确定阻止**的层；它不防自然语言 injection。在 structured 合同中，凭据/绝对路径被完全剥离，slug/internal 只允许进入显式 redacted audit。

### 六维比较（rev2）

| 维度 | A 结构化标注 | B 兼容 envelope | C deterministic guard |
|:---|:---|:---|:---|
| 模型上下文内 data/instructions 分离 | ❌ Hermes 合并拼接，不隔离（§3.2） | ❌ 同 | ❌ 同 |
| 减少 raw/internal 暴露面 | ✅ raw opt-out | ✅ raw opt-in | ✅ 凭据/路径/internal |
| 可维护性/可治理 | ✅ 单点 builder + schema | ✅ 单点 builder | ✅ 单一规则源 |
| Hermes 可用性 | ✅ 不破 | ✅ 不破 | ✅ 不破 |
| 迁移成本 | 高 | 中 | 低 |
| 测试可验证性 | ✅ 可断言"raw 不在输出" | ✅ | ✅ 可断言 guard 命中 |

### 推荐（rev2）

**C 为底座 + B 为载体，A 仅作标注、不宣称隔离。** sanitizer consolidation（C 的规则源合并）**独立为后续 bounded issue，不进 Phase 1 pilot**（MEDIUM 3）。Phase 1 只做：B 的 builder 收口 + raw opt-in + display 固定化 + schema 稳定化。**A 的"标注"形态可作为 builder 的输出附加 structuredContent，但其安全意义等 Hermes 改造后才兑现（G1）。**

---

## 5. 迁移路线（Task 4，rev2）

### 5.1 Threat Model 与全局不变量

**三层威胁区分（不混淆）：**

| 层 | 威胁 | 应对 | 能否"消除/隔离" |
|:---|:---|:---|:---|
| **L1 可确定性阻止** | 凭据、绝对路径、slug、internal 字段、SQL | `DISPLAY_UNSAFE_PATTERNS` deterministic guard + audit redaction | ✅ 凭据/绝对路径永不输出；slug/internal 不进 display/data，仅可进显式脱敏 audit |
| **L2 可结构化标注** | vault-derived untrusted 文本与系统文案混写 | B/A 的 `display`(trusted) vs `data`(untrusted) 分栏 | ⚠️ **仅标注，不隔离**（§3.2 Hermes 合并拼接） |
| **L3 不能虚假承诺** | 自然语言 prompt injection | L1+L2 raising-the-bar + 等 Hermes host-side contract | ❌ CBrain 单边不能；需跨 repo gate |

**Host-side contract（跨 repo，HIGH 3 修正要求 3）：** 真正的 L2 隔离需 Hermes 在 `mcp_tool.py` 拼进模型 JSON 前，对三类内容做区分渲染：
- **trusted copy**（CBrain `display`）：可直接进模型上下文。
- **untrusted data**（CBrain `data`：vault title/summary/context）：host 应标记/分隔（如包进明确的"data block"标签或降权渲染），不与 tool instructions 混写。
- **audit**（CBrain `audit`：raw/internal）：host 应默认不投射进模型上下文，仅 debug/日志可见。

此 contract 是 **跨 repo decision gate（G1）**，CBrain 不得单边实施或宣称。

**structured 输出不变量（所有迁移 Phase 共享）：** 下列约束适用于 `CBRAIN_OUTPUT_BOUNDARY=structured`。迁移期 `legacy` 为逐字兼容 main 的显式例外，只用于灰度/回滚；在切换 rollout 默认前，不能宣称系统默认已经满足这些不变量。

1. `content[0].text` 始终存在（`content` required，§3.1）。**不宣称其"只含可信文案"**——B 形态下它含 `data`（untrusted），只是 `display` 部分为固定文案。
2. **structured 模式内** `include_raw` 默认 `false`，首轮响应不带 raw（与 #231 对齐）；只有显式 `include_raw`/`debug` 才生成经过凭据/绝对路径脱敏的 `audit`。系统 rollout 默认仍是 `legacy`（§5.2），两种默认不得混称。
3. `DISPLAY_UNSAFE_PATTERNS` 是 L1 deterministic guard **唯一来源**；不新增并列词表。
4. 正常匿名标题（`实体A` / `主题D` / `ProjectAlphaSentinel` / `PathLabelSentinel`）保持可读，不被匿名化（L2 标注 ≠ 全匿名）。
5. safety failure **按字段类别处理**（MEDIUM 2，见 §7.3），**不用"空 data"作统一 fallback**——deterministic guard 只约束 trusted display 与凭据/路径外泄；untrusted data 命中 guard 时按字段类别保留/脱敏/进 audit，保留合法证据。
6. 不新增 LLM 调用；不改写入/search/ranking/ontology/graph 算法语义。
7. 公开 fixture 全匿名（实体A/B/组织C/主题D 等合成 sentinel）。

### 5.2 Phase 1 — pilot：graph path + graph query + timeline

**目标（降级、可验证）：** envelope 收口到单点 builder + 新增 `include_raw` opt-in + display 固定化 + `schema_version` 稳定合同。**不宣称建立 prompt-injection 安全边界**（§3.2）。

**为什么是这个组合：** graph path 已有最严 sanitizer（迁移它收敛重复规则源风险最低）；timeline 的 `event.summary`（`format-result.ts:1113`）是 vault 自由文本进 display 的典型（验证 builder 对自由文本的处理）。两者覆盖"标题类"与"自由文本类"。

**输入变化（HIGH 2 修正要求 1，精确）：** graph_query 与 timeline/get_timeline **新增可选参数 `include_raw?: boolean`（default `false`）**。这是**公开 schema 变化 = decision gate G2**。

**三种输出 shape（HIGH 2 修正要求 2，精确）：**

```ts
// (a) legacy shape（main 现状；迁移期开关默认与 rollback 仍可产出）
text: JSON.stringify({ display, summary, raw: <full payload> })

// (b) structured 模式 default shape（include_raw 省略 / =false）
text: JSON.stringify({
  schema_version: 1,
  display: "找到一条 3 跳关系路径。",     // graph — 固定文案
  summary: { /* ToolSummary */ },
  data: { from: "实体A", to: "实体B", hops: [/* untrusted titles/summaries */] },
  // timeline.data: { title:"主题D", events:[{date, summary}] }
  // raw 不出现
})
structuredContent: { schema_version: 1, summary, data }   // 镜像，标注用（§3.2 不隔离）

// (c) pilot include_raw=true shape —— audit 显式获取
text: JSON.stringify({
  schema_version: 1, display, summary, data,
  audit: { raw: <redacted audit payload> }, // 凭据/绝对路径已剥离
})
structuredContent: { schema_version: 1, summary, data, audit: { raw } }
```

**`include_raw=true` 在 old/new client 的访问（HIGH 2 修正要求 3）：** old client `JSON.parse(text).audit.raw`；new client `structuredContent.audit.raw`。两者读取的都是 **redacted audit payload**，不是原始完整 payload：凭据/绝对路径永不输出，slug/id/internal/debug 仅在该 opt-in audit 中可见。**注意：** §3.2 下 old/new 对 Hermes 无区别（都拼进模型 JSON）；此处的 old/new 仅指"是否额外读 structuredContent 字段"的 consumer 习惯。

**兼容策略（HIGH 2 修正要求 4）：** 删除 rev1 "JSON.parse 行为不变"表述。真实变化：(i) 新增 `include_raw` 参数（向后兼容，老调用不传）；(ii) **default 不再返回 raw**（老调用原本能 `JSON.parse(text).raw` 拿到，现在拿不到——这是 breaking，但 raw 是 internal 诊断字段，正是 #327 要收缩的，gate G2）；(iii) 新增 `schema_version`/`data`/`audit` 字段名。需在 Phase 1 开工前 grep 确认 graph/timeline **无测试依赖** `text.raw`（recall/frontdoor 的依赖属 Phase 2，已确认存在）。

**feature flag 与两种 default（不得混称）：** 系统 rollout 默认是 `CBRAIN_OUTPUT_BOUNDARY=legacy`，因此未显式开启时仍维持现行 shape 与现行 raw 行为；只有显式设置 `structured` 才走 builder。在 **structured 模式内部**，`include_raw` 默认 `false`。双写期仅 Phase 1，验证并通过 G2 后 Phase 2 才把 rollout 默认切到 `structured`。

**rollback：** 单 commit。revert + env 回 `legacy` = 回到 main 行为。Phase 1 必须保证 `legacy` 模式输出与 main 逐字一致。代价是 legacy 不满足 structured 的凭据/路径/audit 收敛合同，因此只能作为有时限的灰度与回滚通道，不能当作安全完成态。

**Pilot outputSchema（MEDIUM 4）：** graph_query 与 get_timeline 的 `structuredContent` 各定义一份 `outputSchema`（JSON Schema 2020-12，root object）。公共 envelope：`{ schema_version: 1, summary: ToolSummary, data, audit? }`，`audit` 仅 `include_raw=true` 出现，且 `audit.raw` 必须是凭据/绝对路径已剥离的 redacted audit payload。两个 pilot 的 `data` 完整定义（字段对照 `format-result.ts` 现有 payload 类型，体现 display 字段进 `data` / internal 诊断字段进 `audit.raw` 的拆分）：

- **graph_query.data**（映射 `GraphPathEnvelopePayload`）：shortest_path 模式 `{ from: string, to: string, hops: Array<{ title: string, relation: string }> }`；traverse/backlinks/related 模式 `{ links: Array<{ title: string, relation: string, context?: string }> }`。`title`/`context` = untrusted vault-derived；`slug`/`trust_state`/`maxDepth`/`reason` 等留 `audit.raw`。
- **get_timeline.data**（映射 `TimelinePayload`）：`{ title: string, events: Array<{ date?: string, summary: string, source?: string }> }`。`summary` = untrusted vault-derived 自由文本；`id`/`source_category`/`trust_state`/`source_page_slug`/`evidence` 等留 `audit.raw`。

SDK 据各 outputSchema 校验 structuredContent 形状；`schema_version` 演进靠 bump，old consumer 读 `legacy` 模式 fallback（§5.2 feature flag）。

**Phase 1 不变量验收（HIGH 1 修正要求 4，与 shape 一致）：**
- structured/default shape：`text` 含 `schema_version/display/summary/data`，**不含 raw**（断言）。
- structured/include_raw=true shape：`text.audit.raw` 存在，凭据/绝对路径已剥离，slug/id/internal 仅在此处可见。
- `legacy` 模式：`text` 与 main 逐字一致（断言）。
- **不断言"text 不含 untrusted 字段"**（B 形态下 data 在 text，这是标注不是隔离——HIGH 1）。

### 5.3 Sanitizer consolidation — 移出 Phase 1（MEDIUM 3）

`sanitizeDisplay`（14 术语）、`DISPLAY_UNSAFE_PATTERNS`、graph title guard 调用语义不同，全局合并会改多个 surface、可能再次误杀正常标题。**结论：**
- sanitizer consolidation **独立为后续 bounded issue**，不进 Phase 1 pilot，不与 pilot 同一 rollback commit。
- Phase 1 builder 可**引入 adapter 调用现有 sanitizer**（不改 sanitizer 本身），实现收口。
- 每条规则迁移（未来 issue）必须有正/负对抗测试（§7）。

### 5.4 Phase 2 — recall（含 search query）

沿用 #231 compact/include_raw 合同（不得改可见性与字段集），只把 compact 输出切到 builder（带 `schema_version`）。`query`（`search.ts:182`）默认带 raw → 与 recall 对齐改 default 不带 raw（gate G3）。recall include_raw 路径（`recall.ts:238/:257/:284/:546`）raw 移入 `audit`。**recall/frontdoor 测试依赖 `text.raw`（§2.6）→ Phase 2 必须同步改测试断言到 `audit.raw`，gate G3 含此测试合同变更。**

### 5.5 Phase 3 — discovery + action-candidate

candidates 已半结构化（`discoveries.ts:382`、`action-candidates.ts:155`）。收口 display 到 builder + `schema_version`。修复 action-candidate MCP 层 `String(meta.display_title)` 未过 sanitize 的 gap（统一到 builder adapter）。`assertSafeActionDisplay` hard guard 保留。

### 5.6 Phase 4 — legacy JSON-only tools + consistency gate

pages aliases / jobs / insights / ops / search chunks / expand / knowledge / compounding-review 收口到 builder。引入 CI consistency gate：grep 断言 `src/mcp/tools` 下无绕过 builder 的裸 `text: JSON.stringify`（白名单仅 builder + error envelope）。HTTP server 自行 stringify 处同步走 builder（核实）。

### 5.7 Decision Gates（HIGH 2/3 + MEDIUM，禁止自行实施）

| Gate | 决策内容 | 默认推荐 | 为什么是 gate |
|:---|:---|:---|:---|
| **G1** | **Hermes host-side contract**（HIGH 3）：是否改 `mcp_tool.py` 按 trusted copy / untrusted data / audit 三类区分渲染？§3.2 已答 Hermes 当前合并拼接、不隔离。 | CBrain 侧先做标注（B 形态 + structuredContent 镜像）；host 改造由 Hermes repo 决定 | CBrain 单边不得宣称完成隔离；跨 repo |
| **G2** | Phase 1 graph/timeline 新增 `include_raw`（default false）+ default 不返回 raw | 接受（raw 是 internal，#327 目标即收缩） | 公开 schema 变化 + 老调用 `text.raw` 行为变化（breaking） |
| **G3** | Phase 2 recall/query 默认收缩 raw + 同步改 recall/frontdoor 测试 `text.raw`→`audit.raw` | 接受（#231 先例） | 公开行为 + 测试合同变化 |
| **G4** | Phase 3 discovery/action envelope 统一 | 接受 | envelope shape 变化 |
| **G5** | Phase 4 legacy 裸 payload → envelope | 接受但分子 commit | legacy tool 输出形状变化 |

未批前对应 Phase 不开工。

---

## 6. Compatibility truth table（HIGH 1 修正要求 3 + HIGH 2 修正要求 5）

以 graph_query 为例（timeline 同构）。**关键诚实点：** §3.2 下 Hermes 把 `text` 与 `structuredContent` 都拼进模型 JSON，故"consumer 看到"对 Hermes 而言是并集；下表 old/new 仅区分"是否额外读 structuredContent 字段"。

| CBrain 输出模式 | `content[0].text` | `structuredContent` | Hermes 投射进模型上下文 | raw 是否进上下文 |
|:---|:---|:---|:---|:---|
| **legacy（main 现状、rollout 默认）** | `{display,summary,raw,...}` | 无 | display+summary+raw+legacy | ✅ 是；不满足 structured redaction 合同 |
| **structured 模式 default**（include_raw 省略/false） | `{schema_version,display,summary,data}` | `{schema_version,summary,data}`（镜像） | display+summary+data（text 与 structuredContent 并集） | ❌ 否 |
| **structured 模式 include_raw=true** | `{schema_version,display,summary,data,audit:{raw}}` | `{schema_version,summary,data,audit:{raw}}` | + redacted audit.raw | ✅ 是（opt-in，凭据/绝对路径已剥离） |

读法：
- **rollout default**：Phase 1 未设环境变量时仍走 legacy；表中的 structured/default 只描述显式开启 structured 后的 `include_raw=false` 行为。
- **old consumer（只 `JSON.parse(text)`）**：legacy 拿到 `raw`；structured/default 拿不到 raw（G2 breaking）；include_raw=true 从 `text.audit.raw` 拿到 redacted audit payload。
- **new consumer（读 structuredContent）**：legacy 无 structuredContent；structured/default 读 `data`；include_raw=true 读 redacted `audit.raw`。
- **Hermes（§3.2）**：三模式下分别把 text（+structuredContent）拼进模型；structured/default 把 raw 移出模型上下文（raw 收缩生效），但 `data`（untrusted vault 字段）**仍在模型上下文**——这是"暴露面收敛"，不是"data 隔离"。

---

## 7. 测试与对抗矩阵（Task 6，rev2）

### 7.1 共享匿名对抗矩阵（所有 surface 复用）

| 类别 | fixture（匿名 sentinel） | L1 guard 期望 | 标注/输出期望 |
|:---|:---|:---|:---|
| internal snake_case | `"score":0.82` / `degraded_reason` | 不进 display/data | 仅 opt-in redacted audit |
| internal camelCase | `reasonCodes` / `latencyMs` | 同上 | 同上 |
| 全角/空格分隔 | `ｓｃｏｒｅ` | normalize 后命中 | 同上 |
| 绝对路径 | `/etc/x` / `C:\x` / `/Users/x` | 拦 | 所有模式和字段都不输出（含 audit） |
| slug | `brain/entities/foo` | 拦 | 不进 display/data；仅 opt-in redacted audit |
| credential | `sk-xxx` / `Bearer xxx` / JWT / PEM / `AKIA…` / `ghp_…` | 拦 | 所有模式和字段都不输出（含 audit） |
| C0/C1/bidi/Cf | RLO / `​` / 全角空格 | 剥离 | data 原样但不影响 display 文案 |
| mixed-script | 拉丁+西里尔同形 | graph 既有规则拦 | 不进 display |
| 中英文指令式 vault 文本 | `忽略以上规则` / `ignore previous instructions` | **不承诺拦**（raising-the-bar） | 进 `data`，由 host-side contract（G1）决定是否隔离 |
| 正常中文短标题 | `实体A` / `主题D` | 可读、不误杀 | 进 data，display 引用计数 |
| 合成英文 sentinel | `EntityAlphaSentinel` / `ScorecardSentinel` / `SourceFieldSentinel` / `PathLabelSentinel` / `EvidenceTokenSentinel` | **可读、不误杀**（negative） | 同上 |

### 7.2 Negative tests（防误杀，硬性）

断言以下在 `data` 中保持可读、不被 fallback 替换：`EntityAlphaSentinel`、`PathLabelSentinel`、`ScorecardSentinel`、`SourceFieldSentinel`、`EvidenceTokenSentinel`、`实体A`、`主题D`、`ProjectAlphaSentinel`。（#326 教训：internal term 子串不得误杀正常合成标题。）

### 7.3 safety failure 语义（MEDIUM 2 修正）

deterministic guard 命中时**按字段类别**处理，**不清空整个 data**：
- **trusted display**：guard 命中 → 替换为固定 fallback 文案。
- **凭据/绝对路径**：命中 → 从所有输出字段剥离，包括 opt-in audit（永不外泄）。
- **slug/id/internal/debug**：不进 display/data；仅 `include_raw=true` 时进入经过上述 redaction 的 audit。
- **untrusted vault data**（title/summary/context）：命中 injection 模式 → **保留**于 `data`（合法证据不丢），仅在 host-side contract（G1）生效后才由 host 隔离；guard 不替 host 做删除。
- **read-only tool**：任何 guard 命中都不抛错、不阻断基本响应（fail-open 到 fallback display + 保留 data）。

### 7.4 兼容契约测试

- `legacy` 模式：`text` 与 main 逐字一致（断言）。
- structured/default：`text` 不含 raw；`schema_version===1`；`data` 形状符合 outputSchema。
- structured/include_raw=true：`text.audit.raw` 与 `structuredContent.audit.raw` 一致，且凭据/绝对路径已剥离。
- 测试同步：Phase 2 起把 `text.raw` 断言改为 `audit.raw`（§2.6 列出的依赖）。

---

## 8. Spec 自审（对齐 Codex 9 项复审门槛）

1. **Phase 1 shape / 不变量 / 测试三者无矛盾？** ✅ §5.2 明确区分 rollout 默认 legacy 与 structured 模式内 `include_raw=false`；structured 验收断言不含 raw，legacy 只断言逐字兼容且明确不满足 structured redaction 合同。**不断言"text 不含 untrusted"**（B 形态 data 在 text，是标注非隔离）。shape（§5.2）、truth table（§6）、测试（§7.4）一致。
2. **不再把字段分栏夸大为 prompt injection 硬隔离？** ✅ §0/§3.2/§4/§5.1 反复：Hermes 合并拼接，字段分栏仅标注；L2 隔离依赖 G1 host-side contract。
3. **G1 有可执行的 probe？** ✅ §3.2 已直接读 `mcp_tool.py:3392-3440` 给确定答案（不需 probe；Hermes 升级后可加回归测试锁定）。
4. **graph/timeline raw opt-in 路径完整？** ✅ §5.2 新增 `include_raw`（G2）+ 三种 shape + §6 truth table。
5. **compatibility truth table 覆盖 old/new consumer？** ✅ §6。
6. **pilot schema 有版本和 outputSchema 策略？** ✅ §5.2 `schema_version:1` + graph/timeline 各一份 outputSchema；演进靠 schema_version bump + old consumer 读 legacy 模式。
7. **sanitizer consolidation 移出 pilot 或缩为 adapter？** ✅ §5.3 独立 bounded issue；Phase 1 仅 adapter 不删旧规则。
8. **全文匿名隐私扫描通过？** ✅ 全文只用 `实体A/实体B/主题D` 与 `ScorecardSentinel/SourceFieldSentinel` 等合成 sentinel；无真实人名、公司名、产品名或用户知识内容。
9. **仍保持 spec-only 单 commit、不进 writing-plans？** ✅ 本次为 docs amend，不动运行时代码/测试/schema/handler/formatter。

---

## 9. 非目标

- 不写实现代码（本文件为 spec）。
- 不新增大词表 / LLM classifier。
- 不改 MCP tool 数量或 profile（`register.ts` 36 个注册不动）。
- 不顺手重构 `format-result.ts`（仅 builder 收口时触动必要 formatter）。
- 不改写入/召回/图事实/search ranking/ontology 语义。
- 不改 Hermes 私有配置 / Hermes 运行时代码（host-side contract 是跨 repo gate，不由本 repo 实施）。
- 不把 security 等同于"所有文本一律隐藏"。
- **不宣称 CBrain 单边解决 prompt injection**（§0/§3.2）。
- 不在 Phase 1 pilot 内做 sanitizer 全仓合并（§5.3）。

---

## 10. Acceptance（对齐 #327）

- [x] 跨工具输出标注与暴露面收敛 spec（本文件，目标已按 §0 降级）。
- [x] 覆盖 graph/recall/timeline/discovery/action-candidate 五类（§2.3）。
- [x] 同一匿名对抗矩阵复用（§7.1）。
- [ ] structured 模式下，凭据/绝对路径永不进入任何输出；slug/id/internal/debug 不进 display/data，仅进入显式 opt-in 且脱敏的 audit。legacy 仅作有时限灰度/回滚例外。（实现阶段）
- [ ] 正常标题保持可读。（实现阶段 §7.2）
- [ ] `bun run check` 与 agent-facing contract gate 全绿。（实现阶段）

> **#327 原验收第 4 条"任意原始内容只存在于明确标记的审计数据中"在 Hermes 改造前不可由 CBrain 单边达成**——vault-derived `data` 仍会进模型上下文（§3.2）。本 spec 将其拆为：(a) CBrain 单边可达的"raw/internal 进 audit opt-in"；(b) 依赖 G1 的"vault untrusted data 由 host 隔离"。(a) 实现阶段验收，(b) 跨 repo。

---

## 11. 停止点

本 spec（rev2）为 Phase 0 唯一交付。**不改运行时代码、测试、schema、handler、formatter**（新增 `include_raw`/`outputSchema` 均为 Phase 1 实施项，本阶段只描述）。amend 单 docs commit 后停下，交 Codex 二复审。未明确 APPROVE 前不进入 writing-plans。

**需决策的 gate：** G1（Hermes host-side contract，跨 repo）/ G2（graph/timeline include_raw）/ G3（recall/query raw 收缩 + 测试合同）/ G4 / G5（§5.7）。
