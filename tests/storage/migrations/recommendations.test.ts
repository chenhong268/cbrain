import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRecommendationRecordsMigration } from "../../../src/storage/migrations/recommendations.js";

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

function exists(db: Database, n: string): boolean {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n) as { name?: string } | undefined)?.name === n;
}

function idx(db: Database, n: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(n) as { sql?: string } | undefined)?.sql;
}

describe("recommendation_records migration", () => {
  const dbs: Database[] = [];
  afterEach(() => {
    dbs.forEach((d) => {
      d.close();
    });
    dbs.length = 0;
  });

  test("creates tables + active-unique index", () => {
    const db = newDb();
    dbs.push(db);
    runRecommendationRecordsMigration(db);
    expect(exists(db, "recommendation_records")).toBe(true);
    expect(exists(db, "recommendation_lifecycle_history")).toBe(true);
    expect(idx(db, "idx_rec_active_unique")).toContain("lifecycle_status IN ('pending','current')");
  });

  test("idempotent", () => {
    const db = newDb();
    dbs.push(db);
    runRecommendationRecordsMigration(db);
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
  });

  test("two active same key rejected", () => {
    const db = newDb();
    dbs.push(db);
    runRecommendationRecordsMigration(db);
    const ins = (id: string, lc: string) =>
      db.exec(`INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ('${id}','k','f','ih','{}',0,'t','t','${lc}','fresh',NULL)`);
    ins("r1", "pending");
    expect(() => ins("r2", "current")).toThrow(/UNIQUE/);
    expect(() => ins("r3", "superseded")).not.toThrow();
  });

  test("ATOMIC: fault before marker rolls back ALL", () => {
    const db = newDb();
    dbs.push(db);
    expect(() => runRecommendationRecordsMigration(db, { failBeforeMarker: true })).toThrow(/injected/);
    expect(exists(db, "recommendation_records")).toBe(false);
    expect(idx(db, "idx_rec_active_unique")).toBeUndefined();
    expect((db.prepare("SELECT value FROM config WHERE key='migration_rec_v1_recommendation_records'").get() as { value?: string } | undefined)?.value).toBeUndefined();
    // recovery: re-run without the hook succeeds cleanly
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
    expect(exists(db, "recommendation_records")).toBe(true);
  });

  test("forward repair", () => {
    const db = newDb();
    dbs.push(db);
    runRecommendationRecordsMigration(db);
    db.exec("DROP TABLE recommendation_records");
    db.exec("DELETE FROM config WHERE key='migration_rec_v1_recommendation_records'");
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
    expect(exists(db, "recommendation_records")).toBe(true);
  });
});
