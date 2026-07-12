# Recommendation Contract — 设计 spec（Phase 0）

> Issue: #328（roadmap: governed Recommendation Record and replayable decision support）
> Phase: **0（仅合同设计，不改运行时）**
> 状态：rev2 — 待 Codex re-review
> 依赖：#327（output trust boundary）— display 前置；未完成全部 surface 前 recommendation 不进默认展示

**修订记录**：
- **rev2**（本轮）：修 Codex `CHANGES REQUESTED` —— HIGH 1（replay 拆 integrity-check vs decision-replay + 存 `decision_inputs` + 解耦 `inputs_hash`/`fingerprint`）、HIGH 2（pending/current 都受 freshness gate）、HIGH 3（`record_id` ≠ `fingerprint`、partial unique index、revalidation 带审计复活）、MED 1（ref 非 privacy boundary + 三层 ref/display）、MED 2（per-rule declarative dependency 替代全量 entity hash）、MED 3（conflict 限本 record scope + confirmation 分类规则）。
- rev1：初版 Phase 0 合同。

---

## 0. Phase 0 边界（硬约束）

本 spec **只定义合同**，不做：

- 不改 `src/`、DB schema、migration、MCP schema、tool profile、默认 Agent display。
- 不调用 LLM 生成运行时 recommendation。
- 不保存模型私有 chain-of-thought。
- 不自动执行 repair / merge / sync / delete。
- 不提前锁死数据库迁移（CREATE TABLE 留给 Phase 1 data-model decision gate）。
- 所有 fixture 用匿名占位符（实体A / 主题B / 方案C / 组织D）。

Phase 0 产出 = 本文件 + 对抗审查章节。Phase 1 实现、Phase 2 replay/diff、Phase 3 shadow、Phase 4 policy templates 各自再过独立 gate。

---

## 1. 要解决的问题

CBrain 已能检索证据、区分事实/观点/候选、跑带预算的多步研究、给健康与发现类下一步建议。但每条建议都是**当次一次性输出**，无法稳定回答：

- 当时为什么给出这个建议？
- 用了哪些证据、约束、规则？
- 同一状态能否重放出同一结果？
- 哪条依赖变化后，旧建议为什么失效？
- 两次建议差异来自证据、约束、policy 还是 ontology？

目标不是替用户做决定，而是建立**可复核、可重放、可失效、可拒绝、可 abstain 的建议支持层**。Phase 0 把"建议"从一次性回答里分离出来，定义稳定合同。

---

## 2. 概念边界（recommendation 与周遭事物的分工）

> 验收 #1、#3：明确 recommendation 与 fact / recall / research / attention item / action 的边界。

| 概念 | 回答的问题 | epistemic 性质 | 是否持久 | 是否执行写 |
|:--|:--|:--|:--|:--|
| **fact** | "X 是什么？" | 真值断言（`trust_state ∈ {trusted, user_thought}`） | 是（vault+DB） | — |
| **candidate**（证据层） | "X 可能是什么？" | 待验断言（`trust_state = candidate`） | 是 | — |
| **recall / research** | "关于 X 我知道什么？" | 检索结果（证据集合） | 否（当次） | 否 |
| **attention item** | "有什么值得看？" | 触发信号（detected signal） | 部分（discoveries 表） | 否 |
| **recommendation** | **"给定状态 S，该做什么？"** | **确定性结论 + 提案（非真值断言）** | **是（本合同）** | **否（硬墙）** |
| **action** | "做了什么？" | 已执行的写操作 | 是（audit） | 是 |

### 2.1 五条核心边界

1. **recommendation ≠ fact（最关键）**。recommendation 是"should do"，不是"is"。它**永远不能**被提升为 trusted fact，不能进 `EvidenceBoard.facts`，不能写入 `trust_state ∈ {trusted, user_thought}` 的 link/timeline。它是独立的 epistemic tier（见 §3）。任何把 recommendation 写回 fact 的路径都是合同违反。

2. **recommendation ≠ recall/research**。recall/research 是 query-driven 的证据召回（产出 `SearchResult[]` / `PipelineResult` / `EvidenceBoardResult`）。recommendation 是 state-driven 的结论合成（从当前 vault + policy 状态算出）。research 可以**喂证据**进 recommendation 的 evidence_manifest，但 research 本身不是 recommendation。边界：research = "证据是什么"；recommendation = "给定证据+policy，确定性结论是什么"。

3. **recommendation ≠ attention item**。attention item（`NextAction`、discovery row、health issue）是**原料信号**；recommendation 是**合成结论**。多条 attention item 可汇聚成一条 recommendation；一条 attention item 也可能因证据不足而不产生任何 recommendation（→ abstain）。Phase 1 的 maintenance recommendation 与 next_actions 共享上游来源（health/discovery/fsck），但 recommendation record 多出 fingerprint / inputs_hash / dependency_manifest / lifecycle 合同字段。`NextAction ≠ RecommendationRecord`。

4. **recommendation → action 是单向硬墙**。recommendation **提案**，action **执行**。Phase 1 永不跨越：`auto_execute: false` 是不变量，producer 规则只读，不调用任何写操作（repair/merge/sync/delete）。

5. **recommendation ≠ Compounding Review candidate**。Compounding Review 是 LLM 合成的主题观察（`theme_convergence` / `supported_connection` / `judgment_shift` 等），带自己的生命周期表 `compounding_review_candidates`。它是**意见型**（LLM 叙事）。Phase 1 recommendation 是**确定型**（纯代码，无 LLM）。两者共享审计副表**模式**，不共享域。

---

## 3. Epistemic tiers（真值层级）

CBrain 现有 `TrustState = trusted | user_thought | candidate | rejected | superseded`（`src/core/provenance.ts:21`）。这是**真值轴**：描述"这条命题多可信"。

recommendation 不在这条轴上。它是**独立的提案轴**。强行复用 `TrustState` 表达 recommendation 是 Wrong Abstraction——会让"提案"和"待验命题"在 evidence_manifest 里混在一起，display/filter 规则必然出错。

合同定义独立的 tier 概念（Phase 0 仅逻辑定义，不入 DB enum）：

| tier | 轴 | 含义 | 可否升级为 fact |
|:--|:--|:--|:--|
| `fact` | 真值 | trusted/user_thought 命题 | （本身即 fact） |
| `candidate` | 真值 | 待验命题 | 可，经确认 |
| **`recommendation`** | **提案** | **确定性结论 + 动作提案** | **否，硬禁止** |
| `abstain` | 提案 | 证据/约束不足，不给结论 | 否 |

evidence_manifest 里的每条证据**仍然带 `trust_state`**（真值轴），recommendation 结论本身**不带 trust_state**（它在提案轴）。两条轴正交，manifest 用真值轴过滤，结论用提案轴分类。

---

## 4. Recommendation Record — 最小稳定 shape

> 验收 #2：稳定最小 record shape，不提前锁死 DB 迁移。

这是**逻辑 shape**，不是 CREATE TABLE。字段名对齐现有代码（`NextAction` / `ActionCandidateDraft` / `compounding_review_candidates` / `ActionEvidenceRef`），Phase 1 落表时再决定物理 schema。

