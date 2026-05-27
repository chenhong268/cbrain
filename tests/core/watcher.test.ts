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

  // ─── Concurrency limit ──────────────────────────────

  test("concurrency limited to 3 syncs at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];

    (mockSync.syncPage as ReturnType<typeof mock>).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => resolvers.push(r));
      inFlight--;
    });

    for (let i = 0; i < 8; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `---\ntitle: F${i}\n---\nContent ${i}`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    // Give p-limit a tick to start tasks
    await new Promise((r) => setTimeout(r, 50));

    // Resolve all syncs
    for (const r of resolvers) r();
    await new Promise((r) => setTimeout(r, 50));

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  // ─── Per-slug debounce ──────────────────────────────

  test("same slug is not synced concurrently", async () => {
    let syncCount = 0;
    let resolveSync: () => void = () => {};
    (mockSync.syncPage as ReturnType<typeof mock>).mockImplementation(async () => {
      syncCount++;
      await new Promise<void>((r) => { resolveSync = r; });
    });

    writeFileSync(join(testDir, "debounce.md"), "---\ntitle: Debounce\n---\nV1", "utf-8");
    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    // Modify same file while first sync is still in-flight
    writeFileSync(join(testDir, "debounce.md"), "---\ntitle: Debounce\n---\nV2", "utf-8");
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    // Only one sync dispatched (second skipped due to in-flight)
    expect(syncCount).toBe(1);

    resolveSync();
    await new Promise((r) => setTimeout(r, 50));
  });

  // ─── Startup batching ──────────────────────────────

  test("first scan syncs all changed files", async () => {
    const syncOrder: string[] = [];
    (mockSync.syncPage as ReturnType<typeof mock>).mockImplementation(async (slug: string) => {
      syncOrder.push(slug);
    });

    for (let i = 0; i < 15; i++) {
      writeFileSync(join(testDir, `batch${i}.md`), `---\ntitle: B${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();

    // Give p-limit time to process all queued tasks
    await new Promise((r) => setTimeout(r, 200));

    expect(syncOrder.length).toBe(15);
  });
});

describe("FileWatcher quarantine", () => {
  const testDir = "/tmp/cbrain-test-watcher-q";
  const vaultPath = testDir;
  let db: CBrainDB;
  let syncManager: SyncManager;
  let watcher: FileWatcher;
  let logs: Array<{ module: string; message: string; details?: Record<string, unknown> }>;
  let logger: Logger;

  const failSync: Partial<SyncManager> = {
    syncPage: mock(async (slug: string, _vaultPath: string) => {
      if (slug === "fail") throw new Error("NER exploded");
      return { success: true };
    }),
    removePage: mock((_slug: string) => {}),
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(":memory:");
    syncManager = failSync as unknown as SyncManager;

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
  });

  afterEach(() => {
    watcher?.stop();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("quarantines file after 3 consecutive failures", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });

    // 3 scans to hit threshold
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }

    // Wait for async failure handlers to complete
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(1);

    // 4th scan — quarantined file should be skipped
    const beforeCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    const afterCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    expect(afterCount).toBe(beforeCount); // no new calls
  });

  test("successful sync clears quarantine", async () => {
    writeFileSync(join(testDir, "good.md"), "---\ntitle: Good\ntype: record\n---\nGood", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 50));

    expect(watcher.getQuarantineSize()).toBe(0);
  });

  test("resetQuarantine clears state", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      fail: { failCount: 3, lastError: "boom", quarantinedAt: new Date().toISOString() },
    }));

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    expect(watcher.getQuarantineSize()).toBe(1);

    watcher.resetQuarantine();
    expect(watcher.getQuarantineSize()).toBe(0);
    expect(db.getConfig("watcher.quarantine")).toBeNull();
  });

  test("quarantine persists across watcher restarts", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    // Wait for async failure handlers + persistQuarantine
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    // Verify quarantine is in DB
    const raw = db.getConfig("watcher.quarantine");
    expect(raw).not.toBeNull();

    // New watcher instance — should load quarantine from DB
    const watcher2 = new FileWatcher(syncManager, vaultPath, { logger, db });
    expect(watcher2.getQuarantineSize()).toBe(1);
    watcher2.stop();
  });

  // ─── Content change auto-recovers quarantine ───────────────

  test("quarantined file re-syncs after content change", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(1);

    // 4th scan with SAME content — still quarantined, no sync
    const beforeCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    const sameContentCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    expect(sameContentCount).toBe(beforeCount);

    // Fix the file — change content
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nFixed content", "utf-8");
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));

    // Quarantine cleared, sync attempted again
    const afterFixCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    expect(afterFixCount).toBeGreaterThan(sameContentCount);
  });

  // ─── getQuarantineEntries returns details ──────────────────

  test("getQuarantineEntries returns full details", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));

    const entries = watcher.getQuarantineEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].slug).toBe("fail");
    expect(entries[0].failCount).toBeGreaterThanOrEqual(3);
    expect(entries[0].lastError).toBeTruthy();
    expect(entries[0].quarantinedAt).toBeTruthy();
    expect(entries[0].hash).toBeTruthy();
    expect(entries[0].fullPath).toBeTruthy();
  });

  // ─── Content fix before next scan triggers immediate re-sync ──────

  test("quarantined file with content fix between scans re-syncs", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(1);

    // Fix content BETWEEN scans — no scan yet
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fixed\ntype: record\n---\nAll better now", "utf-8");

    // Next scan should detect hash change and attempt re-sync
    // (sync will fail again because mock throws for slug "fail", but the key behavior
    // is that quarantine was cleared and syncPage was called)
    const beforeSync = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));

    const afterSync = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    expect(afterSync).toBeGreaterThan(beforeSync);
  });

  // ─── Hash recovered from DB on watcher restart ──────────────

  test("quarantine hash persists in DB, watcher restart detects content change", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();
    expect(watcher.getQuarantineSize()).toBe(1);

    // Verify hash in DB
    const raw = db.getConfig("watcher.quarantine");
    const parsed = JSON.parse(raw!);
    expect(parsed.fail.hash).toBeTruthy();
    expect(parsed.fail.fullPath).toBeTruthy();

    // Fix file while watcher is stopped
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fixed\ntype: record\n---\nAll good", "utf-8");

    // New watcher instance — should load quarantine + hash from DB
    const watcher2 = new FileWatcher(syncManager, vaultPath, { logger, db });
    expect(watcher2.getQuarantineSize()).toBe(1);

    // Scan should detect hash change (loaded from DB) vs current file
    const beforeSync = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher2.scanOnce();
    await new Promise((r) => setTimeout(r, 100));

    const afterSync = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    expect(afterSync).toBeGreaterThan(beforeSync);
    watcher2.stop();
  });

  // ─── Release triggers re-sync even without content change ──────────

  test("releaseEntry triggers re-sync on next scan without content change", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(1);

    // Verify quarantined file is skipped
    const beforeCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((failSync.syncPage as ReturnType<typeof mock>).mock.calls.length).toBe(beforeCount);

    // Release — must clear hashes so next scan re-detects the file
    watcher.releaseEntry("fail");
    expect(watcher.getQuarantineSize()).toBe(0);

    // Content unchanged, but scan must now call syncPage
    const afterRelease = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((failSync.syncPage as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(afterRelease);
  });

  test("releaseAllEntries triggers re-sync for all quarantined files", async () => {
    // Use a sync that always fails
    const failAllSync: Partial<SyncManager> = {
      syncPage: mock(async () => { throw new Error("always fail"); }),
      removePage: mock(() => {}),
    };
    const allFailSyncManager = failAllSync as unknown as SyncManager;

    writeFileSync(join(testDir, "a.md"), "---\ntitle: A\ntype: record\n---\nA", "utf-8");
    writeFileSync(join(testDir, "b.md"), "---\ntitle: B\ntype: record\n---\nB", "utf-8");

    watcher = new FileWatcher(allFailSyncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(2);

    // Verify both skipped
    const beforeCount = (failAllSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((failAllSync.syncPage as ReturnType<typeof mock>).mock.calls.length).toBe(beforeCount);

    // Release all
    watcher.releaseAllEntries();
    expect(watcher.getQuarantineSize()).toBe(0);

    // Both files re-synced on next scan
    const afterRelease = (failAllSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((failAllSync.syncPage as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(afterRelease);
  });

  test("cross-process DB release triggers re-sync on next scan", async () => {
    writeFileSync(join(testDir, "fail.md"), "---\ntitle: Fail\ntype: record\n---\nBad", "utf-8");

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(1);

    // Verify quarantined file is skipped
    const beforeCount = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((failSync.syncPage as ReturnType<typeof mock>).mock.calls.length).toBe(beforeCount);

    // Simulate cross-process: MCP removes quarantine from DB directly
    db.deleteConfig("watcher.quarantine");

    // syncQuarantineFromDb + cache clear → next scan re-detects the file
    const afterDbRelease = (failSync.syncPage as ReturnType<typeof mock>).mock.calls.length;
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((failSync.syncPage as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(afterDbRelease);
  });
});
