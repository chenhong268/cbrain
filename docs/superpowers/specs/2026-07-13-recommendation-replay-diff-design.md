# Recommendation Phase 2A — Offline Replay & Deterministic Record Diff（设计 spec）

**状态**：SPEC ONLY，不含代码。提交后停在 Codex review gate，未 APPROVE 前不进 writing-plans、不碰 `src/`/tests/migration/MCP/CLI。
**Issue**：#330 · **Parent roadmap**：#328 · **输出边界**：#327（本期不触碰）
**Base**：`origin/main` @ `69094a5`（== Phase 1 集成点）
**基线合同**：`docs/superpowers/specs/2026-07-12-recommendation-contract-design.md`（§5.1 / §6.2 / §7.2 / §8.1–8.4 / §15 / §17）
**本期边界**：只读 core · 精确历史 rule · 冻结输入 · 五轴确定性 diff · 无 MCP/LLM/迁移

> 审查历程：自审两轮（API 准确性、脱敏匿名 PASS）→ Codex 复审 `ee43297` CHANGES REQUESTED（diff 合同 3 HIGH + 2 MEDIUM，replay 主方向 PASS）→ 本轮 `fix(spec)` 全闭环。锁定决策见 §9。

---

## 1. 问题与边界

Phase 1（#328，已集成为 `69094a5`）已能把维护建议落库为经过可信解码、完整性校验、版本绑定与生命周期治理的 `RecommendationRecord`。系统仍**无法确定性回答**：

1. 这条历史建议能否由当时的**冻结输入 + 精确 rule 版本**重新算出？
2. 两条建议的差异来自 **evidence / constraint / option / dependency / conclusion** 哪一轴、哪个字段？
3. 旧 rule 已 `purged`/`incompatible`/`unknown` 时，系统能否准确区分「无法历史验证」与「重放失败」？

Phase 2A 实现一个**只读、离线、确定性**的 replay + record-to-record diff core。本期**不**向 Agent 暴露新工具，**不**新增 migration/audit 表，**不**调用 LLM/embedding/search/vault/网络。

---

## 2. 基线合同（已验证 Phase 1 API，零幻觉基线）

下述签名均在 `69094a5` 实测确认。Phase 2A **只消费**这些 API，不修改它们。

### 2.1 可信读取 —— `src/core/recommendation/record-store.ts`

```ts
class RecommendationStore {
  constructor(private db: CBrainDB) {}
  getById(id: string): RecommendationRecord | null   // 唯一公开的按 id 读取入口
  // 写方法（replay/diff 一律禁调）：createRecord / transitionLifecycle / updateFreshness / clearSuppression
}
```

- **not-found**：`getById` 在无匹配行时返回 `null`，**不抛**。
- **坏行**：行存在但不可信时，**抛裸 `Error`**（无自定义类）。message 模板：
  - `record-store: untrusted row ${record_id} (auto_execute not strictly false)`
  - `record-store: untrusted row ${record_id} (envelope mismatch)`
  - `record-store: untrusted row ${record_id} (integrity ${code})`
  - ⚠ **message 泄露 `record_id` 与 integrity `code`**；不泄露 payload/fingerprint/stack。`JSON.parse` 损坏 payload 时抛 `SyntaxError`（未被 catch，直接传播）。
- **可信解码** `decodeTrustedRow(r: Row): RecommendationRecord` 是**模块私有、不导出**。它是 `getById` / active-supersede / rejected-suppression 的统一可信入口，强制三层：(1) 绝对不变量 `r.auto_execute === 0 && payload.applicability.auto_execute === false`；(2) envelope `payload.maintenance_key === r.maintenance_key && payload.inputs_hash === r.inputs_hash`；(3) 完整 `checkIntegrity(rec)` 重算 fingerprint（**不信任存储的 fingerprint 列**）返回 ok。
- **DB CHECK 可绕过**：`PRAGMA ignore_check_constraints=ON` 可关掉 `CHECK(auto_execute=0)`。因此 store 层 defense-in-depth（`decodeTrustedRow` + `checkIntegrity`）才是真防线，不是 DB CHECK。
- **read-only 性**：`getById` 仅一次 `SELECT *` + 纯解码，无 INSERT/UPDATE/transaction/history。
- **raw DB 句柄可达性**：`store` 持有 `private db: CBrainDB`，其 `rawDb`（better-sqlite3）可被绕过 `getById` 直接写。replay/diff 的只读证明必须含**结构性 import guard** 阻断这条路径（§6），不能只靠 spy store 写方法。

> **结论**：replay/diff 取可信 record **只能走 `getById`**，不能 import 私有 `decodeTrustedRow`，也不需要扩张 `record-store.ts`。

### 2.2 完整性 —— `src/core/recommendation/integrity.ts`

```ts
type IntegrityCode =
  | "inputs_hash_mismatch" | "fingerprint_mismatch"
  | "cross_undeclared_field" | "cross_evidence_not_projected" | "cross_rule_id_mismatch"
  | "duplicate_declaration" | "illegal_action_type" | "illegal_auto_execute";
type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };
function checkIntegrity(r: RecommendationRecord): IntegrityResult;   // 纯，确定性，从不抛
function computeInputsHash(di: DecisionInputs): string;              // sha256(canonicalJson({signals, inspected_claims(normalized), entity_snapshot, evidence_refs(sorted)}))
function computeFingerprint(p: RecommendationImmutablePayload): string;
function normalizePayloadProse(p: RecommendationImmutablePayload): RecommendationImmutablePayload; // 不可变，仅归一化 prose
```

