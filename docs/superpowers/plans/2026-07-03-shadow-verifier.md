# Shadow Verifier (#265) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shadow-only, deterministic quality verifier for NER extraction and discovery/action-candidate persistence that observes and records signals via `ingest_log` without ever blocking writes.

**Architecture:** New `src/core/quality/shadow-verifier.ts` exports pure deterministic check functions (zero runtime deps) plus fail-open runners (type-only imports, DB/logger injected). Two hook surfaces: NER inside `ContentPipeline.processNer` before its early-return; discovery at all three `upsertDiscovery` call sites. Aggregate counts surface via a new `checkVerifierQuality` HealthDimension. No new tables — reuses `ingest_log` with `source_type="verifier"`.

**Tech Stack:** Bun, TypeScript (strict), bun:sqlite, bun:test. Anonymous fixtures only (`实体A`/`组织C`/`主题D`).

**Spec:** [`docs/superpowers/specs/2026-07-03-shadow-verifier-design.md`](../specs/2026-07-03-shadow-verifier-design.md)

---

## ⚠️ Execution Reminders (from 宏哥)

1. **Worktree MUST branch from local `main`, not `origin/main`.** The spec commit `e412b2e` is local-ahead and unpushed. EnterWorktree defaults to `origin/main` (`fresh`); use the `head` base ref (or `fresh` then `git rebase main`) so the spec is present in the worktree. See memory `worktree-fresh-base-misses-local-main`.
2. **`DISPLAY_UNSAFE_PATTERNS` — export const only, do NOT change pattern semantics.** Adding `export` is the entire change. Do not reorder, add, or weaken patterns. After Task 2, run the `#267` action-candidates tests to prove zero regression.
3. **Mandatory adversarial review before handoff** (Task 8): privacy leakage, accidental write blocking, noisy health output, unbounded cost/latency, duplicated quality logic.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/core/quality/shadow-verifier.ts` | Pure check functions + fail-open runners + env kill switch | **Create** |
| `src/core/maintenance/action-candidates.ts` | Export `DISPLAY_UNSAFE_PATTERNS`; wire `persistDrafts` verifier hook | Modify |
| `src/core/ingestion/pipeline.ts` | Wire NER verifier hook in `processNer` before early-return | Modify |
| `src/core/maintenance/discovery.ts` | Wire verifier at two `upsertDiscovery` sites | Modify |
| `src/storage/sqlite.ts` | Add `getRecentVerifierCounts(hours)` reader | Modify |
| `src/core/maintenance/health.ts` | Add `checkVerifierQuality()` dimension, register in `checkAll()` | Modify |
| `tests/core/shadow-verifier.test.ts` | Pure-function unit tests | **Create** |
| `tests/core/shadow-verifier-integration.test.ts` | Integration + privacy + fail-open + health tests | **Create** |

**Privacy invariant (every persisted row):** `ingest_log.details` for `source_type="verifier"` holds ONLY `{surface, type?, checks, counts, reasonCounts, worst}`. No entity names, slugs, dedup_key, titles, body, or `observations[].detail`. Discovery rows use `page_slug=null`.

---

## Task 0: Worktree & Baseline

**Files:** none

- [ ] **Step 1: Enter worktree branched from local main**

  The spec commit `e412b2e` is local-only. Use the `head` base ref so the spec is in the worktree:
  ```
  EnterWorktree (name: "265-shadow-verifier")
  ```
  If the worktree skill defaults to `origin/main`, verify the spec is present:
  ```bash
  ls docs/superpowers/specs/2026-07-03-shadow-verifier-design.md
  ```
  If missing, rebase the worktree branch onto local `main`:
  ```bash
  git rebase main
  ```

- [ ] **Step 2: Verify clean baseline**

  Run: `bun run lint && bun test`
  Expected: both green before any change. If `lint` reports pre-existing test-only type errors, those are documented as out-of-gate (CLAUDE.md). The `bun test` suite must be fully green.

---

## Task 1: Pure NER verifier functions + types

**Files:**
- Create: `src/core/quality/shadow-verifier.ts`
- Create: `tests/core/shadow-verifier.test.ts`

- [ ] **Step 1: Write the failing tests for NER checks**

  Create `tests/core/shadow-verifier.test.ts`:

  ```ts
  import { describe, test, expect } from "bun:test";
  import {
    verifyNerExtraction,
    summarizeShadowVerifierObservations,
    type NerVerifierInput,
  } from "../../src/core/quality/shadow-verifier.js";

  function nerInput(over: Partial<NerVerifierInput> = {}): NerVerifierInput {
    return {
      bodyChars: 100,
      entityCount: 1,
      relationCount: 0,
      eventCount: 0,
      factCount: 0,
      entities: [{ name: "实体A", type: "company" }],
      relations: [],
      events: [],
      ...over,
    };
  }

  describe("verifyNerExtraction", () => {
    test("long body with zero extraction → error ner_zero_from_long_body", () => {
      const obs = verifyNerExtraction(nerInput({
        bodyChars: 600, entityCount: 0, relationCount: 0, eventCount: 0, factCount: 0,
        entities: [],
      }));
      const e = obs.find((o) => o.code === "ner_zero_from_long_body");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("error");
    });

    test("short body with zero extraction → NOT flagged (below 500 chars)", () => {
      const obs = verifyNerExtraction(nerInput({
        bodyChars: 200, entityCount: 0, entities: [],
      }));
      expect(obs.some((o) => o.code === "ner_zero_from_long_body")).toBe(false);
    });

    test("normal extraction → no warning/error observations", () => {
      const obs = verifyNerExtraction(nerInput({
        bodyChars: 400,
        entityCount: 2,
        entities: [
          { name: "实体A", type: "company" },
          { name: "实体B", type: "person" },
        ],
        relations: [{ from: "实体A", to: "实体B" }],
      }));
      expect(obs.filter((o) => o.severity === "warning" || o.severity === "error")).toEqual([]);
    });

    test("relation endpoint not in entities → warning ner_relation_endpoint_missing", () => {
      const obs = verifyNerExtraction(nerInput({
        entities: [{ name: "实体A", type: "company" }],
        relationCount: 1,
        relations: [{ from: "实体A", to: "孤儿C" }],
      }));
      const e = obs.find((o) => o.code === "ner_relation_endpoint_missing");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("warning");
    });

    test("entity count over conservative threshold → warning ner_extraction_unusually_high", () => {
      // bodyChars=2400 → threshold = max(30, floor(2400/80)) = 30; send 31 entities
      const entities = Array.from({ length: 31 }, (_, i) => ({ name: `实体${i}`, type: "concept" }));
      const obs = verifyNerExtraction(nerInput({
        bodyChars: 2400, entityCount: 31, entities,
      }));
      const e = obs.find((o) => o.code === "ner_extraction_unusually_high");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("warning");
    });

    test("6 entities in 500-char body is NOT unusually high (no false positive)", () => {
      // Conservative threshold: max(30, floor(500/80)) = 30. Six is well under.
      const entities = Array.from({ length: 6 }, (_, i) => ({ name: `实体${i}`, type: "company" }));
      const obs = verifyNerExtraction(nerInput({
        bodyChars: 500, entityCount: 6, entities,
      }));
      expect(obs.some((o) => o.code === "ner_extraction_unusually_high")).toBe(false);
    });

    test("same name with conflicting types → warning ner_duplicate_name_conflicting_type", () => {
      const obs = verifyNerExtraction(nerInput({
        entityCount: 2,
        entities: [
          { name: "实体A", type: "company" },
          { name: "实体A", type: "person" },
        ],
      }));
      expect(obs.some((o) => o.code === "ner_duplicate_name_conflicting_type")).toBe(true);
    });

    test("empty entity name → warning ner_invalid_entity_field", () => {
      const obs = verifyNerExtraction(nerInput({
        entityCount: 2,
        entities: [
          { name: "实体A", type: "company" },
          { name: "", type: "person" },
        ],
      }));
      expect(obs.some((o) => o.code === "ner_invalid_entity_field")).toBe(true);
    });

    test("event with malformed date → info ner_invalid_event_date", () => {
      const obs = verifyNerExtraction(nerInput({
        events: [{ date: "不是日期" }],
        eventCount: 1,
      }));
      const e = obs.find((o) => o.code === "ner_invalid_event_date");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("info");
    });

    test("event with valid YYYY-MM-DD date → NOT flagged", () => {
      const obs = verifyNerExtraction(nerInput({
        events: [{ date: "2026-07-03" }],
        eventCount: 1,
      }));
      expect(obs.some((o) => o.code === "ner_invalid_event_date")).toBe(false);
    });
  });

  describe("summarizeShadowVerifierObservations", () => {
    test("aggregates counts and reason codes, picks worst severity", () => {
      const summary = summarizeShadowVerifierObservations("ner", [
        { surface: "ner", code: "ner_zero_from_long_body", severity: "error" },
        { surface: "ner", code: "ner_invalid_event_date", severity: "info" },
        { surface: "ner", code: "ner_zero_from_long_body", severity: "error" },
      ]);
      expect(summary.counts).toEqual({ info: 1, warning: 0, error: 2 });
      expect(summary.reasonCounts).toEqual({ ner_zero_from_long_body: 2, ner_invalid_event_date: 1 });
      expect(summary.worst).toBe("error");
      expect(summary.checks).toBe(6);
      expect(summary.surface).toBe("ner");
    });

    test("empty observations → worst 'none', zeroed counts", () => {
      const summary = summarizeShadowVerifierObservations("ner", []);
      expect(summary.counts).toEqual({ info: 0, warning: 0, error: 0 });
      expect(summary.worst).toBe("none");
      expect(summary.reasonCounts).toEqual({});
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `bun test tests/core/shadow-verifier.test.ts`
  Expected: FAIL — cannot resolve `../../src/core/quality/shadow-verifier.js` (file does not exist).

- [ ] **Step 3: Create the module with NER checks**

  Create `src/core/quality/shadow-verifier.ts`:

  ```ts
  // Shadow verifier — Phase 1 (#265).
  //
  // Two layers:
  //  - Pure check functions (verifyNerExtraction / verifyDiscoveryCandidate /
  //    summarizeShadowVerifierObservations): deterministic, zero runtime deps.
  //  - Fail-open runners (runNerShadowVerifierFailOpen /
  //    runDiscoveryShadowVerifierFailOpen): type-only imports, DB/logger injected.
  //
  // Privacy: persisted ingest_log rows hold ONLY the summary JSON
  // (counts + reason codes + surface/type/worst). observations[].detail is
  // in-memory only — never persisted.
  //
  // Task 1 lands ONLY the NER pure functions — no external imports yet (they
  // would be unused and trip the lint gate at commit time). Tasks 2/4/5 add
  // imports as the symbols they need come online.

  export type VerifierSeverity = "info" | "warning" | "error";
  export type VerifierSurface = "ner" | "discovery";

  export interface ShadowVerifierObservation {
    surface: VerifierSurface;
    code: string;
    severity: VerifierSeverity;
    /** In-memory only. Counts/type-labels only — never raw names/slugs. Never persisted. */
    detail?: string;
  }

  export interface ShadowVerifierSummary {
    surface: VerifierSurface;
    type?: string;
    checks: number;
    counts: { info: number; warning: number; error: number };
    reasonCounts: Record<string, number>;
    worst: VerifierSeverity | "none";
  }

  export interface NerVerifierInput {
    bodyChars: number;
    entityCount: number;
    relationCount: number;
    eventCount: number;
    factCount: number;
    entities: Array<{ name: string; type: string }>;
    relations: Array<{ from: string; to: string }>;
    events: Array<{ date: string | null }>;
  }

  export interface DiscoveryVerifierInput {
    type: string;
    actionable: string;
    score: number;
    autoApplicable: boolean;
    hasEvidence: boolean;
    hasProposedActions: boolean;
    /** User-visible text only — checked against unsafe-display patterns. */
    displayTexts: string[];
  }

  const NER_CHECK_COUNT = 6;
  const DISCOVERY_CHECK_COUNT = 5;
  const ZERO_EXTRACTION_BODY_MIN = 500;
  const HIGH_ENTITY_THRESHOLD_DIVISOR = 80;
  const HIGH_ENTITY_THRESHOLD_FLOOR = 30;

  function isValidDate(s: string): boolean {
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
    return !Number.isNaN(Date.parse(s));
  }

  export function verifyNerExtraction(input: NerVerifierInput): ShadowVerifierObservation[] {
    const obs: ShadowVerifierObservation[] = [];

    // 1. ner_zero_from_long_body
    if (
      input.bodyChars > ZERO_EXTRACTION_BODY_MIN &&
      input.entityCount === 0 &&
      input.relationCount === 0 &&
      input.eventCount === 0 &&
      input.factCount === 0
    ) {
      obs.push({
        surface: "ner",
        code: "ner_zero_from_long_body",
        severity: "error",
        detail: `bodyChars=${input.bodyChars}`,
      });
    }

    // 2. ner_relation_endpoint_missing
    const names = new Set(input.entities.map((e) => e.name));
    let endpointMissing = 0;
    for (const r of input.relations) {
      if (r.from && !names.has(r.from)) endpointMissing++;
      if (r.to && !names.has(r.to)) endpointMissing++;
    }
    if (endpointMissing > 0) {
      obs.push({
        surface: "ner",
        code: "ner_relation_endpoint_missing",
        severity: "warning",
        detail: `${endpointMissing} endpoints not in extracted entities`,
      });
    }

    // 3. ner_extraction_unusually_high (conservative: max(30, floor(bodyChars/80)))
    const highThreshold = Math.max(
      HIGH_ENTITY_THRESHOLD_FLOOR,
      Math.floor(input.bodyChars / HIGH_ENTITY_THRESHOLD_DIVISOR),
    );
    if (input.entityCount > highThreshold) {
      obs.push({
        surface: "ner",
        code: "ner_extraction_unusually_high",
        severity: "warning",
        detail: `${input.entityCount} > ${highThreshold} (bodyChars=${input.bodyChars})`,
      });
    }

    // 4. ner_duplicate_name_conflicting_type
    const nameTypes = new Map<string, Set<string>>();
    for (const e of input.entities) {
      const set = nameTypes.get(e.name) ?? new Set<string>();
      set.add(e.type);
      nameTypes.set(e.name, set);
    }
    let dupConflicts = 0;
    for (const types of nameTypes.values()) {
      if (types.size > 1) dupConflicts++;
    }
    if (dupConflicts > 0) {
      obs.push({
        surface: "ner",
        code: "ner_duplicate_name_conflicting_type",
        severity: "warning",
        detail: `${dupConflicts} names with conflicting types`,
      });
    }

    // 5. ner_invalid_entity_field
    let invalidFields = 0;
    for (const e of input.entities) {
      if (!e.name || !e.name.trim() || !e.type || !e.type.trim()) invalidFields++;
    }
    if (invalidFields > 0) {
      obs.push({
        surface: "ner",
        code: "ner_invalid_entity_field",
        severity: "warning",
        detail: `${invalidFields} entities with empty name/type`,
      });
    }

    // 6. ner_invalid_event_date
    let badDates = 0;
    for (const ev of input.events) {
      if (ev.date && ev.date.trim() && !isValidDate(ev.date)) badDates++;
    }
    if (badDates > 0) {
      obs.push({
        surface: "ner",
        code: "ner_invalid_event_date",
        severity: "info",
        detail: `${badDates} events with malformed date`,
      });
    }

    return obs;
  }

  export function summarizeShadowVerifierObservations(
    surface: VerifierSurface,
    observations: ShadowVerifierObservation[],
    type?: string,
  ): ShadowVerifierSummary {
    const counts = { info: 0, warning: 0, error: 0 };
    const reasonCounts: Record<string, number> = {};
    for (const o of observations) {
      counts[o.severity]++;
      reasonCounts[o.code] = (reasonCounts[o.code] ?? 0) + 1;
    }
    const worst: VerifierSeverity | "none" =
      counts.error > 0 ? "error" : counts.warning > 0 ? "warning" : counts.info > 0 ? "info" : "none";
    const checks = surface === "ner" ? NER_CHECK_COUNT : DISCOVERY_CHECK_COUNT;
    return { surface, type, checks, counts, reasonCounts, worst };
  }

  // Fail-open runners defined in Task 4/5 — placeholder stubs removed once those tasks land.
  ```

  > Note: Task 1's file deliberately has **zero external imports** — the NER pure functions need none. Tasks 2/4/5 add imports (`DISPLAY_UNSAFE_PATTERNS` in Task 2; `CBrainDB`/`Logger`/`ExtractionResult`/`sanitizeForLog` in Task 4) at the top of the file as the code that uses them lands. This keeps every intermediate commit lint-clean.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `bun test tests/core/shadow-verifier.test.ts`
  Expected: PASS — all NER + summarize tests green.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/quality/shadow-verifier.ts tests/core/shadow-verifier.test.ts
  git commit -m "feat(quality): pure NER shadow verifier checks (#265)"
  ```

---

## Task 2: Discovery verifier + export DISPLAY_UNSAFE_PATTERNS

**Files:**
- Modify: `src/core/maintenance/action-candidates.ts` (export const — semantics unchanged)
- Modify: `src/core/quality/shadow-verifier.ts` (add `verifyDiscoveryCandidate`)
- Modify: `tests/core/shadow-verifier.test.ts` (add discovery tests)

- [ ] **Step 1: Export DISPLAY_UNSAFE_PATTERNS (semantics unchanged)**

  In `src/core/maintenance/action-candidates.ts`, change only the declaration keyword:

  ```ts
  // FROM:
  const DISPLAY_UNSAFE_PATTERNS = [
  // TO:
  export const DISPLAY_UNSAFE_PATTERNS = [
  ```

  **Do not touch the pattern array contents, order, or `assertSafeActionDisplay`.** This is the entire change to this file in Step 1.

- [ ] **Step 2: Add failing discovery tests**

  Append to `tests/core/shadow-verifier.test.ts` (inside a new `describe`):

  ```ts
  import {
    verifyDiscoveryCandidate,
    type DiscoveryVerifierInput,
  } from "../../src/core/quality/shadow-verifier.js";

  function discInput(over: Partial<DiscoveryVerifierInput> = {}): DiscoveryVerifierInput {
    return {
      type: "bridge",
      actionable: "medium",
      score: 0.5,
      autoApplicable: false,
      hasEvidence: false,
      hasProposedActions: false,
      displayTexts: [],
      ...over,
    };
  }

  describe("verifyDiscoveryCandidate", () => {
    test("high actionable with no evidence and no proposed actions → error", () => {
      const obs = verifyDiscoveryCandidate(discInput({
        type: "contradiction", actionable: "high", score: 0.9,
        hasEvidence: false, hasProposedActions: false,
      }));
      const e = obs.find((o) => o.code === "discovery_high_actionable_no_evidence");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("error");
    });

    test("high actionable WITH evidence → NOT flagged", () => {
      const obs = verifyDiscoveryCandidate(discInput({
        actionable: "high", hasEvidence: true, hasProposedActions: false,
      }));
      expect(obs.some((o) => o.code === "discovery_high_actionable_no_evidence")).toBe(false);
    });

    test("auto_applicable on action_ type → error", () => {
      const obs = verifyDiscoveryCandidate(discInput({
        type: "action_review_discovery", autoApplicable: true,
      }));
      const e = obs.find((o) => o.code === "discovery_auto_applicable_on_review_type");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("error");
    });

    test("score out of [0,1] → warning", () => {
      const obs = verifyDiscoveryCandidate(discInput({ score: 1.5 }));
      expect(obs.some((o) => o.code === "discovery_score_out_of_range")).toBe(true);
    });

    test("unknown actionable value → warning", () => {
      const obs = verifyDiscoveryCandidate(discInput({ actionable: "urgent" }));
      expect(obs.some((o) => o.code === "discovery_score_out_of_range")).toBe(true);
    });

    test("action_ type with all-empty display texts → warning discovery_display_missing_fields", () => {
      const obs = verifyDiscoveryCandidate(discInput({
        type: "action_health_review", displayTexts: ["", "  ", ""],
      }));
      expect(obs.some((o) => o.code === "discovery_display_missing_fields")).toBe(true);
    });

    test("display text containing /Users/ path → warning discovery_display_private_raw", () => {
      const obs = verifyDiscoveryCandidate(discInput({
        type: "action_review_discovery",
        displayTexts: ["正常标题", "详情见 /Users/secret/note.md"],
      }));
      const e = obs.find((o) => o.code === "discovery_display_private_raw");
      expect(e).toBeDefined();
      expect(e!.severity).toBe("warning");
    });

    test("metadata-style internal refs in displayTexts are NOT flagged when not user-visible", () => {
      // displayTexts is empty → nothing to scan; internal entity/ refs live elsewhere.
      const obs = verifyDiscoveryCandidate(discInput({ displayTexts: [] }));
      expect(obs.some((o) => o.code === "discovery_display_private_raw")).toBe(false);
    });

    test("normal discovery draft → no warning/error observations", () => {
      const obs = verifyDiscoveryCandidate(discInput({
        type: "action_review_discovery",
        actionable: "high",
        score: 0.8,
        hasEvidence: true,
        hasProposedActions: true,
        displayTexts: ["有一条发现值得复核", "建议人工确认", "打开对应发现确认"],
      }));
      expect(obs.filter((o) => o.severity === "warning" || o.severity === "error")).toEqual([]);
    });

    test("summary carries discovery type and check count 5", () => {
      const obs = verifyDiscoveryCandidate(discInput({ type: "similar_entity", score: 2 }));
      const summary = summarizeShadowVerifierObservations("discovery", obs, "similar_entity");
      expect(summary.surface).toBe("discovery");
      expect(summary.type).toBe("similar_entity");
      expect(summary.checks).toBe(5);
      expect(summary.worst).toBe("warning");
    });
  });
  ```

  Also update the top-of-file import block to include `verifyDiscoveryCandidate` and `DiscoveryVerifierInput`.

- [ ] **Step 3: Run tests to verify they fail**

  Run: `bun test tests/core/shadow-verifier.test.ts`
  Expected: FAIL — `verifyDiscoveryCandidate` is not exported.

- [ ] **Step 4: Implement verifyDiscoveryCandidate**

  First add the import at the top of `src/core/quality/shadow-verifier.ts` (this is the first external import the file takes):

  ```ts
  import { DISPLAY_UNSAFE_PATTERNS } from "../maintenance/action-candidates.js";
  ```

  Then append the function (before the runner section):

  ```ts
  export function verifyDiscoveryCandidate(input: DiscoveryVerifierInput): ShadowVerifierObservation[] {
    const obs: ShadowVerifierObservation[] = [];
    const isActionType = input.type.startsWith("action_");

    // 1. discovery_high_actionable_no_evidence
    if (input.actionable === "high" && !input.hasEvidence && !input.hasProposedActions) {
      obs.push({
        surface: "discovery",
        code: "discovery_high_actionable_no_evidence",
        severity: "error",
        detail: `type=${input.type}`,
      });
    }

    // 2. discovery_auto_applicable_on_review_type
    if (input.autoApplicable && isActionType) {
      obs.push({
        surface: "discovery",
        code: "discovery_auto_applicable_on_review_type",
        severity: "error",
        detail: `type=${input.type}`,
      });
    }

    // 3. discovery_score_out_of_range (covers score AND unknown actionable)
    const knownActionable =
      input.actionable === "high" || input.actionable === "medium" || input.actionable === "low";
    if (input.score < 0 || input.score > 1 || !knownActionable) {
      obs.push({
        surface: "discovery",
        code: "discovery_score_out_of_range",
        severity: "warning",
        detail: `score=${input.score} actionable=${input.actionable}`,
      });
    }

    // 4. discovery_display_missing_fields
    if (isActionType && input.displayTexts.every((t) => !t || !t.trim())) {
      obs.push({
        surface: "discovery",
        code: "discovery_display_missing_fields",
        severity: "warning",
        detail: `type=${input.type}`,
      });
    }

    // 5. discovery_display_private_raw — user-visible texts only
    let unsafeHits = 0;
    for (const text of input.displayTexts) {
      if (!text) continue;
      for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
        if (pattern.test(text)) unsafeHits++;
      }
    }
    if (unsafeHits > 0) {
      obs.push({
        surface: "discovery",
        code: "discovery_display_private_raw",
        severity: "warning",
        detail: `${unsafeHits} unsafe display matches`,
      });
    }

    return obs;
  }
  ```

- [ ] **Step 5: Run tests to verify they pass**

  Run: `bun test tests/core/shadow-verifier.test.ts`
  Expected: PASS — all NER + discovery + summarize tests green.

- [ ] **Step 6: Prove #267 regression-free**

  Run: `bun test tests/core/action-candidates.test.ts` (or whichever file covers `#267`; if unsure, run `bun test | grep -i action`).
  Expected: PASS — exporting the const changed nothing about behavior. If any `#267` test breaks, **stop**: the export was not pure-export. Re-read Step 1.

- [ ] **Step 7: Commit**

  ```bash
  git add src/core/maintenance/action-candidates.ts src/core/quality/shadow-verifier.ts tests/core/shadow-verifier.test.ts
  git commit -m "feat(quality): discovery shadow verifier + export display patterns (#265)"
  ```

---

## Task 3: DB reader getRecentVerifierCounts

**Files:**
- Modify: `src/storage/sqlite.ts` (add reader next to `getRecentNerErrorCount`, ~line 2361)
- Create: `tests/core/shadow-verifier-integration.test.ts` (DB section)

- [ ] **Step 1: Write the failing test**

  Create `tests/core/shadow-verifier-integration.test.ts`:

  ```ts
  import { describe, test, expect, beforeEach, afterEach } from "bun:test";
  import { existsSync, rmSync, mkdirSync } from "node:fs";
  import { join } from "node:path";
  import { CBrainDB } from "../../src/storage/sqlite.js";

  describe("CBrainDB.getRecentVerifierCounts", () => {
    const testDir = "/tmp/cbrain-test-verifier-db";
    const dbPath = join(testDir, "test.sqlite");
    let db: CBrainDB;

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      db = new CBrainDB(dbPath);
    });

    afterEach(() => {
      db.close();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    test("aggregates ner/discovery warning+error counts and reason codes", () => {
      db.addIngestLog("verifier", "ner_shadow_verifier", "records/source-1", JSON.stringify({
        surface: "ner", checks: 6,
        counts: { info: 0, warning: 1, error: 1 },
        reasonCounts: { ner_zero_from_long_body: 1, ner_invalid_event_date: 1 },
        worst: "error",
      }));
      db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify({
        surface: "discovery", type: "action_review_discovery", checks: 5,
        counts: { info: 0, warning: 2, error: 0 },
        reasonCounts: { discovery_display_private_raw: 2 },
        worst: "warning",
      }));

      const counts = db.getRecentVerifierCounts(24);
      expect(counts.ner).toEqual({ warning: 1, error: 1 });
      expect(counts.discovery).toEqual({ warning: 2, error: 0 });
      expect(counts.byCode).toEqual({
        ner_zero_from_long_body: 1,
        ner_invalid_event_date: 1,
        discovery_display_private_raw: 2,
      });
    });

    test("ignores non-verifier ingest_log rows", () => {
      db.addIngestLog("vault", "sync", "records/source-1", JSON.stringify({ nerError: true }));
      db.addIngestLog("api", "ingest", "records/source-2", "{}");
      const counts = db.getRecentVerifierCounts(24);
      expect(counts.ner).toEqual({ warning: 0, error: 0 });
      expect(counts.discovery).toEqual({ warning: 0, error: 0 });
      expect(counts.byCode).toEqual({});
    });

    test("respects the hour window", () => {
      db.addIngestLog("verifier", "ner_shadow_verifier", "x", JSON.stringify({
        surface: "ner", checks: 6, counts: { info: 0, warning: 1, error: 0 },
        reasonCounts: { ner_invalid_event_date: 1 }, worst: "warning",
      }));
      db.rawDb
        .prepare("UPDATE ingest_log SET created_at = datetime('now', '-48 hours')")
        .run();
      const counts = db.getRecentVerifierCounts(24);
      expect(counts.ner).toEqual({ warning: 0, error: 0 });
    });

    test("malformed details are skipped, not thrown", () => {
      db.addIngestLog("verifier", "ner_shadow_verifier", "x", "not-json");
      db.addIngestLog("verifier", "ner_shadow_verifier", "y", null as unknown as string);
      expect(() => db.getRecentVerifierCounts(24)).not.toThrow();
      const counts = db.getRecentVerifierCounts(24);
      expect(counts.ner).toEqual({ warning: 0, error: 0 });
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: FAIL — `db.getRecentVerifierCounts is not a function`.

- [ ] **Step 3: Implement the reader**

  In `src/storage/sqlite.ts`, immediately after `getRecentNerErrorCount` (~line 2361), add:

  ```ts
  getRecentVerifierCounts(hours = 24): {
    ner: { warning: number; error: number };
    discovery: { warning: number; error: number };
    byCode: Record<string, number>;
  } {
    const rows = this.prepare(
      "SELECT action, details FROM ingest_log WHERE source_type = $src AND created_at > datetime('now', '-' || $hours || ' hours')"
    ).all({ $src: "verifier", $hours: hours }) as Array<{ action: string; details: string | null }>;

    const out = {
      ner: { warning: 0, error: 0 },
      discovery: { warning: 0, error: 0 },
      byCode: {} as Record<string, number>,
    };

    for (const row of rows) {
      let summary: { counts?: { warning?: number; error?: number }; reasonCounts?: Record<string, unknown> };
      try {
        summary = row.details ? JSON.parse(row.details) : {};
      } catch {
        continue;
      }
      const bucket =
        row.action === "ner_shadow_verifier" ? out.ner :
        row.action === "discovery_shadow_verifier" ? out.discovery : null;
      if (!bucket) continue;
      bucket.warning += summary.counts?.warning ?? 0;
      bucket.error += summary.counts?.error ?? 0;
      if (summary.reasonCounts) {
        for (const [code, n] of Object.entries(summary.reasonCounts)) {
          if (typeof n === "number") out.byCode[code] = (out.byCode[code] ?? 0) + n;
        }
      }
    }
    return out;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/storage/sqlite.ts tests/core/shadow-verifier-integration.test.ts
  git commit -m "feat(storage): getRecentVerifierCounts reader (#265)"
  ```

---

## Task 4: NER hook + fail-open runner + env kill switch

**Files:**
- Modify: `src/core/quality/shadow-verifier.ts` (add runner)
- Modify: `src/core/ingestion/pipeline.ts` (wire hook in `processNer`)
- Modify: `tests/core/shadow-verifier-integration.test.ts` (add NER integration tests)

- [ ] **Step 1: Write the failing integration tests**

  Append to `tests/core/shadow-verifier-integration.test.ts`:

  ```ts
  import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
  import type { ExtractionResult } from "../../src/core/ingestion/ner.js";

  describe("ContentPipeline NER shadow verifier hook", () => {
    const testDir = "/tmp/cbrain-test-verifier-ner";
    const dbPath = join(testDir, "test.sqlite");
    let db: CBrainDB;

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      db = new CBrainDB(dbPath);
      process.env.CBRAIN_SHADOW_VERIFIER_DISABLE = ""; // ensure enabled
    });

    afterEach(() => {
      db.close();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    const stubEmbedding = {
      embedBatch: async (t: string[]) => t.map(() => ({ embedding: [0, 0], tokenCount: 1 })),
      embedQuery: async () => ({ embedding: [0, 0], tokenCount: 1 }),
    } as any;
    const stubLance = {
      deleteRawChunksByPageSlug: async () => {},
      deleteL1VectorByPageSlug: async () => {},
      addChunks: async () => {},
    } as any;
    const insertPage = (slug: string, title: string, type: string) => {
      db.rawDb
        .prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(slug, type, title, `${slug.replace("/", "-")}.md`, "h1", 0, 3);
    };
    const stubPages = {
      create: (input: { title: string }) => {
        const slug = `stub/${input.title}`;
        insertPage(slug, input.title, "entity/person");
        return { slug };
      },
      getBySlug: () => null,
      update: () => {},
      incrementMention: () => {},
      updateType: () => {},
    } as any;

    function verifierRows() {
      return db.rawDb
        .prepare("SELECT action, page_slug, details FROM ingest_log WHERE source_type = 'verifier'")
        .all() as Array<{ action: string; page_slug: string | null; details: string | null }>;
    }

    test("long body zero extraction writes ner_shadow_verifier error row before early-return", async () => {
      insertPage("records/source-1", "Source", "record");
      const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
        pages: stubPages,
        nerEngine: {} as any,
      });
      const longBody = "正文".repeat(300); // 600 chars
      const extraction: ExtractionResult = {
        entities: [], relations: [], events: [], facts: [], filtered: [],
      };

      await pipeline.processNer("records/source-1", longBody, "record", true, extraction);

      const rows = verifierRows();
      expect(rows.length).toBe(1);
      expect(rows[0].action).toBe("ner_shadow_verifier");
      expect(rows[0].page_slug).toBe("records/source-1");
      const summary = JSON.parse(rows[0].details!);
      expect(summary.counts.error).toBe(1);
      expect(summary.reasonCounts.ner_zero_from_long_body).toBe(1);
      expect(summary.worst).toBe("error");
    });

    test("normal extraction writes a ner_shadow_verifier row with zero warning/error", async () => {
      insertPage("records/source-1", "Source", "record");
      const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
        pages: stubPages, nerEngine: {} as any,
      });
      const extraction: ExtractionResult = {
        entities: [{ name: "实体A", type: "company", relevance: "high", context: "" }],
        relations: [], events: [], facts: [], filtered: [],
      };

      await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);

      const rows = verifierRows();
      expect(rows.length).toBe(1);
      const summary = JSON.parse(rows[0].details!);
      expect(summary.counts.warning).toBe(0);
      expect(summary.counts.error).toBe(0);
      expect(summary.worst).toBe("none");
    });

    test("details never leak raw entity names / slug / body", async () => {
      insertPage("records/source-1", "Source", "record");
      const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
        pages: stubPages, nerEngine: {} as any,
      });
      const extraction: ExtractionResult = {
        entities: [
          { name: "实体A", type: "company", relevance: "high", context: "" },
          { name: "实体A", type: "person", relevance: "high", context: "" }, // dup conflict → warning
        ],
        relations: [{ from: "实体A", to: "孤儿B", relation: "提及", context: "" }],
        events: [], facts: [], filtered: [],
      };

      await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);

      const dump = JSON.stringify(verifierRows());
      // page_slug legitimately holds the source slug (ingest_log audit semantic) —
      // but the DETAILS json must not echo raw entity names.
      for (const forbidden of ["实体A", "孤儿B"]) {
        // details only:
        const detailsJson = JSON.parse(verifierRows()[0].details!);
        expect(JSON.stringify(detailsJson)).not.toContain(forbidden);
      }
      // reason codes are stable identifiers, not raw content
      const summary = JSON.parse(verifierRows()[0].details!);
      expect(summary.reasonCounts).toEqual({
        ner_relation_endpoint_missing: 1,
        ner_duplicate_name_conflicting_type: 1,
      });
    });

    test("verifier throw is fail-open: NER still succeeds, sanitized warn logged", async () => {
      insertPage("records/source-1", "Source", "record");
      const warnCalls: unknown[] = [];
      const captureLogger = {
        warn: (_m: string, _msg: string, ctx?: unknown) => warnCalls.push(ctx),
        info: () => {}, error: () => {}, debug: () => {},
      } as any;
      const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
        pages: stubPages, nerEngine: {} as any, logger: captureLogger,
      });
      // Force verifier failure by corrupting addIngestLog with a leaky message.
      const leaky = "boom at /Users/secret/x.sqlite entity=实体A slug=records/source-1";
      (db as any).addIngestLog = () => { throw new Error(leaky); };

      const extraction: ExtractionResult = {
        entities: [{ name: "实体A", type: "company", relevance: "high", context: "" }],
        relations: [], events: [], facts: [], filtered: [],
      };
      const result = await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);

      expect(result).not.toBeNull();      // NER still completed
      expect(result!.entities).toBe(1);   // entity written
      expect(warnCalls.length).toBe(1);
      const ctx = JSON.stringify(warnCalls[0]);
      expect(ctx).not.toContain("实体A");
      expect(ctx).not.toContain("/Users/secret/x.sqlite");
      expect(ctx).not.toContain("records/source-1");
    });

    test("CBRAIN_SHADOW_VERIFIER_DISABLE=1 writes no verifier rows", async () => {
      process.env.CBRAIN_SHADOW_VERIFIER_DISABLE = "1";
      insertPage("records/source-1", "Source", "record");
      const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
        pages: stubPages, nerEngine: {} as any,
      });
      const extraction: ExtractionResult = {
        entities: [], relations: [], events: [], facts: [], filtered: [],
      };
      await pipeline.processNer("records/source-1", "正文".repeat(300), "record", true, extraction);
      expect(verifierRows().length).toBe(0);
    });
  });
  ```

  > Env kill switch caveat: `CBRAIN_SHADOW_VERIFIER_DISABLE` is read once at module load (cached). Tests that toggle it in-process must be grouped so the module under test re-evaluates — see Step 4 implementation note. If module-level caching makes in-process toggling flaky, read the env each call instead (cheap), which is what Step 4 specifies.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: FAIL — no verifier rows written (hook not wired).

- [ ] **Step 3: Add the fail-open runner + env switch**

  First add these imports at the top of `src/core/quality/shadow-verifier.ts` (alongside the `DISPLAY_UNSAFE_PATTERNS` import added in Task 2):

  ```ts
  import type { CBrainDB } from "../../storage/sqlite.js";
  import type { Logger } from "../logger.js";
  import type { ExtractionResult } from "../ingestion/ner.js";
  import { sanitizeForLog } from "../safety/sync-index-safety.js";
  ```

  Then append to `src/core/quality/shadow-verifier.ts`:

  ```ts
  function isVerifierDisabled(): boolean {
    return process.env.CBRAIN_SHADOW_VERIFIER_DISABLE === "1";
  }

  /** Redact raw extraction tokens (entity names / slug / relation endpoints) from an error message. */
  function sanitizeVerifierError(
    rawMessage: string,
    slug: string | null,
    extraction?: ExtractionResult,
    displayTexts?: string[],
  ): string {
    let safe = sanitizeForLog(rawMessage);
    const tokens = new Set<string>();
    if (slug) tokens.add(slug);
    if (extraction) {
      for (const e of extraction.entities) tokens.add(e.name);
      for (const f of extraction.filtered ?? []) tokens.add(f.name);
      for (const r of extraction.relations) { tokens.add(r.from); tokens.add(r.to); }
    }
    if (displayTexts) for (const t of displayTexts) { if (t && t.length >= 2) tokens.add(t); }
    for (const token of tokens) {
      if (token && token.length >= 2) safe = safe.split(token).join("<redacted>");
    }
    return safe;
  }

  export function runNerShadowVerifierFailOpen(opts: {
    db: CBrainDB;
    logger?: Logger | null;
    slug: string;
    bodyChars: number;
    extraction: ExtractionResult;
  }): void {
    if (isVerifierDisabled()) return;
    try {
      const input: NerVerifierInput = {
        bodyChars: opts.bodyChars,
        entityCount: opts.extraction.entities.length,
        relationCount: opts.extraction.relations.length,
        eventCount: opts.extraction.events.length,
        factCount: opts.extraction.facts.length,
        entities: opts.extraction.entities.map((e) => ({ name: e.name, type: e.type })),
        relations: opts.extraction.relations.map((r) => ({ from: r.from, to: r.to })),
        events: opts.extraction.events.map((e) => ({ date: e.date })),
      };
      const observations = verifyNerExtraction(input);
      const summary = summarizeShadowVerifierObservations("ner", observations);
      opts.db.addIngestLog("verifier", "ner_shadow_verifier", opts.slug, JSON.stringify(summary));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeVerifierError(raw, opts.slug, opts.extraction);
      opts.logger?.warn("pipeline", "ner shadow verifier failed (fail-open, ignored)", { error: safe });
    }
  }
  ```

- [ ] **Step 4: Wire the hook in ContentPipeline.processNer**

  In `src/core/ingestion/pipeline.ts`:

  1. Add import at the top (next to the `ner.js` import):
     ```ts
     import { runNerShadowVerifierFailOpen } from "../quality/shadow-verifier.js";
     ```
  2. In `processNer` (around line 264), change:
     ```ts
     // FROM:
     const extraction = precomputed ?? await this.nerEngine.extract(body);
     if (extraction.entities.length === 0 && extraction.relations.length === 0) {
       return null;
     }

     return this.applyExtraction(fromSlug, extraction, skipDatelessEvents, skipMentionSlugs);

     // TO:
     const extraction = precomputed ?? await this.nerEngine.extract(body);
     // #265: shadow verifier runs BEFORE the empty-extraction early-return so that
     // a long body producing zero extraction is flagged. Fail-open by construction.
     runNerShadowVerifierFailOpen({
       db: this.db,
       logger: this.logger,
       slug: fromSlug,
       bodyChars: body.trim().length,
       extraction,
     });
     if (extraction.entities.length === 0 && extraction.relations.length === 0) {
       return null;
     }

     return this.applyExtraction(fromSlug, extraction, skipDatelessEvents, skipMentionSlugs);
     ```

- [ ] **Step 5: Run tests to verify they pass**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: PASS — all NER hook tests green.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/quality/shadow-verifier.ts src/core/ingestion/pipeline.ts tests/core/shadow-verifier-integration.test.ts
  git commit -m "feat(quality): wire NER shadow verifier hook with fail-open (#265)"
  ```

