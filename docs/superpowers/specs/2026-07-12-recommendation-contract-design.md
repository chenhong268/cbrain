# Recommendation Contract — 设计 spec（Phase 0）

> Issue: #328（roadmap: governed Recommendation Record and replayable decision support）
> Phase: **0（仅合同设计，不改运行时）**
> 状态：rev4 — 待 Codex 第四轮 re-review
> 依赖：#327（output trust boundary）— display 前置；未完成全部 surface 前 recommendation 不进默认展示

**修订记录**：
- **rev4**（本轮）：修 Codex 第三轮 `CHANGES REQUESTED` —— HIGH 1（canonical 递归算法：对象按码点排 key、数组按完整元素串排序、prose/identifier 分开归一、tie case 覆盖 rollback_note/trust_state/filter）、HIGH 2（registry 暴露 version-pinned `captureInputs()` 投影器，creation 与 freshness 共用，不可用→version_invalid 不猜）、HIGH 3（A→B→A 拆 freshness-only 路径 1 vs producer-produced 路径 2，删"无新 record"绝对断言）、MED（fingerprint 身份 wording 改为"完整 canonical payload 相同"）。
- rev3：HIGH 1（完整 immutable payload）、HIGH 2（真双轴字段）、HIGH 3（versioned rule registry）、MED 1-4、LOW。
- rev2：HIGH 1（decision_inputs + integrity/replay 拆分）、HIGH 2（pending freshness）、HIGH 3（record_id≠fingerprint）、MED 1-3。
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
  // ── 身份 ──
  record_id: string;              // 不可变实例身份（主键），不进 fingerprint

  // ── immutable payload（HIGH 1：整体进 fingerprint，见 §6）──
  payload: RecommendationImmutablePayload;
  fingerprint: string;            // = hash(canonical(payload))，内容身份，非唯一（§5.5）

  // ── mutable 状态（不进 fingerprint）──
  created_at: string;
  last_revalidated_at: string;    // 最近一次 freshness check 通过时间
  lifecycle_status: LifecycleStatus;     // HIGH 2：真双轴之一（用户/系统驱动）
  freshness_status: FreshnessStatus;     // HIGH 2：真双轴之二（依赖/版本驱动，独立字段）
  suppressed_until: string | null;       // MED 4：rejected 的 durable 抑制到期；null=直到用户显式 reopen
}

// ── HIGH 1：明确的不可变语义负载，整体纳入 fingerprint ──
interface RecommendationImmutablePayload {
  namespace: string;              // Phase 1 固定 "maintenance"
  maintenance_key: string;        // 归一化稳定键，见 §4.1
  inputs_hash: string;            // = hash(decision_inputs)，纯输入身份（§6）
  conclusion: RecommendationConclusion;
  decision_inputs: DecisionInputs;        // 冻结重放输入（source of truth，§4.3）
  evidence_manifest: EvidenceManifestEntry[];  // decision_inputs 的证据投影（§4.3）
  constraints: RecommendationConstraints;
  dependency_manifest: DependencyManifest;     // producer schema（声明读了哪些字段，§7）
  applicability: Applicability;                // 含 auto_execute —— 篡改即 fingerprint 失配
  risks: string[];
  gaps: string[];
  producer: RecommendationProducer;            // 含 rule_id + rule_version（HIGH 3）
}
// payload 排除：record_id、created_at、last_revalidated_at、lifecycle_status、freshness_status、
//              suppressed_until、target_display（MED 1 read-time 投影）。这些是身份/状态/展示，非语义。

type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

interface ProposedAction {
  type: "review" | "dry_run" | "notify_draft";  // 对齐 ActionCandidateActionType
  target_ref: string;            // internal ref（audit 层，含 slug，§4.2/§11）—— 持久化、进 fingerprint
  reason: string;                // 显式可审计理由，非模型 CoT
  rollback_note?: string;        // 对齐 RepairAction.rollbackNote
  // MED 1：无 target_display —— 安全 title 是 read-time projection，读取时经 #327 + safeTitle 生成（§4.4）
}

