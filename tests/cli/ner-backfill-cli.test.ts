import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { handleNerBackfill } from "../../src/cli/commands/maintenance.js";
import type { LockProbe } from "../../src/cli/commands/reindex.js";
import type { ContentPipeline } from "../../src/core/ingestion/pipeline.js";

const SRC = readFileSync(join(import.meta.dir, "../../src/cli/commands/maintenance.ts"), "utf-8");

const blocking: LockProbe = { blockingOwner: () => ({ kind: "serve", pid: 4242 }) };
const open: LockProbe = { blockingOwner: () => null };

function withTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDeps(dir: string) {
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const db = new CBrainDB(join(dir, "brain.sqlite"));
  const pages = new PageManager(db, vault);
  let processCalls = 0;
  const pipeline = {
    processNer: async () => {
      processCalls += 1;
      throw new Error("processNer should not be called");
    },
  } as unknown as ContentPipeline;
  return { db, pages, pipeline, get processCalls() { return processCalls; } };
}

describe("cbrain ner-backfill CLI (#runtime)", () => {
  test("command is registered with bounded/json options", () => {
    expect(SRC).toContain('.command("ner-backfill")');
    expect(SRC).toContain("--limit <n>");
    expect(SRC).toContain("--json");
  });

  test("refuses when a live writer is active and never processes jobs", async () => {
    const dir = withTempDir("cbrain-ner-backfill-blocked-");
    try {
      const deps = makeDeps(dir);
      deps.db.submitJob("ner-backfill", { slug: "records/private-a" });
      const logs: string[] = [];
      const errs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: blocking },
        { limit: 50, json: true },
        (m) => logs.push(m),
        (m) => errs.push(m),
      );

      expect(exit).toBe(1);
      expect(deps.processCalls).toBe(0);
      expect(errs.join("\n")).toBe("");
      const payload = JSON.parse(logs.join("\n"));
      expect(payload).toMatchObject({ ok: false, blocked: true });
      expect(JSON.stringify(payload)).not.toContain("records/private-a");
      expect(deps.db.listJobs("pending").filter((j) => j.name === "ner-backfill")).toHaveLength(1);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--limit 0 --json is a safe no-op and does not leak pending slugs", async () => {
    const dir = withTempDir("cbrain-ner-backfill-limit-zero-");
    try {
      const deps = makeDeps(dir);
      deps.db.submitJob("ner-backfill", { slug: "records/private-b" });
      const logs: string[] = [];
      const errs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, json: true },
        (m) => logs.push(m),
        (m) => errs.push(m),
      );

      expect(exit).toBe(0);
      expect(deps.processCalls).toBe(0);
      expect(errs).toHaveLength(0);
      const payload = JSON.parse(logs.join("\n"));
      expect(payload).toEqual({
        ok: true,
        counts: { processed: 0, failed: 0, timed_out: 0, skipped: 0 },
      });
      expect(JSON.stringify(payload)).not.toContain("records/private-b");
      expect(deps.db.listJobs("pending").filter((j) => j.name === "ner-backfill")).toHaveLength(1);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
