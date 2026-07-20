# Actionable `next_actions` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generic discovery review groups with deterministic, type-aware, confirmation-gated actions while keeping unsupported types silent and preserving every existing read-only/privacy boundary.

**Architecture:** Add one shared display resolver inside the existing action-candidate module. Both fresh discovery rows and persisted discovery action candidates use it; persisted recurrence reads only a dedicated `source_occurrence_count`. The attention queue, MCP response shape, ranking, freshness, and discovery detail tool stay unchanged.

**Tech Stack:** TypeScript, Bun, bun:test, existing MCP SDK and SQLite test fixtures.

## Global Constraints

- Do not add tools, public response fields, public statuses, tables, migrations, configuration, telemetry, or LLM calls.
- Do not change discovery detection, ranking, freshness, grouping, or the top-three cap.
- Do not interpolate entity names, slugs, paths, raw suggestions, scores, metadata bodies, evidence references, or credentials into generated display copy.
- Every supported suggestion offers a read-only review of at most three items and stops for explicit user confirmation before any write-capable operation.
- Unsupported direct and persisted discovery types are silent in `next_actions`.
- `include_raw=true` keeps its existing key sets and audit-only `sourceRefs`; no new raw field is authorized.
- Tests use synthetic identifiers only.

---

### Task 1: Shared discovery display resolver and honest recurrence

**Files:**
- Modify: `tests/core/action-candidates.test.ts`
- Modify: `src/core/maintenance/action-candidates.ts`

**Interfaces:**
- Produces: `SUPPORTED_ACTION_DISCOVERY_TYPES: ReadonlySet<string>` for the two read paths in this module.
- Produces: private `buildDiscoveryActionDisplay(type: string, recurring: boolean): { title: string; reason: string; suggestion: string } | null`.
- Persists: `metadata.source_occurrence_count` as the source discovery's finite integer count, minimum one.
- Consumes: only `source_occurrence_count` when reconstructing persisted discovery candidates; never the action row's own `occurrence_count` for recurrence prose.

- [ ] **Step 1: Add failing supported-type and confirmation tests**

Add a table-driven test under `describe("buildActionCandidatesFromDiscoveries (#267)")`:

```ts
test("supported discovery types get distinct bounded confirmation-gated actions", () => {
  const cases = [
    ["bridge", "潜在关联"],
    ["trend", "关注变化"],
    ["gap", "待补全"],
    ["contradiction", "信息冲突"],
    ["knowledge_map_isolation", "孤立记忆"],
    ["knowledge_map_bridge", "跨领域连接"],
    ["similar_entity", "可能重复"],
  ] as const;

  const suggestions = new Set<string>();
  for (const [type, titleMarker] of cases) {
    const draft = buildActionCandidatesFromDiscoveries([{
      id: 100,
      type,
      entities: JSON.stringify(["entity/a", "entity/b"]),
      score: 0.9,
      actionable: "high",
      auto_applicable: 0,
      occurrence_count: 1,
      dedup_key: `${type}|entity/a|entity/b`,
      suggestion: "SYNTHETIC_RAW_SUGGESTION_SENTINEL",
      metadata: JSON.stringify({ private_title: "SYNTHETIC_PRIVATE_TITLE_SENTINEL" }),
    }])[0];

    expect(draft.displayTitle).toContain(titleMarker);
    expect(draft.suggestedAction).toContain("最多 3 条");
    expect(draft.suggestedAction).toContain("确认");
    expect(draft.suggestedAction).not.toContain("SYNTHETIC_RAW_SUGGESTION_SENTINEL");
    expect(JSON.stringify([draft.displayTitle, draft.displayReason, draft.suggestedAction]))
      .not.toContain("SYNTHETIC_PRIVATE_TITLE_SENTINEL");
    expect(draft.metadata.source_occurrence_count).toBe(1);
    suggestions.add(draft.suggestedAction);
  }
  expect(suggestions.size).toBe(cases.length);
});
```

- [ ] **Step 2: Add failing unsupported-type tests**

Add direct and persisted cases:

```ts
test("unsupported discovery type is silent", () => {
  expect(buildActionCandidatesFromDiscoveries([{
    id: 101,
    type: "future_private_signal",
    entities: JSON.stringify(["entity/a"]),
    score: 1,
    actionable: "high",
    auto_applicable: 0,
    occurrence_count: 9,
    dedup_key: "future_private_signal|entity/a",
  }])).toHaveLength(0);
});
```

In the persistence describe block, insert an `action_review_discovery` row whose
metadata contains `source_type: "future_private_signal"`, fetch it with
`getDiscoveryById`, and assert `persistedCandidateRowToDraft(row)` is `null`.