- `checkIntegrity` **从不抛**，返回 `{ok, code}`。判定顺序：`illegal_auto_execute`（payload 侧 `!== false`）→ `illegal_action_type` → `duplicate_declaration` → `inputs_hash_mismatch` → `fingerprint_mismatch` → `cross_*`。
- ⚠ `checkIntegrity` **不**校验 envelope（列 ↔ payload）也**不**校验 `row.auto_execute === 0` 列——那两件是 `decodeTrustedRow` 的职责。直接对手搓 record 调 `checkIntegrity` 会**绕过** envelope + 行列防御。
- ⚠ `computeInputsHash`/`computeFingerprint` 内部走 `canonicalJson` → `assertJsonSafe`，**无 try/catch 包裹**：若 `decision_inputs` 含非 JSON-safe 值（裸 surrogate/环/非有限数/undefined 值），`checkIntegrity` 会**抛**（不返回 `ok:false`），经 `getById` 传出。
- **NFKC**：`normalizeProse = s.normalize("NFKC").replace(/\s+/g," ").trim()`。fingerprint **故意**对 prose 做 NFKC，故全角 `ｓｃｏｒｅ` 与 ASCII `score` 共享一个 fingerprint。identifier（refs/slug/source/rule_id/rule_version/code_hash/registry_ref/table/fields/namespace/maintenance_key/hash）**不做** NFKC。
- `IntegrityResult.message` 是按 code 的**固定脱敏串**；但 message 不保证跨版本稳定，**判定一律 key off `code`**。
- `cross_rule_id_mismatch` 只比对 `dependency_manifest.rule_id !== producer.rule_id`——**不**比对 `producer.code_hash`/`registry_ref`。这正是「自洽篡改 producer identity 并重算 fingerprint」能绕过 integrity 的根因，必须由 replay 身份钉扎补（§4 step 3）。

### 2.3 版本化注册表 —— `src/core/recommendation/registry.ts`

```ts
interface RuleRunner {
  code_hash: string;
  captureInputs: (projection: unknown) => DecisionInputs;   // 重读 live projection（capture-time）
  decide: (di: DecisionInputs) => RecommendationConclusion; // 纯，replay 入口
}
type ResolveResult =
  | { status: "ok"; runner: RuleRunner; def: RuleDefinition }
  | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };
class VersionedRuleRegistry {
  resolve(id: string, ver: string): ResolveResult;     // 精确版本，从不抛，从不回退 active，read-only
  resolveActive(id: string): ResolveResult;            // 走 activeVersion（replay 禁用）
  policyManifest(): string;                            // 排序后的 active 快照，read-only，确定性
  registryAuditManifest(): string;                     // 排序后的全量审计快照，read-only，确定性
  // 写方法（replay/diff 一律禁调）：register / setActive / markPurged / markIncompatible
}
```

- `resolve(id, ver)` 按 `${id}@${ver}` 精确查表：live → `ok`；`markPurged` → `unavailable/purged`；`markIncompatible` → `unavailable/incompatible`；既无 live 也无 tombstone → `unavailable/unknown`。**不会**回退到 active 版本。
- `def: RuleDefinition` 承载**身份**（`rule_id` / `rule_version` / `registry_ref`）+ 行为声明；`runner.code_hash` 是**行为**哈希。tombstone 保留 `code_hash` 但 runner 已删——**tombstone 版本不可执行**。
- `code_hash = definitionCodeHash(def)` 只覆盖行为子集，**排除** `rule_id/rule_version/registry_ref`。
- `policyManifest()` / `registryAuditManifest()` 输出已排序的字符串，可直接做 before/after byte-identical 比对。

### 2.4 规则运行时 —— `src/core/recommendation/rule-runtime.ts`

```ts
function definitionCodeHash(def: RuleDefinition): string;
function runRule(def: RuleDefinition): { code_hash; captureInputs; decide };
```

- `decide(di)` **纯函数**：不调 `captureInputs`、不读 DB/LLM/网络，只消费传入的 `DecisionInputs`。当前实现用 `?? 0` 守住 NaN/undefined，**不抛**。
- `captureInputs(projection)` **重读 live projection**。replay **禁止**调用——它会读到与冻结时不同的投影，破坏 byte-exact 重放。
- ⚠ `assertJsonSafe` 只保证 `DecisionInputs` **可序列化**，**不**保证其满足某历史 runner 的**语义 schema**——JSON-safe 的错误 shape 完全可能让 runner 抛错（见 §4.3）。
- 参考生产者 `KNOWN_RELATIONS_DEF`：`rule_id="health:known_relations"`, `rule_version="1.0.0"`, `registry_ref="cbrain.rules:maintenance.known_relations@1.0.0"`。

### 2.5 规范化与哈希 —— `src/core/recommendation/canonical.ts`

```ts
function serializeNumber(n: number): string;   // -0→"0"，非有限（NaN/±Infinity）抛
function normalizeProse(s: string): string;    // NFKC + 折叠空白 + trim
function assertJsonSafe(v: unknown): void;     // 拒绝 undefined 值/裸 surrogate/非 plain object/环/非有限数
function canonicalJson(value: unknown): string;// object key 按 UTF-16 code-unit 升序；数组按完整元素 canonical 串升序（非保序！）；数字经 serializeNumber
function sha256Hex(s: string): string;         // 小写 64 hex
```

- ⚠ **`canonicalJson` 排序数组**：数组元素顺序**不影响**输出。「仅数组顺序不同」的两个 payload canonical 相等、fingerprint 相等。
- **无独立的 equality helper**——确定性比较就是 `canonicalJson(a) === canonicalJson(b)`。
- 全模块无 Map 插入序依赖、无 `Date.now`、无 `Math.random`，纯且确定。

### 2.6 不可变 payload 与五轴字段映射 —— `src/core/recommendation/types.ts`

```ts
interface RecommendationImmutablePayload {
  namespace; maintenance_key; inputs_hash;
  conclusion: RecommendationConclusion;
  decision_inputs: DecisionInputs;
  evidence_manifest: EvidenceManifestEntry[];   // {source, ref, trust_state}
  constraints: RecommendationConstraints;        // {policy_version, ontology_version, schema_version}
  dependency_manifest: DependencyManifest;       // {rule_id, declarations: DependencyDeclaration[]}
  applicability: Applicability;                  // {audience, auto_execute: false, requires_confirmation}
  risks: string[]; gaps: string[];
  producer: RecommendationProducer;              // {rule_id, rule_version, code_hash, registry_ref}
}
interface RecommendationRecord {
  record_id; payload; fingerprint; created_at;   // 不可变身份/起源
  last_revalidated_at; lifecycle_status; freshness_status; suppressed_until; // 可变
}
type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };
type DecisionInputs { signals: Record<string,unknown>; inspected_claims?: string[]; entity_snapshot: Record<string, EntityProjection>; evidence_refs: string[]; }
type TrustState = "trusted" | "user_thought" | "candidate" | "rejected" | "superseded"; // ../provenance
```

