# Recommendation Contract — 设计 spec（Phase 0）

> Issue: #328（roadmap: governed Recommendation Record and replayable decision support）
> Phase: **0（仅合同设计，不改运行时）**
> 状态：待 Codex review
> 依赖：#327（output trust boundary）— display 前置；未完成全部 surface 前 recommendation 不进默认展示

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

3. **recommendation ≠ attention item**。attention item（`NextAction`、discovery row、health issue）是**原料信号**；recommendation 是**合成结论**。多条 attention item 可汇聚成一条 recommendation；一条 attention item 也可能因证据不足而不产生任何 recommendation（→ abstain）。Phase 1 的 maintenance recommendation 与 next_actions 共享上游来源（health/discovery/fsck），但 recommendation record 多出 fingerprint / dependency_hashes / lifecycle 三层合同字段。`NextAction ≠ RecommendationRecord`。

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
  fingerprint: string;            // SHA-256 canonical payload，见 §6
  namespace: string;              // Phase 1 固定 "maintenance"；未来 "open_question" 等
  maintenance_key: string;        // 归一化稳定键，见 §4.1

  // ── 结论（提案轴）──
  conclusion: RecommendationConclusion;

  // ── 证据清单（真值轴过滤后）──
  evidence_manifest: EvidenceManifestEntry[];

  // ── 约束与版本（replay/diff 用）──
  constraints: RecommendationConstraints;

  // ── 依赖哈希（invalidation 用）──
  dependency_hashes: DependencyHashes;

  // ── 适用性与风险 ──
  applicability: Applicability;
  risks: string[];
  gaps: string[];                 // 复用 EvidenceBoard.gaps 语义

  // ── 生命周期 ──
  created_at: string;             // 不进 fingerprint
  lifecycle_status: RecommendationLifecycle;

  // ── record 自身来源（非 vault provenance）──
  producer: RecommendationProducer;
}

type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

interface ProposedAction {
  type: "review" | "dry_run" | "notify_draft";  // 对齐 ActionCandidateActionType
  target: string;               // 抽象 ref，非裸 slug（见 §11 隐私）
  reason: string;               // 显式可审计理由，非模型 CoT
  rollback_note?: string;       // 对齐 RepairAction.rollbackNote
}

interface EvidenceManifestEntry {
  source: "discovery" | "health" | "fsck" | "graph" | "timeline";
  ref: string;                  // 稳定抽象 ref（见 §4.2）
  trust_state: TrustState;      // 真值轴（manifest 内必然 ∈ {trusted, user_thought, candidate}）
}

// ── manifest 不变量（对抗攻击 #2，见 §15）──
// manifest 只含 active 证据：producer 构建前必须过 INACTIVE_STATES（evidence.ts:52）
// 与 ACTIVE_LINK_SQL（sqlite.ts:49），与 EvidenceBoard.build 的 drop 行为一致（evidence.ts:125）。
// 因此 manifest 内不可能出现 rejected/superseded —— inactive 在结构上无法进入结论，
// 不靠运行时 active 标志。全量（含 inactive）证据视图只进 audit/raw surface（#327 gate）。
// 推论：inactive 证据日后翻 active（如 rejected→trusted）会新增 manifest 条目 → fingerprint 变 → 旧 record stale（见 F11）。

interface RecommendationConstraints {
  policy_version: string;       // 见 §7.2
  ontology_version: string;
  schema_version: string;       // 合同自身版本，如 "rec-v1"
  rule_hashes: Record<string, string>;  // 产出规则的代码哈希
}

interface DependencyHashes {
  entity_hashes: Record<string, string>;  // slug → entity 投影哈希
  global_state_hash: string;              // rule 读取的全局输入哈希
}

interface Applicability {
  audience: "user_only";        // Phase 1 固定
  auto_execute: false;          // Phase 1 不变量
  requires_confirmation: ConfirmationRequirement;
}

type ConfirmationRequirement =
  | { tier: "standard" }        // Phase 1 全部
  | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[] };  // Phase 3+ 预留

interface RecommendationProducer {
  rule_id: string;              // 确定性规则标识
  code_hash: string;            // 规则代码哈希（= policy_version 来源之一）
  inputs_hash: string;          // = fingerprint 的别名，便于审计
}

