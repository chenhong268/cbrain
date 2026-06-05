import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { FileWatcher } from "../../src/core/watcher.js";
import { TitleCollisionError } from "../../src/core/sync.js";
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
    removePage: mock(async (_slug: string) => {}),
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
    removePage: mock(async (_slug: string) => {}),
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
      removePage: mock(async () => {}),
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

  // ─── TitleCollisionError produces structured quarantine diagnostic ──────

  test("quarantine entry includes titleCollisionJson for title collision", async () => {
    const tcSync: Partial<SyncManager> = {
      syncPage: mock(async (slug: string, _vp: string) => {
        if (slug === "renwu-a-note") {
          throw new TitleCollisionError({
            title: "人物A",
            incoming: { slug: "renwu-a-note", type: "record", filePath: "renwu-a-note.md" },
            existing: { slug: "brain/entities/person/renwu-a", type: "entity/person", filePath: "brain/entities/person/renwu-a.md" },
          });
        }
        return { success: true };
      }),
      removePage: mock(async () => {}),
    };

    writeFileSync(join(testDir, "renwu-a-note.md"), "---\ntitle: 人物A\ntype: record\n---\n内容", "utf-8");

    watcher = new FileWatcher(tcSync as unknown as SyncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));

    const entries = watcher.getQuarantineEntries();
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry.slug).toBe("renwu-a-note");
    expect(entry.lastError).toContain("Title collision");
    expect(entry.quarantinedAt).toBeTruthy();

    // Structured diagnostic
    expect(entry).toHaveProperty("titleCollisionJson");
    const tc = (entry as Record<string, unknown>).titleCollisionJson as {
      title: string; incoming: { slug: string; type: string; filePath: string }; existing: { slug: string; type: string; filePath: string };
    };
    expect(tc.title).toBe("人物A");
    expect(tc.incoming.slug).toBe("renwu-a-note");
    expect(tc.incoming.type).toBe("record");
    expect(tc.incoming.filePath).toBe("renwu-a-note.md");
    expect(tc.existing.slug).toBe("brain/entities/person/renwu-a");
    expect(tc.existing.type).toBe("entity/person");
    expect(tc.existing.filePath).toBe("brain/entities/person/renwu-a.md");
  });

  // ─── Stale quarantine entry cleaned when file deleted ──────────────

  test("stale quarantine entry removed when file no longer exists", async () => {
    const ghostSync: Partial<SyncManager> = {
      syncPage: mock(async (slug: string, _vp: string) => {
        if (slug === "ghost") throw new Error("sync fail");
        return { success: true };
      }),
      removePage: mock(async () => {}),
    };

    const file = join(testDir, "ghost.md");
    writeFileSync(file, "---\ntitle: Ghost\ntype: record\n---\nVanishing", "utf-8");

    watcher = new FileWatcher(ghostSync as unknown as SyncManager, vaultPath, { logger, db });
    for (let i = 0; i < 3; i++) {
      await watcher.scanOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getQuarantineSize()).toBe(1);

    // Delete the file
    unlinkSync(file);

    // Next scan should clean up the stale quarantine entry
    await watcher.scanOnce();
    await new Promise((r) => setTimeout(r, 100));

    expect(watcher.getQuarantineSize()).toBe(0);
    expect(logs.some(l => l.message === "隔离文件已删除，清理隔离记录")).toBe(true);
  });
});

// ── Bulk-change backpressure ───────────────────────────────────────────

