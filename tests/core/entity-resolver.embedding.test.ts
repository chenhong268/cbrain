import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EntityResolver } from "../../src/core/entity-resolver.js";
import type { EntityCandidate } from "../../src/core/entity-resolver.js";
import type { LLMProvider } from "../../src/llm/provider.js";

describe("EntityResolver embedding shortlist (#168 Phase 1)", () => {
  const testDir = "/tmp/cbrain-test-resolver-embed";
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

  function seedEntity(title: string, type: string, slug?: string): string {
    const s = slug ?? `entity/${title.toLowerCase().replace(/\s+/g, "-")}`;
    db.upsertPage({ slug: s, type, title, filePath: `${s}.md`, contentHash: "abc" });
    return s;
  }
  const candidate = (name: string, type: EntityCandidate["type"] = "company"): EntityCandidate =>
    ({ name, type, relevance: "high" });
  function mockLlm(response: string): LLMProvider {
    return { name: "mock", chat: async () => response };
  }

  test("default constructor (no options) preserves current behavior — no embedding used", async () => {
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const resolver = new EntityResolver(db, mockLlm('{"matches":[]}'));
    const results = resolver.resolveAll([candidate("PA")]);
    // PA does not string-match → stub_created (same as today).
    expect(results.get("PA")?.action).toBe("stub_created");
    await resolver.semanticResolve(results, [candidate("PA")]);
    expect(results.get("PA")?.action).toBe("stub_created");
  });
});