```ts
// 逻辑类型（Phase 0 合同；物理 schema 留给 Phase 1 gate）
interface RecommendationRecord {
  // ── 身份（两层，HIGH 3：实例身份 ≠ 内容指纹）──
  record_id: string;              // 不可变实例身份（maintenance_key + created_at + 确定性 nonce），主键
  fingerprint: string;            // 内容身份 = hash(inputs_hash + conclusion + constraints)，非唯一（§6）
  inputs_hash: string;            // = hash(decision_inputs)，纯输入身份（HIGH 1，与 fingerprint 解耦）
  namespace: string;              // Phase 1 固定 "maintenance"；未来 "open_question" 等
  maintenance_key: string;        // 归一化稳定键，见 §4.1

  // ── 结论（提案轴）──
  conclusion: RecommendationConclusion;

  // ── 冻结决策输入（HIGH 1：decision replay 的依据）──
  decision_inputs: DecisionInputs;        // canonical 冻结输入，足以离线重跑 rule；audit/raw 层（§11）

  // ── 证据清单（真值轴过滤后；internal ref，audit 层，非隐私边界）──
  evidence_manifest: EvidenceManifestEntry[];

  // ── 约束与版本（replay/diff 用）──
  constraints: RecommendationConstraints;

  // ── 依赖声明（MED 2：per-rule declarative）──
  dependency_manifest: DependencyManifest;   // rule 声明实际读取并影响结论的字段；只这些进 inputs_hash

  // ── 适用性与风险 ──
  applicability: Applicability;
  risks: string[];
  gaps: string[];                 // 复用 EvidenceBoard.gaps 语义

  // ── 生命周期（与 freshness 正交，HIGH 2/3）──
  created_at: string;             // 不进 fingerprint
  last_revalidated_at: string;    // 最近一次 freshness check 通过时间；不进 fingerprint
  lifecycle_status: RecommendationLifecycle;

  // ── record 自身来源（非 vault provenance）──
  producer: RecommendationProducer;
}

type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

interface ProposedAction {
  type: "review" | "dry_run" | "notify_draft";  // 对齐 ActionCandidateActionType
  target_ref: string;            // internal ref（audit 层，含 slug，§4.2/§11）
  target_display: string;        // runtime 用户展示：经 #327 清洗的安全 title（safeTitle/safeDisplayText）
  reason: string;                // 显式可审计理由，非模型 CoT
  rollback_note?: string;        // 对齐 RepairAction.rollbackNote
}

interface DecisionInputs {
  // canonical 冻结输入：离线重跑 deterministic rule 所需的全部有界输入。
  // Phase 1 maintenance 多为结构化信号（slug 集合、活跃边、计数、分数），少 prose。
  // 若 rule 检视 claim 文本（如 conflict 检测），相关文本进 inspected_claims，tier = audit/raw（§11）。
  signals: Record<string, unknown>;               // rule 声明的结构化输入（计数/分数/集合）
  inspected_claims?: string[];                     // rule 实际检视的 claim 文本（audit/raw）
  entity_snapshot: Record<string, EntityProjection>;  // 仅 dependency_manifest 声明的字段（§7）
}

interface EntityProjection {
  // 只含 rule 在 dependency_manifest 里声明读取的字段；未声明字段不进快照（MED 2）
  [field: string]: unknown;
}

interface EvidenceManifestEntry {
  source: "discovery" | "health" | "fsck" | "graph" | "timeline";
  ref: string;                  // internal ref（含 slug，audit 层）—— 不是隐私边界（MED 1，§4.2）
  trust_state: TrustState;      // 真值轴（manifest 内必然 ∈ {trusted, user_thought, candidate}）
}

// ── manifest 不变量（对抗攻击 #2，见 §15）──
// manifest 只含 active 证据：producer 构建前必须过 INACTIVE_STATES（evidence.ts:52）
// 与 ACTIVE_LINK_SQL（sqlite.ts:49），与 EvidenceBoard.build 的 drop 行为一致（evidence.ts:125）。
// manifest 无 active 字段——inactive 在结构上无法进入结论。全量（含 inactive）证据视图进 audit/raw。
// 推论：inactive 证据日后翻 active（rejected→trusted）→ decision_inputs.entity_snapshot 变 → inputs_hash 变 → 旧 record stale（F11/F15）。

interface RecommendationConstraints {
  policy_version: string;       // 见 §7.2
  ontology_version: string;
  schema_version: string;       // 合同自身版本，如 "rec-v1"
  rule_hashes: Record<string, string>;  // 产出规则的代码哈希
}

interface DependencyManifest {
  // per-rule 声明式依赖（MED 2）：只 hash rule 真正读取并影响结论的字段。
  // 替代旧的"全实体投影哈希"——无关字段变化不 stale 语义建议。
  rule_id: string;                     // 声明归属（与 producer.rule_id 一致）
  declarations: DependencyDeclaration[];
  inputs_hash: string;                 // = hash(canonical(declared projections))，= record.inputs_hash 的依赖分量
}

interface DependencyDeclaration {
  slug?: string;                // 缺省 = global；实体级依赖填 slug
  table: "pages" | "links" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  fields: string[];             // 只这些字段；如 links 只取 relation + trust_state + other_slug
  filter?: "active" | "all";    // 默认 active（过 ACTIVE_LINK_SQL）
  // 关键：fts/lance 只在 storage-health 类 rule 显式声明时才进 hash——
  // 索引重建不让语义 recommendation stale。
}

interface Applicability {
  audience: "user_only";        // Phase 1 固定
  auto_execute: false;          // Phase 1 不变量
  requires_confirmation: ConfirmationRequirement;
}

type ConfirmationRequirement =
  | { tier: "standard" }        // Phase 1 全部 read-only maintenance 默认（§9.1 分类）
  | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };

// MED 3：high_impact 必须有明确分类规则，不只是类型
type HighImpactReason =
  | "write_action"                  // 任何 repair/merge/sync/delete 执行类
  | "open_question_deep_reasoning"  // Phase 3 LLM 推导
  | "irreversible_real_world"       // 现实不可逆（财务/医疗/法律，Phase 4 黑名单域）
  | "high_value_entity";            // 高连接度实体的结构性变更

interface RecommendationProducer {
  rule_id: string;              // 确定性规则标识
  code_hash: string;            // 规则代码哈希（= policy_version 来源之一）
  // inputs_hash 不再放这里——已在 record 顶层（HIGH 1 解耦 input hash 与 record hash）
}

type RecommendationLifecycle =
  | "pending"      // 已建，待用户确认（创建默认）；仍受 freshness gate（HIGH 2）
  | "current"      // 用户已确认相关；仍受 freshness gate
  | "stale"        // 依赖/输入漂移；可经 revalidation 回 current（HIGH 3）
  | "superseded"   // 同 maintenance_key 的新 active record 取代
  | "rejected"     // 用户显式拒绝；同 fingerprint 在抑制窗口内不重复提案
  | "invalidated"; // ontology/policy/schema 版本变化，结构上不再适用

type AbstainReason =
  | "insufficient_evidence"
  | "conflict"                   // MED 3：仅当冲突命中本 record 的 decision_inputs/claim
  | "inactive_evidence_only"
  | "below_threshold"
  | "policy_prohibits";
```

### 4.1 `maintenance_key`（归一化稳定键）

Phase 1 的 maintenance key 借鉴 `discoveryDedupKey`（`src/storage/sqlite.ts:2499`：`type|JSON.stringify(sorted(unique(entities)))`）与 `computeContentHash`（`src/core/maintenance/compounding-review.ts:84`：`type|title|sorted(slugs)`）的复合键风格：

```
maintenance_key = "<source>:<rule_id>:<sorted(entity_set)>"
# 例：health:known_relations:["entityA","entityB"]
#     discovery:bridge:["entityA","entityB","entityC"]
#     fsck:orphan_chunks:["entityA"]
```

同一 `maintenance_key` 下，`fingerprint` 区分不同结论/不同输入快照。

### 4.2 evidence ref —— internal/audit 引用（MED 1：不是隐私边界）

> **修正**（rev1 把 ref 叫"隐私边界"，错）。这些 ref 是 **content-minimized internal refs**，**含 raw slug**，不是 privacy-safe。

