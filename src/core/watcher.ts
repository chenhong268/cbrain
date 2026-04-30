import { readFileSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import type { SyncManager } from "./sync.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

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
    const files = this.collectMarkdownFiles(this.vaultPath);
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
        this.sync.syncPage(slug, this.vaultPath).catch(() => {});
      } catch {
        // file may have been deleted mid-scan
      }
    }

    // Clean up hashes for deleted files
    for (const path of this.hashes.keys()) {
      if (!seen.has(path)) this.hashes.delete(path);
    }
  }

  private collectMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    const walk = (d: string) => {
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); }
        else if (extname(e.name).toLowerCase() === ".md") { results.push(p); }
      }
    };
    walk(dir);
    return results;
  }
}
