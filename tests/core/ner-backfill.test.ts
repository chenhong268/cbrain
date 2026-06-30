import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite";
import { NER_BACKFILL_STALE_TTL_MS, NER_BACKFILL_JOB } from "../../src/core/ner-backfill";

const testDir = "/tmp/cbrain-test-ner-backfill";
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

describe("findActiveNerJobs (#252)", () => {
  test("no jobs → empty", () => {
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
  test("pending job for slug counts as active", () => {
    db.submitJob("ner-backfill", { slug: "records/foo" });
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS).length).toBe(1);
  });
  test("pending job for a different slug does not match", () => {
    db.submitJob("ner-backfill", { slug: "records/bar" });
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
  test("fresh running job counts as active", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id); // pending → running, started_at = now
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS).length).toBe(1);
  });
  test("stale running job does NOT count as active", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id);
    // backdate started_at beyond TTL
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
  test("claimJobById returns null for an already-claimed (running) job", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    expect(db.claimJobById(id)).not.toBeNull();   // first claim succeeds
    expect(db.claimJobById(id)).toBeNull();       // second claim → null (no longer pending)
  });
  test("findActiveNerJobs ignores non-ner-backfill job names", () => {
    db.submitJob("dream", { slug: "records/foo" });
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
});

describe("resetStaleJobsForNames (#252)", () => {
  test("stale running ner-backfill is reset to pending", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);
    const reset = db.resetStaleJobsForNames([NER_BACKFILL_JOB], NER_BACKFILL_STALE_TTL_MS);
    expect(reset).toBe(1);
    const row = db.getJob(id)!;
    expect(row.status).toBe("pending");
  });
  test("fresh running job is NOT reset", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id);
    expect(db.resetStaleJobsForNames([NER_BACKFILL_JOB], NER_BACKFILL_STALE_TTL_MS)).toBe(0);
    expect(db.getJob(id)!.status).toBe("running");
  });
  test("does not touch other job names", () => {
    const id = db.submitJob("dream", {});
    db.claimJobById(id);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);
    expect(db.resetStaleJobsForNames([NER_BACKFILL_JOB], NER_BACKFILL_STALE_TTL_MS)).toBe(0);
  });
});

describe("snapshotEligibleJobIds (#252)", () => {
  test("returns pending ner-backfill ids ordered by priority then id, bounded by limit", () => {
    const a = db.submitJob("ner-backfill", { slug: "a" }, 0);
    const b = db.submitJob("ner-backfill", { slug: "b" }, 5);
    const c = db.submitJob("ner-backfill", { slug: "c" }, 5);
    db.claimJobById(a);
    const ids = db.snapshotEligibleJobIds([NER_BACKFILL_JOB], 50);
    expect(ids).toEqual([b, c]);
  });
  test("respects limit", () => {
    db.submitJob("ner-backfill", { slug: "a" }, 0);
    db.submitJob("ner-backfill", { slug: "b" }, 0);
    expect(db.snapshotEligibleJobIds([NER_BACKFILL_JOB], 1).length).toBe(1);
  });
});