- **IMMUTABLE** = `payload.*` 全部；**MUTABLE** = `last_revalidated_at` / `lifecycle_status` / `freshness_status` / `suppressed_until`。
- ⚠ types.ts 中**尚不存在** `ReplayResult` / `DiffAxis` / `DiffEntry`（grep 确认）。Phase 0 spec §8.2/§8.3 只有草稿。Phase 2A **新增**这些类型。
- **五轴 → payload 字段映射**（Codex 锁定，详见 §5.1）：`evidence→evidence_manifest`、`constraint→constraints+producer+applicability+risks+gaps`、`option→conclusion.alternatives`、`dependency→inputs_hash+decision_inputs字段级+dependency_manifest.declarations`、`conclusion→conclusion.kind+最终action/abstain reason`。`namespace`/`maintenance_key` 不同 → `incomparable`，非轴。

---

## 3. Replay 结果类型（Phase 2A delta）

Phase 0 §8.2 草拟的 `ReplayResult` 为 `{replayed; conclusion; inputs_match: boolean} | {rule_version_unavailable; reason} | {unverifiable; reason: string}`。Phase 2A 按 issue #330（其类型标注为「建议形态」）与 handoff 的 12 条锁定决策做如下 **delta**：

```ts
export type ReplayResult =
  | { status: "not_found" }
  | { status: "replayed"; inputs_match: true }
  | { status: "rule_version_unavailable"; reason: "unknown" | "purged" | "incompatible" }
  | { status: "unverifiable"; reason: "integrity_failed" | "producer_mismatch" | "runner_failed" }
  | { status: "conclusion_mismatch" };
```

| delta | 原因 |
|---|---|
| 新增 `not_found` 独立状态 | 锁定 #1：not-found 不得混进 `unverifiable` |
| 新增 `conclusion_mismatch` 独立状态 | 锁定 #6：conclusion 不一致 ≠ unavailable/unverifiable |
| `replayed.inputs_match` 收为字面量 `true` | integrity-first 保证到达 `replayed` 时 inputs_hash 必已通过，`inputs_match` 恒真；保留字段以对齐 #330 类型 |
| `replayed` 去掉 `conclusion` 字段 | 成功路径，caller 已持 record（经 `getById`），重复回传 `conclusion`（payload 子集）无信息增益且扩大泄露面 |
| `unverifiable.reason` 由 `string` 收为 **3 值** enum | 锁定 #7：固定 enum，禁止 exception message/stack 泄露 |
| **偏离 #330 建议形态：删 `runner_schema_incompatible`，统一 `runner_failed`** | Phase 2A **无 typed input validator**——`assertJsonSafe` 只保证可序列化、不保证语义 schema 兼容，JSON-safe 的错误 shape 可让 runner 抛错，故**无法可靠区分** schema incompatibility 与 runner exception，统一映射 `runner_failed`（**非「不可达」**）；typed validator 留后续，本期不扩 scope（§9 #4） |
| `rule_version_unavailable.reason` 直接透传 registry 的 `unknown\|purged\|incompatible` | 锁定 #3：精确版本；三类不混淆 |

**union 不重叠自检**：5 个 `status` 字面量两两不同；`unverifiable.reason` 3 值互斥；附加字段不产生歧义判别。✅

---

## 4. Replay 合同

### 4.1 注入与签名

```ts
// src/core/recommendation/record-reader.ts — 可信、只读、不可由普通结构对象冒充
export class RecommendationRecordReader {
  readonly #store: RecommendationStore;
  private constructor(store: RecommendationStore);
  static fromStore(store: RecommendationStore): RecommendationRecordReader;
  getById(id: string): RecommendationRecord | null;
}

// src/core/recommendation/replay.ts
export interface ReplayDeps {
  readonly store: RecommendationRecordReader; // 最小权限：仅 getById
  readonly registry: ExactRuleResolver;       // 最小权限：仅 resolve
}
export interface ExactRuleResolver {
  resolve(id: string, version: string): ResolveResult;
}
export function replayRecord(deps: ReplayDeps, recordId: string): ReplayResult;
```

- 函数式入口（无状态、无缓存）。不引入 `ReplayEngine` 类（YAGNI，见 §7）。`RecommendationRecordReader` 是极薄 facade：只能由 `fromStore(realStore)` 构造（`RecommendationStore` 因 private `db` 本身具有 nominal typing），实例只暴露 `getById`；普通 `{getById(){...}}` 结构对象不能冒充。resolver 接口按最小权限定义，不暴露 `register`/`setActive`/`markPurged` 等写方法。
- `recordId` 是 `RecommendationRecord.record_id`（UUID），**不出现在任何结果变体里**（脱敏）。

### 4.2 流程（顺序即合同）

```
step 1  rec = store.getById(recordId)
        ├─ rec === null                     → { status: "not_found" }
        ├─ 抛（任何 Error / SyntaxError / assertJsonSafe） → catch，丢弃 .message
        │                                     → { status: "unverifiable", reason: "integrity_failed" }
        └─ 返回可信 record                  → 继续（已过 auto_execute 绝对不变量 + envelope + checkIntegrity）

step 2  r = registry.resolve(rec.payload.producer.rule_id, rec.payload.producer.rule_version)
        └─ r.status === "unavailable"       → { status: "rule_version_unavailable", reason: r.reason }  // 透传 enum

step 3  身份钉扎（identity pin；任一不等 → producer_mismatch，不调 decide）
          承重比较（catches 自洽篡改 producer identity + 重算 fingerprint，integrity 抓不到）：
            runner.code_hash    === rec.payload.producer.code_hash
            def.registry_ref    === rec.payload.producer.registry_ref
          防御纵深同义检查（resolve 按 (rule_id,rule_version) 查表，故 def.rule_id/def.rule_version 恒等于
          查表键；保留以防御未来返回与查表键不一致 def 的注册表实现）：
            def.rule_id         === rec.payload.producer.rule_id
            def.rule_version    === rec.payload.producer.rule_version
        └─ 任一不等                         → { status: "unverifiable", reason: "producer_mismatch" }

step 4  try { replayed = runner.decide(rec.payload.decision_inputs) }
        └─ 抛（任何，含 schema-shape 错误）  → catch，丢弃 .message → { status: "unverifiable", reason: "runner_failed" }
        // 禁止调用 runner.captureInputs；只喂冻结 decision_inputs

step 5  if (canonicalJson(replayed) === canonicalJson(rec.payload.conclusion))
          → { status: "replayed", inputs_match: true }
        else
          → { status: "conclusion_mismatch" }
```

### 4.3 各结果码的精确触发条件