interface DecisionInputs {
  // MED 2 source of truth：冻结重放输入。离线重跑 rule 所需的全部有界输入。
  // Phase 1 maintenance 多为结构化信号；rule 检视 claim 文本时进 inspected_claims（audit/raw）。
  signals: Record<string, unknown>;               // 结构化输入（计数/分数/集合）
  inspected_claims?: string[];                     // rule 实际检视的 claim 文本（audit/raw）
  entity_snapshot: Record<string, EntityProjection>;  // 仅 dependency_manifest 声明的字段
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
// MED 2：manifest 是 decision_inputs 的确定性投影——integrity 校验 evidence_manifest ⊆ projection(decision_inputs)。

interface RecommendationConstraints {
  policy_version: string;       // hash of policy bundle（含 rule registry manifest，§7.2）
  ontology_version: string;     // hash of ontology.yaml
  schema_version: string;       // 合同自身版本，如 "rec-v1"
}

interface DependencyManifest {
  // per-rule 声明式依赖（MED 2：producer schema）。声明 rule 读了哪些字段——是 schema，不是值。
  rule_id: string;                     // 声明归属（= producer.rule_id，integrity 校验一致）
  declarations: DependencyDeclaration[];
}

interface DependencyDeclaration {
  slug?: string;                // 缺省 = global；实体级依赖填 slug
  table: "pages" | "links" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  fields: string[];             // 只这些字段；如 links 只取 relation + trust_state + other_slug
  filter?: "active" | "all";    // 默认 active（过 ACTIVE_LINK_SQL）
  // 关键：fts/lance 只在 storage-health 类 rule 显式声明时才进 hash——索引重建不让语义建议 stale。
}

interface Applicability {
  audience: "user_only";        // Phase 1 固定
  auto_execute: false;          // Phase 1 不变量；进 payload → 篡改为 true 即 fingerprint 失配（HIGH 1）
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
  // HIGH 3：versioned rule registry——code_hash 只识别版本，rule_version + registry_ref 才能定位可执行 runner
  rule_id: string;              // 确定性规则标识
  rule_version: string;         // 规则逻辑的语义版本（如 "1.2.0"）
  code_hash: string;            // 该版本 rule 实现的哈希
  registry_ref: string;         // 版本化 runner 定位符（如 "cbrain.rules:maintenance.known_relations@1.2.0"）
}

// ── HIGH 2：真双轴。lifecycle（用户/系统驱动）与 freshness（依赖/版本驱动）是独立字段 ──
type LifecycleStatus =
  | "pending"      // 创建默认，待用户确认
  | "current"      // 用户已确认相关（confirm 只改 lifecycle，不执行）
  | "superseded"   // 同 maintenance_key 新 active record 取代（§5.5 原子事务）
  | "rejected"     // 用户显式拒绝；durable 抑制（suppressed_until，MED 4）
  | "invalidated"; // 终态结构退休（namespace/contract 废弃；Phase 1 罕用）

type FreshnessStatus =
  | "fresh"            // inputs_hash + 版本约束都匹配当前状态
  | "stale"            // 声明依赖漂移（inputs_hash 不匹配）；recoverable
  | "version_invalid"; // policy/ontology/schema 版本结构不匹配；recoverable（版本恢复即可）

// 关键：依赖漂移只改 freshness_status，不碰 lifecycle_status —— A→B→A 路径 1 不丢 pending/current 身份（HIGH 2/3）

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

### 4.3 三份输入的 source of truth（MED 2）

record 有三处看似重叠：`decision_inputs` / `evidence_manifest` / `dependency_manifest`。Codex MED 2 指出若三处独立存真相会不一致。明确角色与派生关系：

| 字段 | 角色 | 真相来源 | 派生关系 |
|:--|:--|:--|:--|
| `decision_inputs` | **冻结重放输入**（rule 实际读到的值） | **source of truth** | producer 执行时冻结 |
| `evidence_manifest` | decision_inputs 的**证据投影**（可引用的 active 证据，stable ref） | 派生 | `evidence_manifest ⊆ projection(decision_inputs)`，确定性投影 |
| `dependency_manifest` | **producer schema**（rule 声明读哪些字段/表，是 shape 非值） | 派生 | rule 注册时声明；`entity_snapshot` 字段集 ⊆ declarations 覆盖 |

**一致性校验**（integrity，§8.1 必查）：
1. `hash(decision_inputs) == record.inputs_hash`（输入未篡改）
2. `evidence_manifest` 每条都能追溯到某条 `decision_inputs` 条目（投影一致性）
3. `decision_inputs.entity_snapshot` 的每个字段都落在 `dependency_manifest.declarations` 内（producer 没读未声明字段——否则 freshness 会漏）
4. `dependency_manifest.rule_id == producer.rule_id`（声明归属一致）

三份都进 immutable payload（HIGH 1），任一篡改 → fingerprint 失配；交叉不一致 → integrity 失败。

### 4.4 target_display —— read-time projection（MED 1）

> Codex MED 1：安全 title 随页面标题与输出边界变化，属当前 read-time projection。存进 frozen conclusion 会让纯展示变化造新 fingerprint，且扩大持久化隐私面。

- `ProposedAction` **只持久化 `target_ref`**（进 fingerprint）。
- `target_display` **不持久化**、不进 payload；在 MCP/display 读取时动态生成：
  ```
  target_display = sanitize_via_#327(safeTitle(resolve_slug(target_ref), entityLookup, fallback))
  ```
- 公开投影类型（`RecommendationDisplay`：含 target_display + 清洗后的 reason/risks）与内部 record 类型分开——display 是 read-time 派生，不是存储字段。
- 效果：页面改名或 #327 boundary 升级只改 display，不改 fingerprint、不造新 record。

---

## 5. 生命周期

> 验收 #2：定义生命周期。

**不复用 `CandidateStatus` enum**（`pending|accepted|rejected|deferred|disabled|superseded`，`src/storage/sqlite.ts:138`）。原因：recommendation 需要**真双轴**——用户/系统驱动的 lifecycle **加** 依赖/版本驱动的独立 freshness；`CandidateStatus` 是单 enum，无法表达"依赖漂移只动 freshness、不丢 lifecycle 身份"（HIGH 2）。把 stale 塞进 lifecycle enum 正是 rev1/rev2 的错。复用 = Wrong Abstraction + display filter 漏判。

**但复用审计副表模式**：`compounding_review_feedback`（`src/storage/sqlite.ts:393`）是 action→status 转换 + reason 的审计副表，recommendation 应有同构的 `recommendation_lifecycle_history`（记 lifecycle 与 freshness 转换，逻辑定义，Phase 1 落表）。

### 5.1 真双轴（HIGH 2：落到类型，不是文字）

rev1/rev2 文字说 lifecycle/freshness 正交，但 `stale` 仍混在 lifecycle enum 里——current 变 stale 后丢失"曾是 current"身份，revalidation 该恢复 pending 还是 current 只能靠猜 history。rev3 把双轴**落到两个独立持久化字段**：

- **`lifecycle_status`**（用户/系统驱动）：`pending | current | superseded | rejected | invalidated`。**不含 stale**。
- **`freshness_status`**（依赖/版本驱动，独立字段）：`fresh | stale | version_invalid`。

**核心不变量**：依赖漂移**只改 `freshness_status`，永不碰 `lifecycle_status`**。于是 A→B→A **路径 1**（无 producer 替代）时 lifecycle 全程不动（一直是 current 或 pending），freshness stale→fresh 自然恢复——无"复活到哪个状态"的歧义。**路径 2**（producer 已产替代）则 A 经 §5.5 转 superseded，需新 record/reactivation（§5.4）。

**展示门控** = `lifecycle_status ∈ {pending, current}` **AND** `freshness_status == fresh`。

> `lifecycle.invalidated` 仅用于**终态结构退休**（namespace/contract 废弃），Phase 1 罕用；版本漂移走 `freshness.version_invalid`（可恢复），不进 lifecycle。

### 5.2 lifecycle 转换（用户/系统驱动，写 history）

```
   创建 → pending ──(用户 confirm)──→ current
                │                       │
                │   (同 key 新 active 插入，§5.5 原子 supersede)
                │                       ▼
                │                   superseded
                │
                ├──(用户 reject, 设 suppressed_until)──→ rejected
                └──(namespace/contract 废弃)──────────→ invalidated
```

- **pending → current**：用户显式 confirm。confirm **只改 lifecycle，不执行 proposed action**（`auto_execute:false` 不变）。
- **→ superseded**：同 `maintenance_key` 新 active record 插入，旧 active 原子转 superseded（§5.5）。
- **→ rejected**：用户拒绝。写 `suppressed_until`（MED 4 durable）。
- **→ invalidated**：终态退休（罕用）。

### 5.3 freshness gate（每次读/display 前重算，写 freshness_status + last_revalidated_at）

> rev4 修正（HIGH 2）：rev3 说"按 dependency_manifest 重读声明字段 → inputs_hash'"——**不够**。declarations 只声明原始表/字段，无法重建派生 `signals`、`inspected_claims` 顺序/过滤、聚合结果。不同实现者会 hash 不同投影却都自称合规。freshness 必须用与 creation **同一个 version-pinned 投影器** `captureInputs()`。

任何 record（无论 lifecycle）读/display 前必须重算 freshness：

1. 经 versioned rule registry 解析 `producer.{rule_id, rule_version}` 的 `captureInputs()` 投影器（§7.2）。
2. 按 `dependency_manifest` 重读声明字段的**当前**值，喂给 `captureInputs()` → 重建当前 `decision_inputs'` → `inputs_hash'`。
   - 若该 rule_version 的 `captureInputs` 不可用（purged/incompatible）→ `freshness_status = version_invalid`（结构化，**不猜**），stop。
3. 重算当前 `constraints'`（policy/ontology/schema version）。
4. 写 `freshness_status`：
   - `inputs_hash' != record.inputs_hash` → `stale`。
   - `constraints'` 版本结构不匹配，或 captureInputs 不可用 → `version_invalid`。
   - 都匹配 → `fresh`，更新 `last_revalidated_at`。
5. **display 只展示 `freshness_status == fresh` 的 pending/current**。

> `captureInputs()` 与 creation 用**同一精确版本**（§7.2），保证 creation 与 freshness hash 的是同一规范投影。依赖漂移**不**改 lifecycle。pending 和 current 一视同仁过 gate。

### 5.4 A→B→A 回摆（HIGH 3：两条路径，不能混）

> rev4 修正：rev3 §5.4 无条件说"A→B→A 无新 record，freshness 翻回即可"。但若 producer 在 B 态**跑过**，按 §5.5 它已原子 supersede A 并插入 B——A 的 lifecycle 变 `superseded`，再回 A 不能只靠 freshness 恢复展示。必须分两种情况。

**路径 1 — freshness-only 观察**（producer **未**在 B 态跑，无替代 record 产生）：
- A→B：freshness gate 观察到漂移 → `freshness_status: fresh → stale`，**lifecycle 不动**（A 仍 pending/current）。
- B→A：下次 freshness gate 经 `captureInputs()` 重算 `inputs_hash' == record.inputs_hash` → `freshness_status: stale → fresh`，**lifecycle 仍不动**。
- **无新 record、无新 fingerprint**——A 身份全程保留，直接重新展示。（F15）

**路径 2 — producer 已在 B 态产出替代 record**（maintenance cycle / on-demand 在 B 态跑了 producer）：
- A→B + producer 跑：producer 用 B 态输入算出**不同** `inputs_hash_B` → 按 §5.5 原子 supersede：A `→ superseded`，新 record B（新 fingerprint）→ pending。
- B→A（状态恢复到 A 的输入）：A **仍是 `superseded`**（freshness 翻转救不了 superseded 的 lifecycle）。要重新展示 A 的内容：
  - **(i)** producer 再跑，`captureInputs()` 产出原 `inputs_hash_A` → 插入**新 record（新 record_id，同 fingerprint F_A）**为 pending（A 已 superseded，不冲突 active 唯一约束）；写 lifecycle_history（`reactivated`）。
  - **(ii)** 或显式 reactivation 转换（superseded → pending），带 history。
  - 二选一由 Phase 1 policy 定（§17）；**不能**只翻 freshness。（F23）

> 区分关键：**producer 是否在中间态跑过、产生过替代 record**。跑过 → 路径 2（superseded，需新 record/reactivation）；没跑 → 路径 1（freshness 自恢复）。rev3 的"无新 record"断言删除。

### 5.5 active 唯一性 + 原子 supersede（MED 3）

> Codex MED 3：rev2 的 `UNIQUE(maintenance_key, fingerprint) WHERE active` 只防"同 key 同 fingerprint"，仍允许同 key 两个**不同** fingerprint 同时 active。rev3 收紧。

产品语义：**每个 `maintenance_key` 同时最多一条 active（pending 或 current）**——一个建议槽位不该有两个矛盾建议并存。

```sql
-- 逻辑约束（Phase 1 落表；additive migration，§10）
CREATE UNIQUE INDEX idx_rec_active_unique
  ON recommendation_records (maintenance_key)
  WHERE lifecycle_status IN ('pending', 'current');
```

**原子 supersede**（producer 插入新 record 时，同事务）：
- 同 key 无 active → 新 record → pending。
- 同 key 有 active 且**同 fingerprint** → 幂等 no-op（已存在）。
- 同 key 有 active 且**不同 fingerprint** → 旧 active → superseded + 新 record → pending（同事务，避免窗口期双 active）。

`record_id` 是主键；`fingerprint` 非唯一（多条历史 record 可同 fingerprint，superseded/stale 不参与 active 唯一约束）。

### 5.6 rejected durable 抑制（MED 4）

> Codex MED 4："end-of-session" 不适合 durable record——CBrain 跨 session 持久，session 边界不稳定。

- rejected record 带 `suppressed_until: string | null`：durable 时间戳；`null` = 抑制到用户显式 reopen。
- producer 插入前检查：若同 `(maintenance_key, fingerprint)` 存在 rejected record 且 `now < suppressed_until`（或 `suppressed_until == null`）→ **不**新插 active。
- 默认 TTL 进 **policy contract**（如 7 天），不靠 session。
- `suppressed_until` 过期 或 用户显式 reopen → 同 fingerprint 允许新 active（新 record_id）。

### 5.7 不变量汇总

- **展示门控**：`lifecycle ∈ {pending, current}` **AND** `freshness == fresh`（HIGH 2）。
- **依赖漂移只动 freshness**：lifecycle 身份不丢；路径 1 A→B→A freshness 自动恢复，路径 2（producer 已产替代 → superseded）需新 record/reactivation（HIGH 3，F15/F23）。
- **每 key 最多一条 active**：partial unique index + 原子 supersede（MED 3）。
- **rejected durable**：`suppressed_until` + policy TTL，非 session（MED 4）。
- **confirm ≠ execute**：pending→current 只改 lifecycle。
- **inactive 不进 manifest**：见 §4。
- **fingerprint 覆盖全 payload**：见 §6（HIGH 1）。

---

## 6. 内容指纹与输入哈希（HIGH 1：覆盖完整 payload）

> 验收 #2 + 硬约束"byte-stable structured result/fingerprint"。
> **rev3 修正**：rev2 的 fingerprint 只覆盖 `{inputs_hash, conclusion, constraints}`——`auto_execute`、dependency declarations、evidence_manifest、risks、gaps、producer 被篡改时 integrity 仍通过。rev3 定义显式 `RecommendationImmutablePayload`，fingerprint 覆盖**全部不可变语义字段**。

### 6.1 两个独立 hash + 完整 payload

```
inputs_hash  = SHA-256(canonical_json(decision_inputs))
               // 纯输入身份：hash 冻结输入（signals + inspected_claims + entity_snapshot）
               // 不含 conclusion。decision replay 的输入指纹。

fingerprint  = SHA-256(canonical_json(RecommendationImmutablePayload))
               // 内容身份：覆盖完整不可变语义负载（§4 payload 接口）
               //   namespace, maintenance_key, inputs_hash, conclusion,
               //   evidence_manifest, constraints, dependency_manifest,
               //   applicability(含 auto_execute), risks, gaps, producer
               // 非唯一（§5.5 partial unique index 仅约束 active）。
```

**payload 排除**（不进 fingerprint）：`record_id`、`created_at`、`last_revalidated_at`、`lifecycle_status`、`freshness_status`、`suppressed_until`、`target_display`（MED 1 read-time 投影）。这些是身份/状态/展示。

**篡改检测覆盖**（HIGH 1）：
- 改 `auto_execute:false → true` → applicability 变 → payload 变 → fingerprint 失配。
- 删 `dependency_manifest.declarations` 一条 → payload 变 → fingerprint 失配（也防"freshness 永远漏检"）。
- 改 evidence ref / risks / gaps / producer.rule_id → payload 变 → fingerprint 失配。
- DB 层另加 `CHECK (auto_execute = 0)`（defense in depth），但 fingerprint 是主防线。

**角色分工**：
- `inputs_hash`：decision replay（§8.2）的输入身份。
- `fingerprint`：完整 payload 的内容身份 + 完整性校验（§8.1）。

### 6.2 Canonical JSON（递归、identifier-safe、byte-stable）

> rev4 修正（HIGH 1）：rev3 的 "JSON.stringify 默认排序" 是**错的**——它不排序；数组比较器漏字段（`rollback_note`/`trust_state`/`filter`）；NFKC 一刀切会合并寻址不同实体的 identifier。

**payload 值类型受限**（JSON-safe）：只允许 `null | boolean | number | string | array | object`。禁止 `undefined`/`function`/`symbol`/`Date` 对象。时间戳是 ISO string 且本就排除在 payload 外（§6.1）。

**一个递归 canonical 算法**（绝不依赖插入顺序）：

```
canonical(value):
  null / boolean        → JSON 标准字面量
  number                → 最短等价十进制（整数无尾零；避免 1 vs 1.0 歧义；Phase 1 优先整数信号）
  string                → 按"字段分类"归一化（见下），再 JSON-escape
  array                 → 对每元素递归 canonical 得字符串；**按这些字符串升序排序**后逗号拼入 [ ]
                          （数组视为集合——排序键是完整元素的 canonical 串，自动含全部字段，
                            rollback_note/trust_state/filter 无遗漏；若某 rule 输入顺序语义相关，
                            必须把序号编码进元素自身）
  object                → 对每 value 递归 canonical；**按 key 的 UTF-16 码点升序显式排序**输出
```

**关键**：
- **数组排序键 = 完整元素的 canonical 字符串**（不是 `type|target_ref|reason` 之类的部分比较器）——任何被漏的字段自动进排序键。
- **对象 key 显式按码点排序**，不靠 `JSON.stringify`（它保持插入序）。

**字符串字段分类归一化**（prose vs identifier 分开）：

| 类别 | 处理 | 字段（Phase 1） |
|:--|:--|:--|
| **prose** | NFKC + 折叠多余空白 | `inspected_claims` 文本、`reason`、`risks`、`gaps`、`rollback_note` |
| **identifier** | **原样字节，不做 NFKC** | refs、slug、`source` enum、`rule_id`、`rule_version`、`code_hash`、`registry_ref`、`table`/`fields` 名、`namespace`、`maintenance_key`、各 hash 值 |

> identifier 寻址具体存储实体，NFKC 会合并不同实体（如 `entityA-1` 与全角变体可能冲突）。identifier 的规范化由生产侧保证（slug 生成即规范），hash 时不二次归一。

**输出**：canonical 串 UTF-8 编码后 SHA-256，64 hex（对齐 `computeContentHash` 全长风格，`compounding-review.ts:84`）。**不使用** `Date.now()`/`Math.random()`/自增 id/任何 mutable 字段。

### 6.3 同一 payload → 同一指纹

- `inputs_hash` 相同 ⟺ `decision_inputs` 的 canonical 形式相同（**输入身份**）。
- `fingerprint` 相同 ⟺ **完整 `RecommendationImmutablePayload` 的 canonical 形式相同**（**内容身份**）——不只是 inputs+conclusion+constraints，还含 evidence_manifest / dependency_manifest / applicability / risks / gaps / producer。

仅 `decision_inputs + conclusion + constraints` 相同**不**保证 fingerprint 相同（其它 payload 字段也参与）。这是 replay 与状态恢复（§5.4）的基础。

### 6.4 与现有去重键的关系

- `discoveryDedupKey`（实体集合复合键，sqlite.ts:2499）：标识"同一组实体+类型的信号"。**不区分结论**。
- `compounding_review_candidates.content_hash`（type|title|sorted slugs，compounding-review.ts:84）：标识"同一候选内容"。
- **recommendation `inputs_hash`**：标识"同一冻结输入"。**recommendation `fingerprint`**：标识"**同一完整不可变内容**"（全 payload）。两层最细粒度。

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
  ]
  // 注：inputs_hash 不在 manifest 里——它在 record 顶层，是 captureInputs() 输出的哈希（§7.2）
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