- [ ] **Step 3: Add failing persisted recurrence and hostile-copy tests**

Import `persistedCandidateRowToDraft`. Add a helper that persists an
`action_review_discovery` row with fixed synthetic refs. Test these cases:

```ts
test("persisted discovery recurrence uses source count, not action rerun count", () => {
  const metadata = {
    source: "discovery",
    source_type: "bridge",
    source_occurrence_count: 1,
    display_title: "SYNTHETIC_PRIVATE_TITLE_SENTINEL",
    display_reason: "SYNTHETIC_RAW_REASON_SENTINEL",
    suggested_action: "SYNTHETIC_RAW_SUGGESTION_SENTINEL",
  };
  for (let i = 0; i < 3; i++) {
    db.upsertDiscovery(
      "action_review_discovery",
      ["discovery:synthetic-bridge"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      metadata,
    );
  }
  const row = db.getDiscoveryById(db.getDiscoveriesByType("action_review_discovery", 1)[0].id)!;
  expect(row.occurrence_count).toBe(3);
  const draft = persistedCandidateRowToDraft(row)!;
  expect(draft.displayReason).not.toContain("多次");
  expect(JSON.stringify(draft)).not.toContain("SYNTHETIC_PRIVATE_TITLE_SENTINEL");
  expect(JSON.stringify(draft)).not.toContain("SYNTHETIC_RAW_SUGGESTION_SENTINEL");
});
```

Add separate rows proving validated `source_occurrence_count: 3` produces the
repeated reason, and invalid values (`0`, `1.5`, `NaN` serialized as `null`, and a
string) fail closed to the single reason. Assert persisted health rows still use
safe validated stored display copy.

- [ ] **Step 4: Run the new core tests and verify RED**

Run:

```bash
bun test tests/core/action-candidates.test.ts
```

Expected: failures showing the current generic title/suggestion, unsupported type
promotion, missing `source_occurrence_count`, and action-row recurrence misuse.

- [ ] **Step 5: Implement the minimal resolver**

In `action-candidates.ts`, add the supported set and a fixed-copy switch. Each
suggestion must contain “最多 3 条”, a type-specific verification target, and an
explicit confirmation stop. Implement this complete resolver:

```ts
const SUPPORTED_ACTION_DISCOVERY_TYPES: ReadonlySet<string> = new Set([
  "bridge",
  "trend",
  "gap",
  "contradiction",
  "knowledge_map_isolation",
  "knowledge_map_bridge",
  "similar_entity",
]);

function buildDiscoveryActionDisplay(type: string, recurring: boolean): {
  title: string;
  reason: string;
  suggestion: string;
} | null {
  if (!SUPPORTED_ACTION_DISCOVERY_TYPES.has(type)) return null;
  const repeatedReason = recurring
    ? "同类信号已经多次出现，值得优先核对。"
    : "这项信号的重要程度较高，但仍需人工核对。";
  switch (type) {
    case "bridge":
      return {
        title: "有一组潜在关联待筛选",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级关联线索并核对依据；展示后请你确认补链或忽略，确认前不修改。",
      };
    case "trend":
      return {
        title: "有一组关注变化待核对",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级变化并核对近期记录；展示后请你确认更新或忽略，确认前不修改。",
      };
    case "gap":
      return {
        title: "有一组记忆内容待补全",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级待补全项并核对已有内容；展示后请你确认先补充哪一项，确认前不修改。",
      };
    case "contradiction":
      return {
        title: "有一组信息冲突待核对",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级冲突并核对来源；展示后请你确认保留哪个有证据的版本，确认前不修改。",
      };
    case "knowledge_map_isolation":
      return {
        title: "有一组孤立记忆待确认",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级孤立记忆并核对依据；展示后请你确认补充关联或保持不变，确认前不修改。",
      };
    case "knowledge_map_bridge":
      return {
        title: "有一组跨领域连接待复核",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级跨领域连接并核对依据；展示后请你确认保留或加强，确认前不修改。",
      };
    case "similar_entity":
      return {
        title: "有一组可能重复项待核对",
        reason: repeatedReason,
        suggestion: "可先查看最多 3 条当前高优先级重复候选并做只读比较；展示后请你确认合并或分别保留，确认前不修改。",
      };
    default:
      return null;
  }
}
```

Call `assertSafeActionDisplay` on all three returned strings.

Change `reviewDiscoveryDraft` to return `ActionCandidateDraft | null`, call the
resolver before building the draft, and add:

```ts
const sourceOccurrenceCount = Number.isInteger(row.occurrence_count) && (row.occurrence_count ?? 0) >= 1
  ? row.occurrence_count!
  : 1;
```