evidence ref 不存原文摘录，只存稳定引用，复用现有 `ActionEvidenceRef` 模式（`src/core/maintenance/action-candidates.ts:17`）：

- discovery 类：`discovery:<dedup_key>` 或 `discovery:id:<n>`（对齐 `stableDiscoveryRef`，action-candidates.ts:109）—— **dedup_key 含实体 slug**
- health 类：`health:<dimension>:<kind|group>:<slug|"global">`（对齐 `healthStableRef`，action-candidates.ts:179）—— **含 slug**
- fsck 类：`fsck:<check>:<sample_slug|"global">` —— **含 sample slug**
- graph/timeline 类：`graph:<from>|<to>` / `timeline:<slug>:<event_date>` —— **含 slug**

**三层分层**（对齐 CBrain 现有 digest 三层模式 discovery-digest.ts）：

| 层 | 内容 | 受众 | 谁清洗 |
|:--|:--|:--|:--|
| **internal ref**（本节） | 含 raw slug，无 prose 摘录 | audit/debug only | 无（内部用） |
| **runtime 用户 display** | 经 #327 boundary 清洗的**真实安全 title**（`safeTitle(slug, entityLookup, fallback)` discovery-digest.ts:109 / `safeDisplayText` action-candidates.ts:310）；**不一刀切匿名**——建议要对用户可操作；清洗失败才退化为通用 fallback（"一项待确认的记忆"） | 终端用户 | #327 surface + safeTitle |
| **公开示例 / 测试 / 文档** | 匿名占位符（实体A / 主题B / 方案C / 组织D） | issue / PR / spec 读者 | 强制匿名 |

**关键**：ref 层不能直接给用户看（含 slug）；runtime display 走 `safeTitle` 拿真实但清洗过的 title，让建议保持可操作性。一刀切输出"实体A"会让建议失去操作意义——Codex MED 1 指出这点。

---

## 5. 生命周期

> 验收 #2：定义生命周期。

**不复用 `CandidateStatus` enum**（虽然它最完整：`pending|accepted|rejected|deferred|disabled|superseded`，`src/storage/sqlite.ts:138`）。原因：recommendation 需要 `stale`（依赖漂移）和 `invalidated`（版本结构变化）语义，`CandidateStatus` 没有；反过来 recommendation 不需要 `deferred`/`disabled`。复用会导致 Wrong Abstraction + display filter 漏判。

**但复用审计副表模式**：`compounding_review_feedback`（`src/storage/sqlite.ts:393`）是 action→status 转换 + reason 的审计副表，recommendation 应有同构的 `recommendation_lifecycle_history`（逻辑定义，Phase 1 落表）。

### 5.1 两条正交轴（HIGH 2/3 的根因修复）

rev1 把"用户确认状态"和"依赖是否新鲜"混进一个 enum，导致 pending 能绕过 freshness、A→B→A 死锁。rev2 拆成两条正交轴：

**轴 A — lifecycle（用户/系统驱动的实例状态）**：`pending` → `current` → `superseded`；`→ rejected`；`→ invalidated`。这些是**用户确认或系统取代**触发的离散转换，写 `recommendation_lifecycle_history`。

**轴 B — freshness（依赖/约束驱动的可重算性）**：`fresh` / `stale` / `version_invalid`。这是**每次读/display 前确定性重算**的连续判断，**不写 enum**，写 `last_revalidated_at`。

**展示门控 = 轴 A ∈ {pending, current} AND 轴 B = fresh**。两个都要满足。

### 5.2 lifecycle 转换（轴 A）

```
   创建 → pending ──(用户 confirm)──→ current
                │                       │
                │         (同 key 新 active record 接受/取代)
                │                       ▼
                │                   superseded
                │
                ├──(用户 reject)──→ rejected
                └──(版本结构性变, 轴B=version_invalid)──→ invalidated
```

- **pending**：创建默认。尚未用户确认。**仍受 freshness gate**（HIGH 2 修复）。
- **current**：用户显式 confirm（"这条建议相关，保留为 active"）。confirm **只改 lifecycle，不代表执行动作**——Phase 1 `auto_execute:false` 不变，proposed action 永不因 confirm 而执行。
- **superseded**：同 `maintenance_key` 产生新 active record（用户更认可新的）。
- **rejected**：用户显式拒绝。同 `fingerprint` 在抑制窗口内不重复提案（见 §5.4）。
- **invalidated**：轴 B 判定 `version_invalid`（ontology/policy/schema 版本结构变化），系统转 invalidated。

### 5.3 freshness gate（轴 B，HIGH 2 核心）

**任何 pending/current record 在读/display 前必须过 freshness check**（不只 current）：

1. 重算当前 `inputs_hash'`（按 dependency_manifest 重读声明字段）+ 当前 `constraints'`（重算 policy/ontology/schema version）。
2. 比较：
   - `inputs_hash' != record.inputs_hash` → 轴 B = `stale`。轴 A 转 `stale`（pending/current 都转）。
   - `constraints'` 版本结构变化（ontology/policy/schema_version 不匹配）→ 轴 B = `version_invalid`。轴 A 转 `invalidated`。
   - 都匹配 → 轴 B = `fresh`，更新 `last_revalidated_at`。
3. **stale/invalidated 不展示**，即使轴 A 还是 pending/current 名义值——freshness check 在 display 前已把轴 A 推到 stale/invalidated。

> 这修复 HIGH 2：rev1 的 display filter 只看轴 A，pending 能绕过。rev2 display 前强制 freshness check，pending/current 一视同仁。

### 5.4 revalidation 与回摆（HIGH 3 核心）

stale **不是终态**，可经完整 revalidation 回 active：

- revalidation = 用**当前 DB 状态**重跑 rule（读当前状态，非冻结输入；与 §8.2 decision replay 不同——后者跑冻结 `decision_inputs`），产出**当前** `inputs_hash'` 与 `conclusion'`，与 stale record 比对（详见 §8.4）。
- 若重跑得到**同 `inputs_hash`**（依赖状态恢复，A→B→A 的 "回到 A"）：原 stale record 的 fingerprint 仍匹配 → **原地复活**为 pending/current（保留用户原确认），写 lifecycle_history（`revalidated` + 时间）。**不需要新 fingerprint**，因为内容没变。
- 若重跑得到**不同 `inputs_hash`**（B 是新状态）：产出新 record（新 fingerprint），旧 stale record 保留为审计历史，新 record 走正常 pending 流程。

> 这修复 HIGH 3：rev1 要求 stale 必须产"新 fingerprint"才能回 current，但 A→B→A 确定性重算必然得原 fingerprint，配 `fingerprint UNIQUE` 死锁。rev2 允许同 fingerprint 经 revalidation 带审计复活。

### 5.5 唯一性约束（替代 `fingerprint UNIQUE`）

**`fingerprint` 不再全局 UNIQUE**。改为**partial unique index**（SQLite 已有 `WHERE` 部分索引先例，`src/storage/migrations/pages.ts:51` / `indexes.ts:14-15`）：

```sql
-- 逻辑约束（Phase 1 落表时实现）
CREATE UNIQUE INDEX idx_rec_active_unique
  ON recommendation_records (maintenance_key, fingerprint)
  WHERE lifecycle_status IN ('pending', 'current');
```

- 同一 `(maintenance_key, fingerprint)` 同时只能有一条 active（pending/current）—— 满足"不重复提案"。
- stale/superseded/rejected/invalidated record 不参与唯一约束 —— A→B→A 复活、审计历史共存都不冲突。
- `record_id`（非 fingerprint）才是主键。

### 5.6 不变量汇总

