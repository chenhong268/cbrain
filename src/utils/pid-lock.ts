import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export class PidLock {
  private pidFile: string;
  private transport: "stdio" | "http";

  constructor(dataDir: string, transport: "stdio" | "http") {
    this.pidFile = join(dataDir, `cbrain-${transport}.pid`);
    this.transport = transport;
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

  /** Collect stale PIDs: the one in the PID file + any from `ps` matching cbrain serve. */
  private findStalePids(): number[] {
    const myPid = process.pid;
    const found = new Set<number>();

    // 1. PID file
    if (existsSync(this.pidFile)) {
      const oldPid = this.readPid();
      if (oldPid && oldPid !== myPid && this.isRunning(oldPid)) found.add(oldPid);
    }

    // 2. Scan for matching processes via pgrep
    try {
      const pattern = this.transport === "http" ? "cbrain.*serve.*--http" : "cbrain.*serve";
      const out = execSync(`pgrep -f '${pattern}'`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (out) {
        for (const line of out.split("\n")) {
          const pid = parseInt(line.trim(), 10);
          if (pid && pid !== myPid && this.isRunning(pid)) found.add(pid);
        }
      }
    } catch { /* pgrep returns 1 when no matches */ }

    return [...found];
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