describe("FileWatcher bulk-change backpressure", () => {
  const testDir = "/tmp/cbrain-test-watcher-bulk";
  const vaultPath = testDir;
  let db: CBrainDB;
  let syncManager: SyncManager;
  let watcher: FileWatcher;
  let logs: Array<{ module: string; message: string; details?: Record<string, unknown> }>;
  let logger: Logger;

  const bulkSync: Partial<SyncManager> = {
    syncPage: mock(async (_slug: string, _vaultPath: string) => ({ success: true })),
    removePage: mock(async (_slug: string) => {}),
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(":memory:");
    syncManager = bulkSync as unknown as SyncManager;

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

    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();
    (bulkSync.removePage as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    watcher?.stop();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("below-threshold scan enqueues normally", async () => {
    // Create 5 files — well below BULK_THRESHOLD (50)
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `---\ntitle: File${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });

    // First scan to establish baseline
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Modify all 5 files
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `---\ntitle: File${i}\n---\nUpdated`, "utf-8");
    }

    // Second scan — should enqueue all 5 immediately (no bulk pause)
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    expect(bulkSync.syncPage).toHaveBeenCalledTimes(5);
    expect(watcher.isBulkPaused()).toBe(false);
  });

  test("above-threshold scan pauses and records pending state", async () => {
    // Create 55 files (above BULK_THRESHOLD of 50)
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });

    // First scan to establish baseline
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Modify all 55 files
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nUpdated`, "utf-8");
    }

    // Second scan — should detect bulk change and pause
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    // Should NOT have enqueued any syncs
    expect(bulkSync.syncPage).toHaveBeenCalledTimes(0);

    // Should be paused
    expect(watcher.isBulkPaused()).toBe(true);

    // Status should report pending count
    const status = watcher.getBulkStatus();
    expect(status?.paused).toBe(true);
    expect(status?.pendingCount).toBe(55);
    expect(status?.threshold).toBe(50);

    // Should have logged bulk detection
    expect(logs.some((l) => l.message === "检测到大批量变更")).toBe(true);
  });

  test("paused watcher skips subsequent scans", async () => {
    // Create files and trigger bulk pause
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Modify to trigger bulk
    for (let i = 0; i < 55; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nUpdated`, "utf-8");
    }
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    expect(watcher.isBulkPaused()).toBe(true);

    // Add more files and scan again — should be skipped
    writeFileSync(join(testDir, "extra.md"), "---\ntitle: Extra\n---\nMore", "utf-8");
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    // Still paused, no extra syncs
    expect(bulkSync.syncPage).toHaveBeenCalledTimes(0);
  });

  test("resumeBulk releases one batch per call, stays paused until all released", async () => {
    const fileCount = 55;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 300));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nUpdated`, "utf-8");
    }
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    expect(watcher.isBulkPaused()).toBe(true);
    expect(watcher.getBulkStatus().pendingCount).toBe(55);

    // First call: release 10 of 55
    let result = await watcher.resumeBulk();
    expect(result.releasedCount).toBe(10);
    expect(result.remainingCount).toBe(45);
    expect(watcher.isBulkPaused()).toBe(true);

    // Second call: release 10 of 45
    result = await watcher.resumeBulk();
    expect(result.releasedCount).toBe(10);
    expect(result.remainingCount).toBe(35);
    expect(watcher.isBulkPaused()).toBe(true);

    // Release remaining in a loop
    let totalReleased = 20;
    while (watcher.isBulkPaused()) {
      result = await watcher.resumeBulk();
      totalReleased += result.releasedCount;
    }

    expect(totalReleased).toBe(fileCount);
    expect(watcher.isBulkPaused()).toBe(false);
    expect(watcher.getBulkStatus().pendingCount).toBe(0);

    // Give p-limit time to process all enqueued syncs
    await new Promise((r) => setTimeout(r, 500));
    expect(bulkSync.syncPage).toHaveBeenCalledTimes(fileCount);
  });

  test("getBulkStatus returns not paused when no bulk state", () => {
    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });

    const status = watcher.getBulkStatus();
    expect(status.paused).toBe(false);
    expect(status.pendingCount).toBe(0);
  });

  test("cross-process resume request triggers bounded release on next scan", async () => {
    const fileCount = 55;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db });
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 300));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(testDir, `bulk${i}.md`), `---\ntitle: Bulk${i}\n---\nUpdated`, "utf-8");
    }
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    expect(watcher.isBulkPaused()).toBe(true);
    expect(bulkSync.syncPage).toHaveBeenCalledTimes(0);

    // Simulate cross-process resume request (MCP without live watcher)
    db.setConfig("watcher.bulk_resume_request", JSON.stringify({ requestedAt: new Date().toISOString() }));

    // Next scan should detect the request and release only ONE batch (10)
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));

    // Only 10 should have been synced (one bounded batch)
    expect(bulkSync.syncPage).toHaveBeenCalledTimes(10);
    // Still paused with 45 remaining
    expect(watcher.isBulkPaused()).toBe(true);
    expect(watcher.getBulkStatus().pendingCount).toBe(45);

    // Resume request should have been consumed
    expect(db.getConfig("watcher.bulk_resume_request")).toBeNull();

    // Second request releases another 10
    db.setConfig("watcher.bulk_resume_request", JSON.stringify({ requestedAt: new Date().toISOString() }));
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));

    expect(bulkSync.syncPage).toHaveBeenCalledTimes(20);
    expect(watcher.getBulkStatus().pendingCount).toBe(35);
  });

  test("final batch resume does not re-trigger bulk pause", async () => {
    // Create exactly 12 files (threshold 50, but we use custom threshold 5)
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(testDir, `final${i}.md`), `---\ntitle: Final${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db, bulkThreshold: 5 });

    // First scan — all 12 are new, first-scan batching handles them
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 300));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Modify all 12 files
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(testDir, `final${i}.md`), `---\ntitle: Final${i}\n---\nUpdated`, "utf-8");
    }

    // Second scan — triggers bulk pause (12 > threshold 5)
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));
    expect(watcher.isBulkPaused()).toBe(true);
    expect(watcher.getBulkStatus().pendingCount).toBe(12);

    // First resume request: release 10, 2 remaining
    db.setConfig("watcher.bulk_resume_request", JSON.stringify({ requestedAt: new Date().toISOString() }));
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));
    expect(watcher.getBulkStatus().pendingCount).toBe(2);
    expect(watcher.isBulkPaused()).toBe(true);
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Final resume request: release last 2, should unpause
    db.setConfig("watcher.bulk_resume_request", JSON.stringify({ requestedAt: new Date().toISOString() }));
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));

    // Should be fully unpaused now
    expect(watcher.isBulkPaused()).toBe(false);
    expect(watcher.getBulkStatus().pendingCount).toBe(0);

    // Only the final 2 should have been synced in this round
    expect(bulkSync.syncPage).toHaveBeenCalledTimes(2);

    // No new bulk_pending should exist (would indicate re-pause)
    expect(db.getConfig("watcher.bulk_pending")).toBeNull();
  });

  test("custom bulkThreshold changes pause threshold", async () => {
    // Create 10 files, set threshold to 5
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `---\ntitle: File${i}\n---\nContent`, "utf-8");
    }

    watcher = new FileWatcher(syncManager, vaultPath, { logger, db, bulkThreshold: 5 });

    // First scan to establish baseline
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 200));
    (bulkSync.syncPage as ReturnType<typeof mock>).mockClear();

    // Modify all 10 files
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(testDir, `file${i}.md`), `---\ntitle: File${i}\n---\nUpdated`, "utf-8");
    }

    // Second scan — should trigger bulk pause (10 > custom threshold of 5)
    await (watcher as unknown as { doScan: () => Promise<void> }).doScan();
    await new Promise((r) => setTimeout(r, 100));

    expect(watcher.isBulkPaused()).toBe(true);
    const status = watcher.getBulkStatus();
    expect(status.pendingCount).toBe(10);
    expect(status.threshold).toBe(5);
  });
});
