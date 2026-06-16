/**
 * Rollback safety for vault sync (#185).
 *
 * LanceDB has no cross delete/add transaction, and `ContentPipeline.writeIndexes()`
 * mutates Lance + SQLite chunks/FTS non-atomically. This module snapshots the
 * pre-sync durable state of a page's index (raw + L1 Lance rows WITH vectors,
 * SQLite raw chunks, L1 summary) and restores the EXACT old bytes on failure.
 *
 * Mirrors the exact-vector snapshot/verify/restore discipline from
 * lance-page-rebuild (#182): never re-embed as a substitute for restoring the
 * real vectors; verify after restore; surface a structured recovery-required
 * error if compensation itself fails.
 */
import type { CBrainDB } from "../storage/sqlite.js";
import type { LanceDBManager, RawVectorRow } from "../storage/lancedb.js";

/**
 * Redact filesystem paths and credential-like tokens from a message before it
 * flows into watcher logs / Agent-facing report details (#185 privacy).
 * Raw errors are retained on the error object's internal fields; only the
 * human/log-facing `message` is sanitized.
 */
// Absolute Unix path with at least one separator (e.g. /tmp/secret/x.sqlite).
// Relative slugs like "records/x" do NOT start with "/", so they are preserved.
const ABS_PATH_RE = /\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+/g;
// Credential-like tokens: API key prefixes, bearer tokens, 40+ hex (sha/git/aws).
const CRED_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]+|[A-Fa-f0-9]{40,}|AKIA[0-9A-Z]{16})\b/g;

export function sanitizeForLog(input: string): string {
  return input.replace(ABS_PATH_RE, "<path>").replace(CRED_RE, "<redacted>");
}

/** Thrown when a sync fails AND the compensating rollback could not fully
 *  restore consistency. Callers (watcher/Hermes) must treat as reindex-required. */
export class SyncRollbackError extends Error {
  readonly code = "SYNC_ROLLBACK_INCOMPLETE";
  readonly recoveryRequired = true;
  readonly originalError: Error;
  readonly rollbackErrors: Error[];
  constructor(originalError: Error, rollbackErrors: Error[]) {
    const details = rollbackErrors.map((e) => sanitizeForLog(e.message)).join("; ");
    super(
      `SYNC_ROLLBACK_INCOMPLETE: original=${sanitizeForLog(originalError.message)}; rollback failures=[${details}]; reindex required`,
    );
    this.name = "SyncRollbackError";
    this.originalError = originalError;
    this.rollbackErrors = rollbackErrors;
  }
}

/** Thrown when the pre-mutation index snapshot of an EXISTING page cannot be
 *  read (unreadable/missing Lance table, transient read error). Fail-closed:
 *  the sync MUST abort before any durable mutation rather than proceed against
 *  an empty baseline that would make later compensation destroy real vectors.
 *  Structured `code` lets watcher/ops flag recovery without string matching. */
export class SyncSnapshotError extends Error {
  readonly code = "SYNC_SNAPSHOT_FAILED";
  readonly recoveryRequired = true;
  constructor(
    readonly slug: string,
    readonly readError: Error,
  ) {
    super(
      `SYNC_SNAPSHOT_FAILED: cannot read existing index snapshot for "${slug}"; sync aborted before mutation, recovery required — ${sanitizeForLog(readError.message)}`,
    );
    this.name = "SyncSnapshotError";
  }
}

/** A captured SQLite raw chunk. */
interface ChunkSnapshot {
  readonly chunkIndex: number;
  readonly content: string;
}

/** Full durable snapshot of a page's index state before mutation. */
export interface IndexSnapshot {
  readonly slug: string;
  readonly rawRows: RawVectorRow[];
  readonly l1Rows: RawVectorRow[];
  readonly sqliteRawChunks: ChunkSnapshot[];
  readonly l1Summary: { content: string; contentHash: string | null } | null;
}

/** Result of a restore attempt. */
export interface RestoreResult {
  readonly ok: boolean;
  readonly errors: Error[];
}

