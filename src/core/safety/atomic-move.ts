/**
 * Atomic file+DB move helpers for slug/type changes.
 * Shared by PageManager and maintenance CLI — do not duplicate.
 *
 * Sequence: stage temp file → DB transaction → publish (rename) → cleanup old file.
 * Any failure after DB mutation triggers compensation (single movePage call).
 * Non-ENOENT cleanup failures are thrown with preserved error details.
 */

/** Thrown when a move fails AND the compensating rollback also fails. */
export class RollbackIncompleteError extends Error {
  readonly primaryError: Error;
  readonly rollbackError: Error;
  constructor(primaryError: Error, rollbackError: Error) {
    super(
      `Rollback incomplete — primary: ${primaryError.message}; rollback: ${rollbackError.message}`,
    );
    this.name = "RollbackIncompleteError";
    this.primaryError = primaryError;
    this.rollbackError = rollbackError;
  }
}

/** Thrown when a move fails AND artifact cleanup also fails (non-ENOENT). */
export class CleanupIncompleteError extends Error {
  readonly primaryError: Error;
  readonly cleanupErrors: ReadonlyArray<{ path: string; error: Error }>;
  constructor(
    primaryError: Error,
    cleanupErrors: ReadonlyArray<{ path: string; error: Error }>,
  ) {
    const details = cleanupErrors
      .map((e) => `${e.path}: ${e.error.message}`)
      .join("; ");
    super(`${primaryError.message} (cleanup failed: ${details})`);
    this.name = "CleanupIncompleteError";
    this.primaryError = primaryError;
    this.cleanupErrors = cleanupErrors;
  }
}

/** Injectable filesystem operations for deterministic fault testing. */
export interface MoveFsOps {
  writeFileSync(path: string, content: string, encoding: BufferEncoding): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: boolean }): void;
}

/** Injectable DB operations needed by atomic moves. */
export interface MoveDbOps {
  movePage(
    oldSlug: string,
    newSlug: string,
    newType: string,
    newFilePath: string,
    contentHash?: string | null,
  ): void;
  updateTypeAndHash(
    slug: string,
    newType: string,
    contentHash: string | null,
  ): void;
}

/** Result of a file cleanup attempt. ENOENT = already gone = ok. */
export interface CleanResult {
  ok: boolean;
  error: Error | null;
}

let _seq = 0;

/** Generate a unique staging path to avoid concurrent collisions. */
export function stagingPath(target: string): string {
  return `${target}.staging.${process.pid}.${++_seq}`;
}

/**
 * Delete a file; ENOENT = already gone = success.
 * Returns CleanResult preserving actual error details (path, code, message).
 */
export function cleanFile(
  fs: { unlinkSync(path: string): void },
  path: string,
): CleanResult {
  try {
    fs.unlinkSync(path);
    return { ok: true, error: null };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { ok: true, error: null };
    }
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error };
  }
}

/** Parameters for atomicSlugChange. */
export interface SlugChangeParams {
  oldSlug: string;
  newSlug: string;
  newType: string;
  oldType: string;
  oldRelPath: string;
  oldHash: string | null;
  newRelPath: string;
  destAbsPath: string;
  oldAbsPath: string;
  stagedContent: string;
  newHash: string;
}

/**
 * Atomic slug-change move: stage → DB → publish → unlink old.
 *
 * Sequence:
 *   1. mkdir + writeFileSync(stagedPath)
 *   2. db.movePage (single transaction with hash)
 *   3. renameSync(stagedPath → destAbsPath)
 *   4. unlinkSync(oldAbsPath)
 *
 * Any failure after DB mutation triggers compensation.
 * Non-ENOENT cleanup failures throw CleanupIncompleteError with preserved details.
 */
export function atomicSlugChange(
  fs: MoveFsOps,
  db: MoveDbOps,
  params: SlugChangeParams,
): void {
  const stagedPath = stagingPath(params.destAbsPath);
  const destDir = params.destAbsPath.substring(
    0,
    params.destAbsPath.lastIndexOf("/"),
  );

  // Phase 1: Stage new file (never touch old file yet)
  if (fs.existsSync(params.destAbsPath)) {
    throw new Error(`atomicSlugChange: target file already exists: ${params.destAbsPath}`);
  }
  fs.mkdirSync(destDir, { recursive: true });

  try {
    fs.writeFileSync(stagedPath, params.stagedContent, "utf-8");
  } catch (writeErr) {
    const writeError =
      writeErr instanceof Error ? writeErr : new Error(String(writeErr));
    const stagingClean = cleanFile(fs, stagedPath);
    if (!stagingClean.ok) {
      throw new CleanupIncompleteError(writeError, [
        { path: stagedPath, error: stagingClean.error! },
      ]);
    }
    throw writeError;
  }

  // Phase 2: DB move + hash in single atomic transaction
  try {
    db.movePage(
      params.oldSlug,
      params.newSlug,
      params.newType,
      params.newRelPath,
      params.newHash,
    );
  } catch (dbErr) {
    const dbError = dbErr instanceof Error ? dbErr : new Error(String(dbErr));
    const stagingClean = cleanFile(fs, stagedPath);
    if (!stagingClean.ok) {
      throw new CleanupIncompleteError(dbError, [
        { path: stagedPath, error: stagingClean.error! },
      ]);
    }
    throw dbError;
  }

  // Phase 3: Publish staged file to final location
  try {
    fs.renameSync(stagedPath, params.destAbsPath);
  } catch (publishErr) {
    const publishError =
      publishErr instanceof Error
        ? publishErr
        : new Error(String(publishErr));
    compensateAndThrow(fs, db, {
      currentSlug: params.newSlug,
      targetSlug: params.oldSlug,
      targetType: params.oldType,
      targetRelPath: params.oldRelPath,
      targetHash: params.oldHash,
      stagedFilePath: stagedPath,
      destFilePath: params.destAbsPath,
      primaryError: publishError,
    });
    return; // compensateAndThrow always throws
  }

  // Phase 4: Delete old file — failure IS a failed move
  try {
    fs.unlinkSync(params.oldAbsPath);
  } catch (unlinkErr) {
    const unlinkError =
      unlinkErr instanceof Error ? unlinkErr : new Error(String(unlinkErr));
    try {
      db.movePage(
        params.newSlug,
        params.oldSlug,
        params.oldType,
        params.oldRelPath,
        params.oldHash,
      );
    } catch (compensateErr) {
      throw new RollbackIncompleteError(
        unlinkError,
        compensateErr instanceof Error
          ? compensateErr
          : new Error(String(compensateErr)),
      );
    }
    const destClean = cleanFile(fs, params.destAbsPath);
    if (!destClean.ok) {
      throw new CleanupIncompleteError(unlinkError, [
        { path: params.destAbsPath, error: destClean.error! },
      ]);
    }
    throw new Error(
      `atomicSlugChange: failed to delete old file, state restored: ${unlinkError.message}`,
    );
  }
}

