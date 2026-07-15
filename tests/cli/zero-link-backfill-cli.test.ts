import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program";
import { handleZeroLinkBackfill } from "../../src/cli/commands/zero-link-backfill";
import { CBrainDB } from "../../src/storage/sqlite";
import type { LockProbe } from "../../src/cli/commands/reindex";

const testDir = "/tmp/cbrain-test-zero-link-cli";
const dbPath = join(testDir, "brain.sqlite");
const open: LockProbe = { blockingOwner: () => null };
const blocked: LockProbe = { blockingOwner: () => ({ kind: "serve", pid: 4242 }) };

function seed(): void {
  const db = new CBrainDB(dbPath);
  db.upsertPage({ slug: "records/private-a", type: "record", title: "匿名记录", filePath: "records/private-a.md", contentHash: "hash-a" });
  db.insertChunk("records/private-a", 0, "first");
  db.insertChunk("records/private-a", 1, "second");
  db.close();
}

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => rmSync(testDir, { recursive: true, force: true }));

describe("cbrain zero-link-backfill (#342)", () => {
  test("is registered as a top-level command", () => {
    expect(buildProgram().commands.map((command) => command.name())).toContain("zero-link-backfill");
  });

  test("default dry-run is true read-only and works while a writer is reported active", () => {
    seed();
    const before = statSync(dbPath).mtimeMs;
    const walPath = `${dbPath}-wal`;
    const beforeWal = existsSync(walPath) ? statSync(walPath).mtimeMs : null;
    const logs: string[] = [];
    const exit = handleZeroLinkBackfill(
      { config: { dbPath }, lockProbe: blocked },
      { enqueue: false, json: true },
      (message) => logs.push(message),
    );
    expect(exit).toBe(0);
    const report = JSON.parse(logs.join("\n"));
    expect(report).toMatchObject({ mode: "dry_run", status: "ok", total: 1, actionable: 1, selected: 1 });
    expect(report).not.toHaveProperty("batchId");
    expect(JSON.stringify(report)).not.toContain("private-a");
    expect(JSON.stringify(report)).not.toContain("hash-a");
    expect(statSync(dbPath).mtimeMs).toBe(before);
    expect(existsSync(walPath) ? statSync(walPath).mtimeMs : null).toBe(beforeWal);
  });

  test("missing DB is fixed and does not create a file", () => {
    const logs: string[] = [];
    expect(handleZeroLinkBackfill(
      { config: { dbPath }, lockProbe: open },
      { enqueue: false, json: true },
      (message) => logs.push(message),
    )).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toEqual({
      version: 1, status: "error", code: "DB_NOT_FOUND", error: "CBrain database was not found",
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("enqueue requires explicit positive bounded limit", () => {
    seed();
    for (const limit of [undefined, 0, 501, 1.5]) {
      const logs: string[] = [];
      expect(handleZeroLinkBackfill(
        { config: { dbPath }, lockProbe: open },
        { enqueue: true, limit, json: true },
        (message) => logs.push(message),
      )).toBe(1);
      expect(JSON.parse(logs.join("\n")).code).toBe("INVALID_LIMIT");
    }
    const db = new CBrainDB(dbPath);
    expect(db.listJobs()).toHaveLength(0);
    db.close();
  });

  test("enqueue refuses an active writer before opening writable DB", () => {
    seed();
    const before = statSync(dbPath).mtimeMs;
    const logs: string[] = [];
    expect(handleZeroLinkBackfill(
      { config: { dbPath }, lockProbe: blocked },
      { enqueue: true, limit: 1, json: true },
      (message) => logs.push(message),
    )).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ code: "WRITER_ACTIVE", owner: { kind: "serve", pid: 4242 } });
    expect(statSync(dbPath).mtimeMs).toBe(before);
  });

  test("enqueue returns a random UUID and scalar-only short-batch receipt", () => {
    seed();
    const logs: string[] = [];
    expect(handleZeroLinkBackfill(
      { config: { dbPath }, lockProbe: open },
      { enqueue: true, limit: 5, json: true },
      (message) => logs.push(message),
    )).toBe(0);
    const receipt = JSON.parse(logs.join("\n"));
    expect(receipt).toMatchObject({ mode: "enqueue", status: "ok", selected: 1, newJobs: 1 });
    expect(receipt.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(receipt)).not.toContain("private-a");
    expect(JSON.stringify(receipt)).not.toContain("hash-a");
  });
});