Persist both existing `occurrence_count: sourceOccurrenceCount` and new
`source_occurrence_count: sourceOccurrenceCount`. In
`buildActionCandidatesFromDiscoveries`, push only non-null drafts.

In `persistedCandidateRowToDraft`, branch by source. For discovery rows:

```ts
const sourceType = typeof meta.source_type === "string" ? meta.source_type : "";
const rawSourceOccurrence = meta.source_occurrence_count;
const sourceOccurrenceCount = typeof rawSourceOccurrence === "number"
  && Number.isFinite(rawSourceOccurrence)
  && Number.isInteger(rawSourceOccurrence)
  && rawSourceOccurrence >= 1
    ? rawSourceOccurrence
    : 1;
const display = buildDiscoveryActionDisplay(sourceType, sourceOccurrenceCount >= 3);
if (!display) return null;
```

Use `display` directly for discovery-backed prose and keep `safeDisplayText` only
for health-backed persisted prose. Set reconstructed discovery metadata
`occurrence_count` and `source_occurrence_count` to the validated source value.

- [ ] **Step 6: Run core tests and verify GREEN**

Run:

```bash
bun test tests/core/action-candidates.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/core/maintenance/action-candidates.ts tests/core/action-candidates.test.ts
git commit -m "fix: make discovery actions actionable"
```

---

### Task 2: MCP journey, detail handoff, and raw/privacy regression gates

**Files:**
- Modify: `tests/mcp/next-actions.test.ts`
- Modify: `src/mcp/tools/next-actions.ts`

**Interfaces:**
- Consumes: the shared action display behavior from Task 1.
- Verifies: unchanged `next_actions` public envelope, raw envelope, read-only behavior, and existing `read_discoveries` detail surface.
- Produces: a six-type `NEXT_ACTION_DETAIL_TYPES` admission gate so
  `similar_entity` remains available to its existing action-candidate lane but is
  silent in `next_actions` until its explicit detail surface works.

- [ ] **Step 1: Add a failing mixed-group experience test**

Seed supported `bridge`, `trend`, and `gap` rows with synthetic refs, then call
`next_actions({ sources: ["discovery"] })`. Assert:

```ts
expect(payload.summary.shownCount).toBe(3);
expect(payload.display).toContain("潜在关联");
expect(payload.display).toContain("关注变化");
expect(payload.display).toContain("待补全");
expect(payload.display).not.toContain("有一条发现值得复核");
expect(payload.display).not.toContain("打开对应发现");
expect(payload.display.match(/最多 3 条/g)?.length).toBe(3);
expect(payload.display.match(/确认前不修改/g)?.length).toBe(3);
for (const item of payload.items) {
  expect(Object.keys(item).sort()).toEqual(["evidence_count", "severity", "source"]);
}
```

- [ ] **Step 2: Add detail handoff and empty-result tests**

For each of the six supported types, seed one current pending row, call
`next_actions`, then call:

```ts
read_discoveries.handler({ typeFilter: type, limit: 3, debug: false })
```

Assert the returned public card count is between one and three, `_debug` is absent,
and neither call changes the number/status of discovery rows. In a separate empty
database case, call the same `read_discoveries` request and assert zero cards and a
no-current-discovery display. Do not add automatic chaining production code.

- [ ] **Step 3: Add a failing similar-entity admission test**

Seed one high-actionable `similar_entity` row, call
`next_actions({ sources: ["discovery"] })`, and assert `items` is empty and the
display reports no current action. Run the single test and verify RED because the
shared action-candidate resolver intentionally still supports this governance
type.

- [ ] **Step 4: Implement the narrow detail-handoff admission gate**

In `src/mcp/tools/next-actions.ts`, define:

```ts
const NEXT_ACTION_DETAIL_TYPES: ReadonlySet<string> = new Set([
  "bridge",
  "trend",
  "gap",
  "contradiction",
  "knowledge_map_isolation",
  "knowledge_map_bridge",
]);

function hasNextActionDetailHandoff(draft: ActionCandidateDraft): boolean {
  const sourceType = draft.metadata.source_type;
  return typeof sourceType === "string" && NEXT_ACTION_DETAIL_TYPES.has(sourceType);
}
```

Apply it to both persisted discovery drafts and fresh drafts before they enter
`discoveryDrafts`. Do not apply it to health drafts and do not change the shared
action-candidate builder.

- [ ] **Step 5: Add the full default-envelope privacy matrix**

Seed both a fresh `bridge` row and a persisted `action_review_discovery` row with
synthetic hostile data across their entities, raw suggestion, and metadata:

```ts
const forbidden = [
  "entity/private-a",
  "entities/private-b",
  "brain/entities/private-c",
  "/synthetic/private/path",
  "C:\\synthetic\\private\\path",
  "SYNTHETIC_RAW_SUGGESTION_SENTINEL",
  "Bearer synthetic-credential-sentinel",
  "synthetic\u202Econtrol",
];
```

Call default `next_actions` and assert none of these markers appears anywhere in
`JSON.stringify(payload)`. Also assert `payload.raw === null`.

- [ ] **Step 6: Lock the existing raw shape without denying audit-only refs**

Call `next_actions({ include_raw: true })` and assert:

```ts
expect(Object.keys(payload.raw).sort()).toEqual([
  "allItemsRanked",
  "audit",
  "observeOnlyItems",
  "staleItems",
]);
for (const item of payload.raw.allItemsRanked) {
  expect(Object.keys(item).sort()).toEqual([
    "detectedAt",
    "evidenceCount",
    "freshness",
    "groupKey",
    "lastDetectedAt",
    "occurrenceCount",
    "reason",
    "severity",
    "source",
    "sourceRefs",
    "suggestion",
    "title",
  ]);
  const prose = JSON.stringify([item.title, item.reason, item.suggestion]);
  expect(prose).not.toContain("SYNTHETIC_RAW_SUGGESTION_SENTINEL");
  expect(prose).not.toContain("Bearer synthetic-credential-sentinel");
}
```

Allow existing `sourceRefs` to remain audit-only. Assert `raw.audit` retains only
its established scalar/count breakdown keys and contains none of the hostile
metadata markers.

- [ ] **Step 7: Run MCP tests and verify GREEN**

Run:

```bash
bun test tests/mcp/next-actions.test.ts
```

Expected: all tests pass. If an exact raw item key differs because an
optional timestamp is legitimately absent, seed timestamps so the production
shape is deterministic; do not weaken the key assertion.

- [ ] **Step 8: Run focused regression set**

```bash
bun test tests/core/action-candidates.test.ts tests/core/attention-queue.test.ts tests/core/discovery-digest.test.ts tests/mcp/next-actions.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 9: Commit Task 2**

```bash
git add tests/mcp/next-actions.test.ts src/mcp/tools/next-actions.ts
git commit -m "test: lock actionable next actions journey"
```

If `src/mcp/tools/next-actions.ts` is unchanged, omit it from `git add`.

---

### Task 3: Contract verification and delivery evidence

**Files:**
- Modify only if required by an existing documentation gate: `docs/mcp-tools.md`
- No production behavior expansion.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: a clean, independently reviewable branch with deterministic and full-suite evidence.

- [ ] **Step 1: Run documentation and static gates**

```bash
bun run check:docs
bun run lint
git diff --check origin/main...HEAD
```

Expected: every command exits zero. If the repository has no `lint` script, run
the exact type/lint command used by `bun run check` instead and record it in the
delivery report; do not add a new script.

- [ ] **Step 2: Run the repository privacy scan**

Scan only implementation-facing changed paths so the plan's prose does not become
its own match:

```bash
if git diff origin/main...HEAD -- src tests skills docs/mcp-tools.md \
  | rg -n "/Users/${USER}/|宏哥|chenhong268|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"; then
  exit 1
fi
```

Expected: no matches and exit zero. Synthetic credential/path fixtures are
allowed only where their assertions prove they cannot reach the output.

- [ ] **Step 3: Run the full suite**

```bash
bun run check
```

Expected: zero failures.

- [ ] **Step 4: Perform local adversarial review**

Attack these cases against the final diff:

1. action row rerun count incorrectly treated as source recurrence;
2. unsupported type surfacing generic advice;
3. hostile persisted copy entering default or raw display prose;
4. wording that authorizes writes before user confirmation;
5. response-shape, ranking, freshness, or read-only regression.

Fix any finding with a failing regression test first, then rerun focused and full
gates.

- [ ] **Step 5: Commit any gate-only correction**

If documentation or a regression correction was required:

```bash
git add src/core/maintenance/action-candidates.ts tests/core/action-candidates.test.ts tests/mcp/next-actions.test.ts docs/mcp-tools.md
git commit -m "docs: align actionable next actions contract"
```

If no file changed, do not create an empty commit.

- [ ] **Step 6: Record delivery evidence**

Report:

- spec commit and implementation commit SHAs;
- exact changed files;
- focused and full test counts;
- documentation/static/privacy results;
- adversarial review verdict;
- rollback command (`git revert` of implementation commits);
- residual risk that actionability still depends on the user accepting the
  read-only detail offer; no automatic chaining is introduced.