### 7.2 版本定义（文件/代码哈希 + 版本化 rule registry，非 DB 列）

| 版本字段 | 定义 | 来源 | 是否需 DB 迁移 |
|:--|:--|:--|:--|
| `ontology_version` | SHA-256(`ontology.yaml` 内容) | 文件 | 否 |
| `policy_version` | policy bundle 哈希（含 rule registry manifest：rule_id→version 映射） | 代码+registry | 否 |
| `schema_version` | 合同自身版本常量（如 `"rec-v1"`） | spec 定义 | 否 |

**关键设计**：版本不存 DB 列，**算出来存进 record payload**。落表时是 JSON 字段值，不需要 schema migration。

**HIGH 3 版本化 rule registry**：rule 单独由 `producer.{rule_id, rule_version, code_hash, registry_ref}` 标识（§4）。policy 升级后旧 rule 实现可能已不存在——`code_hash` 只识别版本，**不能执行**。registry 在**精确版本**上暴露**两个**确定性函数：

```ts
interface VersionedRuleRegistry {
  resolve(rule_id, rule_version): RuleRunner | RuleUnavailable;
}
interface RuleRunner {
  // (a) 输入投影器：声明依赖的当前值 → canonical DecisionInputs。
  //     产出 signals（派生/聚合）、inspected_claims（规范序/过滤）、entity_snapshot。
  //     declarations 只声明读了哪些原始字段；captureInputs 才能重建派生 DecisionInputs（HIGH 2）。
  captureInputs(declaredValues: DeclaredProjection): DecisionInputs;
  // (b) 决策执行器：冻结 DecisionInputs → conclusion（离线，无 DB/LLM/网络）。
  decide(decision_inputs: DecisionInputs): RecommendationConclusion;
}
```

