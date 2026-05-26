import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { QueryRouter, type RouteResult } from "../../src/core/query-router.js";

function insertPage(db: CBrainDB, slug: string, title: string) {
  db.prepare(
    `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, 'h')`
  ).run(slug, title, `${slug}.md`);
}

describe("QueryRouter", () => {
  const testDir = "/tmp/cbrain-test-query-router";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let router: QueryRouter;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    router = new QueryRouter(db);

    insertPage(db, "entity-a", "实体A");
    insertPage(db, "entity-b", "实体B");
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // ── fast / entity_lookup ─────────────────────────────────

  test("exact title match → fast/entity_lookup", () => {
    const r = router.route("实体A");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });

  test("slug match → fast/entity_lookup", () => {
    const r = router.route("entity-b");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });

  test("single known entity without complex signals → fast", () => {
    const r = router.route("实体A 的信息");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });

  test("empty query → hybrid/keyword", () => {
    const r = router.route("");
    expect(r.mode).toBe("hybrid");
    expect(r.intent).toBe("keyword");
  });

  // ── hybrid / timeline ────────────────────────────────────

  test("temporal keyword without complexity → hybrid/timeline", () => {
    const r = router.route("最近有什么新动态");
    expect(r.mode).toBe("hybrid");
    expect(r.intent).toBe("timeline");
  });

  // ── agentic / relationship ───────────────────────────────

  test("two known entities with conjunction → agentic", () => {
    const r = router.route("实体A 和 实体B 的关系");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("relationship");
  });

  test("long query with 3+ tokens → agentic", () => {
    const r = router.route("主题A 主题B 主题C 的联系");
    expect(r.mode).toBe("agentic");
  });

  // ── agentic / comparison ─────────────────────────────────

  test("comparison keywords → agentic/comparison", () => {
    const r = router.route("实体A 对比 实体B 的区别");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("comparison");
  });

  // ── agentic / review ─────────────────────────────────────

  test("review keywords → agentic/review", () => {
    const r = router.route("实体A 最近有什么变化和进展");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("review");
  });

  // ── agentic / gap_analysis ───────────────────────────────

  test("gap analysis keywords → agentic/gap_analysis", () => {
    const r = router.route("还有什么关于 实体A 实体B 我遗漏的");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("gap_analysis");
  });

  // ── hybrid / keyword (default) ───────────────────────────

  test("unknown keyword → hybrid/keyword", () => {
    const r = router.route("心理学");
    expect(r.mode).toBe("hybrid");
    expect(r.intent).toBe("keyword");
  });

  // ── reasons ──────────────────────────────────────────────

  test("result always has non-empty reasons", () => {
    const cases = ["实体A", "最近动态", "实体A 和 实体B", "心理学", ""];
    for (const q of cases) {
      const r = router.route(q);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});
