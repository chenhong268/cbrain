import { watch, existsSync } from "node:fs";
import { join } from "node:path";
import type { SyncManager } from "./sync.js";

export class FileWatcher {
  private sync: SyncManager;
  private vaultPath: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(sync: SyncManager, vaultPath: string) {
    this.sync = sync;
    this.vaultPath = vaultPath;
  }

  start(): void {
    this.watcher = watch(
      this.vaultPath,
      { recursive: true },
      (_event, filename) => {
        if (!filename?.endsWith(".md")) return;

        const existing = this.timers.get(filename);
        if (existing) clearTimeout(existing);

        this.timers.set(
          filename,
          setTimeout(async () => {
            this.timers.delete(filename);
            const slug = filename.replace(/\.md$/, "");
            const fullPath = join(this.vaultPath, filename);
            try {
              if (existsSync(fullPath)) {
                await this.sync.syncPage(slug, this.vaultPath);
              } else {
                // File deleted — clean up orphaned DB entries
                await this.sync.removeOrphans(this.vaultPath);
              }
            } catch {
              // best-effort
            }
          }, 2000),
        );
      },
    );
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