- **creation**：`decision_inputs = runner.captureInputs(readDeclaredDeps())`；`inputs_hash = hash(canonical(decision_inputs))`；`conclusion = runner.decide(decision_inputs)`。
- **freshness**（§5.3）：重读声明字段当前值 → **同一 version-pinned** `captureInputs()` → `inputs_hash'`。
- **replay**（§8.2）：`runner.decide(record.decision_inputs)` → 比 conclusion。
- creation 与 freshness **必须用同一精确版本的 `captureInputs`**——否则 hash 的是不同投影（HIGH 2）。`captureInputs` 不可用（rule_version purged）→ freshness 返回 `version_invalid`，replay 返回 `rule_version_unavailable`，**都不猜**。
- registry 保留窗口 / 兼容策略见 §8.2。

### 7.3 全局输入（并入 manifest）

rev1 的 `global_state_hash` 独立概念取消——全局读取（fsck 全表、config 项、health 全维度）直接作为 **slug 缺省的 declaration** 进 `dependency_manifest`（如 `{ table: "config", fields: ["key_X"] }`）。统一进 `inputs_hash`，不再单独字段。粒度由 rule 自定，但 declaration 必须 ⊆ rule 实际读取集合（§7.1 审查义务）。

---

## 8. Replay / Diff / Invalidation 语义

