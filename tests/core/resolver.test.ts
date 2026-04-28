import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResolverChecker } from "../../src/core/resolver.js";

describe("ResolverChecker", () => {
  const testDir = "/tmp/cbrain-test-resolver";
  const skillsDir = join(testDir, "skills");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function writeResolver(content: string) {
    const path = join(skillsDir, "RESOLVER.md");
    writeFileSync(path, content, "utf-8");
    return path;
  }

  function touchSkill(name: string) {
    writeFileSync(join(skillsDir, name), "# Fake skill\n", "utf-8");
  }

  // ─── parsing ────────────────────────────────────────────────

  test("parse extracts all routing rules", () => {
    const resolverPath = writeResolver(`# Test Resolver

## Routing Rules

### Query & Search
- 查询、搜索 → query.md
- 查找 → query.md [default]

### Maintenance
- 同步、体检 → maintain.md
`);

    const checker = new ResolverChecker(resolverPath);
    const rules = checker.parse();

    expect(rules.length).toBe(3);
    expect(rules[0].patterns).toEqual(["查询", "搜索"]);
    expect(rules[0].skill).toBe("query.md");
    expect(rules[0].category).toBe("Query & Search");
    expect(rules[0].flags).toEqual([]);

    expect(rules[1].flags).toEqual(["default"]);

    expect(rules[2].patterns).toEqual(["同步", "体检"]);
    expect(rules[2].skill).toBe("maintain.md");
    expect(rules[2].category).toBe("Maintenance");
  });

  test("parse handles comma-separated patterns", () => {
    const resolverPath = writeResolver(`# Resolver

### Test Category
- 导入, 录入, 记一下, 保存 → ingest.md
`);

    const checker = new ResolverChecker(resolverPath);
    const rules = checker.parse();

    expect(rules[0].patterns).toEqual(["导入", "录入", "记一下", "保存"]);
  });

  test("parse skips non-category headers", () => {
    const resolverPath = writeResolver(`# Resolver

### Skill Inventory
- query.md → query.md

### Resolution Logic
- test → test.md

### Validation
- check → check.md

### Real Category
- 真实 → real.md
`);

    const checker = new ResolverChecker(resolverPath);
    const rules = checker.parse();

    // Should only parse from "Real Category", skip Inventory/Logic/Validation sections
    expect(rules.length).toBe(1);
    expect(rules[0].skill).toBe("real.md");
  });

  // ─── validation ─────────────────────────────────────────────

  test("check passes when all skills are routed and exist", () => {
    touchSkill("query.md");
    touchSkill("ingest.md");
    touchSkill("enrich.md");
    touchSkill("maintain.md");
    touchSkill("dream.md");
    touchSkill("signal-detector.md");
    touchSkill("brain-ops.md");

    const resolverPath = writeResolver(`# Resolver

### Query
- 查询 → query.md

### Ingest
- 导入 → ingest.md

### Enrich
- 补充 → enrich.md

### Maintain
- 同步 → maintain.md

### Dream
- 夜间 → dream.md

### Signal
- 信号 → signal-detector.md

### Ops
- 操作 → brain-ops.md
`);

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    expect(report.valid).toBe(true);
    expect(report.rules).toBe(7);
    expect(report.skillsReferenced.length).toBe(7);
    expect(report.skillsOnDisk.length).toBe(7);
    expect(report.orphans.length).toBe(0);
    expect(report.missingFiles.length).toBe(0);
    expect(report.overlaps.length).toBe(0);
    expect(report.issues.length).toBe(0);
  });

  test("check detects orphan skills", () => {
    touchSkill("query.md");
    touchSkill("orphan.md"); // on disk but not in RESOLVER.md

    const resolverPath = writeResolver(`# Resolver

### Query
- 查询 → query.md
`);

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    expect(report.valid).toBe(false);
    expect(report.orphans).toContain("orphan.md");
    expect(report.issues.some((i) => i.includes("Orphan"))).toBe(true);
  });

  test("check detects missing skill files", () => {
    touchSkill("query.md");
    // missing.md is referenced but not on disk

    const resolverPath = writeResolver(`# Resolver

### Query
- 查询 → query.md
- 搜索 → missing.md
`);

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    expect(report.valid).toBe(false);
    expect(report.missingFiles).toContain("missing.md");
    expect(report.issues.some((i) => i.includes("Missing"))).toBe(true);
  });

  test("check detects overlapping patterns", () => {
    touchSkill("query.md");
    touchSkill("search.md");

    const resolverPath = writeResolver(`# Resolver

### Query
- 搜索 → query.md

### Search
- 搜索 → search.md
`);

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    expect(report.valid).toBe(false);
    expect(report.overlaps.length).toBe(1);
    expect(report.overlaps[0].pattern).toBe("搜索");
    expect(report.overlaps[0].skills).toEqual(["query.md", "search.md"]);
  });

  test("check reports coverage count per category", () => {
    touchSkill("a.md");
    touchSkill("b.md");
    touchSkill("c.md");

    const resolverPath = writeResolver(`# Resolver

### Category A
- 甲 → a.md
- 乙 → a.md

### Category B
- 丙 → b.md

### Category C
- 丁 → c.md
- 戊 → c.md
- 己 → c.md
`);

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    expect(report.coverage.length).toBe(3);
    const catA = report.coverage.find((c) => c.category === "Category A")!;
    const catB = report.coverage.find((c) => c.category === "Category B")!;
    const catC = report.coverage.find((c) => c.category === "Category C")!;
    expect(catA.rules).toBe(2);
    expect(catB.rules).toBe(1);
    expect(catC.rules).toBe(3);
  });

  test("check passes with empty RESOLVER.md (no rules)", () => {
    const resolverPath = writeResolver(`# Empty Resolver

## Routing Rules

`);
    // No skills on disk either

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    expect(report.rules).toBe(0);
    expect(report.valid).toBe(true);
  });
});