| 结果 | 触发 | runner.decide 被调？ |
|---|---|---|
| `not_found` | `getById` 返回 `null` | 否 |
| `integrity_failed` | `getById` 抛（auto_execute/envelope/integrity 任一，payload JSON 损坏 `SyntaxError`，或 `decision_inputs` 非JSON-safe 致 `checkIntegrity` 内 `assertJsonSafe` 抛） | 否 |
| `rule_version_unavailable` | `resolve` 返回 `unavailable`（`unknown`/`purged`/`incompatible`） | 否 |
| `producer_mismatch` | 身份钉扎：`runner.code_hash` 或 `def.registry_ref` 不等（承重）；或 `def.rule_id`/`def.rule_version` 不等（防御纵深） | 否 |
| `runner_failed` | `runner.decide` 抛（含 JSON-safe 但语义 schema 不兼容致 runner 抛——见下） | 调了，但 fail-closed |
| `replayed` | `decide` 返回且 canonical conclusion 相等 | 是 |
| `conclusion_mismatch` | `decide` 返回但 canonical conclusion 不等 | 是 |

> **关于 schema 类异常（修正 MEDIUM 1 措辞）**：原 #330 建议形态含独立 `runner_schema_incompatible`。但 Phase 2A **无 typed input validator**——`assertJsonSafe` 只保证 `DecisionInputs` 可序列化，**不**保证其满足历史 runner 的语义 schema；JSON-safe 的错误 shape 完全可能让 `decide` 抛错。故**无法可靠区分** schema incompatibility 与 runner exception，统一映射 `runner_failed`。这不是「不可达」——是「不可区分」。typed validator 留后续 phase，本期不扩 scope（§9 #4）。

### 4.4 错误脱敏边界（锁定 #7，验收 #6）

- `ReplayResult` 所有变体**只含 enum / 字面量**：`status`、`reason`、`inputs_match`。**绝不**包含 `record_id`、`payload`、`conclusion`、异常 `message`、`stack`、文件路径、slug、ref。
- `getById` 抛出的 `Error` message 含 `record_id` + integrity `code`——`replayRecord` 必须 `catch (_e) { ... }`，**不读 `e.message`**，统一映射为 `integrity_failed`。
- `runner.decide` 抛错同理：`catch (_e)`，不读 message，映射 `runner_failed`。**不靠字符串匹配区分 schema/failure**——无 typed validator，二者不可靠区分（§4.3）。
- `rule_version_unavailable.reason` 直接透传 registry 的 enum（结构化串，非泄露向量）。

### 4.5 与 integrity / freshness 的分工（锁定 #2，Phase 0 §8.1 vs §8.2 / F14）

- **integrity（§8.1）= 离线重算，不执行 rule**：`getById` → `decodeTrustedRow` → `checkIntegrity` 已覆盖。replay **不重复** `inputs_hash` / `fingerprint` 比对——那是死代码。
- **decision-replay（§8.2）= 执行 `runner.decide` 比对 conclusion**：replay 的本职。两条路径**不得合并**（F14）。
- **freshness（§5.3/§8.4）= 用同版本 `captureInputs` 重建 inputs_hash 比对当前投影**：写 `freshness_status` + `last_revalidated_at`，**碰 DB**。replay **不**做 freshness——只读冻结 `decision_inputs`，不重建投影，不写 freshness。

---

## 5. Diff 合同

### 5.1 五轴分区、字段映射、粒度与 incomparable（Codex 锁定）

只比较两条**可信** record 的**不可变 payload**。可变字段不参与。

**前置 incomparable 判定**：若 `a.payload.namespace !== b.payload.namespace` 或 `a.payload.maintenance_key !== b.payload.maintenance_key`，两 record 不属同一比较槽位 → 返回固定 `{ ok:false, reason:"incomparable" }`，**不**生成任何 entries（避免 misleading diff）。`namespace`/`maintenance_key` **不是 diff 轴**。

**粒度（锁定）**：per-element + per-field——每个变化字段/元素一条 `DiffEntry`，携带稳定 `key`（RFC 6901 JSON Pointer）+ 显式 `change`（不靠 before/after 猜，见 §5.2）。所有动态 path segment 必须先做 `~ → ~0`、`/ → ~1` 转义；禁止用 `.`, `:`, `::`, `[]` 裸拼 identifier。

| 轴（固定序） | 承载字段 | `key` JSON Pointer 示例 | 触发 |
|---|---|---|---|
| `evidence` | `evidence_manifest[]` {source,ref,trust_state} | `/evidence_manifest/<source>/<escaped-ref>` | 条目增删或 trust_state 翻转 |
| `constraint` | `constraints` + `producer` + `applicability` + `risks[]` + `gaps[]`（均影响建议可执行边界） | `/constraints/policy_version`、`/producer/code_hash`、`/applicability/requires_confirmation/tier`、`/applicability/requires_confirmation/reason`、`/applicability/requires_confirmation/confirm`（集语义数组，仅 `high_impact` 臂出现）、`/risks/<escaped-canonical>`、`/gaps/<escaped-canonical>` | 任一变化 |
| `option` | `conclusion.alternatives[]`（**仅候选选项集**） | `/conclusion/alternatives/<escaped-canonical-action>` | alternatives 集合增删/变化 |
| `dependency` | `inputs_hash`（快判）+ `decision_inputs` 字段级 + `dependency_manifest.declarations[]` | `/decision_inputs/signals/<escaped-k>`、`/decision_inputs/entity_snapshot/<escaped-slug>/<escaped-as>`、`/decision_inputs/evidence_refs/<escaped-ref>`、`/decision_inputs/inspected_claims/<escaped-claim>`、`/dependency_manifest/declarations/slug/<escaped-slug>/<escaped-as>` | inputs_hash 不等则下沉 decision_inputs 字段级 diff（§5.3）；declarations 变化 |
| `conclusion` | `conclusion.kind` + 最终 selected `action`（propose）或 abstain `reason` | `/conclusion/kind`、`/conclusion/action/type`、`/conclusion/action/target_ref`、`/conclusion/action/reason`、`/conclusion/action/rollback_note`、`/conclusion/reason` | 最终建议变化 |

**rule_id 单归属**：`rule_id` 经 `producer.rule_id` 只在 constraint 轴追踪（`dependency_manifest.rule_id` 在 trusted record 上恒等于 `producer.rule_id`，不重复）。

