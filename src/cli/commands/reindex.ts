/**
 * Per-page vector recovery CLI handlers (#182).
 *
 * Extracted from `maintenance.ts` for testability. Two entry points share the
 * same `rebuildPageVectors` core:
 *   - `cbrain sync --slug <slug> --reindex`           → handleReindexSlug
 *   - `cbrain sync --reindex-quarantined`             → handleReindexQuarantined
 *
 * Both refuse to run while a live CBrain process (serve/watcher) holds the
 * index, never fake success, and emit only anonymized/sanitized output.
 */
import type { CBrainDB } from "../../storage/sqlite.js";
import type { EmbeddingProvider } from "../../embedding/provider.js";
import type { LanceDBManager } from "../../storage/lancedb.js";
import {
  rebuildPageVectors,
  classifyQuarantineFault,
  anonymizeSlug,
  sanitizeError,
} from "../../storage/lance-page-rebuild.js";
import { PidLock } from "../../utils/pid-lock.js";
import { WatcherLock } from "../../utils/watcher-lock.js";

const QUARANTINE_CONFIG_KEY = "watcher.quarantine";

// ── Option resolution ───────────────────────────────────────────────────

export interface SyncOptions {
  slug?: string;
  reindex?: boolean;
  reindexVectors?: boolean;
  reindexQuarantined?: boolean;
}

export type SyncMode =
  | "sync-all"
  | "sync-slug"
  | "reindex-vectors"
  | "reindex-slug"
  | "reindex-quarantined";

export type ResolveResult = { ok: true; mode: SyncMode } | { ok: false; message: string };

/**
 * Resolve the sync command's mutually-exclusive modes. Recovery flags must not
 * be combined with each other or with plain sync flags; ambiguous combos are
 * rejected rather than guessed.
 */
export function resolveSyncMode(opts: SyncOptions): ResolveResult {
  const { slug, reindex, reindexVectors, reindexQuarantined } = opts;

  if (reindexQuarantined) {
    if (slug) return fail("--reindex-quarantined 不能与 --slug 同时使用");
    if (reindex) return fail("--reindex-quarantined 不能与 --reindex 同时使用");
    if (reindexVectors) return fail("--reindex-quarantined 不能与 --reindex-vectors 同时使用");
    return { ok: true, mode: "reindex-quarantined" };
  }
  if (reindex) {
    if (!slug) return fail("--reindex 必须配合 --slug <page-slug> 使用");
    if (reindexVectors) return fail("--reindex 不能与 --reindex-vectors 同时使用");
    return { ok: true, mode: "reindex-slug" };
  }
  if (reindexVectors) {
    if (slug) return fail("--reindex-vectors 重建整个索引，不能指定 --slug");
    return { ok: true, mode: "reindex-vectors" };
  }
  return { ok: true, mode: slug ? "sync-slug" : "sync-all" };
}

function fail(message: string): ResolveResult {
  return { ok: false, message };
}

/** Coarse, privacy-safe category for a non-vector quarantine fault (no raw content/titles). */
function nonVectorCategory(lastError: string): string {
  if (/title.?collision|duplicate.?title/i.test(lastError)) return "title collision";
  if (/frontmatter|yaml|parse/i.test(lastError)) return "frontmatter/parse";
  if (/enoent|no such file|not found|missing/i.test(lastError)) return "missing file";
  return "structural";
}

// ── Live-index lock probe ───────────────────────────────────────────────

export interface BlockingOwner {
  kind: "serve" | "watcher";
  pid: number;
}

export interface LockProbe {
  /** Returns the active process holding the live index, or null if it is free. */
  blockingOwner(): BlockingOwner | null;
}

/** Build a production lock probe from the profile dir (checks http+stdio serve + watcher). */
export function createLiveLockProbe(profileDir: string): LockProbe {
  return {
    blockingOwner(): BlockingOwner | null {
      // Scan BOTH the plain pid file and any lock-id-suffixed pid files that
      // `serve` writes under `CBRAIN_LOCK_ID` — the unsuffixed check alone misses
      // a serve running with a custom lock id, which still holds the live index.
      for (const transport of ["http", "stdio"] as const) {
        const pids = PidLock.scanActiveOwnerPids(profileDir, transport);
        if (pids.length > 0) return { kind: "serve", pid: pids[0] };
      }
      const watcher = new WatcherLock(profileDir);
      if (watcher.isLocked()) {
        const owner = watcher.readOwner();
        return { kind: "watcher", pid: owner?.pid ?? 0 };
      }
      return null;
    },
  };
}

// ── --slug --reindex ────────────────────────────────────────────────────

