import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PREFLIGHT_CHECKS, getPreflightCheckIds } from "../../bin/check-v2-preflight.js";

const DOCS_DIR = join(import.meta.dir, "..", "..", "docs", "product");

function readDoc(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf-8");
}

describe("getPreflightCheckIds", () => {
  test("returns exactly the ids of DEFAULT_PREFLIGHT_CHECKS, in order", () => {
    expect([...getPreflightCheckIds()]).toEqual(DEFAULT_PREFLIGHT_CHECKS.map((c) => c.id));
  });

  test("is non-empty (guards against an accidental empty list)", () => {
    expect(getPreflightCheckIds().length).toBeGreaterThan(0);
  });
});

const WORD_TO_NUM: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Extract the documented gate count from a sentence like "aggregates seven offline gates". */
function parseDocumentedGateCount(doc: string): number | null {
  const line = doc.split("\n").find((l) => /aggregates\s+\w+\s+offline\s+gates/i.test(l));
  if (!line) return null;
  const match = line.match(/aggregates\s+(\w+)\s+offline\s+gates/i);
  if (!match) return null;
  const token = match[1];
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return WORD_TO_NUM[token.toLowerCase()] ?? null;
}

const IDS = getPreflightCheckIds();

describe("preflight release docs consistency", () => {
  test("release checklist documents the real gate count", () => {
    const checklist = readDoc("v2-rc-release-checklist.md");
    const documented = parseDocumentedGateCount(checklist);
    expect(
      documented,
      `checklist must state how many gates the preflight aggregates (expected ${IDS.length})`,
    ).toBe(IDS.length);
  });

  test("release checklist names every preflight check id", () => {
    const checklist = readDoc("v2-rc-release-checklist.md");
    for (const id of IDS) {
      expect(checklist, `release checklist missing check id ${id}`).toContain(id);
    }
  });

  test("preflight bug audit lists every check id", () => {
    const audit = readDoc("v2-preflight-bug-audit.md");
    for (const id of IDS) {
      expect(audit, `bug audit missing check id ${id}`).toContain(id);
    }
  });
});
