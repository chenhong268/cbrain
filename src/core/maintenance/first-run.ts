/**
 * First-Run Readiness Doctor — comprehensive infrastructure check for 2.0 onboarding.
 *
 * Checks: config → paths → DB → indexes → services → MCP guidance.
 * Read-only. No service start, no data migration, no side effects beyond probe files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import type { CBrainConfig } from "../../cli/context.js";
import { loadConfigSafe, resolveRuntimePath } from "../../cli/context.js";
import type { ReadinessState, NextAction } from "../../cli/init-types.js";
import { CBrainDB } from "../../storage/sqlite.js";
import { WatcherLock } from "../../utils/watcher-lock.js";
import { checkLanceIntegrity } from "../../storage/lance-integrity.js";

// ── Types ──

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  readonly id: string;
  readonly category: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly action?: string;
}

export interface FirstRunReport {
  readonly overallStatus: CheckStatus;
  readonly checks: ReadonlyArray<CheckResult>;
  /** @deprecated Use `nextAction` for structured data. Kept as string for backward compat. */
  readonly recommendedNextAction: string;
  readonly nextAction: NextAction;
  readonly readinessState: ReadinessState;
}

interface FirstRunContext {
  readonly config: CBrainConfig | null;
  readonly configPath: string | null;
  readonly runtimePath: string;
  readonly profileDir: string;
}

