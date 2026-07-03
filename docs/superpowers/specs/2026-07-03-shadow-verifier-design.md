# Shadow Verifier for NER & Discovery Quality (#265 Phase 1)

> 状态：设计已确认，待 writing-plans 拆实现计划
> Issue: #265
> 日期: 2026-07-03

## Context

CBrain 缺少对高风险记忆生成步骤（NER 抽取、discovery/action candidate 持久化）的独立质量信号。
Phase 1 是 **shadow-only**：只观察、只记录、只在 health/dream 聚合暴露 —— 永不阻塞写、永不改写/删除已生成事实、不引入 LLM 校验、不引入通用多 agent 框架。

复用现有 `ingest_log` 审计基础设施，Phase 1 **不加新表**。

## Goal

为两个生成面加 deterministic 影子校验：

1. **NER**：`NerEngine.extract()` 返回后、`applyExtraction()` 落库前。
2. **Discovery**：`upsertDiscovery()` 持久化候选前（三个调用点全覆盖）。

## Non-goals

- 无 LLM verifier（留后续 issue）。
- 无阻塞 ingest / NER / discovery / action candidate 写。
- 无 auto-fix / auto-delete / auto-merge / auto-rewrite。
- 无新表（除非证明 `ingest_log` 不足）。
- 无私密 fixture（测试只用 `实体A`/`实体B`/`组织C`/`主题D` 等匿名占位）。

## Architecture

新增 `src/core/quality/shadow-verifier.ts`。分两层：

- **纯函数层**（`verifyNerExtraction` / `verifyDiscoveryCandidate` / `summarizeShadowVerifierObservations`）：deterministic，**零运行时依赖**（不 import DB / LLM / logger / ontology 实现），可独立单测、可在任何上下文 import 而无副作用。
- **fail-open runner**（`runNerShadowVerifierFailOpen` / `runDiscoveryShadowVerifierFailOpen`）：用 **type-only import**（`import type { CBrainDB }` / `import type { Logger }`），DB/logger 作参数注入。模块运行时不耦合具体实现，仅做 IO 包装（env 短路 → 跑纯函数 → summarize → `addIngestLog` → catch+脱敏）。

```ts
verifyNerExtraction(input: NerVerifierInput): ShadowVerifierObservation[];
verifyDiscoveryCandidate(input: DiscoveryVerifierInput): ShadowVerifierObservation[];
summarizeShadowVerifierObservations(
  surface: "ner" | "discovery",
  observations: ShadowVerifierObservation[],
): ShadowVerifierSummary;

runNerShadowVerifierFailOpen(opts: {
  db: CBrainDB; logger?: Logger | null; slug: string;
  bodyChars: number; extraction: ExtractionResult;
}): void;

runDiscoveryShadowVerifierFailOpen(opts: {
  db: CBrainDB; logger?: Logger | null;
  action: "discovery_shadow_verifier";
  input: DiscoveryVerifierInput;
}): void;
```

### 数据结构

```ts
type VerifierSeverity = "info" | "warning" | "error";
type VerifierSurface = "ner" | "discovery";

interface ShadowVerifierObservation {
  surface: VerifierSurface;
  code: string;            // 稳定 reason code，跨调用方一致
  severity: VerifierSeverity;
  detail?: string;         // 仅含 counts / 类型标签，绝不含 raw name/slug/body/title
}

interface ShadowVerifierSummary {
  surface: VerifierSurface;
  type?: string;           // discovery 的 type（如 action_review_discovery）；NER 无
  checks: number;          // 本轮跑的 check 数
  counts: { info: number; warning: number; error: number };
  reasonCounts: Record<string, number>;  // code -> count
  worst: VerifierSeverity | "none";
}
```

### 输入类型（调用方负责映射，verifier 不接触原始私密字段）

```ts
interface NerVerifierInput {
  bodyChars: number;                 // body.trim().length
  entityCount: number;
  relationCount: number;
  eventCount: number;
  factCount: number;
  entities: Array<{ name: string; type: string }>;  // 仅查重名/缺字段，不进 details
  relations: Array<{ from: string; to: string }>;   // 仅查端点存在性
  events: Array<{ date: string | null }>;           // 仅查 date 形状
}

interface DiscoveryVerifierInput {
  type: string;                      // discovery type 或 action candidate type
  actionable: string;                // "high"|"medium"|"low" 或未知串
  score: number;
  autoApplicable: boolean;
  hasEvidence: boolean;
  hasProposedActions: boolean;
  displayTexts: string[];            // 仅用户可见文本，跑 banned pattern
}
```

