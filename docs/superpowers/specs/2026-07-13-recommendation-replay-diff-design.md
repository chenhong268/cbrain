# Recommendation Phase 2A — Offline Replay & Deterministic Record Diff（设计 spec）

**状态**：SPEC ONLY，不含代码。提交后停在 Codex review gate，未 APPROVE 前不进 writing-plans、不碰 `src/`/tests/migration/MCP/CLI。
**Issue**：#330 · **Parent roadmap**：#328 · **输出边界**：#327（本期不触碰）
**Base**：`origin/main` @ `69094a5`（== Phase 1 集成点）
**基线合同**：`docs/superpowers/specs/2026-07-12-recommendation-contract-design.md`（§5.1 / §6.2 / §7.2 / §8.1–8.4 / §15 / §17）
**本期边界**：只读 core · 精确历史 rule · 冻结输入 · 五轴确定性 diff · 无 MCP/LLM/迁移

> 本 spec 已过两轮自审（API 准确性、脱敏匿名 PASS；锁定决策/攻击覆盖/内部一致性的 HIGH 已闭环，见 §11）。标 **[决策点]** 处为本 spec 已选默认、并列出备选供 Codex 翻盘的条目。

---

## 1. 问题与边界

Phase 1（#328，已集成为 `69094a5`）已能把维护建议落库为经过可信解码、完整性校验、版本绑定与生命周期治理的 `RecommendationRecord`。系统仍**无法确定性回答**：

1. 这条历史建议能否由当时的**冻结输入 + 精确 rule 版本**重新算出？
2. 两条建议的差异来自 **evidence / constraint / option / dependency / conclusion** 哪一轴？
3. 旧 rule 已 `purged`/`incompatible`/`unknown` 时，系统能否准确区分「无法历史验证」与「重放失败」？

Phase 2A 实现一个**只读、离线、确定性**的 replay + record-to-record diff core。本期**不**向 Agent 暴露新工具，**不**新增 migration/audit 表，**不**调用 LLM/embedding/search/vault/网络。

---

## 2. 基线合同（已验证 Phase 1 API，零幻觉基线）

下述签名均在 `69094a5` 实测确认（API 准确性镜头 PASS，0 finding）。Phase 2A **只消费**这些 API，不修改它们。

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

- `resolve(id, ver)` 按 `${id}@${ver}` 精确查表：live → `ok`；`markPurged` 留下的 tombstone → `unavailable/purged`；`markIncompatible` 留下的 tombstone → `unavailable/incompatible`；既无 live 也无 tombstone → `unavailable/unknown`。**不会**回退到 active 版本——这正是 replay 要的精确历史语义。
- `def: RuleDefinition` 承载**身份**（`rule_id` / `rule_version` / `registry_ref`）+ 行为声明（`readTemplate` 等）；`runner.code_hash` 是**行为**哈希。tombstone 保留 `code_hash` 但 runner 已删——**tombstone 版本不可执行**。
- `code_hash = definitionCodeHash(def)` 只覆盖行为子集（`readTemplate/candidateTrustState/evidenceSource/evidenceRefTemplate/abstainReason/propose`），**排除** `rule_id/rule_version/registry_ref`。所以「只 bump version 不改行为」时 `code_hash` 不变，旧版本仍可精确 resolve。
- `policyManifest()` / `registryAuditManifest()` 输出已排序的字符串，可直接做 before/after byte-identical 比对。

### 2.4 规则运行时 —— `src/core/recommendation/rule-runtime.ts`

```ts
function definitionCodeHash(def: RuleDefinition): string;
function runRule(def: RuleDefinition): { code_hash; captureInputs; decide };
```

- `decide(di)` **纯函数**：不调 `captureInputs`、不读 DB/LLM/网络，只消费传入的 `DecisionInputs`。当前实现用 `?? 0` 守住 NaN/undefined，**不抛**。这是 replay 的唯一调用点。
- `captureInputs(projection)` **重读 live projection**（按 `def.readTemplate.as` 读 `projection[slug][as]`）。replay **禁止**调用——它会读到与冻结时不同的投影，破坏 byte-exact 重放。
- 参考生产者 `KNOWN_RELATIONS_DEF`：`rule_id="health:known_relations"`, `rule_version="1.0.0"`, `registry_ref="cbrain.rules:maintenance.known_relations@1.0.0"`。

