import { stat, readFile } from "node:fs/promises";
import { relative } from "node:path";
import pLimit from "p-limit";
import type { SyncManager } from "./sync.js";
import { hashContent, collectMarkdownFiles } from "./shared.js";
import type { Logger } from "./logger.js";
import type { CBrainDB } from "../storage/sqlite.js";

export interface FileWatcherOpts {
  logger?: Logger;
  db?: CBrainDB;
}

const SYNC_CONCURRENCY = 3;
const FIRST_SCAN_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;
const FAIL_THRESHOLD = 3;
const QUARANTINE_CONFIG_KEY = "watcher.quarantine";

interface PendingSync {
  slug: string;
  fullPath: string;
  hash: string;
  mtime: { mtime: number; size: number };
}

interface QuarantineEntry {
  failCount: number;
  lastError: string;
  quarantinedAt: string;
  hash?: string;
  fullPath?: string;
}

export class FileWatcher {
  private sync: SyncManager;
  private vaultPath: string;
  private logger?: Logger;
  private db?: CBrainDB;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private scanning = false;
  private readonly POLL_MS = 30_000;
  private hashes = new Map<string, string>();
  private mtimes = new Map<string, { mtime: number; size: number }>();
  private limit = pLimit(SYNC_CONCURRENCY);
  private inFlight = new Set<string>();
  private inFlightHashes = new Map<string, string>();
  private inFlightPaths = new Map<string, string>();
  private isFirstScan = true;
  private quarantine: Map<string, QuarantineEntry> = new Map();