/** Parameters for atomicTypeChange (same-slug type update). */
export interface TypeChangeParams {
  slug: string;
  oldType: string;
  oldHash: string | null;
  newType: string;
  absPath: string;
  stagedContent: string;
  newHash: string;
}

/**
 * Same-slug type change: stage temp → DB update → rename over original.
 *
 * If DB fails, temp is deleted and nothing changes.
 * If rename fails after DB success, DB is compensated back.
 * Non-ENOENT cleanup failures throw CleanupIncompleteError.
 */
export function atomicTypeChange(
  fs: MoveFsOps,
  db: MoveDbOps,
  params: TypeChangeParams,
): void {
  const tempPath = stagingPath(params.absPath);

  try {
    fs.writeFileSync(tempPath, params.stagedContent, "utf-8");
  } catch (writeErr) {
    const writeError =
      writeErr instanceof Error ? writeErr : new Error(String(writeErr));
    const tempClean = cleanFile(fs, tempPath);
    if (!tempClean.ok) {
      throw new CleanupIncompleteError(writeError, [
        { path: tempPath, error: tempClean.error! },
      ]);
    }
    throw writeError;
  }

  try {
    db.updateTypeAndHash(params.slug, params.newType, params.newHash);
  } catch (dbErr) {
    const dbError = dbErr instanceof Error ? dbErr : new Error(String(dbErr));
    const tempClean = cleanFile(fs, tempPath);
    if (!tempClean.ok) {
      throw new CleanupIncompleteError(dbError, [
        { path: tempPath, error: tempClean.error! },
      ]);
    }
    throw dbError;
  }

  try {
    fs.renameSync(tempPath, params.absPath);
  } catch (renameErr) {
    const renameError =
      renameErr instanceof Error ? renameErr : new Error(String(renameErr));
    try {
      db.updateTypeAndHash(params.slug, params.oldType, params.oldHash);
    } catch (compensateErr) {
      cleanFile(fs, tempPath); // ENOENT ok
      throw new RollbackIncompleteError(
        renameError,
        compensateErr instanceof Error
          ? compensateErr
          : new Error(String(compensateErr)),
      );
    }
    const tempClean = cleanFile(fs, tempPath);
    if (!tempClean.ok) {
      throw new CleanupIncompleteError(renameError, [
        { path: tempPath, error: tempClean.error! },
      ]);
    }
    throw renameError;
  }
}

/**
 * Compensate a failed publish: move DB back to old state, clean artifacts.
 * ENOENT on cleanup is success (file never existed or already gone).
 * Only non-ENOENT cleanup errors are thrown as CleanupIncompleteError.
 */
function compensateAndThrow(
  fs: MoveFsOps,
  db: MoveDbOps,
  params: {
    currentSlug: string;
    targetSlug: string;
    targetType: string;
    targetRelPath: string;
    targetHash: string | null;
    stagedFilePath: string;
    destFilePath: string;
    primaryError: Error;
  },
): never {
  try {
    db.movePage(
      params.currentSlug,
      params.targetSlug,
      params.targetType,
      params.targetRelPath,
      params.targetHash,
    );
  } catch (compensateErr) {
    cleanFile(fs, params.stagedFilePath); // ENOENT ok
    throw new RollbackIncompleteError(
      params.primaryError,
      compensateErr instanceof Error
        ? compensateErr
        : new Error(String(compensateErr)),
    );
  }
  const stagingClean = cleanFile(fs, params.stagedFilePath);
  const destClean = cleanFile(fs, params.destFilePath);
  const cleanupErrors: Array<{ path: string; error: Error }> = [];
  if (!stagingClean.ok)
    cleanupErrors.push({
      path: params.stagedFilePath,
      error: stagingClean.error!,
    });
  if (!destClean.ok)
    cleanupErrors.push({
      path: params.destFilePath,
      error: destClean.error!,
    });
  if (cleanupErrors.length > 0) {
    throw new CleanupIncompleteError(params.primaryError, cleanupErrors);
  }
  throw params.primaryError;
}
