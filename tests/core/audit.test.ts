import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLogger, type AuditEntry, type MetricsSnapshot } from "../../src/core/audit.js";

describe("AuditLogger", () => {
  const testDir = "/tmp/cbrain-test-audit";
  let audit: AuditLogger;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    audit = new AuditLogger(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("log", () => {
    test("creates a log file on first entry", () => {
      audit.log({
        timestamp: "2026-04-25T10:00:00.000Z",
        operation: "test_op",
        status: "success",
      });

      const logDir = join(testDir, "logs");
      expect(existsSync(logDir)).toBe(true);

      const files = join(logDir, "操作日志-2026-04-25.md");
      expect(existsSync(files)).toBe(true);
      const content = readFileSync(files, "utf-8");
      expect(content).toContain("操作日志");
      expect(content).toContain("test_op");
    });

    test("appends to existing log file", () => {
      audit.log({
        timestamp: "2026-04-25T10:00:00.000Z",
        operation: "op1",
        status: "success",
      });
      audit.log({
        timestamp: "2026-04-25T11:00:00.000Z",
        operation: "op2",
        status: "error",
      });

      const content = readFileSync(join(testDir, "logs", "操作日志-2026-04-25.md"), "utf-8");
      const lines = content.trim().split("\n");
      // header (2) + separator (1) + 2 rows = 5 lines after splitting by newlines
      expect(content).toContain("op1");
      expect(content).toContain("op2");
      expect(content).toContain("error");
    });

    test("includes page slug and duration when provided", () => {
      audit.log({
        timestamp: "2026-04-25T10:00:00.000Z",
        operation: "ingest",
        pageSlug: "entities/zhangsan",
        status: "success",
        durationMs: 150,
      });

      const content = readFileSync(join(testDir, "logs", "操作日志-2026-04-25.md"), "utf-8");
      expect(content).toContain("entities/zhangsan");
      expect(content).toContain("150ms");
    });
  });

  describe("writeMetrics", () => {
    test("creates a metrics file", () => {
      const snapshot: MetricsSnapshot = {
        timestamp: "2026-04-25T10:00:00.000Z",
        totalPages: 100,
        entities: 30,
        concepts: 20,
        events: 10,
        records: 25,
        sources: 15,
        totalLinks: 50,
        avgMentionsPerPage: 2.5,
        orphans: 5,
        bareStubs: 3,
        conceptsPerSource: 0.4,
        indexSizeKB: 1024,
      };

      audit.writeMetrics(snapshot);

      const filePath = join(testDir, "metrics", "指标快照-2026-04-25.md");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("指标快照");
      expect(content).toContain("100");
      expect(content).toContain("30");
    });

    test("appends to existing metrics file", () => {
      audit.writeMetrics({
        timestamp: "2026-04-25T10:00:00.000Z",
        totalPages: 50,
        entities: 10,
        concepts: 5,
        events: 2,
        records: 3,
        sources: 1,
        totalLinks: 10,
        avgMentionsPerPage: 1.0,
        orphans: 0,
        bareStubs: 0,
        conceptsPerSource: 1.25,
        indexSizeKB: 512,
      });

      audit.writeMetrics({
        timestamp: "2026-04-25T11:00:00.000Z",
        totalPages: 60,
        entities: 12,
        concepts: 6,
        events: 3,
        records: 4,
        sources: 2,
        totalLinks: 15,
        avgMentionsPerPage: 1.2,
        orphans: 1,
        bareStubs: 0,
        conceptsPerSource: 1.0,
        indexSizeKB: 600,
      });

      const content = readFileSync(join(testDir, "metrics", "指标快照-2026-04-25.md"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBeGreaterThan(4);
      expect(content).toContain("50");
      expect(content).toContain("60");
    });
  });

  describe("entry static method", () => {
    test("creates an AuditEntry with required fields", () => {
      const entry = AuditLogger.entry("ingest", "success");
      expect(entry.operation).toBe("ingest");
      expect(entry.status).toBe("success");
      expect(entry.timestamp).toBeDefined();
    });

    test("includes optional fields", () => {
      const entry = AuditLogger.entry("query", "success", {
        pageSlug: "entities/test",
        durationMs: 42,
        details: { strategy: "hybrid" },
      });

      expect(entry.pageSlug).toBe("entities/test");
      expect(entry.durationMs).toBe(42);
      expect(entry.details).toEqual({ strategy: "hybrid" });
    });
  });
});
