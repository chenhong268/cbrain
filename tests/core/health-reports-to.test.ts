import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HealthChecker } from "../../src/core/maintenance/health.js";

// Anonymous sentinel slugs only (#233).
const SUB = "entities/sub";
const BOSS = "entities/boss";

describe("HealthChecker reports_to consistency (#233)", () => {
  const testDir = "/tmp/cbrain-test-health-reports-to";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let checker: HealthChecker;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    checker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultPath);

    for (const s of [SUB, BOSS]) {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`,
      ).run(s, s, `entities/${s.split("/").pop()}.md`, `h-${s}`, 0, 3);
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
    }
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function writeVaultWithReportsTo(slug: string, reportsTo: string): void {
    writeFileSync(
      join(vaultPath, `entities/${slug.split("/").pop()}.md`),
      `---\ntitle: "${slug}"\ntype: entity/person\nreports_to: ${reportsTo}\n---\nbody`,
    );
  }

  async function reportsToIssues() {
    const report = await checker.checkAll();
    return report.dimensions
      .flatMap((d) => d.issues)
      .filter((i) => i.description.includes("reports_to") || i.description.includes("图边"));
  }

  test("HIGH 2: frontmatter reports_to with only a superseded edge is reported as missing", async () => {
    writeVaultWithReportsTo(SUB, BOSS);
    // Only a superseded edge exists (lifecycle left it as history)
    db.rawDb.prepare(
      `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
    ).run(SUB, BOSS);

    const issues = await reportsToIssues();
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.description.includes("缺少对应图边"))).toBe(true);
  });

  test("trusted active edge is NOT flagged as missing", async () => {
    writeVaultWithReportsTo(SUB, BOSS);
    db.upsertActiveReportsTo(SUB, BOSS, "agent", 0.95);

    const issues = await reportsToIssues();
    expect(issues.filter((i) => i.description.includes("缺少对应图边"))).toHaveLength(0);
  });

  test("candidate-only edge is also reported as missing current edge", async () => {
    writeVaultWithReportsTo(SUB, BOSS);
    // Only a candidate (weak/NER) edge — not a current authoritative edge
    db.rawDb.prepare(
      `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'candidate', 'ner')`,
    ).run(SUB, BOSS);

    const issues = await reportsToIssues();
    expect(issues.some((i) => i.description.includes("缺少对应图边"))).toBe(true);
  });
});