---

## Task 5: Discovery hooks (all three upsert sites)

**Files:**
- Modify: `src/core/quality/shadow-verifier.ts` (add discovery runner)
- Modify: `src/core/maintenance/discovery.ts` (two sites)
- Modify: `src/core/maintenance/action-candidates.ts` (`persistDrafts` site)
- Modify: `tests/core/shadow-verifier-integration.test.ts` (discovery integration tests)

- [ ] **Step 1: Write the failing integration tests**

  Append to `tests/core/shadow-verifier-integration.test.ts`:

  ```ts
  import { ActionCandidateManager } from "../../src/core/maintenance/action-candidates.js";
  import { DiscoveryManager } from "../../src/core/maintenance/discovery.js";

  describe("Discovery shadow verifier hooks", () => {
    const testDir = "/tmp/cbrain-test-verifier-disc";
    const dbPath = join(testDir, "test.sqlite");
    let db: CBrainDB;

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      db = new CBrainDB(dbPath);
      process.env.CBRAIN_SHADOW_VERIFIER_DISABLE = "";
    });

    afterEach(() => {
      db.close();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    function verifierRows() {
      return db.rawDb
        .prepare("SELECT action, page_slug, details FROM ingest_log WHERE source_type = 'verifier'")
        .all() as Array<{ action: string; page_slug: string | null; details: string | null }>;
    }

    test("persistDrafts writes a discovery_shadow_verifier row per draft; page_slug is null", () => {
      const mgr = new ActionCandidateManager(db);
      // A clean draft → 1 row, zero warning/error.
      mgr.persistDrafts([{
        type: "action_health_review",
        entities: ["health:test:scope"],
        score: 0.6,
        actionable: "medium",
        displayTitle: "有一项健康问题需要人工确认",
        displayReason: "这项信号可能影响知识质量",
        suggestedAction: "人工确认后再决定",
        evidence: [{ source: "health", ref: "health:test:scope", kind: "test" }],
        proposedActions: [{ type: "review", target: "health:test:scope", reason: "复核" }],
        metadata: {},
      }]);

      const rows = verifierRows().filter((r) => r.action === "discovery_shadow_verifier");
      expect(rows.length).toBe(1);
      expect(rows[0].page_slug).toBeNull();
      const summary = JSON.parse(rows[0].details!);
      expect(summary.counts.warning).toBe(0);
      expect(summary.counts.error).toBe(0);
      expect(summary.type).toBe("action_health_review");
    });

    test("unsafe display text in draft is flagged via discovery_display_private_raw", () => {
      const mgr = new ActionCandidateManager(db);
      mgr.persistDrafts([{
        type: "action_review_discovery",
        entities: ["discovery:1"],
        score: 0.8,
        actionable: "high",
        displayTitle: "正常标题",
        displayReason: "详情 /Users/secret/note.md",
        suggestedAction: "复核",
        evidence: [{ source: "discovery", ref: "discovery:1", kind: "x" }],
        proposedActions: [{ type: "review", target: "discovery:1", reason: "r" }],
        metadata: {},
      }]);
      const summary = JSON.parse(verifierRows()[0].details!);
      expect(summary.reasonCounts.discovery_display_private_raw).toBe(1);
      expect(summary.worst).toBe("warning");
    });

    test("verifier details never leak entity refs / dedup_key / display text", () => {
      const mgr = new ActionCandidateManager(db);
      mgr.persistDrafts([{
        type: "action_health_review",
        entities: ["health:dim:k:records/sensitive-slug"],
        score: 0.6,
        actionable: "medium",
        displayTitle: "敏感标题实体Z",
        displayReason: "理由",
        suggestedAction: "动作",
        evidence: [{ source: "health", ref: "health:dim:k:records/sensitive-slug", kind: "k" }],
        proposedActions: [{ type: "review", target: "health:dim:k:records/sensitive-slug", reason: "r" }],
        metadata: { source_ref: "health:dim:k:records/sensitive-slug" },
      }]);
      const details = verifierRows()[0].details!;
      for (const forbidden of ["records/sensitive-slug", "敏感标题实体Z", "health:dim:k:records/sensitive-slug"]) {
        expect(details).not.toContain(forbidden);
      }
    });

    test("verifier throw inside discovery path is fail-open: candidate still persisted", () => {
      const leaky = "boom entity=实体A /Users/secret";
      (db as any).addIngestLog = () => { throw new Error(leaky); };
      const warnCalls: unknown[] = [];
      const mgr = new ActionCandidateManager(db, {
        warn: (_m: string, _s: string, ctx?: unknown) => warnCalls.push(ctx),
        info: () => {}, error: () => {}, debug: () => {},
      } as any);
      // persistDrafts must not throw even though verifier logging throws.
      const report = mgr.persistDrafts([{
        type: "action_health_review",
        entities: ["health:x:y"],
        score: 0.6, actionable: "medium",
        displayTitle: "标题", displayReason: "理由", suggestedAction: "动作",
        evidence: [{ source: "health", ref: "health:x:y", kind: "k" }],
        proposedActions: [{ type: "review", target: "health:x:y", reason: "r" }],
        metadata: {},
      }]);
      expect(report.total).toBe(1);
    });

    test("DiscoveryManager.runDiscovery gap path writes discovery_shadow_verifier rows (page_slug=null)", async () => {
      // Seed a high-mention, zero-link entity page → deterministic gap detector fires
      // (no LLM needed: types=["gap"] skips detectContradictions). This proves the
      // discovery.ts Site B wiring actually invokes the runner.
      db.rawDb
        .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("entity/test-entity", "entity/person", "实体A", "entity-test-entity.md", "h1", 10, 3);
      const mgr = new DiscoveryManager(db, undefined, { warn() {}, info() {}, error() {}, debug() {} } as any);
      await mgr.runDiscovery(["gap"]);
      const discRows = verifierRows().filter((r) => r.action === "discovery_shadow_verifier");
      expect(discRows.length).toBeGreaterThan(0);
      expect(discRows.every((r) => r.page_slug === null)).toBe(true);
      // If this fails because detectGaps did not fire under this seed, adjust the seed
      // (raise mention_count / widen title) rather than deleting the test — the point
      // is to exercise the discovery.ts → runner wiring.
    });
  });
  ```

  > The last test is intentionally a placeholder marker — the *real* assertion that `discovery.ts` calls the runner is structural (Step 4 wiring) plus the privacy/fail-open guarantees already covered via `persistDrafts`. If during implementation you find `runDiscovery` is trivially testable with a seeded DB (no LLM), replace the marker with a real assertion; otherwise leave it and rely on the wiring + adversarial review.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: FAIL — `persistDrafts` writes no verifier rows yet.

