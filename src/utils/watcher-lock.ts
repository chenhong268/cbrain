import { openSync, closeSync, readFileSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WatcherOwner {
  pid: number;
  startedAt: string;
  transport: string;
}

export interface AcquireResult {
  acquired: boolean;
  reason?: string;
}

export class WatcherLock {
  readonly lockFile: string;
  private transport: string;

  constructor(dataDir: string, transport = "http") {
    this.lockFile = join(dataDir, ".watcher.lock");
    this.transport = transport;
  }

  tryAcquire(): AcquireResult {
    // Try atomic create — O_EXCL fails if file exists
    try {
      const fd = openSync(this.lockFile, "wx");
      const payload = JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: this.transport,
      } satisfies WatcherOwner);
      writeFileSync(fd, payload);
      closeSync(fd);
      return { acquired: true };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { acquired: false, reason: `lock error: ${String(e)}` };
      }
    }

    // File exists — check if owner is alive
    const owner = this.readOwner();
    if (!owner) {
      // Corrupt or empty file — steal it
      return this.steal();
    }

    if (this.isProcessAlive(owner.pid)) {
      return { acquired: false, reason: `watcher already running (pid ${owner.pid}, ${owner.transport})` };
    }

    // Owner is dead — steal
    return this.steal();
  }

  release(): void {
    try {
      if (existsSync(this.lockFile)) {
        const owner = this.readOwner();
        if (!owner || owner.pid === process.pid) {
          unlinkSync(this.lockFile);
        }
      }
    } catch { /* best effort */ }
  }

  readOwner(): WatcherOwner | null {
    try {
      const raw = readFileSync(this.lockFile, "utf-8").trim();
      if (!raw) return null;
      return JSON.parse(raw) as WatcherOwner;
    } catch {
      return null;
    }
  }

  isLocked(): boolean {
    const owner = this.readOwner();
    if (!owner) return false;
    return this.isProcessAlive(owner.pid);
  }

  private steal(): AcquireResult {
    try { unlinkSync(this.lockFile); } catch { /* */ }
    try {
      const fd = openSync(this.lockFile, "wx");
      const payload = JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: this.transport,
      } satisfies WatcherOwner);
      writeFileSync(fd, payload);
      closeSync(fd);
      return { acquired: true };
    } catch (e) {
      return { acquired: false, reason: `steal failed: ${String(e)}` };
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