/**
 * Snapshot everything writeIndexes() can mutate for a page.
 *
 * `exists` distinguishes a genuinely new page from an existing one:
 *  - existing page (exists=true): a Lance read failure is fail-closed — it
 *    throws SyncSnapshotError so the sync aborts BEFORE any mutation rather
 *    than proceeding against an empty baseline (which would let a later write
 *    failure delete real vectors or claim rollback success against nothing).
 *  - new page (exists=false): no prior vectors exist, so a missing table /
 *    unreadable read (incl. test mocks) correctly yields an empty snapshot.
 */
export async function snapshotIndexState(
  db: CBrainDB,
  lance: LanceDBManager,
  slug: string,
  exists: boolean,
): Promise<IndexSnapshot> {
  let rawRows: RawVectorRow[] = [];
  let l1Rows: RawVectorRow[] = [];
  try {
    rawRows = await lance.readRawVectorRows(slug);
  } catch (e) {
    if (exists) throw new SyncSnapshotError(slug, e instanceof Error ? e : new Error(String(e)));
    // new page: missing table / mock — no prior vectors, empty baseline is correct.
  }
  try {
    l1Rows = await lance.readL1VectorRows(slug);
  } catch (e) {
    if (exists) throw new SyncSnapshotError(slug, e instanceof Error ? e : new Error(String(e)));
  }

  const sqliteRawChunks = db
    .getChunksByPage(slug, { summaryLevel: 0 })
    .map((c) => ({ chunkIndex: c.chunk_index, content: c.content }));

  const l1 = db.getL1Summary(slug);
  return {
    slug,
    rawRows,
    l1Rows,
    sqliteRawChunks,
    l1Summary: l1 ? { content: l1.content, contentHash: l1.content_hash } : null,
  };
}

function vectorsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Restore the snapshot: rewrite Lance raw (+ L1 if present) and SQLite chunks/FTS,
 * then verify the live state matches the snapshot exactly. Returns ok=false
 * (never throws) when restore or verify fails; the caller decides whether to
 * raise SyncRollbackError.
 */