type RecommendationLifecycle =
  | "pending"      // 已建，待用户复核（创建默认）
  | "current"      // 依赖+约束匹配，仍有效
  | "stale"        // 依赖哈希漂移，结论可能失效，须重算后才能回 current
  | "superseded"   // 同 maintenance_key 的新 record 取代
  | "rejected"     // 用户显式拒绝，不再以同 fingerprint 重复提案
  | "invalidated"; // ontology/policy/schema 版本变化，结构上不再适用

type AbstainReason =
  | "insufficient_evidence"
  | "conflict"
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

### 4.2 抽象 evidence ref（隐私 + 稳定）

evidence ref **不存原文摘录**，只存稳定抽象引用，复用现有 `ActionEvidenceRef` 模式（`src/core/maintenance/action-candidates.ts:17`）：

- discovery 类：`discovery:<dedup_key>` 或 `discovery:id:<n>`（对齐 `stableDiscoveryRef`，action-candidates.ts:109）
- health 类：`health:<dimension>:<kind|group>:<slug|"global">`（对齐 `healthStableRef`，action-candidates.ts:179）
- fsck 类：`fsck:<check>:<sample_slug|"global">`
- graph/timeline 类：`graph:<from>|<to>` / `timeline:<slug>:<event_date>`

ref 稳定（不随 vault 文本变化），且不含原文——隐私边界靠这层。原文摘录只在 audit/raw surface（受 #327 gate）。

---

## 5. 生命周期

> 验收 #2：定义生命周期。

**不复用 `CandidateStatus` enum**（虽然它最完整：`pending|accepted|rejected|deferred|disabled|superseded`，`src/storage/sqlite.ts:138`）。原因：recommendation 需要 `stale`（依赖漂移）和 `invalidated`（版本结构变化）语义，`CandidateStatus` 没有；反过来 recommendation 不需要 `deferred`/`disabled`。复用会导致 Wrong Abstraction + display filter 漏判。

**但复用审计副表模式**：`compounding_review_feedback`（`src/storage/sqlite.ts:393`）是 action→status 转换 + reason 的审计副表，recommendation 应有同构的 `recommendation_lifecycle_history`（逻辑定义，Phase 1 落表）。

### 5.1 状态转换

```
                ┌─────────────┐
                │   pending   │ ← 创建（默认）
                └──┬──┬──┬──┬─┘
       依赖+约束   │  │  │  │ 用户拒绝
       匹配       │  │  │  │
        ▼        │  │  │  ▼
     ┌────────┐  │  │  │ ┌──────────┐
     │current │  │  │  │ │ rejected │
     └───┬────┘  │  │  │ └──────────┘
         │依赖漂移│  │  │
         ▼       │  │  │ 同 key 新 record
     ┌────────┐  │  │  │ 接受
     │ stale  │──┘  │  │
     └────────┘     │  │
                    │  │ ontology/policy/
                    │  │ schema 版本变
                    ▼  ▼
              ┌──────────────┐
              │ invalidated  │
              └──────────────┘
              ┌──────────────┐
              │ superseded   │ ← 同 maintenance_key 新 fingerprint 接受
              └──────────────┘
```

不变量：

- **`stale` / `superseded` / `rejected` / `invalidated` 不得作为 `current` 展示**。display 层 filter `lifecycle_status IN ('current','pending')`。
- `stale` 想回 `current`：必须重算（产出新 fingerprint 的 record），不能就地"刷新"标签。
- `rejected` 后，同 `maintenance_key` + 同 `fingerprint` 的 record 不再重复提案（去重靠 fingerprint，不是靠 key——key 相同但输入变了仍可新提案）。
- `rejected` 不阻止同 key 不同 fingerprint 的新 record（状态变了，新结论该提还得提）。

---

## 6. Fingerprint（确定性指纹）

> 验收 #2 + 硬约束"同一状态与 policy 产生 byte-stable structured result/fingerprint"。

```
fingerprint = SHA-256(canonical_json({
  namespace,
  maintenance_key,
  conclusion,                  // kind + propose(action+alternatives) | abstain(reason)
  evidence_manifest_sorted,    // 按 ref 排序，过滤后
  constraints,                 // policy/ontology/schema/rule_hashes
  dependency_hashes            // entity_hashes(按 slug 排序) + global_state_hash
}))
```

**进 fingerprint 的**：所有决定"结论是否相同"的输入。
**不进 fingerprint 的**：`created_at`、`lifecycle_status`、`producer`（这些是可变元数据/审计信息）。

### 6.1 canonical JSON 规则（byte-stable 保证）

