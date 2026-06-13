import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Liveness check shared by instance + static scanning paths. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  /**
   * Read-only liveness check for recovery gating: returns the owner pid if a
   * pid file exists, the owner is alive, AND it is not the current process.
   * Returns null otherwise. Never acquires, kills, or steals the lock — used by
   * live-index recovery to refuse running while a serve process holds the index.
   */
  activeOwnerPid(): number | null {
    const pid = this.readPid();
    if (pid === null || pid === process.pid) return null;
    return this.isRunning(pid) ? pid : null;
  }

  /**
   * Scan the data dir for ALL active pid files of a transport — the plain
   * `cbrain-<transport>.pid` AND any lock-id-suffixed `cbrain-<transport>-<id>.pid`
   * that `serve` writes under `CBRAIN_LOCK_ID`. Read-only liveness check: never
   * acquires, kills, or steals. Returns live, non-self owner pids (deduped).
   *
   * Used by live-index recovery so it refuses even when serve ran with a custom
   * lock id (which the unsuffixed check alone misses).
   */
  static scanActiveOwnerPids(dataDir: string, transport: "http" | "stdio"): number[] {
    let entries: string[];
    try {
      entries = readdirSync(dataDir);
    } catch {
      return [];
    }
    const re = new RegExp(`^cbrain-${transport}(?:-.+)?\\.pid$`);
    const pids: number[] = [];
    const seen = new Set<number>();
    for (const name of entries) {
      if (!re.test(name)) continue;
      let pid: number | null;
      try {
        pid = parseInt(readFileSync(join(dataDir, name), "utf-8").trim(), 10) || null;
      } catch {
        pid = null;
      }
      if (pid && pid !== process.pid && !seen.has(pid) && isPidAlive(pid)) {
        seen.add(pid);
        pids.push(pid);
      }
    }
    return pids;
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