export async function restoreIndexState(
  db: CBrainDB,
  lance: LanceDBManager,
  slug: string,
  snap: IndexSnapshot,
): Promise<RestoreResult> {
  if (slug !== snap.slug) {
    return { ok: false, errors: [new Error(`slug mismatch: param=${slug} snap=${snap.slug}`)] };
  }

  const errors: Error[] = [];

  // LanceDB has no cross delete/add transaction, so each restore step below is
  // non-atomic — a partial restore can leave the index briefly inconsistent.
  // That transient window is acceptable because vault sync is single-threaded
  // (no concurrent reader), and the verify steps (4 & 5) catch any partial
  // restore and return { ok: false } → caller surfaces SyncRollbackError.

  // 1. Restore Lance raw rows (exact vectors).
  try {
    await lance.deleteRawChunksByPageSlug(slug);
    if (snap.rawRows.length > 0) {
      await lance.addChunks(
        snap.rawRows.map((r) => ({
          pageSlug: r.pageSlug,
          chunkIndex: r.chunkIndex,
          content: r.content,
          vector: r.vector,
        })),
      );
    }
  } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }

  // 2. Restore Lance L1 rows (exact vectors) if the snapshot had any.
  if (snap.l1Rows.length > 0) {
    try {
      await lance.deleteL1VectorByPageSlug(slug);
      await lance.addChunks(
        snap.l1Rows.map((r) => ({
          pageSlug: r.pageSlug,
          chunkIndex: r.chunkIndex,
          content: r.content,
          vector: r.vector,
        })),
      );
    } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
  }

  // 3. Restore SQLite chunks + FTS in one transaction (mirror of writeIndexes).
  try {
    db.transaction(() => {
      db.deleteChunksByPage(slug);
      db.ftsDeleteByPage(slug);
      db.deleteL1Summary(slug);
      for (const c of snap.sqliteRawChunks) db.insertChunk(slug, c.chunkIndex, c.content);
      if (snap.sqliteRawChunks.length > 0) {
        db.ftsInsert(slug, snap.sqliteRawChunks.map((c) => c.content).join("\n\n"));
      }
      if (snap.l1Summary) {
        db.insertChunkWithLevel(slug, -1, snap.l1Summary.content, 1, snap.l1Summary.contentHash);
        db.ftsInsert(slug, snap.l1Summary.content);
      }
    });
  } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }

  if (errors.length > 0) return { ok: false, errors };

  // 4. Verify Lance raw rows match the snapshot exactly (count, content, vectors).
  try {
    const after = await lance.readRawVectorRows(slug);
    if (after.length !== snap.rawRows.length) {
      return { ok: false, errors: [new Error(`raw row count ${after.length} != ${snap.rawRows.length}`)] };
    }
    const byIndex = new Map(after.map((r) => [r.chunkIndex, r]));
    for (const o of snap.rawRows) {
      const got = byIndex.get(o.chunkIndex);
      if (!got || got.content !== o.content || !vectorsEqual(got.vector, o.vector)) {
        return { ok: false, errors: [new Error(`raw mismatch at chunk ${o.chunkIndex}`)] };
      }
    }
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e : new Error(String(e))] };
  }

  // 5. Verify Lance L1 rows match the snapshot exactly (count, content, vectors).
  if (snap.l1Rows.length > 0) {
    try {
      const l1After = await lance.readL1VectorRows(slug);
      if (l1After.length !== snap.l1Rows.length) {
        return { ok: false, errors: [new Error(`L1 row count ${l1After.length} != ${snap.l1Rows.length}`)] };
      }
      const l1ByIndex = new Map(l1After.map((r) => [r.chunkIndex, r]));
      for (const o of snap.l1Rows) {
        const got = l1ByIndex.get(o.chunkIndex);
        if (!got || got.content !== o.content || !vectorsEqual(got.vector, o.vector)) {
          return { ok: false, errors: [new Error(`L1 mismatch at chunk ${o.chunkIndex}`)] };
        }
      }
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e : new Error(String(e))] };
    }
  }

  // 6. Verify SQLite raw chunks match the snapshot (count, chunkIndex, content).
  try {
    const afterChunks = db.getChunksByPage(slug, { summaryLevel: 0 });
    if (afterChunks.length !== snap.sqliteRawChunks.length) {
      return { ok: false, errors: [new Error(`sqlite chunk count ${afterChunks.length} != ${snap.sqliteRawChunks.length}`)] };
    }
    const chunkByIndex = new Map(afterChunks.map((c) => [c.chunk_index, c.content]));
    for (const c of snap.sqliteRawChunks) {
      if (chunkByIndex.get(c.chunkIndex) !== c.content) {
        return { ok: false, errors: [new Error(`sqlite chunk mismatch at index ${c.chunkIndex}`)] };
      }
    }
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e : new Error(String(e))] };
  }

  // 7. Verify SQLite L1 summary matches the snapshot (presence/content/hash).
  try {
    const l1After = db.getL1Summary(slug);
    if (snap.l1Summary) {
      if (!l1After || l1After.content !== snap.l1Summary.content || l1After.content_hash !== snap.l1Summary.contentHash) {
        return { ok: false, errors: [new Error("sqlite L1 summary content/hash mismatch")] };
      }
    } else if (l1After) {
      return { ok: false, errors: [new Error("sqlite L1 summary unexpectedly present after restore")] };
    }
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e : new Error(String(e))] };
  }

  // 8. Verify FTS rows match the snapshot (old content recalled, no replacement residue).
  try {
    const ftsContents = db.getFtsContentsByPage(slug);
    const expected = new Set<string>();
    if (snap.sqliteRawChunks.length > 0) {
      expected.add(snap.sqliteRawChunks.map((c) => c.content).join("\n\n"));
    }
    if (snap.l1Summary) expected.add(snap.l1Summary.content);
    const actual = new Set(ftsContents);
    if (actual.size !== expected.size || [...expected].some((e) => !actual.has(e))) {
      return { ok: false, errors: [new Error(`fts rows mismatch: ${actual.size} present, expected ${expected.size}`)] };
    }
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e : new Error(String(e))] };
  }

  return { ok: true, errors: [] };
}
