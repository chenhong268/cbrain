import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("cbrain perf-diagnose (#189)", () => {
  const dir = "/tmp/cbrain-test-perf-diagnose";
  const dbPath = join(dir, "b.sqlite");
  const vault = join(dir, "vault");
  const cfg = join(dir, "c.json");

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(vault, { recursive: true });
    writeFileSync(cfg, JSON.stringify({
      vaultPath: vault, dbPath, lancePath: join(dir, "lance"), embedding: { provider: "zhipu" },
    }));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  function run(args: string): { stdout: string; exit: number } {
    try {
      const stdout = execSync(`${BIN} perf-diagnose ${args}`, {
        encoding: "utf-8",
        env: { ...process.env, CBRAIN_CONFIG: cfg },
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { stdout, exit: 0 };
    } catch (e) {
      const err = e as { stdout?: string; status?: number };
      return { stdout: err.stdout ?? "", exit: err.status ?? 1 };
    }
  }

  test("empty DB (tables exist, no rows) -> exit 0 + zero counts", () => {
    const db = new CBrainDB(dbPath);
    db.close();
    const r = run("--json");
    expect(r.exit).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.summary.session_count).toBe(0);
    expect(d.summary.slow_count).toBe(0);
    expect(d.tables.sessions).toBe(true);
  });

  test("read-only: command performs no durable writes", () => {
    const db = new CBrainDB(dbPath);
    const now = new Date().toISOString();
    db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, started_at, latency_ms, status, llm_calls, total_steps) VALUES (?,?,?,?,?,?,?,?)",
    ).run("sentinel-query-text", "deep_recall", "topic", now, 2500, "success", 1, 3);
    const before = (db.rawDb.prepare("SELECT COUNT(*) c FROM search_trace_sessions").get() as { c: number }).c;
    db.close();

    const r = run("--json");
    expect(r.exit).toBe(0);

    const db2 = new CBrainDB(dbPath);
    const after = (db2.rawDb.prepare("SELECT COUNT(*) c FROM search_trace_sessions").get() as { c: number }).c;
    const row = db2.rawDb.prepare("SELECT query FROM search_trace_sessions WHERE id = 1").get() as { query: string };
    db2.close();

    expect(after).toBe(before);                     // no rows added/removed
    expect(row.query).toBe("sentinel-query-text");  // content unchanged
  });

  test("--json is sanitized: raw query text / paths / secrets never echoed", () => {
    const db = new CBrainDB(dbPath);
    const now = new Date().toISOString();
    const secret = "sk-deadbeefcafef00d";
    const pathLike = "/Users/mac/secret/vault/note.md";
    db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, started_at, latency_ms, status, llm_calls, total_steps, summary_json) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(`${secret} ${pathLike} raw user content`, "deep_recall", "topic", now, 2500, "success", 1, 3, `{"out":"${pathLike}"}`);
    db.close();

    const text = run("--json").stdout;
    expect(text).not.toContain(secret);
    expect(text).not.toContain(pathLike);
    expect(text).not.toMatch(/raw user content/);
    expect(text).not.toMatch(/\/Users/);
  });

  test("seeded slow sessions: sorted desc + slowest step kind derived from steps", () => {
    const db = new CBrainDB(dbPath);
    const now = new Date().toISOString();
    const ins = db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, started_at, latency_ms, status, llm_calls, total_steps) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run("q1", "deep_recall", "topic", now, 1500, "success", 1, 2);
    ins.run("q2", "deep_recall", "topic", now, 3000, "degraded", 2, 3);
    const sid1 = db.rawDb.prepare("SELECT id FROM search_trace_sessions WHERE latency_ms = 1500").get() as { id: number };
    const sid2 = db.rawDb.prepare("SELECT id FROM search_trace_sessions WHERE latency_ms = 3000").get() as { id: number };
    const stepIns = db.rawDb.prepare(
      "INSERT INTO search_trace_steps (session_id, step_index, kind, input_json, output_summary, latency_ms) VALUES (?,?,?,?,?,?)",
    );
    stepIns.run(sid1.id, 0, "vector_search", "{}", "x", 100);
    stepIns.run(sid1.id, 1, "llm_synthesize", "{}", "x", 1300);
    stepIns.run(sid2.id, 0, "fts_search", "{}", "x", 200);
    stepIns.run(sid2.id, 1, "llm_synthesize", "{}", "x", 2700);
    db.close();

    const d = JSON.parse(run("--json --min-latency-ms 1000").stdout);
    expect(d.summary.slow_count).toBe(2);
    expect(d.slow_sessions[0].latency_ms).toBe(3000);                  // sorted desc
    expect(d.slow_sessions[0].slowest_step_kind).toBe("llm_synthesize");
    expect(d.slowest_step_kinds[0].kind).toBe("llm_synthesize");
    expect(d.summary.degraded_rate).toBeCloseTo(0.5, 5);
  });

  test("missing optional table -> sanitized warning, exit 0", () => {
    const db = new CBrainDB(dbPath);
    db.rawDb.exec("DROP TABLE search_log");
    db.close();

    const r = run("--json");
    expect(r.exit).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.tables.searchLog).toBe(false);
    expect(d.tables.sessions).toBe(true);
    expect(d.warnings.some((w: string) => w.includes("search_log"))).toBe(true);
  });

  test("human output is concise and sanitized", () => {
    const db = new CBrainDB(dbPath);
    const now = new Date().toISOString();
    db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, started_at, latency_ms, status, llm_calls, total_steps) VALUES (?,?,?,?,?,?,?,?)",
    ).run("/Users/x/secret.md private text", "deep_recall", "topic", now, 2500, "success", 1, 3);
    db.close();

    const text = run("--min-latency-ms 1000").stdout;
    expect(text).toContain("deep_recall");
    expect(text).not.toMatch(/\/Users|secret\.md|private text/);
  });

  test("--min-latency-ms 0 is honored, not coerced to the default 1000 (#189 review)", () => {
    const db = new CBrainDB(dbPath);
    const now = new Date().toISOString();
    // 500ms session: below the 1000 default, above a 0 threshold
    db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, started_at, latency_ms, status, llm_calls, total_steps) VALUES (?,?,?,?,?,?,?,?)",
    ).run("q", "deep_recall", "topic", now, 500, "success", 1, 2);
    db.close();

    const d = JSON.parse(run("--json --min-latency-ms 0 --days 7").stdout);
    expect(d.window.min_latency_ms).toBe(0);     // not silently 1000
    expect(d.summary.session_count).toBe(1);
    expect(d.summary.slow_count).toBe(1);        // 500ms >= 0 threshold
  });

  test("--days 0 is honored, not coerced to the default 7 (#189 review)", () => {
    new CBrainDB(dbPath).close();
    const d = JSON.parse(run("--json --days 0").stdout);
    expect(d.window.days).toBe(0);               // not silently 7
  });

  test("window includes rows in SQLite datetime('now') space format (real-world, not ISO-T)", () => {
    const db = new CBrainDB(dbPath);
    // Omit started_at -> column DEFAULT datetime('now') = "YYYY-MM-DD HH:MM:SS" (space format).
    db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, latency_ms, status, llm_calls, total_steps) VALUES (?,?,?,?,?,?,?)",
    ).run("q", "deep_recall", "topic", 2000, "success", 1, 2);
    db.close();

    const d = JSON.parse(run("--json --days 7").stdout);
    expect(d.summary.session_count).toBe(1);     // space-format row matched by datetime() compare
  });

  test("by_degraded_reason keeps only known codes; unknown/private strings in reason_codes are dropped (#189 review)", () => {
    const db = new CBrainDB(dbPath);
    const now = new Date().toISOString();
    db.rawDb.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent, started_at, latency_ms, status, llm_calls, total_steps, summary_json) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "q", "deep_recall", "topic", now, 2500, "degraded", 1, 3,
      JSON.stringify({
        degraded_reason: "vector_timeout",
        reason_codes: ["vector_timeout", "sk-DEADBEEF-PRIVATE", "用户私密判断", "/Users/private/vault/file.md"],
        secret_blob: "RAW-PRIVATE-CONTENT",
      }),
    );
    db.close();

    const out = run("--json --min-latency-ms 1000");
    const d = JSON.parse(out.stdout);
    // Only the known code is categorized; unknown strings are NOT turned into categories.
    expect(d.by_degraded_reason.map((x: { reason: string }) => x.reason).sort()).toEqual(["vector_timeout"]);
    // Private content never reaches the report — neither as a category nor echoed.
    expect(out.stdout).not.toContain("sk-DEADBEEF-PRIVATE");
    expect(out.stdout).not.toContain("用户私密判断");
    expect(out.stdout).not.toContain("RAW-PRIVATE-CONTENT");
    expect(out.stdout).not.toMatch(/\/Users/);
  });
});
