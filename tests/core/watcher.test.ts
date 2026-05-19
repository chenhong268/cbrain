import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { FileWatcher } from "../../src/core/watcher.js";
import type { SyncManager } from "../../src/core/sync.js";
import type { Logger } from "../../src/core/logger.js";

describe("FileWatcher", () => {
  const testDir = "/tmp/cbrain-test-watcher";
  const vaultPath = testDir;
  let db: CBrainDB;
  let syncManager: SyncManager;
  let watcher: FileWatcher;
  let logs: Array<{ module: string; message: string; details?: Record<string, unknown> }>;
  let logger: Logger;

  const mockSync: Partial<SyncManager> = {
    syncPage: mock(async (_slug: string, _vaultPath: string) => ({ success: true })),
    removePage: mock((_slug: string) => {}),
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(":memory:");
    syncManager = mockSync as unknown as SyncManager;

    logs = [];
    logger = {
      info: mock((module: string, message: string, details?: Record<string, unknown>) => {
        logs.push({ module, message, details });
      }),
      warn: mock((module: string, message: string, details?: Record<string, unknown>) => {
        logs.push({ module, message, details });
      }),
      error: mock(),
    } as unknown as Logger;

    (mockSync.syncPage as ReturnType<typeof mock>).mockClear();
    (mockSync.removePage as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    watcher?.stop();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // ─── New file triggers sync ─────────────────────────

  test("new .md file triggers syncPage", async () => {
    writeFileSync(join(testDir, "test.md"), "---\ntitle: Test\n---\nHello", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.syncPage).toHaveBeenCalledTimes(1);
    expect(logs.some(l => l.message === "检测到变更")).toBe(true);
  });

  // ─── Modified file triggers re-sync ─────────────────

  test("modified file triggers re-sync", async () => {
    const file = join(testDir, "test.md");
    writeFileSync(file, "---\ntitle: Test\n---\nHello", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    (mockSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Modify content
    writeFileSync(file, "---\ntitle: Test\n---\nUpdated content", "utf-8");
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.syncPage).toHaveBeenCalledTimes(1);
  });

  // ─── Unchanged file skipped ─────────────────────────

  test("unchanged file is skipped", async () => {
    writeFileSync(join(testDir, "test.md"), "---\ntitle: Test\n---\nHello", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    (mockSync.syncPage as ReturnType<typeof mock>).mockClear();

    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.syncPage).toHaveBeenCalledTimes(0);
  });

  // ─── Deleted file triggers removePage ───────────────

  test("deleted file triggers removePage", async () => {
    const file = join(testDir, "deleteme.md");
    writeFileSync(file, "---\ntitle: DeleteMe\n---\nBye", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    expect(mockSync.syncPage).toHaveBeenCalledTimes(1);

    unlinkSync(file);
    (mockSync.syncPage as ReturnType<typeof mock>).mockClear();

    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.removePage).toHaveBeenCalledTimes(1);
    expect(mockSync.removePage).toHaveBeenCalledWith("deleteme");
    expect(logs.some(l => l.message === "删除检测")).toBe(true);
  });

  // ─── outputs/ directory ignored ─────────────────────

  test("outputs/ directory is ignored", async () => {
    mkdirSync(join(testDir, "outputs"), { recursive: true });
    writeFileSync(join(testDir, "outputs", "log.md"), "# Log", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.syncPage).toHaveBeenCalledTimes(0);
  });

  // ─── .obsidian directory ignored ────────────────────

  test(".obsidian directory is ignored", async () => {
    mkdirSync(join(testDir, ".obsidian"), { recursive: true });
    writeFileSync(join(testDir, ".obsidian", "config.md"), "# Config", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.syncPage).toHaveBeenCalledTimes(0);
  });

  // ─── Logger called on startup ───────────────────────

  test("logger called on start", () => {
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    watcher.start();
    watcher.stop();

    expect(logs.some(l => l.message === "启动")).toBe(true);
  });

  // ─── No logger works fine ───────────────────────────

  test("works without logger", async () => {
    writeFileSync(join(testDir, "nologger.md"), "---\ntitle: NoLog\n---\nContent", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath);
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    watcher.stop();

    expect(mockSync.syncPage).toHaveBeenCalledTimes(1);
  });

  // ─── Multiple deletions in one scan ─────────────────

  test("multiple deletions in one scan", async () => {
    const files = ["a.md", "b.md", "c.md"];
    for (const f of files) {
      writeFileSync(join(testDir, f), `---\ntitle: ${f}\n---\nContent`, "utf-8");
    }
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    expect(mockSync.syncPage).toHaveBeenCalledTimes(3);

    for (const f of files) unlinkSync(join(testDir, f));
    (mockSync.syncPage as ReturnType<typeof mock>).mockClear();

    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    expect(mockSync.removePage).toHaveBeenCalledTimes(3);
    const deletedSlugs = (mockSync.removePage as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(deletedSlugs.sort()).toEqual(["a", "b", "c"]);
  });
});