- **展示门控**：`lifecycle_status ∈ {pending, current}` **AND** freshness check 通过。pending/current 都过 freshness gate（HIGH 2）。
- **stale 可复活**：同 fingerprint 经完整 revalidation 回 active，写 history（HIGH 3）。
- **rejected 抑制窗口**：同 `(maintenance_key, fingerprint)` 在窗口内（默认至 end-of-session 或配置 TTL）不再以 active 提案；窗口外或不同 fingerprint 不受限。
- **confirm ≠ execute**：pending→current 只改 lifecycle，不触发任何写操作。
- **inactive 不进 manifest**：见 §4 manifest 不变量。

---

## 6. 内容指纹与输入哈希（HIGH 1 解耦）

> 验收 #2 + 硬约束"同一状态与 policy 产生 byte-stable structured result/fingerprint"。
> **rev2 修正**：rev1 只有一个 `fingerprint` 且把 conclusion 也 hash 进去——replay 时变成"对已存结论再 hash"，只能验完整性、不能从输入重推结论。rev2 拆成两个独立 hash。

### 6.1 两个独立 hash

```
inputs_hash  = SHA-256(canonical_json(decision_inputs))
               // 纯输入身份：只 hash 冻结输入（signals + inspected_claims + entity_snapshot）
               // 不含 conclusion。这是 decision replay 的输入指纹。

fingerprint  = SHA-256(canonical_json({
                 inputs_hash,                // 绑定输入
                 conclusion,                 // kind + propose(action+alternatives) | abstain(reason)
                 constraints                 // policy/ontology/schema/rule_hashes
               }))
               // 内容身份：输入 + 结论 + 约束。非唯一（§5.5 用 partial unique index 约束 active）。
```

**角色分工**：
- `inputs_hash`：决策重放（§8.2）用它——重跑 rule 得到的输出结论，其 `inputs_hash` 应等于冻结值，证明"同输入"。
- `fingerprint`：内容身份 + 完整性校验（§8.1）——绑定"这输入→这结论"，篡改任一项即不匹配。

### 6.2 canonical JSON 规则（byte-stable 保证）

1. 对象 key 按 UTF-16 码点升序（JSON.stringify 默认 + 显式 sort 兜底）。
2. 数组按显式 sort（inspected_claims / entity_snapshot keys / alternatives 按 `type|target_ref|reason` / declarations 按 `slug|table|fields`）。
3. 字符串值做 **NFKC 归一化**（对齐 #327 `sanitizeStructuredText` 的 NFKC 步骤，`src/core/safety/display-safety.ts:106`），消除全角/半角差异（`ｓｃｏｒｅ` ≡ `score`）——指纹要语义稳定。
4. 无多余空白（`JSON.stringify` 默认）。
5. UTF-8 编码后 SHA-256，输出 64 hex（对齐 `computeContentHash` 全长风格，`src/core/maintenance/compounding-review.ts:84`）。
6. **不使用** `Date.now()` / `Math.random()` / 自增 id / `created_at` / `last_revalidated_at` / `lifecycle_status`（这些进 hash 就破坏 byte-stable）。

### 6.3 同一状态 → 同一指纹

只要 `decision_inputs + conclusion + constraints` 相同，`inputs_hash` 与 `fingerprint` 都相同，无论何时何地计算。这是 replay 与 A→B→A 复活（§5.4）的基础。

### 6.4 与现有去重键的关系

- `discoveryDedupKey`（实体集合复合键，sqlite.ts:2499）：标识"同一组实体+类型的信号"。**不区分结论**。
- `compounding_review_candidates.content_hash`（type|title|sorted slugs，compounding-review.ts:84）：标识"同一候选内容"。
- **recommendation `inputs_hash`**：标识"同一冻结输入"。**recommendation `fingerprint`**：标识"同一输入→同一结论"。两层最细粒度。

---

## 7. 依赖声明与版本（per-rule，不锁 DB 迁移）

> 关键 gap：**ontology/policy/schema version 常量当前不存在**。代码里只有 `package.json` 版本（`src/version.ts`）和 per-page 内容版本（`src/core/version.ts` + `versions` 表）。spec 必须定义版本，但用"文件/代码内容哈希"绕开 DB 迁移。

### 7.1 per-rule 声明式依赖（MED 2：替代全量 entity hash）

> **rev2 修正**：rev1 用"实体在 9 表+FTS 的全量投影"算 `entity_hash`，且文字与公式不一致（文字说覆盖 9 表+FTS，公式漏了 versions/mention_snapshots/FTS）。更根本：**FTS/Lance 是派生索引，重建不该让语义建议 stale；rule 没读的 tag/alias 变化也不该失效建议**。全量 hash = 无意义 stale 风暴。

rev2 改为 **per-rule declarative dependency manifest**：每条 rule 显式声明它**真正读取并影响结论**的字段，只这些进 `inputs_hash`。

```
// 例：known_relations repair rule 只读 reports_to 边
dependency_manifest = {
  rule_id: "health:known_relations",
  declarations: [
    { slug: "entityA", table: "links", fields: ["relation","trust_state","other_slug"], filter: "active" },
    { slug: "entityB", table: "links", fields: ["relation","trust_state","other_slug"], filter: "active" }
    // 不声明 tags/aliases/chunks/timeline —— 这些变化不让本建议 stale
  ],
  inputs_hash: SHA-256(canonical_json(declared_projections_sorted))
}

// 例：storage-health rule 显式依赖索引状态
dependency_manifest = {
  rule_id: "fsck:fts_coverage",
  declarations: [
    { table: "fts", fields: ["coverage_ratio"] },       // 显式声明 FTS
    { table: "lance", fields: ["vector_coverage"] }     // 显式声明 Lance
  ],
  ...
}
```

**规则**：
- rule **未声明**的字段/表，其变化**不**进 `inputs_hash`，**不**触发 stale（见 F16）。
- `fts` / `lance` 只在 storage-health 类 rule **显式声明**时才进 hash——索引重建不让语义 recommendation stale。
- 实体级声明带 `slug`；全局声明（fsck 全表、config 项）`slug` 缺省。
- `filter: "active"` 默认过 `ACTIVE_LINK_SQL`（sqlite.ts:49）；`"all"` 仅当 rule 明确需要 inactive 证据时（罕见）。
- 可行性：所需列都存在（`pages.content_hash` shared.ts:21 / `chunks.content_hash` / 各 status 列）；声明式 manifest 是逻辑 shape，Phase 1 落表时定物理形式。

**审查义务**：rule 的 declaration 是**合同**——Codex review 时必须核对 declaration ⊆ rule 实际读取集合（漏声明 = 漏失效，过声明 = 无意义 stale）。

### 7.2 版本定义（文件/代码哈希，非 DB 列）

| 版本字段 | 定义 | 来源 | 是否需 DB 迁移 |
|:--|:--|:--|:--|
| `ontology_version` | SHA-256(`ontology.yaml` 内容) | 文件 | 否 |
| `policy_version` | 产出 recommendation 的规则代码哈希（`rule_hashes` 聚合） | 代码 | 否 |
| `schema_version` | 合同自身版本常量（如 `"rec-v1"`） | spec 定义 | 否 |

**关键设计**：版本不存 DB 列，而是**算出来存进 record 字段**。record 落表时这些是普通 JSON 字段值，不需要 schema migration。Phase 1 即使复用现有表（见 §10），版本也能完整记录。

### 7.3 全局输入（并入 manifest）

rev1 的 `global_state_hash` 独立概念取消——全局读取（fsck 全表、config 项、health 全维度）直接作为 **slug 缺省的 declaration** 进 `dependency_manifest`（如 `{ table: "config", fields: ["key_X"] }`）。统一进 `inputs_hash`，不再单独字段。粒度由 rule 自定，但 declaration 必须 ⊆ rule 实际读取集合（§7.1 审查义务）。