### 2.5 规范化与哈希 —— `src/core/recommendation/canonical.ts`

```ts
function serializeNumber(n: number): string;   // -0→"0"，非有限（NaN/±Infinity）抛
function normalizeProse(s: string): string;    // NFKC + 折叠空白 + trim
function assertJsonSafe(v: unknown): void;     // 拒绝 undefined 值/裸 surrogate/非 plain object/环/非有限数
function canonicalJson(value: unknown): string;// object key 按 UTF-16 code-unit 升序；数组按完整元素 canonical 串升序（非保序！）；数字经 serializeNumber
function sha256Hex(s: string): string;         // 小写 64 hex
```

- ⚠ **`canonicalJson` 排序数组**：数组元素顺序**不影响**输出。所以「仅数组顺序不同」的两个 payload canonical 相等、fingerprint 相等。**想检测 reorder 必须单独比 raw 数组**，不能靠 `canonicalJson`。
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
  applicability: Applicability;                  // auto_execute: false（字面量）
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
type TrustState = "trusted" | "user_thought" | "candidate" | "rejected" | "superseded"; // ../provenance
```

- **IMMUTABLE** = `payload.*` 全部；**MUTABLE** = `last_revalidated_at` / `lifecycle_status` / `freshness_status` / `suppressed_until`。`record_id` / `created_at` / `fingerprint` 为不可变身份。
- ⚠ types.ts 中**尚不存在** `ReplayResult` / `DiffAxis` / `Diff`（grep 确认）。Phase 0 spec §8.2/§8.3 只有草稿。Phase 2A **新增**这些类型。
- **五轴 → payload 字段映射**（详见 §5.1）：`evidence→evidence_manifest`、`constraint→constraints+producer`、`option→conclusion.action+alternatives(+abstain reason)`、`dependency→inputs_hash+dependency_manifest.declarations`、`conclusion→conclusion.kind`。

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
| **偏离 #330 建议形态：删 `runner_schema_incompatible`** | 经 `getById` 的 `decision_inputs` 已在 `checkIntegrity` 内过 `assertJsonSafe`，replay 前置再跑**不可达**（详见 §4.3 / §9 决策点 #3）；schema 类异常一律并入 `runner_failed` |
| `rule_version_unavailable.reason` 直接透传 registry 的 `unknown\|purged\|incompatible` | 锁定 #3：精确版本；三类不混淆 |

**union 不重叠自检**：5 个 `status` 字面量两两不同；`unverifiable.reason` 3 值互斥；每个状态的附加字段不产生歧义判别。✅

---

## 4. Replay 合同

### 4.1 注入与签名

```ts
// src/core/recommendation/replay.ts
export interface ReplayDeps {
  readonly store: RecommendationStore;       // 注入，便于 spy 写方法（证明 read-only）
  readonly registry: VersionedRuleRegistry;  // 注入，便于 spy resolve vs resolveActive
}
export function replayRecord(deps: ReplayDeps, recordId: string): ReplayResult;
```

- 函数式入口（无状态、无缓存）。命名上「replay engine」即本模块；不引入 `ReplayEngine` 类（YAGNI，见 §7 方案 A）。
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
        └─ 抛（任何）                        → catch，丢弃 .message → { status: "unverifiable", reason: "runner_failed" }
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
| `runner_failed` | `runner.decide` 抛（含未来 runner 的 schema 类抛错——见下） | 调了，但 fail-closed |
| `replayed` | `decide` 返回且 canonical conclusion 相等 | 是 |
| `conclusion_mismatch` | `decide` 返回但 canonical conclusion 不等 | 是 |

> **关于 schema 类异常**：原 #330 建议形态含独立 `runner_schema_incompatible`。但经 `getById` 的 `decision_inputs` 已在 `checkIntegrity → computeInputsHash → canonicalJson → assertJsonSafe` 内强制 JSON-safe，replay 不存在一个「先于 decide、又能被 getById 放行」的 schema 不可达分支。故删除该码，schema 类异常一律 `runner_failed`（决策点 #3）。

### 4.4 错误脱敏边界（锁定 #7，验收 #6）

- `ReplayResult` 所有变体**只含 enum / 字面量**：`status`、`reason`、`inputs_match`。**绝不**包含 `record_id`、`payload`、`conclusion`、异常 `message`、`stack`、文件路径、slug、ref。
- `getById` 抛出的 `Error` message 含 `record_id` + integrity `code`——`replayRecord` 必须 `catch (_e) { ... }`，**不读 `e.message`**，统一映射为 `integrity_failed`。
- `runner.decide` 抛错同理：`catch (_e)`，不读 message，映射 `runner_failed`。**不靠字符串匹配区分 schema/failure**——经 `getById` 的输入已 JSON-safe，schema 不可达，统一 `runner_failed` 即可（决策点 #3）。
- `rule_version_unavailable.reason` 直接透传 registry 的 enum（已是结构化串，非泄露向量）。

### 4.5 与 integrity / freshness 的分工（锁定 #2，Phase 0 §8.1 vs §8.2 / F14）

- **integrity（§8.1）= 离线重算，不执行 rule**：`getById` → `decodeTrustedRow` → `checkIntegrity` 已覆盖。replay **不重复** `inputs_hash` / `fingerprint` 比对——那是死代码（integrity-first 已挡）。若未来出现绕过 `getById` 的读取路径，该路径必须自跑 `checkIntegrity` 才能信任 record。
- **decision-replay（§8.2）= 执行 `runner.decide` 比对 conclusion**：replay 的本职。两条路径**不得合并**（F14）。
- **freshness（§5.3/§8.4）= 用同版本 `captureInputs` 重建 inputs_hash 比对当前投影**：写 `freshness_status` + `last_revalidated_at`，**碰 DB**。replay **不**做 freshness——只读冻结 `decision_inputs`，不重建投影，不写 freshness。三者输入相同（record）但产出与副作用不同，代码路径分离。

---

## 5. Diff 合同

### 5.1 五轴分区、字段映射与粒度

只比较两条**可信** record 的**不可变 payload**。可变字段（`lifecycle_status` / `freshness_status` / `last_revalidated_at` / `suppressed_until`）**不参与** semantic diff。

**粒度（锁定）**：per-element——每个发生变化的元素产出**一条** `DiffEntry`（非整轴聚合）。`before`/`after` 为该元素的 `canonicalJson`，缺失侧为 `""`。

| 轴（固定顺序） | 元素键 | 比较 | 触发条件 |
|---|---|---|---|
| `evidence` | `(source, ref)` | `evidence_manifest` 每条 `{source,ref,trust_state}` | 条目增删，或同 `(source,ref)` 的 `trust_state` 翻转 |
| `constraint` | 字段名 | `constraints.{policy_version,ontology_version,schema_version}` + `producer.{rule_id,rule_version,code_hash,registry_ref}` | 任一版本串或 producer 身份字段变化（**rule_id 唯一归属此轴**，见下） |
| `option` | 元素 canonical | **仅当两 record `conclusion.kind` 相同**：propose → `conclusion.action`（整体）+ `conclusion.alternatives[]` 每条；abstain → `conclusion.reason` | proposed action / alternatives / abstain reason 变化 |
| `dependency` | 元素 canonical | `inputs_hash` + `dependency_manifest.declarations[]` 每条 | inputs_hash 不等（= decision_inputs canonical 漂移）或 declarations（table/as/fields/relation/direction/filter）变化 |
| `conclusion` | kind | `conclusion.kind` | propose ↔ abstain 翻转 |

**轴序固定为** `evidence < constraint < option < dependency < conclusion`（issue #330 §2 列序），**非**字典序。

**cross-kind 规则（锁定）**：当两 record 的 `conclusion.kind` 不同时，`option` 轴**不产任何 entry**（`action` 与 `abstain.reason` 结构不可比）；kind 翻转由 `conclusion` 轴**独占**承载（一条 entry：`before="propose"`, `after="abstain"` 之类）。`option` 轴仅在两 record 同 kind 时运行。

**rule_id 单归属（锁定）**：`rule_id` 只在 `constraint` 轴（经 `producer.rule_id`）追踪。`dependency_manifest.rule_id` **不**作为 dependency 轴元素——因 `checkIntegrity` 的 `cross_rule_id_mismatch` 强制 `dependency_manifest.rule_id === producer.rule_id`，trusted record 上二者恒等，同时追踪会造成一次 rule_id 变化触发两条 entry（重复信号）。

> ⚠ **[决策点 #1]**：`option` 轴承载 `action`+`alternatives`+abstain `reason`、`conclusion` 轴只载 `kind` 翻转——本 spec 选择。备选（#330 字面「conclusion：...最终 action/reason 变化」）：`action`/`reason` 归 `conclusion`，`option` 只留 `alternatives`。两者皆可实现，Codex 可翻盘。
> ⚠ **[决策点 #2]**：`risks[]` / `gaps[]` / `applicability` / `namespace` / `maintenance_key` **不在五轴内**；其差异不产生 diff entry。若需纳入须指定归属或扩轴（#330 已锁五轴，本 spec 不扩）。

**数组语义**：`evidence_manifest` / `alternatives` / `declarations` 的**顺序差异不算 diff**（对齐 `canonicalJson` 排序数组的语义与 fingerprint）；按元素 canonical 比对，仅成员/内容差异算。检测 reorder 不在本期五轴内。

### 5.2 DiffEntry 形状与确定性排序

```ts
// src/core/recommendation/diff.ts
export type DiffAxis = "evidence" | "constraint" | "option" | "dependency" | "conclusion";
export interface DiffEntry {
  readonly axis: DiffAxis;
  readonly before: string;   // canonicalJson(左侧元素)，缺失侧为 ""
  readonly after: string;    // canonicalJson(右侧元素)，缺失侧为 ""
}
```

- `before`/`after` 一律是 `canonicalJson` 序列化的元素（已排序 key/数组），或缺失侧 `""`。保证「输入对象 key 顺序 / 数组顺序变化 → 输出仍稳定」（验收 #11）。
- **去重**：entries 先按 `(axis, before, after)` 三元组去重（消除理论上的同元素重复/同 canonical 碰撞），再排序。
- **排序**：primary 按 `axis` 固定序，secondary 按 `before` 字典序，tertiary 按 `after` 字典序（因已去重，`(axis,before,after)` 唯一，全序确定）。整个 `entries` 在返回前 sort 一次。**绝不**依赖 Map / SQL / 对象插入序。
- 空结果 `entries = []` ⟺ 五轴全无元素差异（非轴字段差异除外，见决策点 #2）。

### 5.3 纯核心 vs fetch 包装

```ts
// 纯核心：对两条已可信 record 做 payload 五轴比对，无 DB/registry 依赖，单测主战场
export function diffRecommendationRecords(
  a: RecommendationRecord,
  b: RecommendationRecord,
): DiffEntry[];