1. 对象 key 按 UTF-16 码点升序（JSON.stringify 默认 + 显式 sort 兜底）。
2. 数组按显式 sort（manifest 按 ref；entity_hashes 按 slug；alternatives 按 `type|target|reason`）。
3. 字符串值做 **NFKC 归一化**（对齐 #327 `sanitizeStructuredText` 的 NFKC 步骤，`src/core/safety/display-safety.ts:106`），消除全角/半角差异（`ｓｃｏｒｅ` ≡ `score`）——指纹要语义稳定。
4. 无多余空白（`JSON.stringify` 默认）。
5. UTF-8 编码后 SHA-256，输出 64 hex（对齐 `computeContentHash` 全长风格，不用 `hashContent` 的 16-char 截断——recommendation 需要抗碰撞强度）。
6. **不使用** `Date.now()` / `Math.random()` / 自增 id（这些进 fingerprint 就破坏 byte-stable）。

### 6.2 同一状态 → 同一 fingerprint

只要 `namespace + maintenance_key + conclusion + evidence_manifest + constraints + dependency_hashes` 相同，fingerprint 相同，无论何时何地计算。这是 replay 的基础。

### 6.3 与现有去重键的关系

- `discoveryDedupKey`（实体集合复合键）：标识"同一组实体+类型的信号"。**不区分结论**。
- `compounding_review_candidates.content_hash`（type|title|sorted slugs）：标识"同一候选内容"。
- **recommendation fingerprint**：标识"同一输入快照→同一结论"。最细粒度。同一 `maintenance_key` 可有多个 fingerprint（输入漂移），正是 stale/diff 要检测的。

---

## 7. 依赖哈希与版本（不锁 DB 迁移）

> 关键 gap：**ontology/policy/schema version 常量当前不存在**。代码里只有 `package.json` 版本（`src/version.ts`）和 per-page 内容版本（`src/core/version.ts` + `versions` 表）。spec 必须定义版本，但用"文件/代码内容哈希"绕开 DB 迁移。

### 7.1 entity_hashes（依赖漂移检测）

recommendation 依赖实体 E 时，E 的哈希覆盖其在 9 张表（+ FTS）的活跃投影。复用现有 `ACTIVE_LINK_SQL`（`src/storage/sqlite.ts:49`）过滤：

```
entity_hash(slug) = SHA-256(canonical_json({
  page: pages.content_hash,                        // 现有 16-char，src/core/shared.ts:21（hashContent）
  links_out: sorted(active 出边 {relation, other_slug, trust_state}),  // ACTIVE_LINK_SQL
  links_in:  sorted(active 入边),
  tags:      sorted(tags),
  aliases:   sorted(aliases),
  timeline:  sorted(active timeline {event_date, summary, trust_state}),
  chunks:    SHA-256(sorted(chunks.content_hash))  // 现有 chunks.content_hash
}))
```

可行性已验证：所需 `content_hash` 列都存在（`pages.content_hash` / `pages.ingest_content_hash` / `chunks.content_hash`），活跃过滤常量存在。Phase 0 不实现，只证明可行 + 命名确切表集合（即 `DERIVED_FK_TABLES` 白名单 `src/storage/sqlite.ts:637` 加 `pages` + `chunks_fts`）。

### 7.2 版本定义（文件/代码哈希，非 DB 列）

| 版本字段 | 定义 | 来源 | 是否需 DB 迁移 |
|:--|:--|:--|:--|
| `ontology_version` | SHA-256(`ontology.yaml` 内容) | 文件 | 否 |
| `policy_version` | 产出 recommendation 的规则代码哈希（`rule_hashes` 聚合） | 代码 | 否 |
| `schema_version` | 合同自身版本常量（如 `"rec-v1"`） | spec 定义 | 否 |

**关键设计**：版本不存 DB 列，而是**算出来存进 record 字段**。record 落表时这些是普通 JSON 字段值，不需要 schema migration。Phase 1 即使复用现有表（见 §10），版本也能完整记录。

### 7.3 global_state_hash

rule 若读取全局输入（如 fsck 全表扫描、health 全维度报告），用 `global_state_hash = SHA-256(sorted(读到的关键签名))` 捕获。粒度由 rule 自定，但必须在 `producer.rule_id` 文档里声明读哪些表，否则 invalidation 会漏。

---

## 8. Replay / Diff / Invalidation 语义

> Phase 0 定义语义；Phase 2 实现（且 Phase 2 涉及数据模型，须单独过 data-model gate）。