---

## 8. Replay / Diff / Invalidation 语义

> Phase 0 定义语义；Phase 2 实现（且 Phase 2 涉及数据模型，须单独过 data-model gate）。

### 8.1 Integrity check（完整性校验）—— 廉价，不跑 rule

> 回答："record 自身没被篡改、字段内部自洽吗？"

用 record 里**已存的** `decision_inputs` + `conclusion` + `constraints` 重算：
- `inputs_hash' == record.inputs_hash`？
- `fingerprint' == record.fingerprint`？

两个都等 = 完整性通过。**不执行 rule、不查 DB、不调 LLM/网络**。这是 rev1 唯一做的事——rev2 明确降级为"完整性校验"，不再叫 replay。

### 8.2 Decision replay（决策重放）—— HIGH 1 的真正 replay

> 回答："从冻结输入重跑确定性 rule，能得到记录的结论吗？"
> Phase 2 硬约束：replay 只读冻结 record（含 `decision_inputs`），不调 LLM、网络、不重新检索 vault。

```
replayed_conclusion = rule(decision_inputs)        // 离线执行确定性 rule
assert hash(decision_inputs) == record.inputs_hash  // 输入身份一致
assert replayed_conclusion == record.conclusion      // 结论可重现
```

- `decision_inputs` 是 canonical 冻结输入（§4），**足以离线重跑 rule**——这是 rev2 相对 rev1 的关键增加。rev1 没存 `decision_inputs`，所以"重算"只能 hash 已存结论，证明不了可重推。
- 通过 = 该 record 的结论**确定性可从冻结输入重现**（满足 issue replay 目标）。
- 失败 = rule 非确定性 / record 被改 / rule 代码变了但 `policy_version` 没更新——任一都是 bug，记 audit。

### 8.3 Diff（差异）

对比两条 record（或 record vs 当前状态），沿 **5 轴**输出结构化差异：

```ts
type DiffAxis =
  | "evidence"     // manifest 条目增删（含跨 active 边界：inactive↔active）/ trust_state 翻转
  | "constraint"   // policy/ontology/schema/rule 版本变
  | "option"       // alternatives / ProposedAction 集合变
  | "dependency"   // inputs_hash 不匹配（per-rule declared projection 漂移）
  | "conclusion";  // propose↔abstain 或 action 不同

interface Diff { axis: DiffAxis; before: string; after: string; }[]
```

Phase 2 先做 hash 级快判（`inputs_hash` 比、`constraints` 比），命中再下沉到字段级 diff。排序优先级必须下沉到截断层（对齐 memory：`rank-priority-before-truncate`），不在 TS 后置排序。

### 8.4 Freshness / Invalidation / Revalidation（HIGH 2/3）

> **freshness gate 同时约束 pending 与 current**（HIGH 2）；**stale 可经 revalidation 复活**（HIGH 3）。

任何 pending/current record 在读/display 前重算 `inputs_hash'` 与 `constraints'`：

| 触发 | 转换（轴 A） | 适用 |
|:--|:--|:--|
| `inputs_hash' != record.inputs_hash`（声明依赖漂移） | `pending/current → stale` | pending **和** current（HIGH 2） |
| `ontology_version` / `policy_version` / `schema_version` 结构性不匹配 | `pending/current → invalidated` | pending **和** current |
| 同 `maintenance_key` 新 active record 被确认 | 旧 active `→ superseded` | pending/current |
| 用户拒绝 | `→ rejected` | pending/current |
| **revalidation**：用当前状态重跑 rule 得**同 `inputs_hash`** | `stale → pending/current`（保留原确认，写 history） | stale（HIGH 3 复活） |
| **revalidation**：重跑得**不同 `inputs_hash`** | 产出**新 record**，旧 stale 留作审计 | stale |

**硬规则**：
- 任一声明依赖变化 → stale，**pending/current 都不得静默展示**（issue 原文要求，HIGH 2 落实）。
- 未声明的字段变化**不**触发 stale（MED 2，见 F16）。
- stale 经完整 revalidation 可复活——同 fingerprint 不死锁（HIGH 3，见 F15）。

---

## 9. Abstain 语义

> 验收 #2 + 验收场景：conflict abstain、无证据 abstain。

证据不足时 `conclusion.kind = "abstain"`，**不发 ProposedAction**。record 仍持久化（有 fingerprint 去重，避免反复重算）。

`AbstainReason` 映射现有检测逻辑：

| reason | 触发（映射现有代码） |
|:--|:--|
| `insufficient_evidence` | 本 record 范围内 `facts` 空 + `gaps` 非空（evidence.ts:150 `detectGaps`） |
| `conflict` | **MED 3：仅当 `detectClaimConflicts`（evidence.ts:276）命中的冲突证据 ∈ 本 record 的 `decision_inputs`/`evidence_manifest`**。无关实体的全局冲突不阻断本建议 |
| `inactive_evidence_only` | 本 record 范围内全部 candidate 证据被 `INACTIVE_STATES`（evidence.ts:52）过滤掉 |
| `below_threshold` | proactive `score < 0.5`（proactive.ts:44），或 `actionable !== "high"` |
| `policy_prohibits` | rule 显式推迟（如 Phase 1 丢弃 `observe_only` health 项，action-candidates.ts:213） |

> **MED 3 修正**：rev1 "任意 `EvidenceBoard.conflicts` 非空就 abstain"——会让关于实体A的建议因实体Z的无关冲突而放弃。rev2 限定：conflict abstain 只在冲突证据落入**本 record 的 decision scope** 时触发。

abstain record 的 lifecycle 同样走 pending/current/stale + freshness gate，但 display 默认不展示（除非用户主动查"为什么没给建议"）。

### 9.1 Confirmation 分类规则（MED 3）

`ConfirmationRequirement` 不只是类型——必须有分类规则：

- **`standard`**（Phase 1 全部）：所有 **read-only maintenance** recommendation（health review、fsck finding、discovery bridge、known_relations dry_run 预览）。这些只产 review/dry_run/notify_draft，不执行写。
- **`high_impact`**（未来 Phase，按 `HighImpactReason` 分类）：
  - `write_action`：任何 repair/merge/sync/delete **执行**类（Phase 1 不存在，出现即 high_impact，须确认 target+option+constraint）。
  - `open_question_deep_reasoning`：Phase 3 LLM QuestionFrame 推导。
  - `irreversible_real_world`：Phase 4 现实不可逆域（财务/医疗/法律，**黑名单**，不得自动获得执行权）。
  - `high_value_entity`：高连接度实体（如中心 hub）的结构性变更。

Phase 1 全部落在 standard，`auto_execute:false` 不变。high_impact 是为 Phase 3+ 预留的**分类规则**，不是当前实现。

---

## 10. 存储方案 trade-off（新表 vs 复用 lifecycle）

> 验收 #4：比较两种 Phase 1 存储方案，列 trade-off，给推荐，本轮不实施。

### 方案 A：新 `recommendation_records` 表

**Pros**
- Schema 为 record shape 量身定做：`record_id` 主键 + **partial unique index** `(maintenance_key, fingerprint) WHERE lifecycle IN (pending,current)`（§5.5）+ `inputs_hash` 索引 + `lifecycle_status CHECK`。
- 与 discoveries / compounding_review_candidates 零语义碰撞。
- 审计副表 `recommendation_lifecycle_history` 同构 `compounding_review_feedback`（sqlite.ts:393），记录 revalidation/复活历史（HIGH 3）。
- "查当前 recommendation" = 单条索引查询。
- 生命周期 vocab 干净（pending/current/stale/superseded/rejected/invalidated），无 overload。
- `decision_inputs` 作为 JSON 列存储，支持 decision replay（HIGH 1）。