> **关键**：`DiscoveryVerifierInput` **不携带** entities / dedup_key / slug / title / source_ref。
> 调用方在映射时丢弃一切私密字段。verifier 内部不持有任何可追溯标识。

## Checks（Phase 1 deterministic）

### NER checks

| code | severity | 触发条件 |
|---|---|---|
| `ner_zero_from_long_body` | error | `bodyChars > 500` 且 entity/relation/event/fact 计数全 0 |
| `ner_relation_endpoint_missing` | warning | 存在 relation 的 `from`/`to` 不在 `entities[].name` 集合内 |
| `ner_extraction_unusually_high` | warning | `entityCount > max(30, floor(bodyChars / 80))` |
| `ner_duplicate_name_conflicting_type` | warning | 同名 entity 出现 ≥2 种 type |
| `ner_invalid_entity_field` | warning | 任一 entity 名为空 / type 为空 / name 为纯空白 |
| `ner_invalid_event_date` | info | event 有非空 `date` 但形状非法（非 `YYYY-MM-DD` 前缀且非可解析日期） |

**阈值取保守值**：`max(30, floor(bodyChars/80))`。Phase 1 宁可漏报也不把正常中文 NER（500 字抽 6 个实体）打成噪声。

### Discovery checks

| code | severity | 触发条件 |
|---|---|---|
| `discovery_high_actionable_no_evidence` | error | `actionable === "high"` 且 `!hasEvidence` 且 `!hasProposedActions` |
| `discovery_auto_applicable_on_review_type` | error | `autoApplicable === true` 且 `type` 以 `action_` 开头 |
| `discovery_score_out_of_range` | warning | `score` 不在 `[0,1]` 或 `actionable` 不在已知枚举 |
| `discovery_display_missing_fields` | warning | `type` 以 `action_` 开头 且 `displayTexts` 全为空串 |
| `discovery_display_private_raw` | warning | 任一 `displayTexts` 命中 banned pattern（见下） |

**`discovery_display_private_raw` 只扫用户可见文本**（`displayTexts`），**不扫整个 metadata**。
banned pattern 复用 `action-candidates.ts` 的 `DISPLAY_UNSAFE_PATTERNS`（`/Users/`、`entity/...`、`concept/...`、`records/`、`sql`、`debug`、`select * from` 等），export 出来共享。
metadata 内部的 `evidence.ref` / `entities` / `target` / 内部 id **不查**（它们合法存在），但**也绝不写进 verifier details**。

reason code 从 `discovery_metadata_private_raw` 改名 `discovery_display_private_raw`，更准确反映"只扫展示字段"。

## Hook 点（全部 fail-open）

### NER —— `src/core/ingestion/pipeline.ts`

在 `processNer()` (line ~264) extract 之后、**early-return 之前**：

```ts
const extraction = precomputed ?? await this.nerEngine.extract(body);
this.runNerShadowVerifier(fromSlug, body, extraction);  // #265 fail-open
if (extraction.entities.length === 0 && extraction.relations.length === 0) {
  return null;
}
```

`runNerShadowVerifier` 是 `ContentPipeline` 的 private 方法：
- env kill switch 短路。
- try/catch 包裹：跑 `verifyNerExtraction` → `summarizeShadowVerifierObservations` → `addIngestLog("verifier", "ner_shadow_verifier", fromSlug, JSON)`。
- catch 里 `sanitizeForLog` + raw token 脱敏（复用 pipeline.ts:454-473 现有模式），仅 `logger.warn`，**绝不 rethrow**。

放在 early-return **前**，是 issue 明确要求：长 body 零抽取必须被 flag，而当前 early-return 会跳过后续逻辑。

### Discovery —— 三个 `upsertDiscovery` 点全覆盖

每个点在 `upsertDiscovery()` **之前**映射成 `DiscoveryVerifierInput` 调用 `verifyDiscoveryCandidate`，fail-open 写 `ingest_log`：