> Phase 0 定义语义；Phase 2 实现（且 Phase 2 涉及数据模型，须单独过 data-model gate）。

### 8.1 Integrity check（完整性 + 交叉一致性，MED 2）—— 廉价，不跑 rule

> 回答："record 没被篡改、且三份输入（decision_inputs/manifest/dependency）互相一致吗？"

用 record **已存**字段重算（不执行 rule、不查 DB、不调 LLM/网络）：

1. **输入完整性**：`hash(decision_inputs) == record.inputs_hash`？
2. **payload 完整性**（HIGH 1）：`hash(canonical(payload)) == record.fingerprint`？——覆盖 conclusion/evidence_manifest/dependency_manifest/applicability(含 auto_execute)/risks/gaps/producer/constraints 全集。
3. **交叉一致性**（MED 2，§4.3）：
   - `evidence_manifest` 每条可追溯到 `decision_inputs`（投影一致）。
   - `decision_inputs.entity_snapshot` 字段集 ⊆ `dependency_manifest.declarations` 覆盖（producer 没读未声明字段）。
   - `dependency_manifest.rule_id == producer.rule_id`。

全通过 = 完整。任一失败 = 篡改或 bug，记 audit。这是 rev1 唯一做的事——明确为"完整性校验"，不叫 replay。

### 8.2 Decision replay（决策重放）—— HIGH 1/3 的真正 replay

> 回答："从冻结输入、用记录时的精确 rule 版本重跑，能得到记录的结论吗？"
> Phase 2 硬约束：replay 只读冻结 record（含 `decision_inputs`），不调 LLM、网络、不重新检索 vault。

`code_hash` 只识别版本，不能执行。replay 经 §7.2 的 versioned registry 解析**精确版本** runner，调 `runner.decide()`：

```ts
type ReplayResult =
  | { status: "replayed"; conclusion: RecommendationConclusion; inputs_match: boolean }
  | { status: "rule_version_unavailable"; reason: "purged" | "incompatible" | "unknown" }
  | { status: "unverifiable"; reason: string };  // 输入与 registry 期望 schema 不兼容
```

replay 流程：
```
runner = registry.resolve(producer.rule_id, producer.rule_version)
if runner is RuleUnavailable → return rule_version_unavailable   // 不是 replay failure
if hash(decision_inputs) != record.inputs_hash → return unverifiable
replayed = runner.decide(decision_inputs)                        // §7.2 decide()
if canonical(replayed) != canonical(record.conclusion) → replay failure（非确定性/篡改，记 audit）
else → replayed, inputs_match = true
```

- **`rule_version_unavailable` ≠ replay failure**：旧 rule 被清理/不兼容时，不算"重放失败"，算"无法历史验证"——不误报。
- **保留策略**（Phase 2 定）：旧 rule version 保留 N 个 policy 版本或 TTL；超期 → `purged` → 后续 replay 返回 unavailable。兼容窗口内的旧 rule 必须可执行（`captureInputs` + `decide` 都在）。
- 通过 = 结论**确定性可从冻结输入 + 精确版本 rule 重现**（满足 issue replay 目标）。

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

### 8.4 Freshness gate（HIGH 2/3，写 freshness_status 字段）

> freshness 是**独立持久化字段**。依赖漂移只改 freshness，lifecycle 不动。重算用 §7.2 的 version-pinned `captureInputs()`（HIGH 2）。

任何 record 读/display 前经 `captureInputs()` 重算 `inputs_hash'` + `constraints'`，写 `freshness_status` + `last_revalidated_at`：

| 触发 | freshness_status | lifecycle_status |
|:--|:--|:--|
| `inputs_hash' != record.inputs_hash`（声明依赖漂移） | `→ stale` | **不动** |
| `constraints'` 版本结构不匹配，或 `captureInputs` runner 不可用 | `→ version_invalid` | **不动** |
| 都匹配 | `→ fresh` | **不动** |
| 路径 1 A→B→A（无替代 record）：状态恢复，`inputs_hash'` 重新相等 | `stale → fresh` | **不动** |
| 路径 2 A→B→A（producer 已产 B，A=superseded）：状态恢复 | freshness 不适用（A 已 superseded，display 由 lifecycle 排除） | **仍是 superseded**，需新 record/reactivation（§5.4 路径 2） |

**display 只展示 `lifecycle ∈ {pending,current} AND freshness == fresh`**。

**硬规则**：
- 任一声明依赖变化 → `freshness=stale`，不展示（pending/current 一视同仁，HIGH 2）。
- 未声明字段变化**不**触发 stale（MED 2，见 F16）。
- 依赖漂移**只**动 freshness——路径 1 A→B→A freshness 自恢复（HIGH 3，F15）；路径 2（已 superseded）需新 record（F23）。
- `captureInputs` 不可用 → `version_invalid`（不猜），不静默展示。
- `lifecycle.invalidated` 仅 namespace/contract 终态退休触发，与 version_invalid 无关。

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
- Schema 为 record shape 量身定做：`record_id` 主键 + **partial unique index** `(maintenance_key) WHERE lifecycle IN (pending,current)`（§5.5，MED 3 收紧到单 key）+ `inputs_hash` 索引 + `freshness_status` / `lifecycle_status` 双列 + `CHECK (auto_execute = 0)`（HIGH 1 defense in depth）。
- 与 discoveries / compounding_review_candidates 零语义碰撞。
- 审计副表 `recommendation_lifecycle_history` 同构 `compounding_review_feedback`（sqlite.ts:393），记录 freshness/lifecycle 转换历史。
- "查当前 recommendation" = 单条索引查询。
- 双轴 vocab 干净（lifecycle 5 值 + freshness 3 值，分开），无 overload。
- `decision_inputs` + immutable payload 作为 JSON 列存储，支持 integrity + decision replay（HIGH 1/3）。

