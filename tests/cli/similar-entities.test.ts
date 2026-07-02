import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/maintenance/discovery.js";
import { parseScopeFlag } from "../../src/cli/commands/maintenance.js";

describe("CLI similar-entities (dry-run default) (#246)", () => {
  const testDir = "/tmp/cbrain-test-cli-similar";
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

  function seedPage(slug: string, title: string, type = "entity/company"): void {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: slug });
  }

  test("dry-run detection writes nothing to discoveries", async () => {
    // "实体 A 公司" and "实体A公司" normalize to the same string → name_normalized match
    seedPage("entity/a", "实体 A 公司");
    seedPage("entity/b", "实体A公司");
    const mgr = new DiscoveryManager(db);
    const report = await mgr.runSimilarEntityDetection({ dryRun: true });
    expect(report.total).toBe(1);
    expect(report.candidates?.length ?? 0).toBe(1);
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0); // dry-run → nothing persisted
  });

  test("execute persists", async () => {
    seedPage("entity/a", "实体 A 公司");
    seedPage("entity/b", "实体A公司");
    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection(); // execute path (default)
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });

  test("MEDIUM: execute returns inserted candidates (CLI persisted-count contract)", async () => {
    seedPage("entity/a", "实体 A 公司");
    seedPage("entity/b", "实体A公司");
    const mgr = new DiscoveryManager(db);
    const report = await mgr.runSimilarEntityDetection(); // execute
    expect(report.total).toBe(1);
    expect(report.candidates?.length ?? 0).toBe(1); // execute now returns inserted candidates
    // second run: recurring, nothing new inserted
    const report2 = await mgr.runSimilarEntityDetection();
    expect(report2.total).toBe(0);
    expect(report2.candidates?.length ?? 0).toBe(0);
  });
});

describe("parseScopeFlag (#246 CLI scope validation)", () => {
  test("undefined → ok, no scope", () => {
    expect(parseScopeFlag(undefined)).toEqual({ ok: true, scope: undefined });
  });
  test("entity / concept → ok", () => {
    expect(parseScopeFlag("entity")).toEqual({ ok: true, scope: "entity" });
    expect(parseScopeFlag("concept")).toEqual({ ok: true, scope: "concept" });
  });
  test("typo / invalid → rejected with clear error, no auto-correct", () => {
    const r = parseScopeFlag("entitiy");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("--scope must be entity or concept");
    // case-sensitive: "Entity" is invalid (no auto-correct / case-folding)
    expect(parseScopeFlag("Entity").ok).toBe(false);
    expect(parseScopeFlag("entities").ok).toBe(false);
  });
  test("invalid scope does not reach the manager (CLI guard prevents persistence)", () => {
    // The CLI calls parseScopeFlag BEFORE constructing DiscoveryManager. An invalid value
    // is rejected here, so runSimilarEntityDetection is never called. Simulate the guard:
    const invalid = parseScopeFlag("entitiy");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toBe("--scope must be entity or concept");
    // The manager call site is unreachable when ok===false — no DB, no persistence.
    // (A full DB integration test for this is unnecessary: parseScopeFlag is the guard.)
  });
});
