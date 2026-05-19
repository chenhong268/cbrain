import { stat, readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { SyncManager } from "./sync.js";
import { hashContent, collectMarkdownFiles } from "./shared.js";
import type { Logger } from "./logger.js";

export interface FileWatcherOpts {
  logger?: Logger;
}

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

  private async doScan(): Promise<void> {
    const files = await collectMarkdownFiles(this.vaultPath, new Set(["outputs"]));
    const seen = new Set<string>();

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
        this.sync.syncPage(slug, this.vaultPath).then(
          () => { this.logger?.info("watcher", "同步完成", { slug }); },
          (e) => { this.logger?.warn("watcher", `同步失败: ${slug}`, { error: String(e) }); }
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger?.warn("watcher", `文件读取失败: ${fullPath}`, { error: String(e) });
        }
      }
    }

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
          this.sync.removePage(slug);
        } catch (e) {
          this.logger?.warn("watcher", `删除清理失败: ${slug}`, { error: String(e) });
        }
      }
      this.logger?.info("watcher", "删除检测", { slugs: deleted });
    }
  }
}
