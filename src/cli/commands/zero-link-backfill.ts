import type { Command } from "commander";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfigSafe, type CBrainConfig } from "../context.js";
import { createLiveLockProbe, type LockProbe } from "./reindex.js";
import {
  enqueueZeroLinkBackfill,
  planZeroLinkBackfill,
  type ZeroLinkBackfillReport,
} from "../../core/maintenance/zero-link-backfill.js";

export interface ZeroLinkBackfillOptions {
  enqueue: boolean;
  limit?: number;
  json: boolean;
}

export interface ZeroLinkBackfillDeps {
  config: Pick<CBrainConfig, "dbPath">;
  lockProbe?: LockProbe;
}

function fixedError(code: string): { version: 1; status: "error"; code: string; error: string } {
  const messages: Record<string, string> = {
    INVALID_LIMIT: "limit is invalid for this mode",
    WRITER_ACTIVE: "a CBrain writer is active",
    CONFIG_INVALID: "CBrain configuration is invalid",
    DB_NOT_FOUND: "CBrain database was not found",
    DB_OPEN_FAILED: "CBrain database could not be opened",
    STATE_CONFLICT: "zero-link state requires review",
    QUEUE_INTEGRITY_CONFLICT: "NER queue integrity requires review",
    ENQUEUE_FAILED: "zero-link enqueue failed",
  };
  return { version: 1, status: "error", code, error: messages[code] ?? "zero-link operation failed" };
}

function emitReport(report: ZeroLinkBackfillReport, json: boolean, log: (message: string) => void): void {
  if (json) {
    log(JSON.stringify(report, null, 2));
    return;
  }
  log(`零链接富记录：当前债务 ${report.total}，可执行 ${report.actionable}，本次选择 ${report.selected}`);
  log(`状态：活动 ${report.active}，已解析 ${report.resolved}，无图关系 ${report.terminalNoGraphLinks}，提交未知 ${report.commitUnknown}`);
  log(`冲突：状态 ${report.stateConflicts}，队列完整性 ${report.queueIntegrityConflicts}`);
  if (report.batchId) log(`批次：${report.batchId}`);
}

export function handleZeroLinkBackfill(
  deps: ZeroLinkBackfillDeps,
  opts: ZeroLinkBackfillOptions,
  log: (message: string) => void = console.log,
  logError: (message: string) => void = console.error,
): number {
  const dbPath = resolve(deps.config.dbPath);
  if (!existsSync(dbPath)) {
    const error = fixedError("DB_NOT_FOUND");
    if (opts.json) log(JSON.stringify(error, null, 2)); else logError(`${error.code}: ${error.error}`);
    return 1;
  }
  if (opts.enqueue) {
    if (!Number.isSafeInteger(opts.limit) || (opts.limit ?? 0) < 1 || (opts.limit ?? 0) > 500) {
      const error = fixedError("INVALID_LIMIT");
      if (opts.json) log(JSON.stringify(error, null, 2)); else logError(`${error.code}: ${error.error}`);
      return 1;
    }
    const owner = deps.lockProbe?.blockingOwner();
    if (owner) {
      const error = { ...fixedError("WRITER_ACTIVE"), owner: { kind: owner.kind, pid: owner.pid } };
      if (opts.json) log(JSON.stringify(error, null, 2)); else logError(`${error.code}: ${error.error}`);
      return 1;
    }
  } else if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 500)) {
    const error = fixedError("INVALID_LIMIT");
    if (opts.json) log(JSON.stringify(error, null, 2)); else logError(`${error.code}: ${error.error}`);
    return 1;
  }

  let rawDb: Database | null = null;
  try {
    rawDb = opts.enqueue
      ? new Database(dbPath, { create: false, readwrite: true })
      : new Database(dbPath, { readonly: true, create: false });
    rawDb.exec("PRAGMA foreign_keys = ON");
    if (opts.enqueue) rawDb.exec("PRAGMA busy_timeout = 5000");
    const report = opts.enqueue
      ? enqueueZeroLinkBackfill({ rawDb }, opts.limit!)
      : planZeroLinkBackfill({ rawDb }, opts.limit);
    emitReport(report, opts.json, log);
    return report.status === "ok" ? 0 : 1;
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : "";
    const code = rawCode === "QUEUE_INTEGRITY_CONFLICT" ? rawCode : opts.enqueue ? "ENQUEUE_FAILED" : "DB_OPEN_FAILED";
    const payload = fixedError(code);
    if (opts.json) log(JSON.stringify(payload, null, 2)); else logError(`${payload.code}: ${payload.error}`);
    return 1;
  } finally {
    rawDb?.close();
  }
}

export function register(program: Command): void {
  program
    .command("zero-link-backfill")
    .description("Inspect or enqueue governed NER repair for rich zero-link records")
    .option("--limit <n>", "Maximum ordered candidates to select")
    .option("--enqueue", "Atomically enqueue a bounded repair batch")
    .option("--json", "Emit machine-readable scalar JSON")
    .action((rawOptions) => {
      const loaded = loadConfigSafe();
      if (!loaded || typeof loaded.config.dbPath !== "string" || !loaded.config.dbPath.trim()) {
        const payload = fixedError("CONFIG_INVALID");
        if (rawOptions.json) console.log(JSON.stringify(payload, null, 2)); else console.error(`${payload.code}: ${payload.error}`);
        process.exitCode = 1;
        return;
      }
      const limit = rawOptions.limit === undefined ? undefined : Number(rawOptions.limit);
      const profileDir = dirname(resolve(loaded.config.dbPath));
      process.exitCode = handleZeroLinkBackfill(
        { config: loaded.config, lockProbe: createLiveLockProbe(profileDir) },
        { enqueue: Boolean(rawOptions.enqueue), limit, json: Boolean(rawOptions.json) },
      );
    });
}

