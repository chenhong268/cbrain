import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rewriteVaultLinks } from "./shared.js";
import type { CBrainDB } from "../storage/sqlite.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import type { Logger } from "./logger.js";

const LANCE_PENDING_DELETE_KEY = "page_delete.lance_pending";

export interface SafeDeleteDeps {
  db: CBrainDB;
  vaultPath: string;
  lance?: LanceDBManager;
  logger?: Logger;
}

export interface SafeDeleteResult {
  /** Vault + SQLite source-of-truth delete completed. */
  committed: boolean;
  /** Derived LanceDB cleanup succeeded. */
  lanceCleaned: boolean;
  /** LanceDB cleanup failed; vectors may linger and a pending-delete audit was recorded. */
  lanceRepairRequired: boolean;
}

/** Injectable destructive ops (tests pass failing versions). Defaults use real fs + rewriteVaultLinks. */
export interface DeleteOps {
  rewriteLinks: (slug: string) => number;
  unlink: (absPath: string) => void;
}

/** Raised when a delete failed AND the compensating restore could not fully revert. Recovery required. */
export class PageDeleteRollbackError extends Error {
  readonly original: Error;
  readonly restoreErrors: Error[];
  constructor(original: Error, restoreErrors: Error[]) {
    super(
      `PAGE_DELETE_ROLLBACK_INCOMPLETE: original=${original.message}; ` +
      `restoreFailures=${restoreErrors.length}; recovery required`,
    );
    this.name = "PageDeleteRollbackError";
    this.original = original;
    this.restoreErrors = restoreErrors;
  }
}

interface FileSnapshot {
  path: string;
  bytes: Buffer | null; // null = file did not exist pre-delete
}

function defaultOps(deps: SafeDeleteDeps): DeleteOps {
  return {
    rewriteLinks: (slug) => rewriteVaultLinks(deps.vaultPath, [{ oldSlug: slug }], deps.db),
    unlink: unlinkSync,
  };
}

/** Snapshot original bytes of every vault file the delete will touch (target + dead-link candidates). */
function snapshotAffectedFiles(slug: string, deps: SafeDeleteDeps): FileSnapshot[] {
  const snaps: FileSnapshot[] = [];
  const pushIfNew = (p: string): void => {
    if (snaps.some((s) => s.path === p)) return;
    snaps.push({ path: p, bytes: existsSync(p) ? readFileSync(p) : null });
  };
  const targetRel = deps.db.getPageFilePath(slug);
  if (targetRel) pushIfNew(join(deps.vaultPath, targetRel));
  // Mirror rewriteVaultLinks' candidate discovery exactly.
  const short = slug.split("/").pop()!;
  for (const s of deps.db.findSlugsByText([`[[${slug}]]`, `[[${short}]]`])) {
    const rel = deps.db.getPageFilePath(s);
    if (rel) pushIfNew(join(deps.vaultPath, rel));
  }
  return snaps;
}

/** Restore snapshotted files to their pre-delete bytes. Returns any errors (never throws). */
function restoreFiles(snaps: FileSnapshot[]): Error[] {
  const errors: Error[] = [];
  for (const s of snaps) {
    try {
      if (s.bytes === null) {
        if (existsSync(s.path)) unlinkSync(s.path);
      } else {
        writeFileSync(s.path, s.bytes);
      }
    } catch (e) {
      errors.push(e as Error);
    }
  }
  return errors;
}

function readLancePending(deps: SafeDeleteDeps): string[] {
  try {
    const raw = deps.db.getConfig(LANCE_PENDING_DELETE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function setLancePending(deps: SafeDeleteDeps, slugs: string[]): void {
  try {
    if (slugs.length === 0) deps.db.deleteConfig(LANCE_PENDING_DELETE_KEY);
    else deps.db.setConfig(LANCE_PENDING_DELETE_KEY, JSON.stringify(slugs));
  } catch { /* best-effort audit */ }
}

/**
 * Staged, recoverable page deletion.
 *
 * Stages: (1) rewrite dead wikilinks in other vault files; (2) unlink the target file;
 * (3) atomic SQLite cascade delete = COMMIT POINT; (4) derived LanceDB cleanup.
 *
 * Before the commit point, any failure restores ALL snapshotted vault files and rethrows
 * (the SQLite transaction rolls itself back). Past the commit point the source-of-truth
 * delete is durable; a Lance failure is recorded as repair-required, never a resurrection.
 */
export async function safeDeletePage(
  slug: string,
  deps: SafeDeleteDeps,
  ops: DeleteOps = defaultOps(deps),
): Promise<SafeDeleteResult> {
  const targetRel = deps.db.getPageFilePath(slug);
  if (targetRel === null) {
    return { committed: false, lanceCleaned: false, lanceRepairRequired: false };
  }

  const snaps = snapshotAffectedFiles(slug, deps);
  const restoreOrFail = (original: Error): never => {
    const restoreErrors = restoreFiles(snaps);
    if (restoreErrors.length) throw new PageDeleteRollbackError(original, restoreErrors);
    throw original;
  };

  // Stage 1 — rewrite dead links in other vault files.
  try {
    const rewritten = ops.rewriteLinks(slug);
    if (rewritten > 0) deps.logger?.info("page", "死链已清理", { slug });
  } catch (e) {
    restoreOrFail(e as Error);
  }

  // Stage 2 — remove target vault file.
  const targetAbs = join(deps.vaultPath, targetRel);
  try {
    if (existsSync(targetAbs)) ops.unlink(targetAbs);
  } catch (e) {
    restoreOrFail(e as Error);
  }

  // Stage 3 — atomic SQLite cascade delete (COMMIT POINT).
  try {
    deps.db.deletePageCascaded(slug);
  } catch (e) {
    restoreOrFail(e as Error);
  }

  // Past here: vault + SQLite source-of-truth delete is durable. Never resurrect.

  // Stage 4 — derived LanceDB cleanup. Failure is repair-required, not a rollback.
  let lanceCleaned = false;
  let lanceRepairRequired = false;
  if (deps.lance) {
    try {
      await deps.lance.deleteByPageSlug(slug);
      lanceCleaned = true;
      setLancePending(deps, readLancePending(deps).filter((s) => s !== slug));
    } catch {
      lanceRepairRequired = true;
      const pending = readLancePending(deps);
      if (!pending.includes(slug)) setLancePending(deps, [...pending, slug]);
      deps.logger?.warn("page", "删除部分完成：向量清理失败，已记录待修复", { slug });
    }
  }

  return { committed: true, lanceCleaned, lanceRepairRequired };
}