### 8.1 Replay（重放）

> Phase 2 硬约束：replay 只读取冻结记录，不调用 LLM、网络或重新检索。

replay = 从**冻结 record**（manifest + dependency_hashes + constraints 都在 record 里）重算结论，验证 `SHA-256(canonical_json(frozen_inputs)) == record.fingerprint`。

- 不查当前 DB（输入已冻结在 record 里）。
- 不调 LLM / 网络。
- 通过 = 该 record 内部自洽，结论确定性可复现。
- 价值：给出一个**基线快照**，供 diff 比对当前状态。

### 8.2 Diff（差异）

对比两条 record（或 record vs 当前状态），沿 **5 轴**输出结构化差异：

```ts
type DiffAxis =
  | "evidence"     // manifest 条目增删（含跨 active 边界：inactive↔active）/ trust_state 翻转
  | "constraint"   // policy/ontology/schema/rule 版本变
  | "option"       // alternatives / ProposedAction 集合变
  | "dependency"   // entity_hash 不匹配
  | "conclusion";  // propose↔abstain 或 action 不同

interface Diff { axis: DiffAxis; before: string; after: string; }[]
```

Phase 2 先做 hash 级快判（entity_hashes 比、constraints 比），命中再下沉到字段级 diff。排序优先级必须下沉到截断层（对齐 memory：`rank-priority-before-truncate`），不在 TS 后置排序。

### 8.3 Invalidation 规则（生命周期强制转换）

| 触发 | 转换 |
|:--|:--|
| `dependency_hashes.entity_hashes` 任一不匹配 | `current → stale` |
| `constraints.ontology_version` 或 `policy_version` 不匹配 | `current → invalidated` |
| 同 `maintenance_key` + 不同 `fingerprint` 的新 record 被接受 | 旧 record `→ superseded` |
| 用户拒绝 | `→ rejected` |
| `constraints.schema_version` 不匹配（合同大版本变） | `→ invalidated` |

**硬规则**：任一依赖 hash 变化后旧 record 进 stale，**不得静默作为 current**（issue 原文要求）。

---

## 9. Abstain 语义

> 验收 #2 + 验收场景：conflict abstain、无证据 abstain。

证据不足时 `conclusion.kind = "abstain"`，**不发 ProposedAction**。record 仍持久化（有 fingerprint 去重，避免反复重算）。

`AbstainReason` 映射现有检测逻辑：

| reason | 触发（映射现有代码） |
|:--|:--|
| `insufficient_evidence` | `EvidenceBoard.facts` 空 + `gaps` 非空（evidence.ts:150 `detectGaps`） |
| `conflict` | `EvidenceBoard.conflicts` 非空（evidence.ts:276 `detectClaimConflicts`） |
| `inactive_evidence_only` | 全部 candidate 证据被 `INACTIVE_STATES`（evidence.ts:52）过滤掉 |
| `below_threshold` | proactive `score < 0.5`（proactive.ts:44），或 `actionable !== "high"` |
| `policy_prohibits` | rule 显式推迟（如 Phase 1 丢弃 `observe_only` health 项，action-candidates.ts:213） |

abstain record 的 lifecycle 同样走 pending/current/stale，但 display 默认不展示（除非用户主动查"为什么没给建议"）。

---

## 10. 存储方案 trade-off（新表 vs 复用 lifecycle）

> 验收 #4：比较两种 Phase 1 存储方案，列 trade-off，给推荐，本轮不实施。

### 方案 A：新 `recommendation_records` 表

**Pros**
- Schema 为 record shape 量身定做：`fingerprint UNIQUE`、`maintenance_key` 索引、`lifecycle_status CHECK`。
- 与 discoveries / compounding_review_candidates 零语义碰撞。
- 审计副表 `recommendation_lifecycle_history` 同构 `compounding_review_feedback`（sqlite.ts:393）。
- "查当前 recommendation" = 单条索引查询。
- 生命周期 vocab 干净（pending/current/stale/superseded/rejected/invalidated），无 overload。

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

### 11.3 合同内建隐私（即使 display 未启）

