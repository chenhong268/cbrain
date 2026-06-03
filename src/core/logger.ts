import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  details?: Record<string, unknown>;
}

export class Logger {
  private logDir: string;

  constructor(outputsDir: string) {
    this.logDir = join(outputsDir, "logs");
    mkdirSync(this.logDir, { recursive: true });
  }

  info(_module: string, _message: string, _details?: Record<string, unknown>): void {
    // info only stays in memory, not persisted — keeps logs lean
  }

  warn(module: string, message: string, details?: Record<string, unknown>): void {
    this.write({ timestamp: new Date().toISOString(), level: "warn", module, message, details });
  }

  error(module: string, message: string, details?: Record<string, unknown>): void {
    this.write({ timestamp: new Date().toISOString(), level: "error", module, message, details });
  }

  /** Return error entries from the last N days. */
  getRecentErrors(days: number = 7): LogEntry[] {
    const errors: LogEntry[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      const logFile = join(this.logDir, `系统日志-${date}.md`);
      if (!existsSync(logFile)) continue;

      const lines = require("node:fs").readFileSync(logFile, "utf-8").split("\n");
      for (const line of lines) {
        if (line.includes("| ❌ |")) {
          const parts = line.split("|").map((s: string) => s.trim());
          if (parts.length >= 6) {
            errors.push({
              timestamp: `${date}T${parts[1]}`,
              level: "error",
              module: parts[3] || "unknown",
              message: parts[4] || "unknown",
            });
          }
        }
      }
    }
    return errors;
  }

  // ─── Private ────────────────────────────────────────────────

  private write(entry: LogEntry): void {
    try {
    const date = entry.timestamp.slice(0, 10);
    const logFile = join(this.logDir, `系统日志-${date}.md`);

    if (!existsSync(logFile)) {
      const header = `# 系统日志 — ${date}\n\n| 时间 | 级别 | 模块 | 消息 | 详情 |\n|------|------|------|------|------|\n`;
      require("node:fs").writeFileSync(logFile, header, "utf-8");
    }

    const time = entry.timestamp.slice(11, 19);
    const icon = entry.level === "error" ? "❌" : entry.level === "warn" ? "⚠️" : "ℹ️";
    const details = entry.details
      ? Object.entries(entry.details).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")
      : "-";

    const row = `| ${time} | ${icon} | ${entry.module} | ${entry.message} | ${details} |\n`;
    appendFileSync(logFile, row, "utf-8");
    } catch { /* log dir may not be writable in test environments */ }
  }
}