  constructor(sync: SyncManager, vaultPath: string, opts?: FileWatcherOpts) {
    this.sync = sync;
    this.vaultPath = vaultPath;
    this.logger = opts?.logger;
    this.db = opts?.db;
    this.loadQuarantine();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger?.info("watcher", "启动", { vaultPath: this.vaultPath, pollMs: this.POLL_MS });
    this.scan();
    this.interval = setInterval(() => { this.scan(); }, this.POLL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try { await this.doScan(); } finally { this.scanning = false; }
  }

  private enqueueSync(pending: PendingSync): void {
    if (this.inFlight.has(pending.slug)) {
      this.logger?.info("watcher", "跳过：正在同步", { slug: pending.slug });
      return;
    }
    if (this.isQuarantined(pending.slug)) {
      const prevHash = this.hashes.get(pending.fullPath)
        ?? this.quarantine.get(pending.slug)?.hash;
      // Always store hash so doScan won't re-detect this file unless content actually changes
      this.hashes.set(pending.fullPath, pending.hash);
      this.mtimes.set(pending.fullPath, pending.mtime);
      if (prevHash !== undefined && prevHash !== pending.hash) {
        // Content changed — give it another chance
        this.quarantine.delete(pending.slug);
        this.persistQuarantine();
        this.logger?.info("watcher", "隔离文件内容变更，重新同步", { slug: pending.slug });
      } else {
        return;
      }
    }
    this.inFlight.add(pending.slug);
    this.inFlightHashes.set(pending.slug, pending.hash);
    this.inFlightPaths.set(pending.slug, pending.fullPath);
    this.limit(() => this.sync.syncPage(pending.slug, this.vaultPath))
      .then(() => {
        this.hashes.set(pending.fullPath, pending.hash);
        this.mtimes.set(pending.fullPath, pending.mtime);
        this.recordSuccess(pending.slug);
        this.logger?.info("watcher", "同步完成", { slug: pending.slug });
      })
      .catch((e) => {
        this.recordFailure(pending.slug, String(e));
        this.logger?.warn("watcher", `同步失败: ${pending.slug}`, { error: String(e) });
      })
      .finally(() => { this.inFlight.delete(pending.slug); this.inFlightHashes.delete(pending.slug); this.inFlightPaths.delete(pending.slug); });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async doScan(): Promise<void> {
    // Reload quarantine from DB so external releases (e.g. MCP in another process) take effect
    this.syncQuarantineFromDb();
    const files = await collectMarkdownFiles(this.vaultPath, new Set(["outputs"]));
    const seen = new Set<string>();
    const changed: PendingSync[] = [];

    for (const fullPath of files) {
      seen.add(fullPath);
      try {
        const s = await stat(fullPath);
        const meta = { mtime: s.mtimeMs, size: s.size };
        const prevMeta = this.mtimes.get(fullPath);
        if (prevMeta && prevMeta.mtime === meta.mtime && prevMeta.size === meta.size) {
          continue;
        }

        const content = await readFile(fullPath, "utf-8");
        const h = hashContent(content);
        const prev = this.hashes.get(fullPath);

        if (prev === h) continue;

        const relPath = relative(this.vaultPath, fullPath);
        const slug = relPath.replace(/\.md$/, "");
        this.logger?.info("watcher", "检测到变更", { slug });
        changed.push({ slug, fullPath, hash: h, mtime: meta });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger?.warn("watcher", `文件读取失败: ${fullPath}`, { error: String(e) });
        }
      }
    }

    if (this.isFirstScan && changed.length > FIRST_SCAN_BATCH_SIZE) {
      for (let i = 0; i < changed.length; i += FIRST_SCAN_BATCH_SIZE) {
        const batch = changed.slice(i, i + FIRST_SCAN_BATCH_SIZE);
        for (const pending of batch) {
          this.enqueueSync(pending);
        }
        if (i + FIRST_SCAN_BATCH_SIZE < changed.length) {
          await this.sleep(BATCH_DELAY_MS);
        }
      }
      this.logger?.info("watcher", "首次扫描分批完成", { total: changed.length, batchSize: FIRST_SCAN_BATCH_SIZE });
    } else {
      for (const pending of changed) {
        this.enqueueSync(pending);
      }
    }
    this.isFirstScan = false;

    // Deletion detection: files that disappeared since last scan
    const vanished: Array<{ slug: string; path: string }> = [];
    for (const path of [...this.hashes.keys()]) {
      if (!seen.has(path)) {
        const relPath = relative(this.vaultPath, path);
        const slug = relPath.replace(/\.md$/, "");
        vanished.push({ slug, path });
      }
    }
    if (vanished.length > 0) {
      for (const { slug, path } of vanished) {
        try {
          await this.sync.removePage(slug);
          this.hashes.delete(path);
          this.mtimes.delete(path);
        } catch (e) {
          this.logger?.warn("watcher", `删除清理失败: ${slug}`, { error: String(e) });
        }
      }
      this.logger?.info("watcher", "删除检测", { slugs: vanished.map(v => v.slug) });
    }
  }

  async scanOnce(): Promise<void> {
    return this.scan();
  }

  resetQuarantine(): void {
    this.quarantine.clear();
    try { this.db?.deleteConfig(QUARANTINE_CONFIG_KEY); } catch { /* */ }
  }

  releaseEntry(slug: string): boolean {
    if (!this.quarantine.has(slug)) return false;
    this.quarantine.delete(slug);
    this.persistQuarantine();
    return true;
  }

  releaseAllEntries(): number {
    const count = this.quarantine.size;
    this.quarantine.clear();
    try { this.db?.deleteConfig(QUARANTINE_CONFIG_KEY); } catch { /* */ }
    return count;
  }

  getQuarantineSize(): number {
    return this.quarantine.size;
  }

  getQuarantineEntries(): Array<{ slug: string; failCount: number; lastError: string; quarantinedAt: string; hash?: string; fullPath?: string }> {
    return [...this.quarantine.entries()].map(([slug, entry]) => ({ slug, ...entry }));
  }

  private loadQuarantine(): void {
    if (!this.db) return;
    try {
      const raw = this.db.getConfig(QUARANTINE_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, QuarantineEntry>;
        for (const [k, v] of Object.entries(parsed)) {
          this.quarantine.set(k, v);
          if (v.hash && v.fullPath) {
            this.hashes.set(v.fullPath, v.hash);
          }
        }
      }
    } catch { /* start fresh */ }
  }

  /** Re-sync quarantine from DB so external releases (cross-process MCP) take effect.
   *  Only affects fully-quarantined entries (failCount >= threshold) — in-progress
   *  entries were never persisted and should not be touched. */
  private syncQuarantineFromDb(): void {
    if (!this.db) return;
    try {
      const raw = this.db.getConfig(QUARANTINE_CONFIG_KEY);
      if (!raw) {
        // DB empty — remove fully-quarantined entries (released externally)
        for (const [slug, entry] of this.quarantine) {
          if (entry.quarantinedAt !== "") this.quarantine.delete(slug);
        }
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, QuarantineEntry>;
      // Remove fully-quarantined entries that no longer exist in DB
      for (const [slug, entry] of this.quarantine) {
        if (entry.quarantinedAt !== "" && !(slug in parsed)) {
          this.quarantine.delete(slug);
        }
      }
    } catch { /* keep current state */ }
  }

  private persistQuarantine(): void {
    if (!this.db) return;
    try {
      const obj: Record<string, QuarantineEntry> = {};
      for (const [k, v] of this.quarantine) obj[k] = v;
      this.db.setConfig(QUARANTINE_CONFIG_KEY, JSON.stringify(obj));
    } catch { /* non-critical */ }
  }

  private recordFailure(slug: string, error: string): void {
    const entry = this.quarantine.get(slug);
    const failCount = (entry?.failCount ?? 0) + 1;
    if (failCount >= FAIL_THRESHOLD) {
      const hash = this.inFlightHashes.get(slug);
      const fullPath = this.inFlightPaths.get(slug);
      this.quarantine.set(slug, {
        failCount,
        lastError: error,
        quarantinedAt: new Date().toISOString(),
        hash,
        fullPath,
      });
      this.persistQuarantine();
      this.logger?.warn("watcher", `文件已隔离: ${slug}（连续失败 ${failCount} 次）`, { error });
    } else {
      this.quarantine.set(slug, { failCount, lastError: error, quarantinedAt: "" });
    }
  }

  private recordSuccess(slug: string): void {
    if (this.quarantine.has(slug)) {
      this.quarantine.delete(slug);
      this.persistQuarantine();
    }
  }

  private isQuarantined(slug: string): boolean {
    const entry = this.quarantine.get(slug);
    if (!entry) return false;
    return entry.quarantinedAt !== "";
  }
}
