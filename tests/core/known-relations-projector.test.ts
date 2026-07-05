import { describe, expect, test } from "bun:test";
import type { LinkRow } from "../../src/storage/sqlite.js";
import {
  buildKnownRelationsBlock,
  hasKnownRelationsDrift,
  replaceKnownRelationsSection,
} from "../../src/core/graph/known-relations-projector.js";

function link(overrides: Partial<LinkRow>): LinkRow {
  return {
    id: 1,
    from_slug: "entity/source",
    to_slug: "entity/target",
    relation: "提及",
    weight: 1,
    strength: "medium",
    context: null,
    source_type: "agent",
    confidence: 0.9,
    created_at: "2026-01-01T00:00:00.000Z",
    last_validated_at: null,
    effective_weight: 0.9,
    ...overrides,
  };
}

describe("KnownRelationsProjector", () => {
  test("builds deterministic outgoing and incoming projection with duplicates removed", () => {
    const outgoing = [
      link({ id: 1, relation: "协作", to_slug: "entity/b" }),
      link({ id: 2, relation: "提及", to_slug: "entity/a" }),
      link({ id: 3, relation: "协作", to_slug: "entity/b" }),
    ];
    const incoming = [
      link({ id: 4, relation: "关联", from_slug: "entity/c", to_slug: "entity/source" }),
      link({ id: 5, relation: "协作", from_slug: "entity/a", to_slug: "entity/source" }),
    ];

    expect(buildKnownRelationsBlock(outgoing, incoming)).toBe(
      "## Known Relations\n\n" +
      "- 协作 → [[entity/b]]\n" +
      "- 提及 → [[entity/a]]\n" +
      "- ← 关联 from [[entity/c]]\n" +
      "- ← 协作 from [[entity/a]]\n",
    );
  });

  test("excludes candidate reports_to from user-facing projection", () => {
    const outgoing = [
      link({ relation: "reports_to", to_slug: "entity/manager", trust_state: "trusted" }),
      link({ relation: "reports_to", to_slug: "entity/candidate", trust_state: "candidate", source_type: "ner" }),
    ];

    const block = buildKnownRelationsBlock(outgoing, []);

    expect(block).toContain("[[entity/manager]]");
    expect(block).not.toContain("[[entity/candidate]]");
  });

  test("replaces only the managed Known Relations block and preserves user body", () => {
    const body = [
      "用户正文第一段。",
      "",
      "用户正文第二段。",
      "",
      "## Known Relations",
      "",
      "- stale → [[entity/old]]",
      "",
    ].join("\n");
    const next = replaceKnownRelationsSection(body, "## Known Relations\n\n- 提及 → [[entity/new]]\n");

    expect(next).toBe([
      "用户正文第一段。",
      "",
      "用户正文第二段。",
      "",
      "## Known Relations",
      "",
      "- 提及 → [[entity/new]]",
      "",
    ].join("\n"));
  });

  test("detects stale projection drift, not only missing lines", () => {
    const stale = "正文\n\n## Known Relations\n\n- 提及 → [[entity/old]]\n";
    const outgoing = [link({ relation: "提及", to_slug: "entity/new" })];

    expect(hasKnownRelationsDrift(stale, outgoing, [])).toBe(true);
    expect(hasKnownRelationsDrift("正文\n\n## Known Relations\n\n- 提及 → [[entity/new]]\n", outgoing, [])).toBe(false);
  });
});