- evidence ref 只存抽象引用（§4.2），不存原文摘录。
- display 文本（Phase 1 生成时）用匿名占位符（对齐 `slugToAnonymousToken`，health-debt.ts:78）。
- record 的所有公开示例（本 spec + 任何测试）只用 `实体A`/`主题B`/`方案C`/`组织D`。
- audit/raw surface 才允许含 slug/路径，且必须经 #327 `redactAudit`（`src/mcp/tools/audit-redact.ts:17`）三层脱敏。

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
| **action candidates**（action-candidates.ts） | `PersistedActionCandidate`（落 discoveries） | 是 recommendation 的上游候选来源之一；recommendation 多出 fingerprint/dependency_hashes/lifecycle 合同层。 |

**核心分工**：`detection（信号）→ recommendation（确定性结论）→ action（执行）`。三段式，recommendation 居中，两端硬墙。

---

## 14. Fixtures（≥10，匿名）

> 验收 #3：至少 10 条匿名 fixture，覆盖 issue Phase 0 全部验收场景。

每条 fixture：`given（状态）/ when（操作）/ then（合同断言）`。全部用匿名占位符。

### F1 — 稳定重放（stable replay）
**given**：实体A、实体B 存在 reports_to 候选边；policy/ontology 不变。
**when**：同一 rule 两次产出 recommendation。
**then**：两次 `fingerprint` 相同；replay（重算 canonical inputs）== 存储 fingerprint。

### F2 — 依赖变化 → stale
**given**：F1 的 record 处于 `current`。
**when**：实体A 的 `pages.content_hash` 变（body 被编辑）。
**then**：重算 `entity_hash("实体A")` ≠ 记录值 → record 转 `stale`；不得作为 `current` 展示。

### F3 — policy diff
**given**：F1 的 record 记录 `policy_version = H(rule code v1)`。
**when**：rule 代码改动，`policy_version = H(rule code v2)`。
**then**：`constraints.policy_version` 不匹配 → record 转 `invalidated`；diff axis = `constraint`。

### F4 — candidate 不升级为 fact
**given**：recommendation 引用一条 `trust_state=candidate` 的 reports_to 证据。
**when**：用户"接受"该 recommendation。
**then**：recommendation 生命周期推进，但**不写**任何 `trust_state=trusted` 的 link/timeline；candidate 证据保持 candidate（或走独立确认流，但不由 recommendation 自动升）。

### F5 — inactive evidence 排除
**given**：实体A 有两条 reports_to 证据，一条 `trusted`、一条 `rejected`。
**when**：rule 构建 evidence_manifest（过 `INACTIVE_STATES`/`ACTIVE_LINK_SQL`）。
**then**：`rejected` 那条**结构性不进 manifest**（manifest 内无 `active` 字段，inactive 无法表达）；fingerprint 只反映 active 证据。该 `rejected` 证据日后若翻 `trusted` → 新增 manifest 条目 → fingerprint 变 → 旧 record stale（F11）。

### F6 — conflict → abstain
**given**：关于主题B 存在矛盾证据（`EvidenceBoard.conflicts` 非空）。
**when**：rule 评估。
**then**：`conclusion = { kind: "abstain", reason: "conflict" }`；不发 ProposedAction。

### F7 — 无证据 → abstain
**given**：方案C 无任何 active 证据（facts 空、candidates 全 inactive）。
**when**：rule 评估。
**then**：`conclusion = { kind: "abstain", reason: "insufficient_evidence" }`（或 `inactive_evidence_only`）。

### F8 — 拒绝后不重复
**given**：record R（maintenance_key=K, fingerprint=F）被用户 `rejected`。
**when**：rule 再次产出同 K 同 F 的 record。
**then**：去重命中 `rejected` 历史，**不重新提案**。同 K 不同 fingerprint（输入变了）仍可新提案。

### F9 — 审计隐私
**given**：任意 maintenance record。
**when**：导出公开示例 / 测试 / display。
**then**：不含真实 slug / 路径 / 凭据串 / 内部字段名；evidence ref 为抽象引用；display 文本用 `实体A`/`主题B`。

### F10 — 不自动执行
**given**：任意 propose 型 record。
**when**：record 创建/接受。
**then**：`applicability.auto_execute === false`；producer 无任何写操作调用；无 repair/merge/sync/delete 触发。

### F11 — 事实升级改指纹（对抗）
**given**：F1 record 引用 `trust_state=candidate` 证据。
**when**：该证据独立升为 `trusted`（经用户确认流，非 recommendation 自动）。
**then**：evidence_manifest 的 `trust_state` 字段变 → fingerprint 变 → 旧 record `stale`，不作 current。