| 文件 | 位置 | 输入映射 |
|---|---|---|
| `src/core/maintenance/discovery.ts` | `runDiscovery` upsert 循环 (~113) | `displayTexts: [r.suggestion ?? ""]`；`hasEvidence:false`；`hasProposedActions:false`；`autoApplicable:false` |
| `src/core/maintenance/discovery.ts` | `runSimilarEntityDetection` upsert 循环 (~228) | 同上，suggestion 通常为空 |
| `src/core/maintenance/action-candidates.ts` | `ActionCandidateManager.persistDrafts` (~315) | `displayTexts: [draft.displayTitle, draft.displayReason, draft.suggestedAction]`；`hasEvidence: draft.evidence.length>0`；`hasProposedActions: draft.proposedActions.length>0`；`autoApplicable:false` |

封装一个共享 helper（放 `shadow-verifier.ts`，接收 `CBrainDB` + 输入 + action 名）处理 fail-open + ingest_log 写入，三个调用点统一调用，避免重复 try/catch 模板。

## Storage（复用 ingest_log，无新表）

### 写

```
addIngestLog("verifier", "ner_shadow_verifier" | "discovery_shadow_verifier", page_slug?, details)
```

- **`page_slug`**：
  - NER = `fromSlug`（ingest_log 既有语义就是页面审计，合法）。
  - **Discovery = `null`**（**绝不**写 `discovery:<dedup_key>`、绝不写 entities/slug 列表 —— dedup_key 内含 slug 是隐私泄漏点）。
- **`details`** = `ShadowVerifierSummary` 的 JSON，**只含** `{surface, type?, checks, counts, reasonCounts, worst}`。**禁止**包含 entities / dedup_key / slug / title / source_ref / raw body。

### 读

新增 `CBrainDB.getRecentVerifierCounts(hours = 24)`（参照现有 `getRecentNerErrorCount`）：

```sql
SELECT action, details FROM ingest_log
WHERE source_type = 'verifier' AND created_at > datetime('now', '-$hours hours')
```

TS 聚合 details JSON 的 `counts`，返回：

```ts
{
  ner: { warning: number; error: number };
  discovery: { warning: number; error: number };
  byCode: Record<string, number>;
}
```

## 开关

env `CBRAIN_SHADOW_VERIFIER_DISABLE=1`，模块加载时读一次缓存。**默认开**（deterministic checks 纯内存零成本，写一行 ingest_log 也几乎免费；默认开才能积累观察数据）。kill switch 仅作 emergency brake。

在各 verifier runner 入口（`runNerShadowVerifier` / discovery helper）短路返回，零开销。

## Health surface —— 新 HealthDimension

`src/core/maintenance/health.ts` 加 `checkVerifierQuality(): HealthDimension`，注册进 `checkAll()` 的 dimensions 数组（~line 187 `checkNerQuality()` 之后）。

读 `getRecentVerifierCounts(24)`，按拍板规则定 status：

| 条件 | dimension status | issue severity |
|---|---|---|
| `error > 0` | **fail** | high |
| `warning > 0`（error=0） | warn | medium |
| 仅 info 或全 0 | pass | — |

聚合到 **两个 HealthIssue**（NER surface 一个、Discovery surface 一个），每个 issue 的 title/description **明确写"生成质量风险"语义，不写"数据损坏/数据腐坏"** —— shadow verifier 报的是生成端质量风险，不是主链路存储损坏。

文案示例（匿名，无实体名）：
> 标题：`影子校验：最近 24h NER 抽取存在 3 处生成质量风险 (error)`
> 描述：`影子校验在最近 24 小时记录到 3 条 error 级观察，主要 reason: ner_zero_from_long_body×2, ner_invalid_entity_field×1。详见 ingest_log（source_type=verifier）。`

`slug` 字段用占位（`verifier:ner` / `verifier:discovery`）—— verifier 不绑定单页。

**dream.ts 无需改动**：它调 `checkAll()`，新 dimension 自动进 `HealthReport.dimensions`，dream summary / report 自动覆盖。

## Fail-open 铁律

- 所有 verifier 调用包在 try/catch，**永不 rethrow**。
- verifier 永不阻塞写、永不回滚已落库的 entity/relation/event/discovery。
- verifier 写 `ingest_log` 失败也只 `logger.warn`，不影响主流程。
- catch 里日志经 `sanitizeForLog` + raw token 脱敏，无 raw name/slug/body 泄漏。

## 隐私约束（重点）