export interface ReindexSlugDeps {
  db: CBrainDB;
  lance: LanceDBManager;
  embedding: EmbeddingProvider;
  pageSlug: string;
  lancePath: string;
  lockProbe: LockProbe;
}

export async function handleReindexSlug(
  deps: ReindexSlugDeps,
  log: (m: string) => void = console.log,
  logError: (m: string) => void = console.error,
): Promise<number> {
  // Whole handler lifecycle is one try/finally so EVERY exit path — lock
  // refusal, connect failure, normal end, thrown error — closes DB/Lance.
  try {
    const owner = deps.lockProbe.blockingOwner();
    if (owner) {
      logError(
        `已拒绝：检测到活动的 CBrain ${owner.kind}（pid ${owner.pid}）。请先停止服务再执行单页向量恢复。`,
      );
      return 1;
    }

    await deps.lance.connect(deps.lancePath);
    const r = await rebuildPageVectors({
      db: deps.db,
      lance: deps.lance,
      embedding: deps.embedding,
      pageSlug: deps.pageSlug,
      lancePath: deps.lancePath,
    });
    return reportSingleResult(r, log, logError);
  } catch (e) {
    logError(`单页向量恢复异常：${sanitizeError(e)}`);
    return 1;
  } finally {
    try { deps.db.close(); } catch { /* best effort */ }
    try {
      await deps.lance.close();
    } catch {
      /* best effort */
    }
  }
}

function reportSingleResult(
  r: Awaited<ReturnType<typeof rebuildPageVectors>>,
  log: (m: string) => void,
  logError: (m: string) => void,
): number {
  switch (r.status) {
    case "rebuilt":
      log(`✅ 已重建 ${r.chunkCount} 个 raw chunk（${r.anonymizedSlug}）`);
      return 0;
    case "skipped":
      log(`⏭ 跳过（${r.anonymizedSlug}）：${r.reason ?? "n/a"}`);
      return 1;
    case "aborted_unchanged":
      // Preflight (embedding) failure BEFORE any live mutation. The live index
      // was never touched, so this is NOT a rollback — say so explicitly.
      logError(`⚠ 中止（${r.anonymizedSlug}）：${r.reason}。live 索引未修改`);
      return 1;
    case "fallback_required":
      logError(`⚠ 需全量重建（${r.anonymizedSlug}）：${r.reason}。请改用 cbrain sync --reindex-vectors`);
      return 1;
    case "failed_rolled_back":
      logError(`⚠ 失败已回滚（${r.anonymizedSlug}）：${r.reason}。原向量已恢复`);
      return 1;
    case "rollback_failed":
      logError(`🚨 失败且回滚未完成（${r.anonymizedSlug}）：${r.reason}。live 索引可能不一致，请用 cbrain sync --reindex-vectors`);
      return 1;
  }
}

// ── --reindex-quarantined ───────────────────────────────────────────────

export interface ReindexQuarantinedDeps {
  db: CBrainDB;
  lance: LanceDBManager;
  embedding: EmbeddingProvider;
  lancePath: string;
  lockProbe: LockProbe;
}

export interface QuarantinedRebuildSummary {
  rebuilt: string[];
  skipped: string[];
  failed: string[];
  fallback: string[];
}

