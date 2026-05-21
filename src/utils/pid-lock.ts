import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export class PidLock {
  private pidFile: string;

  constructor(dataDir: string, transport: "stdio" | "http") {
    this.pidFile = join(dataDir, `cbrain-${transport}.pid`);
  }

  acquire(force = false): void {
    if (force) {
      this.writePid();
      return;
    }

    if (existsSync(this.pidFile)) {
      const oldPid = this.readPid();
      if (oldPid && this.isRunning(oldPid)) {
        console.error(`> Stale CBrain process (PID ${oldPid}) found, killing...`);
        try {
          process.kill(oldPid, "SIGTERM");
        } catch {
          // already dead
        }
        // wait up to 3s for process to exit
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && this.isRunning(oldPid)) {
          // busy-wait is fine for 3s
        }
        if (this.isRunning(oldPid)) {
          console.error(`> Process ${oldPid} didn't exit, force killing...`);
          try { process.kill(oldPid, "SIGKILL"); } catch { /* */ }
        }
      }
    }

    this.writePid();
  }

  release(): void {
    try {
      if (existsSync(this.pidFile) && this.readPid() === process.pid) {
        unlinkSync(this.pidFile);
      }
    } catch { /* best effort */ }
  }

  private writePid(): void {
    writeFileSync(this.pidFile, String(process.pid));
  }

  private readPid(): number | null {
    try {
      return parseInt(readFileSync(this.pidFile, "utf-8").trim(), 10) || null;
    } catch {
      return null;
    }
  }

  private isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