**Cons**
- 新增 **additive** migration（`CREATE TABLE` + 索引，config-key 守卫，对齐 `runLatePageMigrations` 模式 `src/storage/migrations/pages.ts:43`——**非** destructive helper，LOW 修正）。
- 代码库已有 5 套 status vocab，再加一套（但双轴分开，比塞进单 enum 清晰）。
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
**then**：两次 `inputs_hash` 与 `fingerprint` 都相同；integrity check（§8.1）通过；decision replay（§8.2，离线 `runner.decide(decision_inputs)`，精确版本）重现同 conclusion。

### F2 — 依赖变化 → freshness=stale（lifecycle 不动，HIGH 2）
**given**：F1 的 record 处于 `pending`（或 `current`），`freshness_status=fresh`。
**when**：实体A 被编辑，rule 声明的依赖字段变化 → 重算 `inputs_hash'` ≠ `record.inputs_hash`。
**then**：freshness gate 写 `freshness_status=stale`；**`lifecycle_status` 不变**（仍是 pending/current）；display 因 freshness≠fresh 不展示。pending 和 current 一视同仁。

### F3 — 版本漂移 → freshness=version_invalid（lifecycle 不动）
**given**：F1 record 记录 `policy_version/ontology_version`，处于 pending/current + fresh。
**when**：ontology/policy 升级，重算 `constraints'` 不匹配。
**then**：freshness gate 写 `freshness_status=version_invalid`；**lifecycle 不动**；display 不展示。版本若回退 → freshness 恢复 fresh（lifecycle 全程不动）。`lifecycle.invalidated` 不触发（仅 namespace 退休才用）。

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

### F8 — 拒绝后 durable 抑制（MED 4，suppressed_until + policy TTL）
**given**：record R（maintenance_key=K, fingerprint=F）被用户 `rejected`，写 `suppressed_until = T+7d`（policy 默认 TTL）。
**when**：rule 在 T+3d 再次产出同 K 同 F record（输入未变）。
**then**：`now < suppressed_until` → **不**新插 active（durable，跨 session）。T+8d 后或用户显式 reopen → 同 F 允许新 active（新 record_id）。同 K 不同 fingerprint 不受限。

### F9 — 三层 ref/display 分层（MED 1）
**given**：任意 maintenance record。
**when**：导出公开示例/测试 → 匿名占位符；runtime display → `safeTitle` 清洗；audit/raw → `redactAudit`。
**then**：公开示例无真实 slug/路径/凭据串；runtime display 是**真实清洗过的 title**（可操作）；audit/raw 含 slug 但经脱敏。internal ref（含 slug）不直接给用户。

### F10 — 不自动执行
**given**：任意 propose 型 record。
**when**：record 创建/confirm。
**then**：`applicability.auto_execute === false`；producer 无任何写操作调用；无 repair/merge/sync/delete 触发；confirm 只改 lifecycle。

### F11 — 事实升级改输入哈希（对抗）
**given**：F1 record 的 decision_inputs 含 `trust_state=candidate` 证据，处于 current+fresh。
**when**：该证据独立升为 `trusted`（经用户确认流，非 recommendation 自动）。
**then**：decision_inputs.entity_snapshot 变 → 重算 `inputs_hash'` ≠ record.inputs_hash → `freshness_status=stale`（lifecycle 仍 current）；display 不展示。

### F12 — canonical 稳定性 + tie 完整性（对抗，HIGH 1）
**given (顺序)**：同一 payload，但 alternatives / evidence_manifest / declarations 数组到达顺序不同。
**then**：canonical 算法按**完整元素**的 canonical 串排序 → inputs_hash / fingerprint 相同；顺序差异不影响指纹。
**given (tie 漏字段)**：两条 alternatives 其余相同、仅 `rollback_note` 不同；两条 evidence 仅 `trust_state` 不同；两条 declarations 仅 `filter` 不同。
**then**：排序键含完整元素 → 这些差异**进**排序/哈希 → 产出**不同** fingerprint（不因 tie 漏字段而误判相同）。
**given (identifier 不归一)**：两个不同 slug `entityA-1` 与其全角变体——identifier 字段**不做 NFKC**，原样字节 → 不同实体不合并；prose 字段才 NFKC。

### F13 — 隐式执行攻击（对抗）
**given**：恶意/失误的 producer 规则尝试在结论里嵌写操作。
**when**：合同校验。
**then**：`ProposedAction.type` 只允许 `review|dry_run|notify_draft`；`auto_execute:false` 不变量；任何写操作尝试 = 合同违反，record 拒绝创建。

### F14 — integrity check ≠ decision replay（HIGH 1）+ 交叉一致性（MED 2）
**given**：一条 record，其 `conclusion` 被手动篡改，但 `decision_inputs` + `inputs_hash` 未变。
**when (integrity)**：重算 `fingerprint'`（覆盖全 payload）≠ `record.fingerprint` → 完整性失败；另：若删一条 `dependency_manifest.declarations`，payload 也变 → 失配。
**when (decision replay)**：离线 `runner.decide(decision_inputs)`（§7.2）得**原** conclusion ≠ 篡改值 → replay 失败。
**when (交叉一致性)**：若 `evidence_manifest` 含一条 decision_inputs 里没有的 ref，或 entity_snapshot 含未声明字段 → integrity 失败（MED 2）。
**then**：integrity 抓篡改/不一致，replay 抓"推不出结论"——不同诊断，各有 fixture。

### F15 — A→B→A 路径 1：freshness-only（HIGH 3，producer 未跑）
**given**：record R（inputs_hash=A）`lifecycle=current, freshness=fresh`。两次读之间**无 producer 运行**。
**when**：状态变 B（依赖漂移）→ freshness gate 写 `freshness=stale`（lifecycle 仍 current）。
**then**：状态恢复回 A → 下次 freshness gate 经 `captureInputs()` 重算 `inputs_hash'=A` → 写 `freshness=fresh`（lifecycle **仍是 current**，身份无丢失）。**无新 record、无新 fingerprint**。

### F16 — 无关字段变化不 stale（MED 2）
**given**：known_relations rule 只声明依赖 `links(reports_to)`；record R 处于 current+fresh。
**when**：实体A 新增一个**tag**（rule 未声明依赖 tags）。
**then**：declared projection 不含 tags → `inputs_hash'` == R.inputs_hash → `freshness` 仍 fresh；R 继续展示。

### F17 — rejected 同 fingerprint 跨 durable 窗口（MED 4）
**given**：record R（fingerprint=F）被 rejected，`suppressed_until=T+7d`。
**when**：T+8d 后 rule 再产同 F record；或用户显式 reopen。
**then**：允许以新 record_id 重新进 active（同 fingerprint，R 已 rejected 不在 active 唯一约束内）；写新 lifecycle_history。

