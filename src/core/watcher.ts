import { stat, readFile } from "node:fs/promises";
import { relative } from "node:path";
import pLimit from "p-limit";
import type { SyncManager } from "./sync.js";
import { hashContent, collectMarkdownFiles } from "./shared.js";
import type { Logger } from "./logger.js";

export interface FileWatcherOpts {
  logger?: Logger;
}

const SYNC_CONCURRENCY = 3;
const FIRST_SCAN_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;

export class FileWatcher {
  private sync: SyncManager;
  private vaultPath: string;
  private logger?: Logger;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private scanning = false;
  private readonly POLL_MS = 30_000;
  private hashes = new Map<string, string>();
  private mtimes = new Map<string, { mtime: number; size: number }>();
  private limit = pLimit(SYNC_CONCURRENCY);
  private inFlight = new Set<string>();
  private isFirstScan = true;

  constructor(sync: SyncManager, vaultPath: string, opts?: FileWatcherOpts) {
    this.sync = sync;
    this.vaultPath = vaultPath;
    this.logger = opts?.logger;
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

  private enqueueSync(slug: string): void {
    if (this.inFlight.has(slug)) {
      this.logger?.info("watcher", "跳过：正在同步", { slug });
      return;
    }
    this.inFlight.add(slug);
    this.limit(() => this.sync.syncPage(slug, this.vaultPath))
      .then(() => { this.logger?.info("watcher", "同步完成", { slug }); })
      .catch((e) => { this.logger?.warn("watcher", `同步失败: ${slug}`, { error: String(e) }); })
      .finally(() => { this.inFlight.delete(slug); });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async doScan(): Promise<void> {
    const files = await collectMarkdownFiles(this.vaultPath, new Set(["outputs"]));
    const seen = new Set<string>();
    const changed: string[] = [];

    for (const fullPath of files) {
      seen.add(fullPath);
      try {
        const s = await stat(fullPath);
        const meta = { mtime: s.mtimeMs, size: s.size };
        const prevMeta = this.mtimes.get(fullPath);
        this.mtimes.set(fullPath, meta);
        if (prevMeta && prevMeta.mtime === meta.mtime && prevMeta.size === meta.size) {
          continue;
        }

        const content = await readFile(fullPath, "utf-8");
        const h = hashContent(content);
        const prev = this.hashes.get(fullPath);
        this.hashes.set(fullPath, h);

        if (prev === h) continue;

        const relPath = relative(this.vaultPath, fullPath);
        const slug = relPath.replace(/\.md$/, "");
        this.logger?.info("watcher", "检测到变更", { slug });
        changed.push(slug);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger?.warn("watcher", `文件读取失败: ${fullPath}`, { error: String(e) });
        }
      }
    }

    if (this.isFirstScan && changed.length > FIRST_SCAN_BATCH_SIZE) {
      for (let i = 0; i < changed.length; i += FIRST_SCAN_BATCH_SIZE) {
        const batch = changed.slice(i, i + FIRST_SCAN_BATCH_SIZE);
        for (const slug of batch) {
          this.enqueueSync(slug);
        }
        if (i + FIRST_SCAN_BATCH_SIZE < changed.length) {
          await this.sleep(BATCH_DELAY_MS);
        }
      }
      this.logger?.info("watcher", "首次扫描分批完成", { total: changed.length, batchSize: FIRST_SCAN_BATCH_SIZE });
    } else {
      for (const slug of changed) {
        this.enqueueSync(slug);
      }
    }
    this.isFirstScan = false;

    // Deletion detection: files that disappeared since last scan
    const deleted: string[] = [];
    for (const path of [...this.hashes.keys()]) {
      if (!seen.has(path)) {
        const relPath = relative(this.vaultPath, path);
        const slug = relPath.replace(/\.md$/, "");
        deleted.push(slug);
        this.hashes.delete(path);
        this.mtimes.delete(path);
      }
    }
    if (deleted.length > 0) {
      for (const slug of deleted) {
        try {
          await this.sync.removePage(slug);
        } catch (e) {
          this.logger?.warn("watcher", `删除清理失败: ${slug}`, { error: String(e) });
        }
      }
      this.logger?.info("watcher", "删除检测", { slugs: deleted });
    }
  }
}