**Cons**
- 新增 migration（config-key 守卫，对齐 `runDestructiveMigration` 模式 sqlite.ts:593）。
- 代码库已有 5 套 status vocab，再加一套。
- Phase 1 record 与 discoveries/action_candidates 行有信息重叠。

### 方案 B：复用现有 lifecycle（discoveries 表）

**Pros**
- 零 migration；discoveries 已有 `status` / `dedup_key` / `occurrence_count` / `metadata` JSON。
- action candidates 已经落 discoveries（`auto_applicable=false`）。

**Cons**
- discoveries 的 `status` vocab（`pending|seen|resolved|dismissed`，sqlite.ts:2563）**没有 stale/superseded/invalidated**——要么扩展（本身就是 migration），要么 overload（Wrong Abstraction，display filter 必漏）。
- discoveries **没有 fingerprint 列**；`dedup_key` 是实体集合键，不是结论键。同一实体集的两个不同结论会碰撞。
- 把 recommendation 塞 discoveries 会**混淆"信号"与"结论"**——正是本合同要划的边界，存储层就毁了。
- replay/diff 需要完整 record shape；塞 `discoveries.metadata` JSON 不可查、不可索引。

### 推荐：**方案 A（新表），但 migration 延后**

理由：本合同的核心就是分离"结论"与"信号"。方案 B 的"零 migration"优势是假的——它要么需要 status 扩展 migration，要么靠 overload 牺牲正确性。discoveries 表的 dedup_key/fingerprint 缺失会让 stale 检测和"拒绝后不重复"两条硬要求落空。

**但 Phase 0 不落表**：本 spec 只定义逻辑 shape + 推荐 A。物理 CREATE TABLE、`recommendation_lifecycle_history` 副表、索引、config-key migration key 命名——全部留给 Phase 1 data-model decision gate（issue 原文："本阶段涉及数据模型和稳定 API，实施前必须单独过 data-model decision gate"）。

---

## 11. 隐私与 display 边界（#327 依赖）

> 验收 #5 + 硬约束"#327 尚未完成全部 surface 前，不进入默认展示"。

### 11.1 #327 现状（事实）

- 仅 `graph_query` + `get_timeline` 经 `buildToolResult` 脱敏（`src/mcp/tools/result-builder.ts:79`），且仅在 `CBRAIN_OUTPUT_BOUNDARY=structured` 模式。
- 当前默认 `legacy`（`src/mcp/output-mode.ts:18`）—— **不脱敏**，raw 全量回传。
- recall / discovery / action-candidate / 旧 JSON 工具**全未覆盖**（#327 Phase 2-4，gate G3/G4/G5）。
- 即使 structured 模式，也不是 prompt-injection 隔离（Hermes 合并 content+structuredContent，spec §3.2）——只是标注 + raw 收缩。

### 11.2 recommendation display 准入条件

recommendation 的 display 文本会经 recall/discovery/action-candidate MCP surface 流出——**这些 surface 当前都在 legacy（不脱敏）**。所以：

- **recommendation record 不得进入默认 Agent display**，直到：
  1. #327 覆盖目标 surface（recall/discovery/action-candidate 至少进 Phase 2-3），且
  2. `CBRAIN_OUTPUT_BOUNDARY` rollout 默认翻 `structured`（plan Execution Handoff："Stop for Codex before any rollout-default change"）。
- Phase 0 合同是 display-agnostic 的；Phase 1 实现必须把 display 准入挂在上述两个条件之后。

### 11.3 三层 ref/display 模型（MED 1 修正）

> rev1 把 evidence ref 叫"隐私边界"——错。ref 含 raw slug，是 internal/audit 引用，**不是** privacy-safe。rev2 分三层（详见 §4.2）：

| 层 | 用途 | 清洗 |
|:--|:--|:--|
| **internal ref**（evidence_manifest / target_ref / decision_inputs） | audit/debug，含 slug | 无；只进 audit/raw surface |
| **runtime display**（target_display） | 给终端用户，建议须可操作 | `safeTitle(slug, entityLookup, fallback)`（discovery-digest.ts:109）/ `safeDisplayText`（action-candidates.ts:310）+ #327 boundary；**不一刀切匿名**，清洗失败才退化通用 fallback |
| **公开示例 / 测试 / 文档** | issue/PR/spec | 强制匿名占位符（实体A/主题B/方案C/组织D） |

- runtime display 用**真实但清洗过的 title**——一刀切输出"实体A"会让建议失去操作意义（Codex MED 1）。
- record 的所有公开示例（本 spec + 任何测试）只用匿名占位符。
- audit/raw surface 含 slug/路径/inspected_claims，必须经 #327 `redactAudit`（`src/mcp/tools/audit-redact.ts:17`）脱敏后才能流出。
- `decision_inputs.inspected_claims`（claim 文本）属 audit/raw 层，display 不直接展示。

---

## 12. 推导结构（issue 允许的节点与边）

> issue 推导结构约束：允许节点 evidence/claim/assumption/constraint/option/recommendation；允许边 supports/contradicts/depends_on/satisfies/violates/limits/preferred_over/leads_to；causes 仅在记录明确因果关系时。

Phase 1 确定性 recommendation 推导浅（rule → evidence → conclusion），但合同用统一图词汇，供 Phase 3（LLM QuestionFrame）复用。

```ts
type DerivationNode =
  | { kind: "evidence";     ref: string }   // → evidence_manifest entry
  | { kind: "claim";        text: string }  // 显式可审计断言
  | { kind: "assumption";   text: string }
  | { kind: "constraint";   ref: string }   // → constraints field
  | { kind: "option";       action: ProposedAction }
  | { kind: "recommendation"; ref: string }; // → record itself

type DerivationEdge =
  | { type: "supports";       from: string; to: string }
  | { type: "contradicts";    from: string; to: string }
  | { type: "depends_on";     from: string; to: string }
  | { type: "satisfies";      from: string; to: string }
  | { type: "violates";       from: string; to: string }
  | { type: "limits";         from: string; to: string }
  | { type: "preferred_over"; from: string; to: string }
  | { type: "leads_to";       from: string; to: string }
  | { type: "causes";         from: string; to: string; causality_recorded: true };
```

**硬约束**：`causes` 边必须 `causality_recorded: true`（有明确因果记录），否则禁用。**不保存模型私有 chain-of-thought**——只存可审计的显式理由、规则、证据、结果。Phase 1 derivation 可选字段（多数 maintenance record 推导太平坦，不必强填）；Phase 3 LLM 推导必填。

---

## 13. 与同级系统的分工（验收 #1 详述）

| 同级系统 | 现有产出 | 与 recommendation 的关系 |
|:--|:--|:--|
| **agentic_research**（research.ts） | `SearchResult[]` / `ResearchReasoning`（内部） | research 是证据来源；recommendation 消费 evidence。research 不产结论提案。 |
| **EvidenceBoard**（evidence.ts） | 5-bucket `EvidenceBoardResult` | board = 证据层（facts/user_thoughts/candidates/gaps/conflicts）。recommendation 引 board 输出进 manifest，但加 conclusion+constraint+fingerprint 三层 board 没有的东西。 |
| **next_actions / attention queue**（attention-queue.ts） | `NextAction`（纯函数，无 status） | NextAction 是触发信号原料；RecommendationRecord 是合成结论。queue 可展示 current recommendation，但 `NextAction ≠ RecommendationRecord`。 |
| **Compounding Review**（compounding-review.ts） | `compounding_review_candidates`（LLM 主题观察） | LLM 意见型，自己的生命周期。Phase 1 recommendation 是确定型（无 LLM）。共享审计副表**模式**，不共享域。 |
| **action candidates**（action-candidates.ts） | `PersistedActionCandidate`（落 discoveries） | 是 recommendation 的上游候选来源之一；recommendation 多出 fingerprint/inputs_hash/dependency_manifest/lifecycle 合同层。 |

