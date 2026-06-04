/**
 * Evidence Summary Tests — #139
 *
 * Unit tests for buildEvidenceSummary() and buildEvidenceFromBatched().
 */
import { describe, test, expect } from "bun:test";
import {
  buildEvidenceSummary,
  buildEvidenceFromBatched,
  EvidenceBoard,
  type EvidenceBoardResult,
  type EvidenceItem,
} from "../../src/core/evidence.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeItem(overrides: Partial<EvidenceItem> & { claim: string }): EvidenceItem {
  return {
    evidence_type: "fact",
    source_type: "link",
    source_slug: "entities/test",
    source_category: "explicit_input",
    trust_state: "trusted",
    confidence: 0.5,
    ...overrides,
  };
}

function makeBoard(overrides: Partial<EvidenceBoardResult> = {}): EvidenceBoardResult {
  return {
    facts: [],
    user_thoughts: [],
    candidates: [],
    gaps: [],
    conflicts: [],
    ...overrides,
  };
}

// ─── buildEvidenceSummary ─────────────────────────────────────

describe("buildEvidenceSummary", () => {
  test("empty board → null", () => {
    expect(buildEvidenceSummary(makeBoard())).toBeNull();
  });

  test("facts only → high confidence", () => {
    const board = makeBoard({
      facts: [
        makeItem({ claim: "fact A", confidence: 0.9 }),
        makeItem({ claim: "fact B", confidence: 0.7 }),
        makeItem({ claim: "fact C", confidence: 0.6 }),
      ],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary).not.toBeNull();
    expect(summary!.confidence).toBe("high");
    expect(summary!.top_facts).toEqual(["fact A", "fact B", "fact C"]);
    expect(summary!.gap_count).toBe(0);
    expect(summary!.conflict_count).toBe(0);
    expect(summary!.total_evidence).toBe(3);
  });

  test("facts + gaps → medium confidence", () => {
    const board = makeBoard({
      facts: [makeItem({ claim: "fact A" }), makeItem({ claim: "fact B" })],
      candidates: [makeItem({ claim: "candidate X", trust_state: "candidate" })],
      gaps: ["candidate X"],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary!.confidence).toBe("medium");
    expect(summary!.gap_count).toBe(1);
    expect(summary!.total_evidence).toBe(3);
  });

  test("facts + conflicts → medium confidence", () => {
    const board = makeBoard({
      facts: [makeItem({ claim: "fact A" }), makeItem({ claim: "fact B" })],
      conflicts: [{ claim: "contradiction", evidence: [makeItem({ claim: "X" }), makeItem({ claim: "Y" })] }],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary!.confidence).toBe("medium");
    expect(summary!.conflict_count).toBe(1);
  });

  test("thoughts only → medium confidence, no top_facts", () => {
    const board = makeBoard({
      user_thoughts: [
        makeItem({ claim: "thought 1", trust_state: "user_thought" }),
        makeItem({ claim: "thought 2", trust_state: "user_thought" }),
      ],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary!.confidence).toBe("medium");
    expect(summary!.top_facts).toEqual([]);
    expect(summary!.total_evidence).toBe(2);
  });

  test("candidates only → low confidence", () => {
    const board = makeBoard({
      candidates: [
        makeItem({ claim: "c1", trust_state: "candidate" }),
        makeItem({ claim: "c2", trust_state: "candidate" }),
        makeItem({ claim: "c3", trust_state: "candidate" }),
      ],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary!.confidence).toBe("low");
    expect(summary!.top_facts).toEqual([]);
    expect(summary!.total_evidence).toBe(3);
  });

  test("fact claim truncated to 80 chars", () => {
    const longClaim = "A".repeat(200);
    const board = makeBoard({
      facts: [makeItem({ claim: longClaim, confidence: 0.9 })],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary!.top_facts[0].length).toBe(83); // 80 + "..."
    expect(summary!.top_facts[0].endsWith("...")).toBe(true);
  });

  test("top facts capped at 5", () => {
    const facts = Array.from({ length: 10 }, (_, i) =>
      makeItem({ claim: `fact ${i}`, confidence: 0.5 })
    );
    const board = makeBoard({ facts });
    const summary = buildEvidenceSummary(board);
    expect(summary!.top_facts.length).toBe(5);
  });

  test("top facts sorted by confidence descending", () => {
    const board = makeBoard({
      facts: [
        makeItem({ claim: "low", confidence: 0.3 }),
        makeItem({ claim: "high", confidence: 0.9 }),
        makeItem({ claim: "mid", confidence: 0.5 }),
      ],
    });
    const summary = buildEvidenceSummary(board);
    expect(summary!.top_facts).toEqual(["high", "mid", "low"]);
  });
});

// ─── buildEvidenceFromBatched ─────────────────────────────────

describe("buildEvidenceFromBatched", () => {
  test("empty maps + empty slugs → empty board", () => {
    const board = buildEvidenceFromBatched(new Map(), new Map(), []);
    expect(board.facts).toEqual([]);
    expect(board.candidates).toEqual([]);
    expect(board.gaps).toEqual([]);
    expect(board.conflicts).toEqual([]);
  });

  test("builds board from pre-fetched link data", () => {
    const linksMap = new Map<string, { outgoing: Array<Record<string, unknown>>; incoming: Array<Record<string, unknown>> }>();
    linksMap.set("entities/a", {
      outgoing: [{
        from_slug: "entities/a",
        to_slug: "entities/b",
        relation: "knows",
        source_type: "wikilink",
        trust_state: "trusted",
        confidence: 0.9,
        context: "A knows B",
        source_page_slug: "entities/a",
        created_at: "2024-01-01",
      }],
      incoming: [],
    });

    const board = buildEvidenceFromBatched(
      linksMap as any,
      new Map(),
      ["entities/a"],
    );
    expect(board.facts.length).toBe(1);
    expect(board.facts[0].claim).toBe("A knows B");
  });

  test("builds board from pre-fetched timeline data", () => {
    const timelineMap = new Map<string, Array<Record<string, unknown>>>();
    timelineMap.set("entities/x", [{
      id: 1,
      event_date: null,
      source: null,
      summary: "Something happened",
      created_at: "2024-01-01",
      trust_state: "user_thought",
      source_page_slug: "entities/x",
    }]);

    const board = buildEvidenceFromBatched(
      new Map(),
      timelineMap as any,
      ["entities/x"],
    );
    expect(board.user_thoughts.length).toBe(1);
    expect(board.user_thoughts[0].claim).toBe("Something happened");
  });
});

// ─── INACTIVE_STATES filtering ────────────────────────────────

describe("EvidenceBoard rejects inactive trust_states", () => {
  test("rejected and superseded items are excluded from facts/candidates", () => {
    const board = new EvidenceBoard({ resolveSlug: () => true });

    // Add trusted items
    board.add(makeItem({ claim: "trusted fact", trust_state: "trusted" }));
    board.add(makeItem({ claim: "user thought", trust_state: "user_thought" }));
    board.add(makeItem({ claim: "candidate fact", trust_state: "candidate" }));

    // Add inactive items — must be filtered out
    board.add(makeItem({ claim: "rejected link", trust_state: "rejected", source_type: "link" }));
    board.add(makeItem({ claim: "superseded chunk", trust_state: "superseded", source_type: "chunk" }));
    board.add(makeItem({ claim: "rejected page", trust_state: "rejected", source_type: "page" }));
    board.add(makeItem({ claim: "superseded timeline", trust_state: "superseded", source_type: "timeline" }));

    const result = board.build();

    // Only 3 active items
    expect(result.facts.length).toBe(1);
    expect(result.user_thoughts.length).toBe(1);
    expect(result.candidates.length).toBe(1);
    expect(result.facts[0].claim).toBe("trusted fact");

    // No rejected/superseded claims anywhere
    const allClaims = [
      ...result.facts,
      ...result.user_thoughts,
      ...result.candidates,
    ].map(i => i.claim);
    expect(allClaims).not.toContain("rejected link");
    expect(allClaims).not.toContain("superseded chunk");
    expect(allClaims).not.toContain("rejected page");
    expect(allClaims).not.toContain("superseded timeline");
  });
});
