import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export class PidLock {
  private pidFile: string;

  constructor(dataDir: string, transport: "stdio" | "http", lockId?: string) {
    const suffix = lockId ? `-${lockId}` : "";
    this.pidFile = join(dataDir, `cbrain-${transport}${suffix}.pid`);
  }

  acquire(force = false): void {
    if (!force) {
      this.killStaleProcesses();
    }
    this.writePid();
  }

  /** Kill the PID-file process + any other CBrain serve processes matching this transport. */
  private killStaleProcesses(): void {
    const pids = this.findStalePids();
    if (pids.length === 0) return;

    console.error(`> Killing ${pids.length} stale CBrain process(es): ${pids.join(", ")}`);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pids.some(p => this.isRunning(p))) { /* wait */ }
    for (const pid of pids) {
      if (this.isRunning(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* */ }
      }
    }
  }

  /** Collect stale PIDs from the PID file. */
  private findStalePids(): number[] {
    const myPid = process.pid;
    if (!existsSync(this.pidFile)) return [];

    const oldPid = this.readPid();
    if (oldPid && oldPid !== myPid && this.isRunning(oldPid)) return [oldPid];
    return [];
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