// fetch + fail-closed 包装：经 store.getById 取可信 record，再调纯核心
export type DiffOutcome =
  | { ok: true; entries: DiffEntry[] }
  | { ok: false; reason: "not_found" | "integrity_failed" };
export function diffRecordsById(
  store: RecommendationStore,
  idA: string,
  idB: string,
): DiffOutcome;
```

- `diffRecommendationRecords` 只依赖 `types` + `canonical`，**不**依赖 store/registry/integrity——它假设两侧已可信（caller 经 `getById` 取得）。
- `diffRecordsById` 按 A→B 顺序取：A `null` → `{ok:false, reason:"not_found"}`；A 抛 → `{ok:false, reason:"integrity_failed"}`；B 同理。**任一侧失败立即 fail-closed，绝不**对仅存的一侧做部分 diff（验收 #12）。失败时不读 `e.message`（脱敏）。

### 5.4 fail-closed

- 任一 record 不可信 → 整体失败，不返回部分 entries。
- 纯核心 `diffRecommendationRecords` 不做可信校验（输入契约：已可信）；fail-closed 责任在 `diffRecordsById` 的 fetch 层。

### 5.5 不生成用户文案（锁定 #12）

- core diff 只产 `{axis, before, after}` 结构化 entries，**不**生成自然语言、不调 `display` safeTitle、**不**宣称满足 #327 Agent-facing display boundary。display/解释属后续 phase。

---

## 6. 只读与副作用约束（验收 #7、#8）

replay/diff 执行前后必须证明以下**完全不变**：

- `recommendation_records` / `recommendation_lifecycle_history` 表内容；
- `lifecycle_status` / `freshness_status` / `suppressed_until` / `last_revalidated_at`；
- pages/links/chunks/FTS/LanceDB；
- registry 的 active version 与 tombstone 状态。

**证明手段（测试）**：

1. **spy 写方法**：注入包装过的 `store`，断言 `createRecord`/`transitionLifecycle`/`updateFreshness`/`clearSuppression` call count = 0；注入包装过的 `registry`，断言 `register`/`setActive`/`markPurged`/`markIncompatible` call count = 0。
2. **spy `captureInputs`**：注入 fake runner，其 `captureInputs` 被调即抛；`decide` 正常返回冻结输入应有的 conclusion。断言 replay 结果不被影响且 `captureInputs` call count = 0（验收 #7）。
3. **byte-identical 快照**：replay/diff 前后对 `recommendation_records`、`recommendation_lifecycle_history` 做 `SELECT * ORDER BY` 导出，对 `registry.policyManifest()` + `registry.registryAuditManifest()` 取串——前后 byte 相等（验收 #8）。

---

## 7. 方案对比

### 方案 A（推荐）：`replayRecord` + `diffRecommendationRecords` 两个小模块，store/registry 注入
- replay.ts 依赖 store+registry+rule-runtime+canonical+types；diff.ts 依赖 types+canonical（纯核心）+ store（fetch 包装）。
- 职责分离：persistence（store）/ registration（registry）/ 重放与比对（本期）。纯核心可无 DB 单测。
- 注入 seam 天然支持 spy（§6）。**不扩张 `record-store.ts`**，符合 #330「除非必要不改 store/migration」。
- 代价：两个新模块 + 一个轻量注入类型。可接受。

### 方案 B：把 replay/diff 塞进 `RecommendationStore`
- 混淆 persistence（CRUD + lifecycle 写）与 read-only 重放/比对职责。store 已有四个写方法，再加 replay/diff 会让 read/write 边界模糊，read-only 证明更难（store 持有 DB 连接）。
- replay 需要 registry（store 当前不依赖 registry）——要么让 store 持有 registry（persistence 耦合规则注册表），要么外部传——既然要传，就不如独立模块。
- 直接违反 #330「避免扩张 `record-store.ts`」。**否决**。

### 方案 C：直接新增 MCP 工具
- #327 尚未把 recommendation surface 纳入 structured output boundary；公开 API gate 阻断新 MCP 工具。
- #330 非目标明列「不新增 MCP/CLI 工具、HTTP endpoint 或 Agent profile 项」。
- core 合同应先于 surface 定型。**本期否决**，待 #327 落地后再桥接。

---

## 8. 测试矩阵（14 验收 + 8 攻击，逐条映射）

所有 fixture 用匿名占位符（`实体A` / `实体B` / `方案C` / `规则R` / `版本v1`/`v2`）。**禁止复合 sentinel 制造假绿**（#330 §验收 #10）——每个轴/攻击独立 fixture，可拆则拆。

### 8.1 验收映射（issue #330 §验收）

| # | 验收 | fixture / 断言 |
|---|---|---|
| 1 | 同一 frozen record + 精确 runner → `replayed`，连续两次 byte-stable | `replayRecord` 两次，`canonicalJson(result)` 字节相等；`status==="replayed"`, `inputs_match===true` |
| 2 | active=v2，record 属仍保留的 v1 → 解析 v1 replay 成功 | registry 同时 live v1+v2 且 `setActive(v2)`；record producer 锁 v1；断言走 `resolve(v1)` 非 `resolveActive`，结果 `replayed` |
| 3 | v1 为 unknown/purged/incompatible → 三种 `rule_version_unavailable` | 三 fixture：v1 未注册 / `markPurged` / `markIncompatible`；reason 分别等于三者 |
| 4 | fingerprint/inputs_hash/producer.code_hash/registry_ref 任一篡改 → runner 未调 | 拆四类：(a1) 改 fingerprint 列 → `integrity_failed`；(a2) 改 inputs_hash（列+payload 不自洽）→ `integrity_failed`；(b1) 自洽篡改 `producer.code_hash` 并重算 fingerprint → `producer_mismatch`；(b2) 自洽篡改 `producer.registry_ref` 并重算 fingerprint → `producer_mismatch`。均断言 `decide` call count=0 |
| 5 | runner 对同输入返回不同 conclusion → `conclusion_mismatch` | fake runner `decide` 返回与 frozen conclusion 不同的 conclusion；结果 `conclusion_mismatch` |
| 6 | runner throw → 固定脱敏 `unverifiable`，无 stack/路径/record id/payload | fake runner `decide` 抛 → `runner_failed`；`JSON.stringify(result)` 不含 record_id/payload/路径/stack。（schema 类异常已并入 `runner_failed`，见 §4.3/决策点 #3，不单列 fixture） |
| 7 | spy 证明 replay 从不调 `captureInputs`，不读 vault/search/network/LLM | fake runner `captureInputs` 抛哨兵；replay 正常返回；call count=0 |
| 8 | replay 前后 DB 表、mutable 状态、registry manifest byte-identical | §6 手段 3：前后快照字节相等 |
| 9 | 两条相同 payload、不同 lifecycle/timestamp → diff 空 | 构造 payload 相同、`lifecycle_status`/`last_revalidated_at`/`suppressed_until` 不同的两 record；`diffRecommendationRecords` 返回 `[]` |
| 10 | 五类 diff 各独立 fixture | 5 fixture：evidence（改一条 manifest 条目 trust_state）/ constraint（改 policy_version）/ dependency（改一条 declaration fields）/ option（同 kind 下改 action.target_ref）/ conclusion（kind propose↔abstain）。前四个断言仅该轴出 entries；**conclusion fixture 因 cross-kind 规则**断言：conclusion 轴 1 entry + option 轴 0 entry |
| 11 | diff 输入顺序 / 对象 key 顺序改变 → 输出稳定 | 拆两 fixture：(a) 仅打乱对象 key 序（单条 evidence entry / constraints / producer 的 key），保持数组序；(b) 仅打乱数组序（evidence_manifest/alternatives 元素顺序），保持 key 序。各自断言 entries 逐字节相等 |
| 12 | 损坏的任一 diff record → fail-closed，不返回部分 diff | A 或 B 经篡改使 `getById` 抛；`diffRecordsById` 返回 `{ok:false}`，entries 不存在 |
| 13 | focused suite、`bun run lint`、`bun run check`、`bun run check:docs` 全绿 | 实现期 gate；spec 阶段不跑 |
| 14 | diff/privacy scan 不含真实知识/绝对路径/凭据/个人标识 | 匿名 fixture；privacy 扫描过 |

### 8.2 攻击映射（issue #330 §对抗性审查）

| # | 攻击 | 防御 / 实测证据 |
|---|---|---|
| 1 | active-version substitution：偷用当前 v2 重放历史 v1 | `resolve(v1)` 不回退 active；fixture active=v2 record=v1，断言用的是 v1 runner（code_hash 来自 v1），结果 `replayed` 而非误用 v2 |
| 2 | integrity bypass：篡改 conclusion 后重算局部 hash 试图让 runner 执行 | 自洽重算 fingerprint 的篡改 → `checkIntegrity` 通过但身份钉扎/`conclusion_mismatch` 拦；仅改列 → `integrity_failed`；runner 调用受控 |
| 3 | producer identity split：rule/version 同但 code_hash/registry_ref 不同 | 拆两 fixture 对应验收 #4(b1)/(b2)：自洽篡改 `producer.code_hash` 或 `producer.registry_ref` 并重算 fingerprint → step 3 身份钉扎 → `producer_mismatch`，`decide` 未调 |
| 4 | hidden read：replay 内调 captureInputs/DB projection 重读当前状态 | fake runner `captureInputs` 抛哨兵；spy `getById` 仅一次；无 projection/search 调用；call count 证据 |
| 5 | partial diff：一侧损坏仍返回另一侧差异 | `diffRecordsById` 损坏侧 fail-closed → `{ok:false}`，无 entries |
| 6 | nondeterminism：Map/object/array 顺序导致字节不稳定 | `canonicalJson` 排序 key+数组；entries 去重 + 二次排序；同一对 record 两次 diff byte 相等（验收 #11 两 fixture 独立佐证） |
| 7 | error leak：runner throw 带 stack/路径/payload/id 出 | `catch (_e)` 不读 message；result 仅 enum；`JSON.stringify` 扫描 |
| 8 | side effect：replay/diff 改 freshness/history/registry/存储 | §6 全套 spy + byte-identical 快照 |

---

## 9. 开放决策点（本 spec 已选默认，供 Codex 翻盘）

1. **`option` vs `conclusion` 轴的 action/reason 归属**。本 spec：`conclusion` 轴只载 `kind` 翻转；`action`(type/target_ref/reason/rollback_note) + `alternatives` + abstain `reason` 归 `option` 轴（cross-kind 时 option 不 emit）。备选（#330 字面）：`action`/`reason` 归 `conclusion`，`option` 只留 `alternatives`。两者皆可实现。
2. **非轴字段（`risks`/`gaps`/`applicability`/`namespace`/`maintenance_key`）差异**。本 spec：不产生 diff entry（五轴已锁）。确认可接受，或指定归属。
3. **`runner_schema_incompatible` 已删除（偏离 #330 建议形态）**。理由：经 `getById` 的 `decision_inputs` 已在 `checkIntegrity` 内过 `assertJsonSafe`，replay 不存在先于 decide 又能被 getById 放行的 schema 分支；保留即死代码 + 幽灵 fixture。schema 类异常并入 `runner_failed`。Codex 若要求保留四值 enum，需指定一个 `getById` 未覆盖、可构造的触发条件。
4. **`replayed.inputs_match` 字面量字段**。integrity-first 下恒 `true`。保留以对齐 #330 类型，还是去掉？本 spec 保留。

---

## 10. 范围与非目标

**范围**：`replay.ts` + `diff.ts` 两个模块；新增 `ReplayResult`/`DiffAxis`/`DiffEntry`/`DiffOutcome`/`ReplayDeps` 类型；对应 `tests/core/recommendation/replay.test.ts` + `diff.test.ts`。跨模块稳定共用才入 `types.ts`，否则留模块内。

**非目标**（与 #330 一致）：不新增 MCP/CLI/HTTP/Agent profile；不改 #327 rollout default；不实现 display/自然语言/derivation graph；不做 record vs current-state diff；不新增 migration/audit 表/retention scheduler；不自动执行 recommendation；不调 LLM/embedding/search/vault/网络；不改 recall/ranking/ingest/ontology 行为；不改 `record-store.ts`（除非发现无法以现有 public API 安全读取——目前 `getById` 足够）。

**规模**：单个 M 级 plan 可覆盖（两模块 + 两测试文件，纯只读，无 schema 变更）。

---

## 11. 自审清单（提交前）

- [x] 无 TBD / TODO（开放项集中在 §9，均标明本 spec 已选默认 + 备选，非未完成）。
- [x] `ReplayResult` union 5 状态判别不重叠、`unverifiable.reason` 3 值互斥；`DiffOutcome` union 不重叠。
- [x] replay 与 integrity（§8.1）/ freshness（§8.4）分工不冲突——replay 不重建投影、不写 freshness、不重跑 integrity（依赖 `getById` 已做）。
- [x] diff 五轴字段映射在本 spec 已锁（§5.1：per-element 粒度 + cross-kind 规则 + rule_id 单归属）；`option`/`conclusion` 归属备选列于 §9 #1 待 Codex 拍板。
- [x] entries 去重 + 全序排序（轴序 → before → after），不依赖 Map/SQL/插入序；collision 经去重消除。
- [x] 无真实标识 / 绝对路径 / 凭据 / 个人标识（匿名占位符；自审 grep 全清）。
- [x] 范围可由单个 M 级 plan 完成，不改 schema、不加 MCP。
- [x] 12 条锁定决策逐条落地（见 §3 delta 表、§4 流程、§5 分区、§6 只读、§7 方案）。
- [x] 14 验收 + 8 攻击逐条映射到 fixture（§8）；#4 拆 4 类、#6 schema 并入 runner_failed、#10 cross-kind 双轴断言、#11 拆 key/array 序，均无复合假绿。

---

**下一步**：本 spec 单独 docs commit 后停在 Codex review gate。未 APPROVE 前不进 writing-plans、不写实现。