**核心分工**：`detection（信号）→ recommendation（确定性结论）→ action（执行）`。三段式，recommendation 居中，两端硬墙。

---

## 14. Fixtures（≥10，匿名）

> 验收 #3：至少 10 条匿名 fixture，覆盖 issue Phase 0 全部验收场景。

每条 fixture：`given（状态）/ when（操作）/ then（合同断言）`。全部用匿名占位符。

### F1 — 稳定重放（integrity + decision replay）
**given**：实体A、实体B 存在 reports_to 候选边；policy/ontology 不变。
**when**：同一 rule 两次产出 recommendation。
**then**：两次 `inputs_hash` 与 `fingerprint` 都相同；integrity check（§8.1）通过；decision replay（§8.2，离线 `rule(decision_inputs)`）重现同 conclusion。

### F2 — 依赖变化 → stale（pending 和 current 都转，HIGH 2）
**given**：F1 的 record 处于 `pending`（或 `current`）。
**when**：实体A 被编辑，rule 声明的依赖字段变化 → 重算 `inputs_hash'` ≠ `record.inputs_hash`。
**then**：freshness gate 把 record 转 `stale`（**无论原 pending 还是 current**）；不得展示。

### F3 — policy diff（pending 和 current 都转）
**given**：F1 record 记录 `policy_version = H(rule code v1)`，处于 pending/current。
**when**：rule 代码改动，`policy_version = H(rule code v2)`。
**then**：`constraints.policy_version` 结构性不匹配 → record 转 `invalidated`（pending/current 同样）；diff axis = `constraint`。

### F4 — candidate 不升级为 fact（confirm ≠ execute）
**given**：recommendation 引用一条 `trust_state=candidate` 的 reports_to 证据，处于 `pending`。
**when**：用户"confirm"该 recommendation（pending → current）。
**then**：**仅** lifecycle 推进到 `current`；**不写**任何 `trust_state=trusted` 的 link/timeline；**不执行** proposed action；candidate 证据保持 candidate。

### F5 — inactive evidence 排除
**given**：实体A 有两条 reports_to 证据，一条 `trusted`、一条 `rejected`。
**when**：rule 构建 evidence_manifest（过 `INACTIVE_STATES`/`ACTIVE_LINK_SQL`）。
**then**：`rejected` 那条**结构性不进 manifest**（manifest 内无 `active` 字段，inactive 无法表达）；fingerprint 只反映 active 证据。该 `rejected` 证据日后若翻 `trusted` → decision_inputs 变 → inputs_hash 变 → 旧 record stale（F11）。

### F6 — conflict → abstain（仅命中本 record scope，MED 3）
**given**：本 record 关注实体A；同时存在关于**无关**实体Z 的矛盾证据（全局 `EvidenceBoard.conflicts` 非空）。
**when**：rule 评估实体A 的建议。
**then**：实体Z 的冲突**不阻断**本建议（不命中 decision_inputs）。仅当冲突证据 ∈ 本 record 的 decision scope → `conclusion = { kind: "abstain", reason: "conflict" }`。

### F7 — 无证据 → abstain
**given**：方案C 无任何 active 证据（facts 空、candidates 全 inactive）。
**when**：rule 评估。
**then**：`conclusion = { kind: "abstain", reason: "insufficient_evidence" }`（或 `inactive_evidence_only`）。

### F8 — 拒绝后不重复（同 fingerprint 抑制窗口）
**given**：record R（maintenance_key=K, fingerprint=F）被用户 `rejected`。
**when**：rule 再次产出同 K 同 F 的 record（输入未变）。
**then**：抑制窗口内**不重新提案**为 active。同 K 不同 fingerprint（输入变了）不受限，仍可新提案。

### F9 — 三层 ref/display 分层（MED 1）
**given**：任意 maintenance record。
**when**：导出公开示例/测试 → 匿名占位符；runtime display → `safeTitle` 清洗；audit/raw → `redactAudit`。
**then**：公开示例无真实 slug/路径/凭据串；runtime display 是**真实清洗过的 title**（可操作）；audit/raw 含 slug 但经脱敏。internal ref（含 slug）不直接给用户。

### F10 — 不自动执行
**given**：任意 propose 型 record。
**when**：record 创建/confirm。
**then**：`applicability.auto_execute === false`；producer 无任何写操作调用；无 repair/merge/sync/delete 触发；confirm 只改 lifecycle。

### F11 — 事实升级改输入哈希（对抗）
**given**：F1 record 的 decision_inputs 含 `trust_state=candidate` 证据。
**when**：该证据独立升为 `trusted`（经用户确认流，非 recommendation 自动）。
**then**：decision_inputs.entity_snapshot 变 → `inputs_hash` 变 → fingerprint 变 → 旧 record `stale`，不作 current。

### F12 — 非确定性攻击（对抗）
**given**：同一输入，但 manifest/declarations 数组顺序不同。
**when**：算 inputs_hash / fingerprint。
**then**：canonical JSON 强制排序 → hash 相同；顺序差异不影响指纹。

### F13 — 隐式执行攻击（对抗）
**given**：恶意/失误的 producer 规则尝试在结论里嵌写操作。
**when**：合同校验。
**then**：`ProposedAction.type` 只允许 `review|dry_run|notify_draft`；`auto_execute:false` 不变量；任何写操作尝试 = 合同违反，record 拒绝创建。

### F14 — integrity check ≠ decision replay（HIGH 1）
**given**：一条 record，其 `conclusion` 被手动篡改，但 `decision_inputs` + `inputs_hash` 未变。
**when (integrity check)**：重算 `fingerprint'` ≠ `record.fingerprint` → 完整性失败（检测篡改）。
**when (decision replay)**：离线 `rule(decision_inputs)` 得到**原** conclusion ≠ 被篡改的 conclusion → replay 失败（证明结论不可从输入重推出现值）。
**then**：两个操作给出不同诊断——integrity 抓篡改，replay 抓"输入推不出结论"。两个操作各有 fixture，不混用。

### F15 — A→B→A 状态回摆 + revalidation（HIGH 3）
**given**：record R（inputs_hash=A）处于 current。状态变 B（依赖漂移）→ R 转 stale。
**when**：状态恢复回 A（依赖再变回）→ 重算 `inputs_hash'` = A = R.inputs_hash。
**then**：R 经完整 revalidation **原地复活**为 current（保留用户确认），写 lifecycle_history（`revalidated` + 时间）；**不需要新 fingerprint**，partial unique index 不冲突（stale 不参与 active 唯一约束）。

### F16 — 无关字段变化不 stale（MED 2）
**given**：known_relations rule 只声明依赖 `links(reports_to)`；record R 处于 current。
**when**：实体A 新增一个**tag**（rule 未声明依赖 tags）。
**then**：rule 的 declared projection 不含 tags → `inputs_hash'` == R.inputs_hash → **不转 stale**，R 仍 current 展示。

### F17 — rejected 同 fingerprint 跨窗口边界
**given**：record R（fingerprint=F）被 rejected，抑制窗口为 session。
**when**：窗口过期后 rule 再产同 F record；或用户主动"重新考虑"。
**then**：允许以新 record_id 重新进 active（同 fingerprint，因 R 已 rejected 不在 active 唯一约束内）；写新 lifecycle_history。

---

## 15. 对抗审查（task #7 + rev2 Codex 6 项）

