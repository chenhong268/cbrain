import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { SyncManager } from "./sync.js";
import { hashContent, collectMarkdownFiles } from "./shared.js";

/**
 * Polling vault watcher. Scans every 3s, hashes each .md file, compares
 * against content_hash in DB. Only syncs files whose content changed.
 * Uses hash (not mtime) — handles copied files, iCloud sync, etc.
 */
export class FileWatcher {
  private sync: SyncManager;
  private vaultPath: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly POLL_MS = 3000;
  private hashes = new Map<string, string>();  // path → content_hash

  constructor(sync: SyncManager, vaultPath: string) {
    this.sync = sync;
    this.vaultPath = vaultPath;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scan();
    this.interval = setInterval(() => { this.scan(); }, this.POLL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private scan(): void {
    const files = collectMarkdownFiles(this.vaultPath, new Set(["outputs"]));
    const seen = new Set<string>();

    for (const fullPath of files) {
      seen.add(fullPath);
      try {
        const content = readFileSync(fullPath, "utf-8");
        const h = hashContent(content);
        const prev = this.hashes.get(fullPath);
        this.hashes.set(fullPath, h);

        if (prev === h) continue; // unchanged

        const relPath = relative(this.vaultPath, fullPath);
        const slug = relPath.replace(/\.md$/, "");
        this.sync.syncPage(slug, this.vaultPath).catch((e) => {
          console.error(`[watcher] syncPage 失败: ${slug}`, e);
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[watcher] 文件读取失败: ${fullPath}`, e);
        }
      }
    }

    // Clean up hashes for deleted files
    for (const path of this.hashes.keys()) {
      if (!seen.has(path)) this.hashes.delete(path);
    }
  }
}