export async function handleReindexQuarantined(
  deps: ReindexQuarantinedDeps,
  log: (m: string) => void = console.log,
  logError: (m: string) => void = console.error,
): Promise<number> {
  // Whole handler lifecycle is one try/finally so EVERY exit path — lock
  // refusal, no/empty config, corrupt JSON, connect failure, partial run —
  // closes DB/Lance.
  try {
    const owner = deps.lockProbe.blockingOwner();
    if (owner) {
      logError(`已拒绝：检测到活动的 CBrain ${owner.kind}（pid ${owner.pid}）。请先停止服务再执行隔离恢复。`);
      return 1;
    }

    const raw = deps.db.getConfig(QUARANTINE_CONFIG_KEY);
    if (raw === null || raw.trim() === "") {
      log("无隔离项。");
      return 0;
    }

    // Strict parse: top level must be a plain object, not an array/string/number.
    // A structurally-valid-but-wrong-typed value is treated as corrupt (config
    // left byte-for-byte unchanged) rather than as an empty set.
    let parsed: Record<string, unknown>;
    try {
      const p: unknown = JSON.parse(raw);
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("not an object");
      parsed = p as Record<string, unknown>;
    } catch {
      logError("已拒绝：watcher.quarantine 配置 JSON 损坏，未做任何修改。请先排查或清理该配置。");
      return 1;
    }

    const slugs = Object.keys(parsed);
    if (slugs.length === 0) {
      log("无隔离项。");
      return 0;
    }

    const summary: QuarantinedRebuildSummary = { rebuilt: [], skipped: [], failed: [], fallback: [] };

    await deps.lance.connect(deps.lancePath);

    for (const slug of slugs) {
      const entry = parsed[slug];
      // Strict per-entry validation: a malformed entry (null/string/array, or
      // missing/non-string lastError) must NOT abort the batch — record it as
      // failed, keep it quarantined, and continue with the remaining items.
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        summary.failed.push(slug);
        logError(`⚠ 失败（${anonymizeSlug(slug)}）：隔离项格式损坏，需人工排查`);
        continue;
      }
      const lastErrorRaw = (entry as Record<string, unknown>).lastError;
      if (typeof lastErrorRaw !== "string") {
        summary.failed.push(slug);
        logError(`⚠ 失败（${anonymizeSlug(slug)}）：隔离项格式损坏，需人工排查`);
        continue;
      }
      // Only vector-class faults are recoverable by per-page reindex.
      if (!classifyQuarantineFault(lastErrorRaw)) {
        summary.skipped.push(slug);
        log(`⏭ 跳过（${anonymizeSlug(slug)}）：非向量故障（${nonVectorCategory(lastErrorRaw)}），需人工处理`);
        continue;
      }
      // Per-item core; one failure must not abort the remaining items.
      try {
        const r = await rebuildPageVectors({
          db: deps.db,
          lance: deps.lance,
          embedding: deps.embedding,
          pageSlug: slug,
          lancePath: deps.lancePath,
        });
        switch (r.status) {
          case "rebuilt":
            summary.rebuilt.push(slug);
            log(`✅ 已重建（${r.anonymizedSlug}，${r.chunkCount} chunk）`);
            break;
          case "skipped":
            summary.skipped.push(slug);
            log(`⏭ 跳过（${r.anonymizedSlug}）：${r.reason ?? "n/a"}`);
            break;
          case "fallback_required":
            summary.fallback.push(slug);
            logError(`⚠ 需全量重建（${r.anonymizedSlug}）：${r.reason}`);
            break;
          case "aborted_unchanged":
            // Embedding failed before any live change — transient, keep quarantined.
            summary.failed.push(slug);
            logError(`⚠ 中止（${r.anonymizedSlug}）：${r.reason}。隔离已保留，可稍后重试`);
            break;
          default:
            // failed_rolled_back | rollback_failed
            summary.failed.push(slug);
            logError(`⚠ 失败（${r.anonymizedSlug}）：${r.reason ?? r.status}`);
            break;
        }
      } catch (e) {
        summary.failed.push(slug);
        logError(`⚠ 失败（${anonymizeSlug(slug)}）：${sanitizeError(e)}`);
      }
    }

    // Release ONLY rebuilt slugs: re-read current config (preserve concurrent
    // changes), remove rebuilt, single atomic write. Never release_all.
    if (summary.rebuilt.length > 0) {
      releaseRebuilt(deps.db, summary.rebuilt, log, logError);
    }

    const remaining = summary.skipped.length + summary.failed.length + summary.fallback.length;
    log(
      `\n汇总：重建 ${summary.rebuilt.length}，跳过 ${summary.skipped.length}，失败 ${summary.failed.length}，需全量 ${summary.fallback.length}`,
    );
    if (remaining > 0) log(`仍有 ${remaining} 个隔离项未修复`);

    // Partial success (not every item rebuilt) → non-zero.
    return summary.rebuilt.length === slugs.length ? 0 : 1;
  } catch (e) {
    logError(`隔离恢复异常：${sanitizeError(e)}`);
    return 1;
  } finally {
    try { deps.db.close(); } catch { /* best effort */ }
    try {
      await deps.lance.close();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Remove only the rebuilt slugs from the quarantine config. Re-reads first so
 * concurrent additions survive; writes once. Deletes the key only when empty
 * (i.e. every quarantined item was rebuilt — never a blind release_all).
 */
function releaseRebuilt(
  db: CBrainDB,
  rebuiltSlugs: string[],
  log: (m: string) => void,
  logError: (m: string) => void,
): void {
  const current = db.getConfig(QUARANTINE_CONFIG_KEY);
  if (current === null) return; // already cleared externally
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(current) as Record<string, unknown>;
  } catch {
    logError("⚠ 释放隔离项时配置已损坏，未更新；已重建项请手动确认。");
    return;
  }
  const before = Object.keys(map).length;
  for (const slug of rebuiltSlugs) delete map[slug];
  const after = Object.keys(map).length;
  if (after === 0) {
    db.deleteConfig(QUARANTINE_CONFIG_KEY);
  } else {
    db.setConfig(QUARANTINE_CONFIG_KEY, JSON.stringify(map));
  }
  log(`已释放 ${before - after} 个已重建隔离项`);
}