// ── Helpers ──

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canWriteToDir(dirPath: string): boolean {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    const probe = join(dirPath, `.cbrain-probe-${Date.now()}`);
    writeFileSync(probe, "test");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// ── Check: Config ──

function checkConfig(ctx: FirstRunContext): CheckResult[] {
  const results: CheckResult[] = [];

  if (!ctx.config) {
    results.push({
      id: "config:exists",
      category: "config",
      status: "fail",
      message: ctx.configPath
        ? `config found at ${ctx.configPath} but failed to parse`
        : "no cbrain.json found",
      action: "运行 cbrain init 创建配置",
    });
    return results;
  }

  results.push({
    id: "config:exists",
    category: "config",
    status: "pass",
    message: `config found at ${ctx.configPath ?? "unknown"}`,
  });

  results.push(ctx.config.vaultPath
    ? { id: "config:vaultPath", category: "config", status: "pass" as const, message: "vaultPath configured" }
    : { id: "config:vaultPath", category: "config", status: "fail" as const, message: "vaultPath missing", action: "在 cbrain.json 中设置 vaultPath" },
  );

  results.push(ctx.config.dbPath
    ? { id: "config:dbPath", category: "config", status: "pass" as const, message: "dbPath configured" }
    : { id: "config:dbPath", category: "config", status: "fail" as const, message: "dbPath missing", action: "在 cbrain.json 中设置 dbPath" },
  );

  results.push(ctx.config.lancePath
    ? { id: "config:lancePath", category: "config", status: "pass" as const, message: "lancePath configured" }
    : { id: "config:lancePath", category: "config", status: "warn" as const, message: "lancePath not set (will default to sibling of dbPath)", action: "在 cbrain.json 中设置 lancePath" },
  );

  // #383: credential-bearing config file must not be group/world-readable.
  results.push(checkConfigPermissions(ctx));

  return results;
}

// ── #383: credential-bearing config file permissions ──

/** A config is "credential-bearing" if any in-file secret field is set (env vars are not in the file). */
function isCredentialBearing(config: CBrainConfig): boolean {
  return !!(config.embedding?.apiKey || config.ner?.llm_api_key || config.reflect?.llm_api_key);
}

/**
 * Read-only check that a credential-bearing config is owner-only on POSIX.
 * Never reads file bytes or prints paths/values/field names. Windows is
 * ACL-governed → capability-skip pass.
 */
function checkConfigPermissions(ctx: FirstRunContext): CheckResult {
  const id = "config:permissions";
  const category = "config";

  if (process.platform === "win32") {
    return { id, category, status: "pass", message: "权限检查在 Windows 上跳过（由 ACL 管理）" };
  }
  if (!ctx.configPath || !existsSync(ctx.configPath)) {
    return { id, category, status: "pass", message: "权限检查跳过（配置文件不可访问）" };
  }
  if (!ctx.config) {
    return { id, category, status: "pass", message: "权限检查跳过（配置未加载）" };
  }
  if (!isCredentialBearing(ctx.config)) {
    return { id, category, status: "pass", message: "配置文件不含凭据" };
  }

  try {
    const mode = statSync(ctx.configPath).mode & 0o777;
    if ((mode & 0o077) === 0) {
      return { id, category, status: "pass", message: "含凭据的配置文件为仅所有者可访问" };
    }
    return {
      id,
      category,
      status: "warn",
      message: "含凭据的配置文件可被组用户或其他用户访问",
      action: "将配置文件限制为仅所有者可访问 (chmod 600)，或改用环境变量提供凭据",
    };
  } catch {
    // Unknown security state on a credential-bearing file is not a pass.
    // Stable, path-free remediation so doctor can't mask an unverified
    // owner-only boundary as readiness.
    return {
      id,
      category,
      status: "warn",
      message: "无法验证含凭据的配置文件权限",
      action: "将配置文件限制为仅所有者可访问 (chmod 600)，或改用环境变量提供凭据",
    };
  }
}

// ── Check: Paths ──

function checkPaths(ctx: FirstRunContext): CheckResult[] {
  if (!ctx.config) {
    return [{ id: "paths:skip", category: "paths", status: "warn", message: "skipped (no config)" }];
  }

  const results: CheckResult[] = [];
  const vault = resolve(ctx.config.vaultPath);

  results.push(
    existsSync(vault)
      ? { id: "paths:vaultExists", category: "paths", status: "pass" as const, message: `vault exists: ${vault}` }
      : { id: "paths:vaultExists", category: "paths", status: "fail" as const, message: `vault not found: ${vault}`, action: "创建 vault 目录或检查 cbrain.json 中的 vaultPath" },
  );

  const dbDir = dirname(resolve(ctx.config.dbPath));
  results.push(
    canWriteToDir(dbDir)
      ? { id: "paths:dbDirWritable", category: "paths", status: "pass" as const, message: "db directory writable" }
      : { id: "paths:dbDirWritable", category: "paths", status: "fail" as const, message: `db directory not writable: ${dbDir}`, action: "检查目录权限" },
  );

  if (ctx.runtimePath) {
    results.push(
      canWriteToDir(ctx.runtimePath)
        ? { id: "paths:runtimeWritable", category: "paths", status: "pass" as const, message: "runtime directory writable" }
        : { id: "paths:runtimeWritable", category: "paths", status: "fail" as const, message: `runtime not writable: ${ctx.runtimePath}`, action: "检查 runtime 目录权限" },
    );
  }

  // Runtime inside vault (or equal to vault root) = warn
  const runtimeResolved = resolve(ctx.runtimePath);
  const rel = relative(vault, runtimeResolved);
  const isInsideVault = !rel.startsWith("..") && !rel.startsWith("/");
  if (isInsideVault) {
    results.push({
      id: "paths:runtimeOutsideVault",
      category: "paths",
      status: rel === "" ? "fail" : "warn",
      message: rel === ""
        ? "runtimePath equals vault root — running artifacts WILL pollute vault"
        : "runtime directory is inside vault",
      action: "设置 runtimePath 到 vault 外的独立目录",
    });
  }

  return results;
}

// ── Check: Database ──

async function checkDatabase(ctx: FirstRunContext): Promise<CheckResult[]> {
  if (!ctx.config) {
    return [{ id: "db:skip", category: "db", status: "warn", message: "skipped (no config)" }];
  }

  const results: CheckResult[] = [];
  let db: CBrainDB | null = null;

  try {
    db = new CBrainDB(ctx.config.dbPath);

    results.push({
      id: "db:open",
      category: "db",
      status: "pass",
      message: `SQLite opened: ${resolve(ctx.config.dbPath)}`,
    });

    // Check WAL
    const mode = db.rawDb.query("PRAGMA journal_mode").get(0) as Record<string, string>;
    const walMode = Object.values(mode)[0];
    results.push(
      walMode === "wal"
        ? { id: "db:wal", category: "db", status: "pass" as const, message: "WAL mode active" }
        : { id: "db:wal", category: "db", status: "warn" as const, message: `journal mode: ${walMode} (expected wal)`, action: "DB 将自动使用 WAL，通常无需处理" },
    );

    // Check tables
    const tables = db.rawDb.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='table'").get(0) as Record<string, number>;
    const tableCount = tables["cnt"] ?? 0;
    results.push(
      tableCount > 0
        ? { id: "db:tables", category: "db", status: "pass" as const, message: `${tableCount} tables found` }
        : { id: "db:tables", category: "db", status: "warn" as const, message: "database is empty", action: "运行 cbrain sync 填充数据库" },
    );
  } catch (e) {
    results.push({
      id: "db:open",
      category: "db",
      status: "fail",
      message: `failed to open database: ${e instanceof Error ? e.message : String(e)}`,
      action: "检查 dbPath 配置和目录权限",
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  return results;
}

// ── Check: Indexes ──

async function checkIndexes(ctx: FirstRunContext): Promise<CheckResult[]> {
  if (!ctx.config) {
    return [{ id: "index:skip", category: "index", status: "warn", message: "skipped (no config)" }];
  }

  const results: CheckResult[] = [];

  // FTS5 — need a DB connection for this check
  let db: CBrainDB | null = null;
  try {
    db = new CBrainDB(ctx.config.dbPath);
    const ftsRow = db.rawDb.query(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='chunks_fts'",
    ).get(0) as Record<string, number>;
    const ftsExists = (ftsRow["cnt"] ?? 0) > 0;
    results.push(
      ftsExists
        ? { id: "index:fts5", category: "index", status: "pass" as const, message: "FTS5 index ready" }
        : { id: "index:fts5", category: "index", status: "warn" as const, message: "FTS5 index not built", action: "运行 cbrain sync 创建全文索引" },
    );
  } catch {
    results.push({
      id: "index:fts5",
      category: "index",
      status: "warn",
      message: "could not check FTS5 status",
    });
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }

  // LanceDB — read-only integrity probe (no warmup, no table creation)
  let db2: CBrainDB | null = null;
  try {
    db2 = new CBrainDB(ctx.config.dbPath);
    const lanceReport = await checkLanceIntegrity(ctx.config.lancePath, db2);
    for (const c of lanceReport.checks) {
      results.push({
        id: `index:lance_${c.id}`,
        category: "index",
        status: c.status,
        message: c.message,
        action: c.action,
      });
    }
  } catch (e) {
    results.push({
      id: "index:lance_probe",
      category: "index",
      status: "fail",
      message: `LanceDB integrity check failed: ${e instanceof Error ? e.message : String(e)}`,
      action: "检查 lancePath 配置和目录权限",
    });
  } finally {
    if (db2) { try { db2.close(); } catch { /* ignore */ } }
  }

  return results;
}

// ── Check: Services ──

function checkServices(ctx: FirstRunContext): CheckResult[] {
  const results: CheckResult[] = [];

  if (!ctx.profileDir) {
    results.push({ id: "services:skip", category: "services", status: "pass", message: "skipped (no profile dir)" });
    return results;
  }

  // PID lock files
  let foundRunning = false;
  for (const transport of ["http", "stdio"] as const) {
    const pidFile = join(ctx.profileDir, `cbrain-${transport}.pid`);
    if (!existsSync(pidFile)) continue;

    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (!pid || !isProcessAlive(pid)) {
        results.push({
          id: `services:pidLock:${transport}`,
          category: "services",
          status: "warn",
          message: `stale PID file for ${transport} (PID ${pid} not running)`,
          action: `删除 ${pidFile} 或运行 cbrain serve`,
        });
      } else {
        foundRunning = true;
        results.push({
          id: `services:pidLock:${transport}`,
          category: "services",
          status: "pass",
          message: `CBrain ${transport} process running (PID ${pid})`,
        });
      }
    } catch {
      // Corrupt PID file — not critical
    }
  }

  // Watcher lock
  const watcherLock = new WatcherLock(ctx.profileDir);
  const owner = watcherLock.readOwner();
  if (owner) {
    if (isProcessAlive(owner.pid)) {
      foundRunning = true;
      results.push({
        id: "services:watcherLock",
        category: "services",
        status: "pass",
        message: `watcher running (PID ${owner.pid}, ${owner.transport})`,
      });
    } else {
      results.push({
        id: "services:watcherLock",
        category: "services",
        status: "fail",
        message: `stale watcher lock (PID ${owner.pid} not running)`,
        action: `删除 ${join(ctx.profileDir, ".watcher.lock")} 或运行 cbrain serve --http`,
      });
    }
  }

  if (!foundRunning && owner === null) {
    results.push({
      id: "services:none",
      category: "services",
      status: "pass",
      message: "no CBrain services running (normal for first-run)",
    });
  }

  return results;
}

// ── Check: Credentials ──

function checkCredentials(ctx: FirstRunContext): CheckResult[] {
  const envKey = process.env.ZHIPU_API_KEY;
  const configKey = ctx.config?.embedding?.apiKey;
  const hasCreds = !!(envKey || configKey);

  return [{
    id: "credentials:api_key",
    category: "credentials",
    status: hasCreds ? ("pass" as const) : ("fail" as const),
    message: hasCreds ? "ZHIPU_API_KEY available" : "ZHIPU_API_KEY not set",
    action: hasCreds ? undefined : "export ZHIPU_API_KEY=your-key 或在 cbrain.json 中设置 embedding.apiKey",
  }];
}

// ── Check: MCP Guidance ──

function checkMcp(_ctx: FirstRunContext): CheckResult[] {
  return [{
    id: "mcp:guidance",
    category: "mcp",
    status: "pass",
    message: "ready to connect Agent. Options:\n  cbrain serve          (stdio MCP for Claude Desktop)\n  cbrain serve --http   (HTTP MCP for remote agents, enables watcher)",
  }];
}

// ── Runner ──

export async function runFirstRunDoctor(): Promise<FirstRunReport> {
  const loaded = loadConfigSafe();
  const config = loaded?.config ?? null;
  const configPath = loaded?.configPath ?? null;
  const runtimePath = config ? resolveRuntimePath(config) : "";
  const profileDir = config ? dirname(resolve(config.dbPath)) : "";

  const ctx: FirstRunContext = { config, configPath, runtimePath, profileDir };

  const allChecks = await Promise.all([
    Promise.resolve(checkConfig(ctx)),
    Promise.resolve(checkPaths(ctx)),
    Promise.resolve(checkCredentials(ctx)),
    checkDatabase(ctx),
    checkIndexes(ctx),
    Promise.resolve(checkServices(ctx)),
    Promise.resolve(checkMcp(ctx)),
  ]);

  const checks = allChecks.flat();
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overallStatus: CheckStatus = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  const nextAction = deriveNextAction(checks);

  return {
    overallStatus,
    checks,
    recommendedNextAction: nextAction.message,
    nextAction,
    readinessState: deriveReadinessState(checks),
  };
}

// ── Next Action ──

function deriveNextAction(checks: ReadonlyArray<CheckResult>): NextAction {
  const failed = new Set(checks.filter((c) => c.status === "fail").map((c) => c.id));
  const warns = new Set(checks.filter((c) => c.status === "warn").map((c) => c.id));

  if (failed.has("config:exists") || failed.has("config:vaultPath") || failed.has("config:dbPath")) {
    return { id: "run_init", command: "cbrain init --dir <path>", message: "运行 cbrain init 创建配置" };
  }
  if (failed.has("credentials:api_key")) {
    return { id: "set_credentials", command: "export ZHIPU_API_KEY=your-key", message: "设置 ZHIPU_API_KEY 环境变量" };
  }
  if (failed.has("db:open")) {
    return { id: "run_init", command: "cbrain init --dir <path>", message: "检查 dbPath 配置和目录权限" };
  }
  if (failed.has("paths:vaultExists")) {
    return { id: "fix_paths", command: "cbrain init --dir <path>", message: "创建 vault 目录或检查 cbrain.json 中的 vaultPath" };
  }
  if (failed.has("services:watcherLock")) {
    return { id: "serve", command: "cbrain serve --http", message: "清理 stale watcher lock 后运行 cbrain serve --http" };
  }

  const hasLanceFail = failed.has("index:lance_probe") || [...failed].some(id => id.startsWith("index:lance_") && checks.find(c => c.id === id)?.status === "fail");
  if (hasLanceFail) {
    return { id: "sync_index", command: "cbrain sync", message: "LanceDB 索引损坏，按 doctor 输出的修复步骤操作后运行 cbrain sync" };
  }

  const hasLanceWarn = [...warns].some(id => id.startsWith("index:lance_"));
  if (warns.has("db:tables") || warns.has("index:fts5") || hasLanceWarn) {
    return { id: "sync_index", command: "cbrain sync", message: "运行 cbrain sync 索引你的 vault" };
  }

  // Check if a service is already active
  const svcActive = checks.some(c =>
    (c.id.startsWith("services:pidLock:") || c.id === "services:watcherLock") && c.status === "pass",
  );
  if (svcActive) {
    return { id: "serve", command: "cbrain serve", message: "CBrain 服务正在运行" };
  }

  return { id: "mcp_config", command: "cbrain mcp-config", message: "准备就绪！运行 cbrain mcp-config 获取 Agent 连接配置" };
}

// ── Readiness State ──

function deriveReadinessState(checks: ReadonlyArray<CheckResult>): ReadinessState {
  const failed = new Set(checks.filter((c) => c.status === "fail").map((c) => c.id));
  const warns = new Set(checks.filter((c) => c.status === "warn").map((c) => c.id));

  if (failed.has("config:exists")) return "no_config";
  if (failed.has("credentials:api_key")) return "missing_creds";

  const svcActive = checks.some(c =>
    (c.id.startsWith("services:pidLock:") || c.id === "services:watcherLock") && c.status === "pass",
  );
  if (svcActive) return "service_active";

  const hasLanceFail = [...failed].some(id => id.startsWith("index:lance_"));
  const hasLanceWarn = [...warns].some(id => id.startsWith("index:lance_"));
  if (warns.has("db:tables") || warns.has("index:fts5") || hasLanceFail || hasLanceWarn) return "missing_index";

  return "ready";
}

// ── Formatters ──

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
};

export function formatHuman(report: FirstRunReport): string {
  const lines: string[] = ["", "First-Run Readiness Check", ""];

  const categories = new Map<string, CheckResult[]>();
  for (const check of report.checks) {
    const existing = categories.get(check.category) ?? [];
    existing.push(check);
    categories.set(check.category, existing);
  }

  const categoryLabels: Record<string, string> = {
    config: "Config",
    paths: "Paths",
    credentials: "Credentials",
    db: "Database",
    index: "Index",
    services: "Services",
    mcp: "Next Steps",
  };

  for (const [cat, checks] of categories) {
    lines.push(`  ${categoryLabels[cat] ?? cat}`);
    for (const check of checks) {
      const icon = check.status === "pass" && check.id.includes("none") || check.id === "mcp:guidance"
        ? "→"
        : STATUS_ICON[check.status];
      lines.push(`    ${icon}  ${check.message.split("\n")[0]}`);
      // Multi-line messages (MCP guidance)
      for (const line of check.message.split("\n").slice(1)) {
        lines.push(`       ${line}`);
      }
      if (check.action) {
        lines.push(`       → ${check.action}`);
      }
    }
    lines.push("");
  }

  const failCount = report.checks.filter((c) => c.status === "fail").length;
  const warnCount = report.checks.filter((c) => c.status === "warn").length;

  if (failCount > 0) {
    lines.push(`  Result: FAIL (${failCount} failure${failCount > 1 ? "s" : ""}, ${warnCount} warning${warnCount > 1 ? "s" : ""})`);
  } else if (warnCount > 0) {
    lines.push(`  Result: PASS (${warnCount} warning${warnCount > 1 ? "s" : ""})`);
  } else {
    lines.push("  Result: PASS");
  }

  lines.push("");

  if (report.nextAction?.message) {
    lines.push(`  Next: ${report.nextAction.message}`);
    if (report.nextAction.command) {
      lines.push(`    ${report.nextAction.command}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatJson(report: FirstRunReport): string {
  return JSON.stringify(report, null, 2);
}