### F18 — 篡改 auto_execute（HIGH 1）
**given**：record R（`applicability.auto_execute=false`，fingerprint=F）。
**when**：攻击者/bug 把 `auto_execute` 改成 `true`。
**then**：integrity 重算 `fingerprint'`（payload 含 applicability）≠ F → 失败；DB 层 `CHECK (auto_execute = 0)` 再拦一道。

### F19 — 篡改 dependency declaration（HIGH 1）
**given**：record R 的 `dependency_manifest.declarations` 含 links 声明，fingerprint=F。
**when**：删掉该声明（企图让 freshness 永远漏检）。
**then**：payload 变 → `fingerprint'` ≠ F → integrity 失败。

### F20 — 篡改 evidence ref（HIGH 1）
**given**：record R 的 `evidence_manifest` 含 ref `discovery:K1`，fingerprint=F。
**when**：把 ref 改成 `discovery:K2`。
**then**：payload 变 → `fingerprint'` ≠ F → integrity 失败；交叉一致性也 catch（K2 不在 decision_inputs）。

### F21 — policy 升级，旧 rule runner 仍可用（HIGH 3）
**given**：record R 由 rule v1 产出（`producer.rule_version=1.0.0`）。当前 policy 已升 v2，但 registry 仍保留 v1 runner（`captureInputs`+`decide` 都在，兼容窗口内）。
**when**：decision replay。
**then**：`registry.resolve(rule_id, "1.0.0")` 返回 v1 runner → `runner.decide(decision_inputs)` 重现 R.conclusion → `ReplayResult{status:"replayed"}`。

### F22 — policy 升级，旧 rule runner 已清理（HIGH 3）
**given**：record R 由 rule v1 产出。v1 超过保留窗口被 purge。
**when**：decision replay / freshness。
**then**：`registry.resolve` 返回 `{status:"unavailable", reason:"purged"}` → replay `rule_version_unavailable`、freshness `version_invalid`——**不是** failure，是"无法历史验证"，不误报、不污染 audit。

### F23 — A→B→A 路径 2：producer 已产替代 record（HIGH 3）
**given**：record R_A（inputs_hash=A, fingerprint=F_A）`current+fresh`。状态变 B 后 **producer 跑了**：用 B 态输入算出 inputs_hash_B（≠A）→ §5.5 原子 supersede：R_A `→ superseded`，新 R_B（fingerprint=F_B）→ pending。
**when**：状态恢复回 A。
**then**：R_A **仍是 `superseded`**——freshness 翻转**救不了**（lifecycle 排除展示）。要重新展示 A 的内容：producer 再跑产 `inputs_hash_A` → 插入**新 record（新 record_id，同 F_A）**为 pending（R_A 已 superseded 不冲突 active 唯一约束），写 `reactivated` history；**或**显式 superseded→pending reactivation。**不能**只翻 freshness。

### F24 — projector 规范唯一性（HIGH 2）
**given**：声明依赖的**原始行**完全不变；但某实现者用不同 `captureInputs`（signals 聚合方式不同，或 inspected_claims 排序/过滤不同）。
**when**：算 inputs_hash。
**then**：只有 registry 解析的**精确版本 `captureInputs()`** 是规范投影——creation 与 freshness 用**同一个**；任何偏离 = projector bug，产出不同 inputs_hash → 被识别为 stale/不一致，**不**被当作"另一种合规实现"。原始行相同不保证 inputs_hash 相同（取决于规范 captureInputs）。

---

## 15. 对抗审查（task #7 + rev2 6 项 + rev3 8 项）

> 原 7 类 + rev2 HIGH 1-3/MED 1-3 + rev3 HIGH 1-3/MED 1-4/LOW，全部合同层缓解 + fixture 覆盖。

| # | 攻击 | 缓解（合同层） | fixture |
|:--|:--|:--|:--|
| 1 | 事实升级：candidate→trusted 后旧 record 冒充 current | decision_inputs 含 trust_state → `inputs_hash` 捕获 → freshness=stale | F11 |
| 2 | inactive evidence 漏进结论 | manifest 无 active 字段，inactive 结构性无法进入 | F5、F11 |
| 3 | conflict 下仍 propose | 仅命中本 record scope 的冲突 abstain | F6 |
| 4 | 隐私泄漏 | 三层 ref/display；display 准入挂 #327；audit/raw 经 redactAudit | F9、§11 |
| 5 | 隐式执行 | `auto_execute:false`；ProposedAction.type 白名单；confirm≠execute | F10、F13 |
| 6 | 非确定性 hash | canonical JSON 排序 + NFKC；排除时间/随机 | F12 |
| 7 | 旧 record 冒充 current | display 门控 lifecycle∈{pending,current} **AND** freshness=fresh | F2、F3 |
| 8 | replay 名不副实 | 拆 integrity（§8.1）vs decision-replay（§8.2）；存 decision_inputs | F1、F14 |
| 9 | pending 绕过 freshness | freshness gate 约束 pending 与 current | F2、F3 |
| 10 | A→B→A 死锁 | record_id≠fingerprint；partial unique index 仅 active | F15、F17 |
| 11 | 无关字段 stale 风暴 | per-rule declarative dependency；未声明不进 hash | F16 |
| 12 | **rev3 HIGH 1** fingerprint 漏覆盖关键字段 | 显式 `RecommendationImmutablePayload` 覆盖全语义字段（含 auto_execute/declarations/evidence/risks/gaps/producer）；DB `CHECK(auto_execute=0)` | F14、F18、F19、F20 |
| 13 | **rev3 HIGH 2** 双轴仍混成 enum、stale 丢身份 | 真双字段：`lifecycle_status`（无 stale）+ 独立 `freshness_status`；依赖漂移只动 freshness | F2、F3、F15 |
| 14 | **rev3 HIGH 3** 历史 rule 无可执行版本 | versioned rule registry（rule_id+rule_version→runner）；unavailable 返回结构化状态，非 failure | F21、F22 |
| 15 | **rev3 MED 1** target_display 进 frozen 结论 | target_display 移出 payload，read-time projection；只存 target_ref | F9、§4.4 |
| 16 | **rev3 MED 2** 三份输入真相重叠 | decision_inputs=source of truth，manifest=投影，dependency=schema；integrity 交叉校验 | F14、§4.3 |
| 17 | **rev3 MED 3** 同 key 两不同 fingerprint 并存 active | `UNIQUE(maintenance_key) WHERE active` + 原子 supersede | §5.5 |
| 18 | **rev3 MED 4** rejected session 抑制不 durable | `suppressed_until` + policy TTL（durable，跨 session） | F8、F17 |
| 19 | **rev3 LOW** 新表误套 destructive migration | additive migration（runLatePageMigrations 风格） | §10 |
| 20 | **rev4 HIGH 1** canonicalization 不稳定（JSON.stringify 不排序 + 数组比较器漏字段 + NFKC 合并 identifier） | 递归 canonical JSON（对象按码点排 key、数组按完整元素 canonical 串排序）；prose/identifier 分开归一；tie case 覆盖 rollback_note/trust_state/filter | F12、§6.2 |
| 21 | **rev4 HIGH 2** freshness 无法重建 DecisionInputs | versioned registry 暴露精确版本 `captureInputs()`；creation 与 freshness 共用同一规范投影器；不可用 → version_invalid，不猜 | F24、§5.3、§7.2 |
| 22 | **rev4 HIGH 3** A→B→A 与原子 supersede 冲突 | 拆 freshness-only（路径 1，F15）vs producer-produced（路径 2，superseded 需新 record/reactivation，F23）；删"无新 record"绝对断言 | F15、F23、§5.4 |
| 23 | **rev4 MED** fingerprint 身份 wording 与全 payload 矛盾 | fingerprint 相同 ⟺ 完整 canonical payload 相同（不只 inputs+conclusion+constraints） | §6.3、§6.4 |

