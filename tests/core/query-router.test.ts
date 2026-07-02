import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { QueryRouter, } from "../../src/core/retrieval/query-router.js";

function insertPage(db: CBrainDB, slug: string, title: string) {
  db.rawDb.prepare(
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

  // ── intent priority overrides fast path (#66) ───────────────

  test("single entity + relationship keyword → agentic, not fast", () => {
    const r = router.route("实体A 的关系");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("relationship");
  });

  test("single entity + review keyword → agentic, not fast", () => {
    const r = router.route("实体A 的总结");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("review");
  });

  test("single entity + temporal keyword → agentic/timeline (entity-specific)", () => {
    const r = router.route("实体A 最近");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("timeline");
  });

  test("single entity + comparison keyword → agentic/comparison, not fast", () => {
    const r = router.route("实体A 对比");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("comparison");
  });

  test("single entity + gap keyword → agentic/gap_analysis, not fast", () => {
    const r = router.route("实体A 还有没有");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("gap_analysis");
  });

  test("entity without intent keywords still routes fast", () => {
    const r = router.route("实体A 的信息");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });

  // ── exact title match has highest priority (#66) ─────────

  test("exact title containing relationship keyword → fast, not agentic", () => {
    // "关系模型" is an exact title match — must NOT match "关系" intent keyword
    insertPage(db, "concepts/guanxi-moxing", "关系模型");
    const r = router.route("关系模型");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });

  // ── timeline routing (#66) ───────────────────────────────

  test("entity + 时间线 keyword → agentic/timeline", () => {
    const r = router.route("实体A 时间线");
    expect(r.mode).toBe("agentic");
    expect(r.intent).toBe("timeline");
  });

  test("generic temporal query (no entity) → hybrid/timeline", () => {
    const r = router.route("最近有什么新动态");
    expect(r.mode).toBe("hybrid");
    expect(r.intent).toBe("timeline");
  });

  // ── #255 over-routing: 比较 adverb must NOT escalate, even with 2 entities ──
  test("比较 + adjective (adverb) does NOT escalate to comparison", () => {
    for (const q of ["比较重要的主题A", "实体A和实体B都比较重要", "比较类似的主题"]) {
      const r = router.route(q);
      expect(r.intent, `${q} must not be comparison`).not.toBe("comparison");
    }
  });

  test("比较 in compare-structure DOES escalate", () => {
    const r = router.route("比较 实体A 和 实体B");
    expect(r.intent).toBe("comparison");
  });

  // ── #255 bilingual positive (English strong signals) ──
  test("English comparison strong → comparison", () => {
    const r = router.route("实体A compare 实体B difference");
    expect(r.intent).toBe("comparison");
  });
  test("English relationship → relationship", () => {
    const r = router.route("实体A and 实体B relationship");
    expect(r.intent).toBe("relationship");
  });
  test("English timeline strong → timeline", () => {
    const r = router.route("实体A what changed since last time");
    expect(r.intent).toBe("timeline");
  });

  // ── #255 English negative: weak words must NOT trigger their intent ──
  // ── #255 over-routing (review feedback): ambiguous actions must NOT escalate to agentic ──
  test("review the code / change the title / change manager → NOT agentic (safer default)", () => {
    for (const q of ["review the code", "review the code about 实体A and 实体B", "change the title", "change manager"]) {
      const r = router.route(q);
      expect(r.mode, `${q} must not be agentic`).not.toBe("agentic");
    }
  });

  // ── #255 English review structure (strong) → review intent ──
  test("English review structure → review intent", () => {
    for (const q of ["review of 实体A", "walk me through 实体A", "overview of 实体A"]) {
      const r = router.route(q);
      expect(r.intent, `${q} should be review`).toBe("review");
    }
  });

  // ── #255 exact title precedence over intent keywords (bilingual) ──
  test("exact English title with intent word still → fast/entity_lookup", () => {
    insertPage(db, "concepts/overview-alpha", "Overview Alpha");
    const r = router.route("Overview Alpha");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });
});