> 原 7 类攻击 + rev2 Codex HIGH 1-3 / MED 1-3，全部合同层缓解 + fixture 覆盖。

| # | 攻击 | 缓解（合同层） | fixture |
|:--|:--|:--|:--|
| 1 | **事实升级**：candidate→trusted 后旧 record 冒充 current | decision_inputs 含 trust_state → `inputs_hash` 捕获升级 → freshness gate 转 stale（pending/current 都转） | F11 |
| 2 | **inactive evidence**：rejected/superseded 漏进结论 | manifest 无 `active` 字段，inactive 结构性无法进入；翻转由 inputs_hash 捕获 → stale | F5、F11 |
| 3 | **conflict**：矛盾下仍 propose | **仅命中本 record scope 的冲突** abstain；无关冲突不阻断（MED 3） | F6 |
| 4 | **隐私泄漏**：record/display 泄漏 vault | 三层模型：internal ref（audit）≠ runtime display（`safeTitle` 清洗真实 title）≠ 公开匿名；display 准入挂 #327；audit/raw 经 `redactAudit`（MED 1） | F9、§11 |
| 5 | **隐式执行**：recommendation 触发写操作 | `auto_execute:false` 不变量；`ProposedAction.type` 白名单；confirm ≠ execute；合同校验拒绝写操作 | F10、F13 |
| 6 | **非确定性 hash**：顺序/时间/随机致同输入不同指纹 | canonical JSON 排序；NFKC；排除时间/随机/自增 id；显式 sort | F12 |
| 7 | **旧 record 冒充 current**：stale/superseded 仍展示 | display 门控 = `lifecycle ∈ {pending,current}` **AND** freshness 通过（HIGH 2）；stale 经 revalidation 可复活，带审计（HIGH 3） | F2、F15 |
| 8 | **HIGH 1 replay 名不副实**：只验完整性不能重推结论 | 拆 integrity-check（§8.1）vs decision-replay（§8.2，离线 `rule(decision_inputs)`）；存 canonical `decision_inputs`；`inputs_hash` ≠ `fingerprint` | F1、F14 |
| 9 | **HIGH 2 pending 绕过 freshness** | freshness gate 同时约束 pending 与 current；display 前强制校验 | F2、F3 |
| 10 | **HIGH 3 fingerprint UNIQUE + A→B→A 死锁** | `record_id`（实例身份）≠ `fingerprint`（内容身份，非唯一）；partial unique index 仅约束 active；stale 同 fingerprint 经 revalidation 带审计复活 | F15、F17 |
| 11 | **MED 2 无关字段 stale 风暴** | per-rule declarative dependency manifest；未声明字段不进 inputs_hash；FTS/Lance 仅 storage-health 声明时才进 | F16 |

**审查结论**：7 类原攻击 + Codex 6 项（HIGH 1-3 / MED 1-3）均有合同层缓解 + fixture 覆盖。隐私（#4）依赖 #327 后续 surface 覆盖——**已知前置依赖**，Phase 1 实现时强制 gate。

---

## 16. Phase 0 非目标（不做）

- 不做通用专家系统。
- 不保证开放世界建议绝对正确。
- 不把"持久化一次回答"宣传为"决策正确"。
- 不用缓存掩盖证据选择不稳定。
- 不自动执行现实操作。
- 不新增不可解释的 LLM planner 权限。
- 不把 recommendation 写成 trusted fact。
- 不修改数据库、MCP schema、tool profile。
- 不实现 replay/diff（Phase 2）、open-question shadow（Phase 3）、policy templates（Phase 4）。

---

## 17. 留给 Phase 1 的开放问题（data-model gate 决策）

Phase 0 不决策，仅列出：

1. **物理 schema**：CREATE TABLE 的列、`record_id` 主键、**partial unique index** `(maintenance_key, fingerprint) WHERE lifecycle IN (pending,current)`、`inputs_hash` 索引、CHECK 约束、config-key migration key 命名。
2. **审计副表**：`recommendation_lifecycle_history` 是否同构 `compounding_review_feedback`（含 revalidation/复活记录），还是复用一张泛化 audit 表。
3. **producer 注册机制**：rule_id 命名空间、code_hash 计算边界（整文件 vs 函数）、如何防 producer 偷偷写、**dependency_manifest declaration 的审查流程**（核对 ⊆ 实际读取集合）。
4. **decision_inputs 存储成本**：canonical 冻结输入作为 JSON 列的体积；是否需要分离 blob 存储；replay 的离线 rule 执行环境。
5. **display 准入**：与 #327 Phase 2-4 的具体对接点；recommendation 走哪个 MCP surface；`safeTitle` 在 recommendation 上下文的 fallback 策略。
6. **abstain 展示**：是否给"为什么没建议"的查询入口。
7. **与 next_actions 的并轨**：attention queue 是否直接消费 freshness-gated `current` recommendation，还是双轨。
8. **抑制窗口策略**：rejected 同 fingerprint 的抑制窗口（session vs TTL）的默认值与配置点。

---

## 18. 验收对照表

| issue Phase 0 验收 | 本 spec 章节 |
|:--|:--|
| 1. Recommendation Contract spec，与 research/EvidenceBoard/next_actions/Compounding Review 分工 | §2、§13 |
| 2. 稳定最小 record shape + 生命周期，不提前锁 DB 迁移 | §4、§5、§6、§7、§10 |
| 3. ≥10 条匿名 fixture，覆盖全部验收场景 | §14（17 条：F1–F17） |
| 4. 新表 vs 复用 lifecycle trade-off + 推荐 | §10 |
| 5. #327 未完成前不进默认 display | §11 |
| 6. 公开示例匿名占位符 | §14 + §11.3 |
| 推导结构约束（节点/边/causes 限定） | §12 |
| 不保存模型私有 CoT | §12 + §0 |
| 对抗审查 7 类 + Codex 6 项 | §15（11 行） |

**rev2 Codex 修订验收对照**：

| Codex 修订验收 | 本 spec 落点 |
|:--|:--|
| 1. integrity-check vs decision-replay 两类语义 + fixture | §8.1 / §8.2 + F1、F14 |
| 2. pending/current 都受 freshness gate | §5.3 + F2、F3 |
| 3. A→B→A 生命周期回摆 | §5.4 + F15、F17 |
| 4. internal ref 与用户 display 分层 | §4.2、§11.3 + F9 |
| 5. dependency hash 改 rule-scoped + 无关变化不失效 | §7.1 + F16 |
| 6. conflict scope 与 high-impact policy 明确 | §9、§9.1 + F6 |
| 7. 仍 Phase 0：只改 spec，不写 plan/不改 runtime/DB/MCP，不 push | §0 + 本文件是唯一交付 |

Codex comment 任务边界对照：

| 任务 | 章节 |
|:--|:--|
| 1. 只读核对现有模块 | 研究阶段（4 个并行 Explore agent），结论见各章 file:line 引用 |
| 2. 新建 spec | 本文件 |
| 3. recommendation 与 fact/recall/research/attention/action 边界 | §2、§3 |
| 4. record shape/lifecycle/fingerprint/dependency hashes/replay/diff/invalidation/abstain | §4–§9 |
| 5. 新表 vs 复用 lifecycle trade-off + 推荐 | §10 |
| 6. ≥10 匿名 fixture | §14 |
| 7. 对抗审查 | §15 |

硬约束对照：不改 src/DB/MCP（§0）；不调 LLM（§0、§9）；不存 CoT（§12）；不自动执行（§4 `auto_execute:false`、§15 #5）；fixture 匿名（§14）；#327 前不展示（§11）。

---

_交付方式：本 spec 单独 commit，不 push、不关闭 issue。停在 Codex review gate，不进入 Phase 1 实现。_