**审查结论**：原 7 + rev2 6 + rev3 8 + rev4 4 全部有合同层缓解 + fixture 覆盖。隐私（#4）依赖 #327 后续 surface 覆盖——**已知前置依赖**，Phase 1 强制 gate。

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

1. **物理 schema**：CREATE TABLE 列、`record_id` 主键、**partial unique index** `(maintenance_key) WHERE lifecycle IN (pending,current)`（MED 3）、`inputs_hash`/`fingerprint` 索引、`CHECK (auto_execute = 0)`（HIGH 1）、双 status 列、config-key **additive** migration key 命名（LOW）。
2. **审计副表**：`recommendation_lifecycle_history` 是否同构 `compounding_review_feedback`（记 lifecycle+freshness 转换），还是泛化 audit 表。
3. **versioned rule registry 实现**：rule_id+rule_version→runner 的物理形式（版本化模块/序列化 AST/快照）；旧 rule 保留窗口与兼容策略（HIGH 3）；code_hash 计算边界。
4. **decision_inputs 存储成本**：immutable payload + decision_inputs 作为 JSON 列的体积；是否分离 blob 存储；replay 的离线 runner 执行环境。
5. **producer 注册与审查**：rule_id 命名空间、如何防 producer 偷偷写、dependency_manifest declaration 审查流程（核对 ⊆ 实际读取集合，MED 2）。
6. **display 准入**：与 #327 Phase 2-4 对接点；recommendation 走哪个 MCP surface；`safeTitle` fallback 策略；`RecommendationDisplay` read-time 投影类型定义（MED 1）。
7. **abstain 展示**：是否给"为什么没建议"查询入口。
8. **与 next_actions 的并轨**：attention queue 是否直接消费 freshness-gated active recommendation。
9. **抑制 TTL 默认值**：`suppressed_until` 的 policy 默认 TTL（MED 4）与配置点。

---

## 18. 验收对照表

| issue Phase 0 验收 | 本 spec 章节 |
|:--|:--|
| 1. Recommendation Contract spec，与 research/EvidenceBoard/next_actions/Compounding Review 分工 | §2、§13 |
| 2. 稳定最小 record shape + 生命周期，不提前锁 DB 迁移 | §4、§5、§6、§7、§10 |
| 3. ≥10 条匿名 fixture，覆盖全部验收场景 | §14（24 条：F1–F24） |
| 4. 新表 vs 复用 lifecycle trade-off + 推荐 | §10 |
| 5. #327 未完成前不进默认 display | §11 |
| 6. 公开示例匿名占位符 | §14 + §11.3 |
| 推导结构约束（节点/边/causes 限定） | §12 |
| 不保存模型私有 CoT | §12 + §0 |
| 对抗审查（原 7 + rev2 6 + rev3 8 + rev4 4） | §15（23 行） |

**rev4 Codex 修订验收对照**（本轮）：

| Codex rev4 验收 | 本 spec 落点 |
|:--|:--|
| 1. Canonicalization 完整、递归、identifier-safe、覆盖 tie case | §6.2（递归 canonical + prose/identifier 分类 + 完整元素排序）+ F12 |
| 2. Freshness 用 creation 同一 versioned input projector | §5.3 + §7.2（`captureInputs()`）+ F24 |
| 3. A→B→A 拆 freshness-only vs replacement-produced | §5.4（两条路径）+ §8.4 + F15（路径 1）/ F23（路径 2） |
| 4. Fingerprint 身份 wording 匹配完整 immutable payload | §6.3 + §6.4 |
| 5. 仍 Phase 0 spec-only，不写 plan/runtime/DB/MCP，不 push | §0 + 本文件唯一交付 |

**rev3 Codex 修订验收对照**（上一轮，已落实）：

| Codex rev3 验收 | 本 spec 落点 |
|:--|:--|
| 1. fingerprint 覆盖完整 immutable semantic payload，展示/生命周期字段排除 | §6.1（`RecommendationImmutablePayload`）+ F14/F18/F19/F20 |
| 2. lifecycle/freshness 真双轴，A→B→A 不丢确认状态 | §5.1（双字段）+ §8.4 + F2/F3/F15 |
| 3. versioned rule registry + rule unavailable 语义 | §7.2 + §8.2 + F21/F22 |
| 4. target_display 改 read-time projection | §4.4 + F9 |
| 5. 三类输入/manifest/dependency 的 source-of-truth 与一致性规则 | §4.3 + §8.1 交叉校验 + F14 |
| 6. active uniqueness 与 rejected suppression policy 明确 | §5.5（UNIQUE maintenance_key WHERE active）+ §5.6（suppressed_until）+ F8/F17 |
| 7. additive migration 表述修正 | §10 Cons + §17 item 1 |
| 8. 仍只改 spec，不写 plan/runtime/DB/MCP，不 push | §0 + 本文件唯一交付 |

**rev2 Codex 修订验收对照**（上一轮，已落实）：

| Codex 修订验收 | 本 spec 落点 |
|:--|:--|
| 1. integrity-check vs decision-replay 两类语义 + fixture | §8.1 / §8.2 + F1、F14 |
| 2. pending/current 都受 freshness gate | §5.3 + F2、F3 |
| 3. A→B→A 生命周期回摆 | §5.4 + F15 |
| 4. internal ref 与用户 display 分层 | §4.2、§11.3 + F9 |
| 5. dependency hash 改 rule-scoped + 无关变化不失效 | §7.1 + F16 |
| 6. conflict scope 与 high-impact policy 明确 | §9、§9.1 + F6 |
| 7. 仍 Phase 0 | §0 |

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
