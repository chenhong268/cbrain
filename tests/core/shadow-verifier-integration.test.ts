import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

describe("CBrainDB.getRecentVerifierCounts", () => {
  const testDir = "/tmp/cbrain-test-verifier-db";
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

  test("aggregates ner/discovery warning+error counts and reason codes", () => {
    db.addIngestLog("verifier", "ner_shadow_verifier", "records/source-1", JSON.stringify({
      surface: "ner", checks: 6,
      counts: { info: 0, warning: 1, error: 1 },
      reasonCounts: { ner_zero_from_long_body: 1, ner_invalid_event_date: 1 },
      worst: "error",
    }));
    db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify({
      surface: "discovery", type: "action_review_discovery", checks: 5,
      counts: { info: 0, warning: 2, error: 0 },
      reasonCounts: { discovery_display_private_raw: 2 },
      worst: "warning",
    }));

    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 1, error: 1 });
    expect(counts.discovery).toEqual({ warning: 2, error: 0 });
    expect(counts.byCode).toEqual({
      ner_zero_from_long_body: 1,
      ner_invalid_event_date: 1,
      discovery_display_private_raw: 2,
    });
  });

  test("ignores non-verifier ingest_log rows", () => {
    db.addIngestLog("vault", "sync", "records/source-1", JSON.stringify({ nerError: true }));
    db.addIngestLog("api", "ingest", "records/source-2", "{}");
    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 0, error: 0 });
    expect(counts.discovery).toEqual({ warning: 0, error: 0 });
    expect(counts.byCode).toEqual({});
  });

  test("respects the hour window", () => {
    db.addIngestLog("verifier", "ner_shadow_verifier", "x", JSON.stringify({
      surface: "ner", checks: 6, counts: { info: 0, warning: 1, error: 0 },
      reasonCounts: { ner_invalid_event_date: 1 }, worst: "warning",
    }));
    db.rawDb
      .prepare("UPDATE ingest_log SET created_at = datetime('now', '-48 hours')")
      .run();
    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 0, error: 0 });
  });

  test("malformed details are skipped, not thrown", () => {
    db.addIngestLog("verifier", "ner_shadow_verifier", "x", "not-json");
    db.addIngestLog("verifier", "ner_shadow_verifier", "y", null as unknown as string);
    expect(() => db.getRecentVerifierCounts(24)).not.toThrow();
    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 0, error: 0 });
  });
});