- `ingest_log.details` **只存** counts / reason codes / surface / type / worst。
- **绝不**存 source body / raw entity name / slug / dedup_key / title / prompt / relation endpoints。
- `ingest_log.page_slug` 对 discovery 写 `null`。
- 测试 fixture 只用匿名占位（`实体A`、`组织C`、`主题D`），**绝不**用真名/真路径/email，**即使作为 negative assertion**（隐私扫描会常驻命中，见 memory `public-tests-anonymous-placeholders`）。
- verifier 错误日志同样经脱敏。

## 测试计划（匿名 fixtures）

用 `bun:test`，DB 落 `/tmp/cbrain-test-*`，`afterEach` 清理。

**纯函数单测（shadow-verifier.ts）**：
1. `verifyNerExtraction`：长 body（`bodyChars>500`）零实体 → 1 error `ner_zero_from_long_body`
2. `verifyNerExtraction`：正常 extraction → 0 warning / 0 error
3. `verifyNerExtraction`：relation 端点不在 entities → warning `ner_relation_endpoint_missing`
4. `verifyNerExtraction`：实体数超 `max(30, floor(bodyChars/80))` → warning `ner_extraction_unusually_high`
5. `verifyDiscoveryCandidate`：`actionable=high` + 无 evidence + 无 proposedActions → error `discovery_high_actionable_no_evidence`
6. `verifyDiscoveryCandidate`：`autoApplicable=true` on `action_review_discovery` → error `discovery_auto_applicable_on_review_type`
7. `verifyDiscoveryCandidate`：`displayTexts` 含 `/Users/x` → warning `discovery_display_private_raw`
8. `verifyDiscoveryCandidate`：正常 draft → 0 warning / 0 error

**集成测试**：
9. `processNer`：verifier 抛错（注入坏输入）→ ingest 仍成功，fail-open，无 rethrow
10. `ActionCandidateManager.persistDrafts`：verifier 抛错 → 候选仍持久化
11. `CBRAIN_SHADOW_VERIFIER_DISABLE=1` → 零 `source_type=verifier` ingest_log 行
12. `getRecentVerifierCounts` 写入后读回 counts 正确
13. `checkVerifierQuality`：error>0 → dimension status `fail` / issue severity `high`；warning only → `warn`；clean → `pass`

**隐私断言**：
14. 写入的 `ingest_log.details` JSON 不含任何 fixture 用过的实体名占位（`实体A` 等）—— 即便输入含这些名，details 也不得回显
15. discovery verifier 写入的 `page_slug` 为 `null`

## 验收标准（来自 issue）

- [ ] 匿名 fixture 展示至少一处低质量 NER 抽取被 flag + 写 audit 行
- [ ] 正常 NER 抽取不产生 warning/error observation
- [ ] 畸形/高风险 discovery candidate 被 flag
- [ ] 正常 ingest/discovery 行为除紧凑 verifier audit 行外不变
- [ ] verifier 失败路径有测试：verifier 内 throw → ingest/discovery 仍成功
- [ ] Health/Dream 聚合能报告近期 verifier warning/error 计数，不泄漏私密内容
- [ ] `bun run check` 通过
- [ ] 交付前跑对抗性 review，重点查：隐私泄漏、意外写阻塞、噪声用户输出、成本/延迟无界、质量逻辑重复

## 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/core/quality/shadow-verifier.ts` | **新增**。纯函数 + fail-open runner helper + env kill switch |
| `src/core/ingestion/pipeline.ts` | `processNer` 加 `runNerShadowVerifier` 调用（early-return 前）；新 private 方法 |
| `src/core/maintenance/discovery.ts` | `runDiscovery` + `runSimilarEntityDetection` 两个 upsert 点加 verifier |
| `src/core/maintenance/action-candidates.ts` | `persistDrafts` 加 verifier；export `DISPLAY_UNSAFE_PATTERNS` 供 verifier 复用 |
| `src/storage/sqlite.ts` | 新增 `getRecentVerifierCounts(hours)`（参照 `getRecentNerErrorCount`） |
| `src/core/maintenance/health.ts` | 新 `checkVerifierQuality()` dimension，注册进 `checkAll()` |
| `tests/quality/shadow-verifier.test.ts` | **新增**。纯函数单测 |
| `tests/quality/shadow-verifier-integration.test.ts` | **新增**。集成 + 隐私断言 |