**cross-kind 语义**：当两 record `conclusion.kind` 不同（propose↔abstain），conclusion 轴承载 kind 变化（`conclusion.kind` changed）+ propose 侧 `action.*` 字段 removed + abstain 侧 `reason` added；`option` 轴照常比 alternatives（与 kind 无关）。

**数组/集语义**：`evidence_manifest`/`alternatives`/`risks`/`gaps`/`evidence_refs`/`inspected_claims`/`declarations` 按**集合语义**比对（顺序不算 diff，对齐 `canonicalJson` 排序）；仅成员/内容差异算。

### 5.2 DiffEntry 形状与确定性排序

```ts
export type DiffChange = "added" | "removed" | "changed";
export interface DiffEntry {
  readonly axis: DiffAxis;
  readonly key: string;        // RFC 6901 JSON Pointer；动态 segment 先 escape，集合元素用 canonical 串作 segment
  readonly change: DiffChange; // 显式派生，不靠 before/after 猜
  readonly before: string;     // canonicalJson(左值)；added 时 ""
  readonly after: string;      // canonicalJson(右值)；removed 时 ""
}
```

- **`change` 显式派生**：元素 A 有 B 无 → `removed`；B 有 A 无 → `added`；都有但 canonical 不等 → `changed`。标量字段（如 `constraints.policy_version`、`conclusion.kind`）只可能 `changed`（永 present）。
- **JSON Pointer 编码**：`escapePointerSegment(s) = s.replaceAll("~", "~0").replaceAll("/", "~1")`。path 由固定 segment 与逐个转义后的动态 segment 用 `/` 连接；不得先拼动态 identifier 再整体转义。`slug=null` 的 global declaration 使用固定分支 `/dependency_manifest/declarations/global/<escaped-as>`；有 slug 使用 `/dependency_manifest/declarations/slug/<escaped-slug>/<escaped-as>`，不使用 `__global__` sentinel。
- **去重（修正 HIGH 1）**：按完整 `(axis, key, change, before, after)` 五元组去重——**仅**防 impl 重复报告同一变化。`key` 承载字段身份：**不同字段的相同值变化不会被合并**（例：`/constraints/policy_version` 与 `/constraints/ontology_version` 都 `"v1"→"v2"` → key 不同 → 保留**两条** entry）。
- **排序（全序）**：primary `axis` 固定序（evidence<constraint<option<dependency<conclusion）；secondary `key` 字典序；tertiary `change`（`added`<`changed`<`removed`）；quaternary `before`；quinary `after`。不依赖 Map/SQL/对象插入序；`(axis,key,change)` 唯一保证全序确定。
- 空 `entries = []` ⟺ 五轴全等（且 namespace/maintenance_key 相同，否则 incomparable）。

### 5.3 dependency 轴字段级 diff（修正 HIGH 3，落实 Phase 0 §8.3「hash 快判 → 字段级下沉」）

- `inputs_hash` **仅作相等快判**：`a.payload.inputs_hash === b.payload.inputs_hash` → 跳过 `decision_inputs` 字段级 diff（canonical 相等，无字段差异）。
- 不等时对 `decision_inputs` 下沉 **path-level diff**（确定性，集语义数组按成员）：
  - `signals`（`Record<string, unknown>`）：逐 key，path `/decision_inputs/signals/<escaped-key>`，标量 `changed` / key 增删 `added`/`removed`。
  - `entity_snapshot`（`Record<slug, Record<as, unknown>>`）：path `/decision_inputs/entity_snapshot/<escaped-slug>/<escaped-as>`。
  - `evidence_refs`（`string[]`，集语义）：path `/decision_inputs/evidence_refs/<escaped-ref>`，增删。
  - `inspected_claims?`（optional `string[]`，集语义）：path `/decision_inputs/inspected_claims/<escaped-claim>`，增删。
- `dependency_manifest.declarations[]`（集语义）：**独立于 inputs_hash** 比对。global declaration path 为 `/dependency_manifest/declarations/global/<escaped-as>`；slug declaration path 为 `/dependency_manifest/declarations/slug/<escaped-slug>/<escaped-as>`。字段级（table/as/fields/relation/direction/filter 任一变 → `changed`；条目增删 → `added`/`removed`）。不复用 `integrity.validateDependencyDeclarations` 当前的字符串拼接 key，也不假设 identifier 禁止分隔符。
- 所有 `key`/`before`/`after` 均 canonical；数组按集语义。用户因此能看到「哪个 signal / entity snapshot / evidence ref / inspected claim 变了」，而非仅「输入变了」。

### 5.4 纯核心 vs fetch 包装（含 incomparable）

```ts
// 模块私有纯核心：只由可信 fetch wrapper 调用，不作为生产导出 API
export type DiffResult =
  | { ok: true; entries: DiffEntry[] }
  | { ok: false; reason: "incomparable" };   // namespace 或 maintenance_key 不同
function diffTrustedRecords(a: RecommendationRecord, b: RecommendationRecord): DiffResult;

// fetch + fail-closed 包装
export type DiffOutcome =
  | { ok: true; entries: DiffEntry[] }
  | { ok: false; reason: "not_found" | "integrity_failed" | "incomparable" };
export function diffRecordsById(store: RecommendationRecordReader, idA: string, idB: string): DiffOutcome;
```

- 模块私有纯核心做 incomparable 判定 + 五轴 diff，只依赖 `types` + `canonical`。生产 `diff.ts` **唯一运行时导出函数**为 `diffRecordsById`；调用者无法传入裸 `RecommendationRecord`，也不能用普通结构对象伪造 reader。
- `diffRecordsById` 按 A→B fetch（A `null` → `not_found`；A 抛 → `integrity_failed`；B 同理），再调纯核心（`incomparable` 透传）。任一侧 fetch 失败立即 fail-closed，绝不对仅存一侧做部分 diff。

### 5.5 fail-closed

- 任一 record 不可信 → 整体失败，不返回部分 entries。
- 模块私有纯核心不重复可信校验；fail-closed 责任在 `diffRecordsById` 的 fetch 层。因为 helper 不导出，生产调用路径无法绕过该层。

### 5.6 不生成用户文案（锁定 #12）

- core diff 只产 `{axis, key, change, before, after}` 结构化 entries，**不**生成自然语言、不调 `display` safeTitle、**不**宣称满足 #327 Agent-facing display boundary。

---

## 6. 只读与副作用约束（修正 MEDIUM 2：claim 与证据对齐）