- [ ] **Step 3: Add the discovery fail-open runner**

  Append to `src/core/quality/shadow-verifier.ts`:

  ```ts
  export function runDiscoveryShadowVerifierFailOpen(opts: {
    db: CBrainDB;
    logger?: Logger | null;
    input: DiscoveryVerifierInput;
  }): void {
    if (isVerifierDisabled()) return;
    try {
      const observations = verifyDiscoveryCandidate(opts.input);
      const summary = summarizeShadowVerifierObservations("discovery", observations, opts.input.type);
      // page_slug=null: discovery rows have no page affinity; never write dedup_key/slug.
      opts.db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify(summary));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeVerifierError(raw, null, undefined, opts.input.displayTexts);
      opts.logger?.warn("discovery", "discovery shadow verifier failed (fail-open, ignored)", { error: safe });
    }
  }
  ```

  Note `ActionCandidateManager` currently takes only `(db)`. To thread a logger, change its constructor to `(db: CBrainDB, logger?: Logger | null)` and store it. Update the constructor in `action-candidates.ts`.

- [ ] **Step 4: Wire the three upsert sites**

  **Site A — `action-candidates.ts` `persistDrafts`:** Accept a logger in the constructor (`ActionCandidateManager`, ~line 298):

  ```ts
  import { runDiscoveryShadowVerifierFailOpen } from "../quality/shadow-verifier.js";
  import type { Logger } from "../logger.js";

  export class ActionCandidateManager {
    constructor(
      private readonly db: CBrainDB,
      private readonly logger?: Logger | null,
    ) {}

    persistDrafts(drafts: ActionCandidateDraft[]): ActionCandidateReport {
      // ...existing setup...
      for (const draft of drafts) {
        assertSafeActionDisplay(draft.displayTitle);
        assertSafeActionDisplay(draft.displayReason);
        assertSafeActionDisplay(draft.suggestedAction);
        // #265: shadow-verify BEFORE upsert. Fail-open.
        runDiscoveryShadowVerifierFailOpen({
          db: this.db,
          logger: this.logger,
          input: {
            type: draft.type,
            actionable: draft.actionable,
            score: draft.score,
            autoApplicable: false,            // action candidates are never auto-applicable
            hasEvidence: draft.evidence.length > 0,
            hasProposedActions: draft.proposedActions.length > 0,
            displayTexts: [draft.displayTitle, draft.displayReason, draft.suggestedAction],
          },
        });
        const result = this.db.upsertDiscovery(/* ...unchanged args... */);
        // ...rest unchanged...
      }
      // ...
    }
  }
  ```

  The constructor change is backward-compatible: `logger` is optional, so existing `new ActionCandidateManager(db)` call sites keep working unchanged (verifier fail-open simply logs to nowhere when no logger is supplied). Do **not** bulk-update call sites — only thread a logger where one is naturally available and useful. Search `new ActionCandidateManager(` to find them; leave most as-is.

  **Site B — `discovery.ts` `runDiscovery` upsert loop (~line 113):** before the `upsertDiscovery` call inside the `for (const r of deduped)` loop:

  ```ts
  import { runDiscoveryShadowVerifierFailOpen } from "../quality/shadow-verifier.js";

  // inside the loop, before const { id, inserted } = this.db.upsertDiscovery(...):
  runDiscoveryShadowVerifierFailOpen({
    db: this.db,
    logger: this.logger,
    input: {
      type: r.type,
      actionable: r.actionable,
      score: r.score,
      autoApplicable: false,
      hasEvidence: false,
      hasProposedActions: false,
      displayTexts: [r.suggestion ?? ""],
    },
  });
  ```

  **Site C — `discovery.ts` `runSimilarEntityDetection` upsert loop (~line 228):** before the `upsertDiscovery` call:

  ```ts
  runDiscoveryShadowVerifierFailOpen({
    db: this.db,
    logger: this.logger,
    input: {
      type: "similar_entity",
      actionable: c.actionable,
      score: c.nameScore,
      autoApplicable: false,
      hasEvidence: false,
      hasProposedActions: false,
      displayTexts: [],
    },
  });
  ```

  `DiscoveryManager` already holds `this.logger`.