### F12 — 非确定性攻击（对抗）
**given**：同一输入，但 manifest/entity_hashes 数组顺序不同。
**when**：算 fingerprint。
**then**：canonical JSON 强制排序 → fingerprint 相同；顺序差异不影响指纹。

### F13 — 隐式执行攻击（对抗）
**given**：恶意/失误的 producer 规则尝试在结论里嵌写操作。
**when**：合同校验。
**then**：`ProposedAction.type` 只允许 `review|dry_run|notify_draft`；`auto_execute:false` 不变量；任何写操作尝试 = 合同违反，record 拒绝创建。

---

## 15. 对抗审查（task #7）

> 7 类攻击 × 缓解 × 对应 fixture。

| # | 攻击 | 缓解（合同层） | fixture |
|:--|:--|:--|:--|
| 1 | **事实升级**：candidate→trusted 后旧 record 仍冒充 current | evidence_manifest 带 `trust_state`，进 fingerprint；升级改指纹 → record 转 stale；display filter 排除 stale | F11 |
| 2 | **inactive evidence**：rejected/superseded 证据漏进结论 | manifest 无 `active` 字段、producer 过滤后只含 active 证据——inactive **结构性**无法进入结论（不靠运行时检查）；inactive→active 翻转由 entity_hash + 新 manifest 条目捕获 → stale | F5、F11 |
| 3 | **conflict**：矛盾下仍 propose | `EvidenceBoard.conflicts` 非空 → 强制 abstain(`conflict`)；不发 ProposedAction | F6 |
| 4 | **隐私泄漏**：record/display 泄漏 vault 内容 | 抽象 evidence ref（不存原文）；display 匿名占位符；display 准入挂 #327 surface 覆盖 + structured 默认；audit/raw 经 `redactAudit` | F9 + §11 |
| 5 | **隐式执行**：recommendation 触发写操作 | `auto_execute:false` 不变量；producer 只读；`ProposedAction.type` 白名单；合同校验拒绝写操作 | F10/F13 |
| 6 | **非确定性 fingerprint**：顺序/时间/随机导致同输入不同指纹 | canonical JSON 排序；NFKC；排除 `created_at`/`Math.random`/`Date.now`/自增 id；manifest/alternatives/entity_hashes 显式 sort | F12 |
| 7 | **旧 record 冒充 current**：stale/superseded 仍展示 | display filter `lifecycle_status IN (current,pending)`；stale 回 current 必须重算新 fingerprint；rejected 同 fingerprint 不重复 | F2/F8 |

**审查结论**：7 类攻击均有合同层缓解 + fixture 覆盖。隐私（#4）依赖 #327 后续 surface 覆盖——这是**已知前置依赖**，不是本 spec 的缺口，Phase 1 实现时强制 gate。

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

1. **物理 schema**：CREATE TABLE 的列、索引、CHECK 约束、`fingerprint UNIQUE`、config-key migration key 命名。
2. **审计副表**：`recommendation_lifecycle_history` 是否同构 `compounding_review_feedback`，还是复用一张泛化 audit 表。
3. **producer 注册机制**：rule_id 命名空间、code_hash 计算边界（整文件 vs 函数）、如何防 producer 偷偷写。
4. **entity_hashes 实现成本**：全投影哈希在大 vault 下的性能；是否需要增量/缓存。
5. **display 准入**：与 #327 Phase 2-4 的具体对接点；recommendation 走哪个 MCP surface。
6. **abstain 展示**：是否给"为什么没建议"的查询入口。
7. **与 next_actions 的并轨**：attention queue 是否直接消费 `current` recommendation，还是双轨。

---

## 18. 验收对照表

| issue Phase 0 验收 | 本 spec 章节 |
|:--|:--|
| 1. Recommendation Contract spec，与 research/EvidenceBoard/next_actions/Compounding Review 分工 | §2、§13 |
| 2. 稳定最小 record shape + 生命周期，不提前锁 DB 迁移 | §4、§5、§6、§7、§10 |
| 3. ≥10 条匿名 fixture，覆盖全部验收场景 | §14（13 条） |
| 4. 新表 vs 复用 lifecycle trade-off + 推荐 | §10 |
| 5. #327 未完成前不进默认 display | §11 |
| 6. 公开示例匿名占位符 | §14 + §11.3 |
| 推导结构约束（节点/边/causes 限定） | §12 |
| 不保存模型私有 CoT | §12 + §0 |
| 对抗审查 7 类 | §15 |

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
