import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { CompoundingReviewManager } from "../../src/core/maintenance/compounding-review.js";

const TEST_DIRS = [
  "/tmp/cbrain-test-cr-schema",
  "/tmp/cbrain-test-cr-dedup",
  "/tmp/cbrain-test-cr-dedup-type",
  "/tmp/cbrain-test-cr-transitions",
  "/tmp/cbrain-test-cr-filtering",
  "/tmp/cbrain-test-cr-feedback",
  "/tmp/cbrain-test-cr-atomic",
  "/tmp/cbrain-test-cr-accept",
  "/tmp/cbrain-test-cr-count",
  "/tmp/cbrain-test-cr-title",
];

function cleanup() {
  for (const dir of TEST_DIRS) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterEach(cleanup);

// ─── Schema Migration ─────────────────────────────────────────

describe("CompoundingReview - schema migration", () => {
  const testDir = "/tmp/cbrain-test-cr-schema";
  const dbPath = join(testDir, "test.sqlite");

  test("creates compounding_review_candidates table", () => {
    mkdirSync(testDir, { recursive: true });
    const db = new CBrainDB(dbPath);
    const row = db.rawDb
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='compounding_review_candidates'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("compounding_review_candidates");
    db.close();
  });

  test("creates compounding_review_feedback table and indexes", () => {
    mkdirSync(testDir, { recursive: true });
    const db = new CBrainDB(dbPath);
    const tables = db.rawDb
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='compounding_review_feedback'")
      .get() as { name: string } | undefined;
    expect(tables).toBeDefined();

    const indexes = db.rawDb
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_crc%'")
      .all() as Array<{ name: string }>;
    expect(indexes.length).toBeGreaterThanOrEqual(2);
    db.close();
  });
});

// ─── Content Hash Dedup ────────────────────────────────────────

describe("CompoundingReview - content_hash dedup", () => {
  const testDir = "/tmp/cbrain-test-cr-dedup";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("same hash creates only 1 row", () => {
    const r1 = mgr.upsertCandidate({
      title: "实体A在主题B上的立场变化",
      candidateType: "theme_convergence",
      sourceSlugs: ["shi-ti-a", "zhu-ti-b"],
    });
    const r2 = mgr.upsertCandidate({
      title: "实体A在主题B上的立场变化",
      candidateType: "theme_convergence",
      sourceSlugs: ["shi-ti-a", "zhu-ti-b"],
    });
    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(false);
    expect(r1.id).toBe(r2.id);
    expect(mgr.count()).toBe(1);
  });

  test("last_seen_at updated for pending candidate on re-upsert", () => {
    const { id } = mgr.upsertCandidate({
      title: "主题B和主题D的关联",
      candidateType: "supported_connection",
      sourceSlugs: ["zhu-ti-b", "zhu-ti-d"],
    });

    mgr.upsertCandidate({
      title: "主题B和主题D的关联",
      candidateType: "supported_connection",
      sourceSlugs: ["zhu-ti-b", "zhu-ti-d"],
    });
    const c2 = mgr.getCandidate(id)!;
    expect(c2.status).toBe("pending");
  });

  test("last_seen_at NOT updated for rejected candidate", () => {
    const { id } = mgr.upsertCandidate({
      title: "被拒绝的观察",
      candidateType: "judgment_shift",
      sourceSlugs: ["ren-wu-a", "zhu-ti-b"],
    });
    const originalSeen = mgr.getCandidate(id)!.last_seen_at;

    mgr.transitionStatus(id, "reject");

    mgr.upsertCandidate({
      title: "被拒绝的观察",
      candidateType: "judgment_shift",
      sourceSlugs: ["ren-wu-a", "zhu-ti-b"],
    });
    const after = mgr.getCandidate(id)!;
    expect(after.last_seen_at).toBe(originalSeen);
    expect(after.status).toBe("rejected");
  });

  test("different full title but same first 30 chars → separate candidates", () => {
    const titleA = "这是一个非常非常非常非常非常长的标题超过三十个字符用来测试截断效果A";
    const titleB = "这是一个非常非常非常非常非常长的标题超过三十个字符用来测试截断效果B";
    const r1 = mgr.upsertCandidate({
      title: titleA,
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
    });
    const r2 = mgr.upsertCandidate({
      title: titleB,
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
    });
    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(true);
    expect(r1.id).not.toBe(r2.id);
    expect(mgr.count()).toBe(2);
  });

  test("same title/slugs but different candidateType → separate candidates", () => {
    const r1 = mgr.upsertCandidate({
      title: "主题B的观察",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    const r2 = mgr.upsertCandidate({
      title: "主题B的观察",
      candidateType: "judgment_shift",
      sourceSlugs: ["a", "b"],
    });
    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(true);
    expect(r1.id).not.toBe(r2.id);
    expect(mgr.count()).toBe(2);
  });
});

// ─── Status Transitions ────────────────────────────────────────

describe("CompoundingReview - status transitions", () => {
  const testDir = "/tmp/cbrain-test-cr-transitions";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("pending → accepted via accept", () => {
    const { id } = mgr.upsertCandidate({
      title: "接受测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    expect(mgr.transitionStatus(id, "accept")).toBe(true);
    expect(mgr.getCandidate(id)!.status).toBe("accepted");
  });

  test("pending → rejected via reject", () => {
    const { id } = mgr.upsertCandidate({
      title: "拒绝测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    expect(mgr.transitionStatus(id, "reject")).toBe(true);
    expect(mgr.getCandidate(id)!.status).toBe("rejected");
  });

  test("pending → deferred via defer", () => {
    const { id } = mgr.upsertCandidate({
      title: "推迟测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    expect(mgr.transitionStatus(id, "defer")).toBe(true);
    expect(mgr.getCandidate(id)!.status).toBe("deferred");
  });

  test("pending → disabled via disable", () => {
    const { id } = mgr.upsertCandidate({
      title: "禁用测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    expect(mgr.transitionStatus(id, "disable")).toBe(true);
    expect(mgr.getCandidate(id)!.status).toBe("disabled");
  });

  test("pending → superseded via superseded", () => {
    const { id } = mgr.upsertCandidate({
      title: "取代测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    expect(mgr.transitionStatus(id, "superseded")).toBe(true);
    expect(mgr.getCandidate(id)!.status).toBe("superseded");
  });

  test("rejected → pending via reactivate", () => {
    const { id } = mgr.upsertCandidate({
      title: "重新激活测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    mgr.transitionStatus(id, "reject");
    expect(mgr.getCandidate(id)!.status).toBe("rejected");

    expect(mgr.transitionStatus(id, "reactivate")).toBe(true);
    expect(mgr.getCandidate(id)!.status).toBe("pending");
  });
});

// ─── Active Filtering ──────────────────────────────────────────

describe("CompoundingReview - active filtering", () => {
  const testDir = "/tmp/cbrain-test-cr-filtering";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("default list returns pending only", () => {
    mgr.upsertCandidate({ title: "待定", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    const r = mgr.upsertCandidate({ title: "被拒绝的", candidateType: "theme_convergence", sourceSlugs: ["b"] });
    mgr.transitionStatus(r.id, "reject");

    const list = mgr.listCandidates();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("pending");
    expect(list[0].title).toBe("待定");
  });

  test("rejected/disabled/superseded always excluded from default", () => {
    const c1 = mgr.upsertCandidate({ title: "会拒绝", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    const c2 = mgr.upsertCandidate({ title: "会禁用", candidateType: "theme_convergence", sourceSlugs: ["b"] });
    const c3 = mgr.upsertCandidate({ title: "会取代", candidateType: "theme_convergence", sourceSlugs: ["c"] });

    mgr.transitionStatus(c1.id, "reject");
    mgr.transitionStatus(c2.id, "disable");
    mgr.transitionStatus(c3.id, "superseded");

    expect(mgr.listCandidates().length).toBe(0);
  });

  test("deferred excluded from default", () => {
    const d = mgr.upsertCandidate({ title: "推迟的", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(d.id, "defer");

    expect(mgr.listCandidates().length).toBe(0);
  });

  test("includeDeferred=true returns pending + deferred", () => {
    mgr.upsertCandidate({ title: "待定A", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    const d = mgr.upsertCandidate({ title: "推迟的B", candidateType: "theme_convergence", sourceSlugs: ["b"] });
    mgr.transitionStatus(d.id, "defer");

    const list = mgr.listCandidates({ includeDeferred: true });
    expect(list.length).toBe(2);
    const statuses = list.map((c) => c.status).sort();
    expect(statuses).toEqual(["deferred", "pending"]);
  });
});

// ─── Feedback Audit ────────────────────────────────────────────

describe("CompoundingReview - feedback audit", () => {
  const testDir = "/tmp/cbrain-test-cr-feedback";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("each transition creates 1 feedback row", () => {
    const { id } = mgr.upsertCandidate({ title: "审计测试", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(id, "accept");

    const feedback = mgr.getFeedback(id);
    expect(feedback.length).toBe(1);
    expect(feedback[0].action).toBe("accept");
  });

  test("multiple transitions → multiple feedback rows", () => {
    const { id } = mgr.upsertCandidate({ title: "多次审计", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(id, "defer");
    mgr.transitionStatus(id, "reactivate");
    mgr.transitionStatus(id, "accept");

    const feedback = mgr.getFeedback(id);
    expect(feedback.length).toBe(3);
    const actions = feedback.map((f) => f.action).sort();
    expect(actions).toEqual(["accept", "defer", "reactivate"]);
  });

  test("note persisted in feedback", () => {
    const { id } = mgr.upsertCandidate({ title: "带备注", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(id, "reject", "暂时不需要这个观察");

    const feedback = mgr.getFeedback(id);
    expect(feedback[0].note).toBe("暂时不需要这个观察");
  });
});

// ─── Transactional Atomicity ───────────────────────────────────

describe("CompoundingReview - status+feedback atomicity", () => {
  const testDir = "/tmp/cbrain-test-cr-atomic";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("every accepted status has matching feedback row", () => {
    const { id } = mgr.upsertCandidate({ title: "原子测试", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(id, "accept");

    const candidate = mgr.getCandidate(id)!;
    const feedback = mgr.getFeedback(id);
    expect(candidate.status).toBe("accepted");
    expect(feedback.length).toBe(1);
    expect(feedback[0].action).toBe("accept");
  });

  test("failed transition (nonexistent id) produces no feedback", () => {
    const ok = mgr.transitionStatus(99999, "accept");
    expect(ok).toBe(false);

    // Directly verify no orphan feedback rows
    const rows = db.rawDb
      .query("SELECT COUNT(*) as cnt FROM compounding_review_feedback")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  test("feedback count always matches transition count for a candidate", () => {
    const { id } = mgr.upsertCandidate({ title: "计数审计", candidateType: "theme_convergence", sourceSlugs: ["a"] });

    mgr.transitionStatus(id, "defer");
    mgr.transitionStatus(id, "reactivate");
    mgr.transitionStatus(id, "reject");

    const feedback = mgr.getFeedback(id);
    expect(feedback.length).toBe(3);

    // Verify status is the final one
    expect(mgr.getCandidate(id)!.status).toBe("rejected");
  });
});

// ─── Accept No Side Effects ────────────────────────────────────

describe("CompoundingReview - accept no side effects", () => {
  const testDir = "/tmp/cbrain-test-cr-accept";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("accept does not create pages or links", () => {
    const { id } = mgr.upsertCandidate({ title: "接受无副作用", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(id, "accept");

    const pages = db.listPages({ limit: 1000 });
    expect(pages.length).toBe(0);
  });
});

// ─── Count ─────────────────────────────────────────────────────

describe("CompoundingReview - count", () => {
  const testDir = "/tmp/cbrain-test-cr-count";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("default count returns pending only", () => {
    mgr.upsertCandidate({ title: "待定1", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.upsertCandidate({ title: "待定2", candidateType: "theme_convergence", sourceSlugs: ["b"] });
    const r = mgr.upsertCandidate({ title: "被拒绝", candidateType: "theme_convergence", sourceSlugs: ["c"] });
    mgr.transitionStatus(r.id, "reject");

    expect(mgr.count()).toBe(2);
  });

  test("count with status filter", () => {
    const r = mgr.upsertCandidate({ title: "被拒绝", candidateType: "theme_convergence", sourceSlugs: ["a"] });
    mgr.transitionStatus(r.id, "reject");
    mgr.upsertCandidate({ title: "待定", candidateType: "theme_convergence", sourceSlugs: ["b"] });

    expect(mgr.count("rejected")).toBe(1);
    expect(mgr.count("pending")).toBe(1);
    expect(mgr.count("accepted")).toBe(0);
  });
});

// ─── Title Truncation ──────────────────────────────────────────

describe("CompoundingReview - title truncation", () => {
  const testDir = "/tmp/cbrain-test-cr-title";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let mgr: CompoundingReviewManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    mgr = new CompoundingReviewManager(db);
  });

  afterEach(() => db.close());

  test("title truncated to 30 chars in storage", () => {
    const longTitle = "这是一个非常非常非常非常非常长的标题超过三十个字符用来测试截断效果";
    const { id } = mgr.upsertCandidate({
      title: longTitle,
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
    });
    const candidate = mgr.getCandidate(id)!;
    expect(candidate.title.length).toBe(30);
    expect(candidate.title).toBe(longTitle.slice(0, 30));
  });
});