- [ ] **Step 5: Run tests to verify they pass**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: PASS.

  Run: `bun test | grep -i "action-candidates\|discovery"` to confirm no regression in `#267`/discovery suites.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/quality/shadow-verifier.ts src/core/maintenance/discovery.ts src/core/maintenance/action-candidates.ts tests/core/shadow-verifier-integration.test.ts
  git commit -m "feat(quality): wire discovery shadow verifier at all upsert sites (#265)"
  ```

---

## Task 6: Health dimension checkVerifierQuality

**Files:**
- Modify: `src/core/maintenance/health.ts` (add dimension + register)
- Modify: `tests/core/shadow-verifier-integration.test.ts` (health tests)

- [ ] **Step 1: Write the failing health tests**

  Append to `tests/core/shadow-verifier-integration.test.ts`:

  ```ts
  import { HealthChecker } from "../../src/core/maintenance/health.js";

  describe("HealthChecker.checkVerifierQuality", () => {
    const testDir = "/tmp/cbrain-test-verifier-health";
    const dbPath = join(testDir, "test.sqlite");
    let db: CBrainDB;
    let checker: HealthChecker;

    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      db = new CBrainDB(dbPath);
      checker = new HealthChecker(db, join(testDir, "outputs"));
    });

    afterEach(() => {
      db.close();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    function findVerifierDim(report: { dimensions: Array<{ name: string; status: string }> }) {
      return report.dimensions.find((d) => d.name === "生成质量影子校验")!;
    }
    function writeNerRow(warning: number, error: number) {
      db.addIngestLog("verifier", "ner_shadow_verifier", "x", JSON.stringify({
        surface: "ner", checks: 6,
        counts: { info: 0, warning, error },
        reasonCounts: error > 0 ? { ner_zero_from_long_body: error } : { ner_invalid_event_date: warning },
        worst: error > 0 ? "error" : "warning",
      }));
    }

    test("clean → pass, no issues", async () => {
      const report = await checker.checkAll();
      const dim = findVerifierDim(report);
      expect(dim.status).toBe("pass");
      expect(dim.issues).toEqual([]);
    });

    test("ner error → dimension fail, issue severity high", async () => {
      writeNerRow(0, 2);
      const report = await checker.checkAll();
      const dim = findVerifierDim(report);
      expect(dim.status).toBe("fail");
      expect(dim.issues.some((i) => i.severity === "high")).toBe(true);
    });

    test("warning only → warn, issue severity medium", async () => {
      writeNerRow(3, 0);
      const report = await checker.checkAll();
      const dim = findVerifierDim(report);
      expect(dim.status).toBe("warn");
      expect(dim.issues.some((i) => i.severity === "medium")).toBe(true);
    });

    test("issue text says '生成质量风险' (not 'data corruption' / '损坏')", async () => {
      writeNerRow(0, 1);
      const report = await checker.checkAll();
      const dim = findVerifierDim(report);
      const text = JSON.stringify(dim);
      expect(text).toContain("生成质量风险");
      expect(text).not.toContain("损坏");
      expect(text).not.toContain("腐坏");
    });

    test("health output contains no raw slugs / entity names / page_slug field name", async () => {
      writeNerRow(0, 1);
      db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify({
        surface: "discovery", type: "action_review_discovery", checks: 5,
        counts: { info: 0, warning: 1, error: 0 },
        reasonCounts: { discovery_display_private_raw: 1 }, worst: "warning",
      }));
      const report = await checker.checkAll();
      const fullMd = checker.writeFullReport(report);
      const { reportPaths: _rp, ...rest } = report;
      const json = JSON.stringify(rest);
      for (const forbidden of ["entity/", "records/", "page_slug", "file_path", "实体A"]) {
        expect(json).not.toContain(forbidden);
        expect(fullMd).not.toContain(forbidden);
      }
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: FAIL — no "生成质量影子校验" dimension.

- [ ] **Step 3: Implement checkVerifierQuality and register it**

  In `src/core/maintenance/health.ts`:

  1. In `checkAll`'s dimensions array (~line 187), add right after `this.checkNerQuality()`:
     ```ts
     this.checkVerifierQuality(),
     ```
  2. Add the method inside `HealthChecker` (right before `checkNerQuality`, ~line 1296):

  ```ts
  private checkVerifierQuality(): HealthDimension {
    const c = this.db.getRecentVerifierCounts(24);
    const nerErr = c.ner.error;
    const nerWarn = c.ner.warning;
    const discErr = c.discovery.error;
    const discWarn = c.discovery.warning;
    const issues: HealthIssue[] = [];

    const topReasons = (prefix: string): string => {
      const entries = Object.entries(c.byCode)
        .filter(([code]) => code.startsWith(prefix))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([code, n]) => `${code}×${n}`);
      return entries.length > 0 ? entries.join(", ") : "无";
    };

    if (nerErr > 0 || nerWarn > 0) {
      issues.push({
        severity: nerErr > 0 ? "high" : "medium",
        slug: "verifier:ner",
        title: `影子校验：最近 24h NER 抽取存在 ${nerErr} 处 error / ${nerWarn} 处 warning 生成质量风险`,
        description: `主要 reason: ${topReasons("ner_")}。详见 ingest_log（source_type=verifier）。`,
        suggestion: "观察 NER 抽取质量趋势（observe-only，未自动调整，不影响已写入记忆）",
      });
    }
    if (discErr > 0 || discWarn > 0) {
      issues.push({
        severity: discErr > 0 ? "high" : "medium",
        slug: "verifier:discovery",
        title: `影子校验：最近 24h Discovery 存在 ${discErr} 处 error / ${discWarn} 处 warning 生成质量风险`,
        description: `主要 reason: ${topReasons("discovery_")}。详见 ingest_log（source_type=verifier）。`,
        suggestion: "观察 Discovery 候选质量趋势（observe-only，未自动调整，不影响已写入发现）",
      });
    }

    const hasError = nerErr > 0 || discErr > 0;
    const hasWarning = nerWarn > 0 || discWarn > 0;
    const status: "pass" | "warn" | "fail" = hasError ? "fail" : hasWarning ? "warn" : "pass";
    return { name: "生成质量影子校验", status, issues };
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  Run: `bun test tests/core/shadow-verifier-integration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/maintenance/health.ts tests/core/shadow-verifier-integration.test.ts
  git commit -m "feat(quality): checkVerifierQuality health dimension (#265)"
  ```

---

## Task 7: Full gate + docs consistency

**Files:** docs (auto-gen tool tables may reference tool count — N/A here, no MCP tool added)

- [ ] **Step 1: Run the full gate**

  Run: `bun run check`
  Expected: `lint` green (source) + `bun test` fully green. Pre-existing test-only type errors are out-of-gate per CLAUDE.md and must not be introduced anew.

- [ ] **Step 2: Fix any gate failures with surgical edits**

  If `tsc` complains about unused imports in `shadow-verifier.ts` (should not — all imports are used by Task 5), do not add suppression comments; remove the import only if genuinely unused.

- [ ] **Step 3: Commit any fixes**

  ```bash
  git add -A
  git commit -m "chore(quality): gate cleanup for #265"
  ```

---

## Task 8: Mandatory adversarial review

**Files:** none (review only — apply fixes if defects found)

- [ ] **Step 1: Run the adversarial review workflow**

  Dispatch a multi-perspective review (or perform inline) over the diff (`git diff main...HEAD`) checking exactly these five dimensions:

  1. **Privacy leakage** — Does any `ingest_log` row with `source_type="verifier"` or any health/dream output contain entity names, slugs, dedup_key, titles, body, prompts, or relation endpoints? Confirm `discovery_*` rows have `page_slug=null`. Confirm `observations[].detail` is never persisted.
  2. **Accidental write blocking** — Can any verifier code path throw in a way that prevents an ingest, NER write, discovery upsert, or action-candidate persist? Trace every `run*ShadowVerifierFailOpen` call site; the surrounding code must not depend on the verifier succeeding.
  3. **Noisy health output** — Does `checkVerifierQuality` push the overall `HealthReport.overallStatus` to `fail` on benign signals? Is the dimension silent (pass, no issues) when there is nothing to report?
  4. **Unbounded cost/latency** — Are all checks O(n) in extraction size with no LLM, no DB reads inside the hot path (NER hook runs per-page on every ingest), and no unbounded loops? Confirm env kill switch short-circuits before any allocation.
  5. **Duplicated quality logic** — Does this re-implement checks already in `ner.ts` (`filterExtractedEntities`, `classifyEntity`) or `action-candidates.ts` (`assertSafeActionDisplay`)? Reuse, don't duplicate. `DISPLAY_UNSAFE_PATTERNS` must be the single source for display-text safety.

- [ ] **Step 2: Triage findings**

  For each confirmed defect: fix with a surgical commit. For each "plausible but unconfirmed" finding: add a regression test that proves the behavior is safe, or fix it.

- [ ] **Step 3: Re-run gate after fixes**

  Run: `bun run check`
  Expected: green.

- [ ] **Step 4: Commit review fixes**

  ```bash
  git add -A
  git commit -m "test(quality): adversarial review fixes for #265"
  ```

---

## Done

When all tasks are complete:
- `bun run check` is green.
- Adversarial review (Task 8) found and fixed (or disproved) defects across all five dimensions.
- Spec acceptance criteria all checked off.
- Commits are on the worktree branch, ready for finishing-a-development-branch (do **not** push or close the issue — that's Hermes' job).