replay/diff 前后须证明**完全不变**：recommendation 两表、mutable 状态、pages/links/chunks/FTS/LanceDB、registry active/tombstone。

> store method spy 挡不住实现绕过 store 直接写 raw DB；必须用**结构性 import guard** + **DB 写计数**兜底。

**证明手段（分层）**：

1. **结构性 import guard + nominal reader facade**：`replay.ts`/`diff.ts` 的 import 仅限 `record-reader`/`registry`（replay 仅 type import `ResolveResult`）/`canonical`/`types`。运行时 deps 只暴露 `RecommendationRecordReader.getById` 与 resolver `resolve`；`record-reader.ts` 是唯一可 import `RecommendationStore` 的新模块，且只委托 `getById`。**禁止** replay/diff import `RecommendationStore` 实现、raw DB 句柄（`rawDb`/`better-sqlite3`）、projection builder、search、vault、Lance、ingest 模块。落地：一个 `import` 自检测试（断言模块依赖图）+ 导出面测试（`diff.ts` 运行时仅导出 `diffRecordsById`）+ compile-time negative fixture（普通结构 reader 不可赋值）。这是阻断「绕 trusted read / 绕 store 写 raw DB / 触达 projection/search/vault/Lance」的主防线。
2. **DB `total_changes()`**：replay/diff 前后 `SELECT total_changes()`（该连接累计写操作数）相等 → 证明无任何 DB 写，**覆盖所有表**（含 pages/links/chunks/FTS），不依赖逐表快照。
3. **recommendation 表快照（纵深）**：前后 `SELECT * FROM recommendation_records ORDER BY rowid` + `recommendation_lifecycle_history` byte 相等。
4. **registry manifest 快照**：前后 `policyManifest()` + `registryAuditManifest()` byte 相等。
5. **Lance 目录快照**：前后对 Lance 目录列文件 + mtime + size 取 hash，相等（import guard 已使 replay/diff 结构上不可达 Lance，此为纵深）。
6. **spy 写方法（纵深）**：注入包装 store/registry，断言写方法 call count=0。
7. **spy `captureInputs`**：fake runner 的 `captureInputs` 被调即抛；断言 replay 结果不受影响 + call count=0（验收 #7）。

> 边界声明对齐：「全存储层不变」由 import guard（结构不可达 projection/search/vault/Lance）+ total_changes（全表写计数）+ Lance 目录快照共同支撑，不再只测两张 recommendation 表。

---

## 7. 方案对比

### 方案 A（推荐）：`replayRecord` + `diffRecordsById` 两个小模块，最小 reader/resolver 注入
- record-reader.ts 只把真实 `RecommendationStore.getById` 收窄为 nominal read facade；replay.ts 依赖 reader+最小 resolver type+canonical+types；diff.ts 依赖 reader+types+canonical。纯 diff helper 留在模块私有边界。
- 职责分离：persistence（store）/ registration（registry）/ 重放与比对（本期）。纯核心可无 DB 单测。
- 注入 seam 天然支持 spy（§6）。**不扩张 `record-store.ts`**。
- 代价：两个新模块 + 一个轻量注入类型。可接受。

### 方案 B：把 replay/diff 塞进 `RecommendationStore`
- 混淆 persistence（CRUD + lifecycle 写）与 read-only 重放/比对职责；store 持有 raw DB 句柄，read-only 证明更难（MEDIUM 2 放大此风险）。
- replay 需要 registry（store 当前不依赖）——既然要外部传 registry，就不如独立模块。直接违反 #330「避免扩张 `record-store.ts`」。**否决**。

### 方案 C：直接新增 MCP 工具
- #327 尚未把 recommendation surface 纳入 structured output boundary；公开 API gate 阻断。#330 非目标明列「不新增 MCP/CLI 工具」。**本期否决**。

---

## 8. 测试矩阵（14 验收 + 8 攻击 + HIGH 1/2/3 专项，逐条映射）

所有 fixture 用匿名占位符（`实体A`/`实体B`/`方案C`/`规则R`/`版本v1`/`v2`）。**禁止复合 sentinel 制造假绿**——每字段/轴/攻击独立 fixture。

### 8.1 验收映射（issue #330 §验收 + Codex HIGH 1/2/3 专项）

