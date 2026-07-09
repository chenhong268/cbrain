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