| # | 验收 | fixture / 断言 |
|---|---|---|
| 1 | 同一 frozen record + 精确 runner → `replayed`，连续两次 byte-stable | `replayRecord` 两次，`canonicalJson(result)` 字节相等；`status==="replayed"`, `inputs_match===true` |
| 2 | active=v2，record 属仍保留的 v1 → 解析 v1 replay 成功 | registry 同时 live v1+v2 且 `setActive(v2)`；record producer 锁 v1；断言走 `resolve(v1)` 非 `resolveActive`，结果 `replayed` |
| 3 | v1 为 unknown/purged/incompatible → 三种 `rule_version_unavailable` | 三 fixture：v1 未注册 / `markPurged` / `markIncompatible`；reason 分别等于三者 |
| 4 | fingerprint/inputs_hash/producer.code_hash/registry_ref 任一篡改 → runner 未调 | 四 fixture：(a1) 改 fingerprint 列 → `integrity_failed`；(a2) 改 inputs_hash 不自洽 → `integrity_failed`；(b1) 自洽篡改 `producer.code_hash` + 重算 fingerprint → `producer_mismatch`；(b2) 自洽篡改 `producer.registry_ref` + 重算 fingerprint → `producer_mismatch`。均断言 `decide` call count=0 |
| 5 | runner 对同输入返回不同 conclusion → `conclusion_mismatch` | fake runner `decide` 返回不同 conclusion；结果 `conclusion_mismatch` |
| 6 | runner throw → 固定脱敏 `unverifiable`，无 stack/路径/record id/payload | fake runner `decide` 抛（含传入 JSON-safe 但语义 schema 错的 shape 致抛）→ `runner_failed`；`JSON.stringify(result)` 不含 record_id/payload/路径/stack |
| 7 | spy 证明 replay 从不调 `captureInputs`，不读 vault/search/network/LLM | fake runner `captureInputs` 抛哨兵；replay 正常返回；call count=0 |
| 8 | replay/diff 前后全存储层不变 | §6 七层证据：import guard + `total_changes()` + recommendation 两表 + registry manifest + Lance 目录，前后 byte/hash 相等 |
| 9 | 两条相同 payload、不同 lifecycle/timestamp → diff 空 | 在临时 DB 持久化两条 payload 相同、mutable 字段不同的 record，经 `RecommendationRecordReader.fromStore(realStore)` 调 `diffRecordsById` → `{ok:true, entries:[]}` |
| 10 | 五轴 + 字段级独立 fixture（无复合假绿，Codex HIGH 2） | 各自独立 fixture，断言仅命中字段：`conclusion.action.target_ref` 改（conclusion 轴）；仅 `conclusion.alternatives` 增（option 轴）；仅 `applicability.requires_confirmation.tier` 改（constraint 轴）；仅一条 `risks`/`gaps` 改（constraint 轴）；不同 `maintenance_key` → `{ok:false, reason:"incomparable"}`；不同 `namespace` → `incomparable` |
| 11 | diff 输入顺序 / 对象 key 顺序 / 数组顺序改变 → 输出稳定 | 拆三 fixture：(a) 仅打乱对象 key 序；(b) 仅打乱数组序（evidence_manifest/alternatives/risks/evidence_refs）；(c) 仅打乱 decision_inputs.entity_snapshot 的 slug/as 序。各自 entries 逐字节相等 |
| 12 | 损坏的任一 diff record / 任一 id 不存在 → fail-closed，不返回部分 diff | 拆三 fixture：(a) A 或 B 经篡改使 `getById` 抛 → `{ok:false, reason:"integrity_failed"}`；(b) A 或 B 的 id 不存在 → `getById` 返回 `null` → `{ok:false, reason:"not_found"}`；(c) A 不存在且 B 损坏 → 取先命中者，仍 `{ok:false}`。均无 entries、不对存活侧部分 diff |
| 13 | focused suite、`bun run lint`、`bun run check`、`bun run check:docs` 全绿 | 实现期 gate；spec 阶段不跑 |
| 14 | diff/privacy scan 不含真实知识/绝对路径/凭据/个人标识 | 匿名 fixture；privacy 扫描过 |
| **H1** | **不同字段相同值变化不被去重吞掉（Codex HIGH 1）** | `constraints.policy_version` 与 `constraints.ontology_version` 都 `"v1"→"v2"` → 断言**两条** entry（key 不同），change 均 `changed` |
| **H3a** | **dependency inputs_hash 不等 → signals 字段级 diff** | 改 `decision_inputs.signals.candidate_count`（重算 inputs_hash）→ dependency 轴出 `/decision_inputs/signals/candidate_count` 一条 `changed` entry，before/after canonical |
| **H3b** | **entity_snapshot 字段级 diff** | 改某 `<slug>.<as>` 值 → `/decision_inputs/entity_snapshot/<escaped-slug>/<escaped-as>` 一条 |
| **H3c1** | **evidence_refs 集语义增删** | 增删一条 evidence_ref（重算 inputs_hash）→ `/decision_inputs/evidence_refs/<escaped-ref>` 一条 `added`/`removed`；顺序打乱不产生 entry |
| **H3c2** | **inspected_claims 集语义增删** | 增删一条 inspected_claim → `/decision_inputs/inspected_claims/<escaped-claim>` 一条 `added`/`removed`；顺序打乱不产生 entry |
| **H3d** | **declarations 字段级 diff** | 改一条 declaration 的 fields/filter → `/dependency_manifest/declarations/(global|slug)/...` 一条 `changed` |
| **H-ck** | **cross-kind（propose↔abstain）完整 entry 集** | A=propose、B=abstain（同 namespace/maintenance_key）；断言 conclusion 轴：`conclusion.kind` changed + `conclusion.action.{type,target_ref,reason,rollback_note}` 各一条 removed + `conclusion.reason` 一条 added；option 轴：A 的每条 `conclusion.alternatives[<canonical>]` 一条 removed（abstain 无 alternatives 字段）。验证与 option 轴不重叠 |
| **H-key** | **动态 segment 含分隔符仍无碰撞** | 分别使用含 `.`, `:`, `::`, `[]`, `/`, `~` 的 slug/as/ref/claim/signal key；断言 JSON Pointer key 唯一、`~`/`/` 正确转义、remove+add 不误报 changed，A/B 输入顺序固定时两次输出 byte-stable |
| **H-trust** | **生产导出 API 无裸 record/伪 reader 绕过入口** | 动态 import `diff.ts`，运行时导出 key 仅 `diffRecordsById`；compile-time negative fixture（`// @ts-expect-error`）证明普通 `{getById}` 结构对象不可赋给带 private field 的 `RecommendationRecordReader`；真实 reader 的 null/throw 仍 fail-closed |
| **M-cap** | **最小权限依赖** | `RecommendationRecordReader` 实例只暴露 `getById`；resolver fake 用 `satisfies ExactRuleResolver`；源码/导出面扫描确认 replay/diff deps 不暴露或调用 store/registry 写方法 |

### 8.2 攻击映射（issue #330 §对抗性审查）

| # | 攻击 | 防御 / 实测证据 |
|---|---|---|
| 1 | active-version substitution：偷用当前 v2 重放历史 v1 | `resolve(v1)` 不回退 active；fixture active=v2 record=v1，断言用 v1 runner（code_hash 来自 v1），结果 `replayed` |
| 2 | integrity bypass：篡改 conclusion 后重算局部 hash 试图让 runner 执行 | 自洽重算 fingerprint 的篡改 → `checkIntegrity` 通过但身份钉扎/`conclusion_mismatch` 拦；仅改列 → `integrity_failed` |
| 3 | producer identity split：rule/version 同但 code_hash/registry_ref 不同 | 验收 #4(b1)/(b2)：自洽篡改 `producer.code_hash` 或 `registry_ref` + 重算 fingerprint → step 3 → `producer_mismatch`，`decide` 未调 |
| 4 | hidden read：replay 内调 captureInputs/DB projection 重读当前状态 | fake runner `captureInputs` 抛哨兵；import guard 阻断 projection/search/vault；spy `getById` 仅一次；call count 证据 |
| 5 | partial diff：一侧损坏仍返回另一侧差异 | `diffRecordsById` 损坏侧 fail-closed → `{ok:false}`，无 entries |
| 6 | nondeterminism：Map/object/array 顺序导致字节不稳定 | `canonicalJson` 排序 key+数组；entries 全序排序（axis→key→change→before→after）；同对 record 两次 diff byte 相等（验收 #11 三 fixture 佐证） |
| 7 | error leak：runner throw 带 stack/路径/payload/id 出 | `catch (_e)` 不读 message；result 仅 enum；`JSON.stringify` 扫描 |
| 8 | side effect：replay/diff 改 freshness/history/registry/存储 | §6 七层证据 |

---

## 9. Codex 复审锁定的决策 + 延后项

**Codex 复审 `ee43297` 已锁定（本轮已落实）：**

1. **五轴字段归属（HIGH 2）**：`option` = 只 `alternatives`；`conclusion` = `kind` + 最终 selected `action`（propose）或 abstain `reason`；`constraint` 纳入 `applicability` + `risks` + `gaps`（影响可执行边界）；`namespace`/`maintenance_key` 不同 → 固定 `incomparable`，不静默忽略、不进轴。
2. **DiffEntry 字段身份（HIGH 1 + 二审 HIGH 2）**：加 RFC 6901 JSON Pointer `key` + 显式 `change`；动态 segment 逐个 escape；去重/排序按 `(axis,key,change,before,after)`，不同字段相同值变化不合并，identifier 分隔符不碰撞。
3. **dependency 字段级 diff（HIGH 3）**：`inputs_hash` 仅快判，不等时下沉 `decision_inputs` path-level diff（signals/entity_snapshot/evidence_refs/inspected_claims）+ declarations 字段级。
4. **可信边界与最小权限（二审 HIGH 1 + MEDIUM 1）**：纯 diff helper 模块私有；唯一生产导出按 id 经 nominal reader 可信读取；reader 只能从真实 store 构造且只暴露 `getById`，resolver 只暴露 `resolve`。

**延后项与已决兼容字段：**

5. **`runner_schema_incompatible` 统一为 `runner_failed`（MEDIUM 1，Codex 已认可统一）**：Phase 2A 无 typed input validator，`assertJsonSafe` 只保证可序列化不保证语义 schema 兼容，二者不可靠区分，统一 `runner_failed`。措辞已从「不可达」改为「不可区分」。typed validator 留后续 phase。
6. **`replayed.inputs_match` 字面量字段**：integrity-first 下恒 `true`。本期保留以对齐 #330 已公布的内部类型建议；不再作为开放决策。

---

## 10. 范围与非目标

**范围**：`record-reader.ts`（nominal read facade）+ `replay.ts` + `diff.ts` 三个小模块；模块内新增 `RecommendationRecordReader`/`ReplayResult`/`DiffAxis`/`DiffEntry`/`DiffChange`/`DiffResult`/`DiffOutcome`/`ReplayDeps`/`ExactRuleResolver`；对应 `tests/core/recommendation/record-reader.test.ts` + `replay.test.ts` + `diff.test.ts`。不修改 `record-store.ts`。

**非目标**（与 #330 一致）：不新增 MCP/CLI/HTTP/Agent profile；不改 #327 rollout default；不实现 display/自然语言/derivation graph；不做 record vs current-state diff；不新增 migration/audit 表/retention scheduler；不自动执行 recommendation；不调 LLM/embedding/search/vault/网络；不改 recall/ranking/ingest/ontology 行为；不改 `record-store.ts`；**不引入 typed input validator**（§9 #4，留后续）。

**规模**：单个 M 级 plan 可覆盖（两模块 + 两测试文件，纯只读，无 schema 变更）。

---

## 11. 自审清单（提交前）

- [x] 无 TBD / TODO（typed validator 留后续 phase；`inputs_match:true` 本期保留；余皆已决）。
- [x] `ReplayResult` 5 状态判别不重叠、`unverifiable.reason` 3 值互斥；`DiffResult`/`DiffOutcome` union 不重叠（`incomparable` 独立）。
- [x] replay 与 integrity（§8.1）/ freshness（§8.4）分工不冲突——replay 不重建投影、不写 freshness、不重跑 integrity。
- [x] diff 五轴字段映射 Codex 已锁（§5.1）：option=alternatives only、conclusion=kind+action/reason、constraint 含 applicability/risks/gaps、namespace/maintenance_key 不同→incomparable。
- [x] `DiffEntry` 含 `key`+`change`，去重不吞不同字段相同值变化（HIGH 1 attack fixture H1 已锁）。
- [x] key 使用 RFC 6901 JSON Pointer，所有动态 segment 逐个 escape；不继承现有 declaration `::` 拼接碰撞（H-key 已锁）。
- [x] dependency 轴 inputs_hash 不等时下沉 decision_inputs 字段级 path diff（HIGH 3，fixture H3a–H3d）。
- [x] 生产 diff 只导出 `diffRecordsById`；纯 helper 模块私有，双侧只能经 nominal trusted reader 进入，普通结构 fake 不可冒充（H-trust 已锁）。
- [x] replay/diff deps 为最小权限 reader/resolver；reader 只暴露 `getById`，resolver 只暴露 `resolve`（M-cap 已锁）。
- [x] entries 全序排序（axis→key→change→before→after），不依赖 Map/SQL/插入序。
- [x] schema 类异常统一 `runner_failed`，措辞「无 typed validator 不可靠区分」非「不可达」（MEDIUM 1）。
- [x] 只读证明 claim 与证据对齐：import guard + `total_changes()` + Lance 目录快照 + recommendation 两表 + registry manifest（MEDIUM 2）。
- [x] 无真实标识 / 绝对路径 / 凭据 / 个人标识（自审 grep 全清）。
- [x] 范围可由单个 M 级 plan 完成，不改 schema、不加 MCP、不引入 typed validator。
- [x] 12 条锁定决策（#330 handoff）逐条落地：#1 not_found→§3/§4.2 · #2 integrity-first→§4.2/§4.5 · #3 exact-version→§4.2 · #4 identity pin→§4.2/§4.3 · #5 frozen-input→§4.2 · #6 conclusion_mismatch→§3 · #7 sanitized enum→§3/§4.4 · #8 五轴 diff→§5 · #9 fail-closed→§5.4/§5.5 · #10 semantic/mutable 分离→§5.1 · #11 read-only→§6 · #12 no Agent surface→§5.6。两轮 Codex 复审 findings 均已闭环。
- [x] 14 验收 + 8 攻击 + H1/H3a/H3b/H3c1/H3c2/H3d/H-ck/H-key/H-trust/M-cap 专项逐条映射到独立 fixture（§8），无复合假绿。

---

**下一步**：本 spec 经 Codex 自审与门禁通过后进入 writing-plans；实现仍须独立 worktree TDD + 对抗审查。
