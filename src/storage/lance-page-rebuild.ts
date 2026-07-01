/**
 * Safe per-page vector recovery (#182).
 *
 * Rebuilds a single page's raw-chunk (`summary_level = 0`) vectors in the LIVE
 * LanceDB index, without a full `--reindex-vectors` rebuild. Designed for ops
 * recovery when only a few pages are quarantined.
 *
 * LanceDB has no cross delete/add transaction, so this uses a manual safety
 * sequence: pre-embed everything → snapshot existing rows (with vectors) →
 * delete+add → verify → on any failure, restore the snapshot. It never fakes
 * success: every failure path returns a structured status describing what
 * happened and what the operator should do next.
 *
 * Design rules (from issue #182):
 *   - Never silently create a missing live `chunks` table → `fallback_required`.
 *   - Pre-embed ALL chunks before touching LanceDB → embedding failure = zero live changes.
 *   - Preserve L1 (`chunkIndex = -1`) rows; only raw rows are replaced.
 *   - Rollback restores the EXACT old rows (re-embedding could drift otherwise).
 *   - User-facing output is anonymized + sanitized (no paths, credentials, stacks).
 */
import type { CBrainDB } from "./sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import {
  LanceTableMissingError,
  type LanceDBManager,
  type RawVectorRow,
} from "./lancedb.js";

// ── Public types ────────────────────────────────────────────────────────

export type RebuildStatus =
  | "rebuilt"
  | "skipped"
  | "aborted_unchanged"
  | "fallback_required"
  | "failed_rolled_back"
  | "rollback_failed";

export interface PageVectorRebuildResult {
  /** Outcome category — drives CLI exit code and quarantine release. */
  readonly status: RebuildStatus;
  /** Number of raw chunks rebuilt (0 on any non-rebuilt status). */
  readonly chunkCount: number;
  /** Anonymized, stable identifier for output — never the raw slug/path. */
  readonly anonymizedSlug: string;
  /** Sanitized, actionable reason. No paths, credentials, or stack traces. */
  readonly reason?: string;
}

export interface RebuildPageVectorsDeps {
  readonly db: CBrainDB;
  readonly lance: LanceDBManager;
  readonly embedding: EmbeddingProvider;
  readonly pageSlug: string;
  /** Live LanceDB path — used only to suggest the full-rebuild fallback, never printed raw. */
  readonly lancePath: string;
}

// ── Quarantine fault classification ─────────────────────────────────────

/**
 * Decide whether a quarantine entry's `lastError` describes a vector/embedding/
 * Lance/index fault (recoverable by per-page reindex) vs a non-vector fault
 * (title collision, frontmatter/parse error, missing file) that per-page
 * reindex cannot fix and must NOT release.
 *
 * Conservative: when a non-vector signal is present, returns false even if a
 * vector keyword also appears — never pretend a structural fault is vector-fixable.
 */
const NON_VECTOR_FAULT_RE =
  /title.?collision|duplicate.?title|frontmatter|bad.?yaml|parse|enoent|no such file|not found|encoding|invalid utf/i;
const VECTOR_FAULT_RE =
  /embed|embedding|lance|lancedb|vector|dimension|\bindex\b|abort|timeout|429|500|502|503|rate.?limit|network/i;

export function classifyQuarantineFault(lastError: string): boolean {
  if (!lastError) return false;
  if (NON_VECTOR_FAULT_RE.test(lastError)) return false;
  return VECTOR_FAULT_RE.test(lastError);
}

// ── Main state machine ──────────────────────────────────────────────────

export async function rebuildPageVectors(
  deps: RebuildPageVectorsDeps,
): Promise<PageVectorRebuildResult> {
  const { db, lance, embedding, pageSlug } = deps;
  const anon = anonymizeSlug(pageSlug);

  // Step 1: page must exist in SQLite.
  if (!db.getPage(pageSlug)) {
    return skipped(anon, "page not found in SQLite");
  }

  // Step 2: read raw chunks (summary_level = 0), ordered by chunk_index.
  const rawChunks = db
    .getChunksByPage(pageSlug, { summaryLevel: 0 })
    .sort((a, b) => a.chunk_index - b.chunk_index);
  if (rawChunks.length === 0) {
    return skipped(anon, "page has no raw chunks");
  }

  // Step 3: pre-embed ALL chunks. No LanceDB mutation in this phase, so any
  // failure here leaves the live index 100% untouched. That is NOT a rollback
  // (nothing was changed) — report `aborted_unchanged` so the operator is not
  // told a rollback happened that never did.
  let embedResults: Array<{ embedding: number[] }>;
  try {
    embedResults = await embedding.embedBatch(rawChunks.map((c) => c.content));
  } catch (e) {
    return abortedUnchanged(anon, `embedding failed: ${sanitizeError(e)}`);
  }

  // Validate embedding count, dimensions, and chunk-index uniqueness.
  const dim = embedding.dimensions;
  if (embedResults.length !== rawChunks.length) {
    return abortedUnchanged(
      anon,
      `embedding count mismatch (${embedResults.length} != ${rawChunks.length})`,
    );
  }
  for (const r of embedResults) {
    if (!r.embedding || r.embedding.length !== dim) {
      return abortedUnchanged(anon, `embedding dimension mismatch (expected ${dim})`);
    }
  }
  const indexSet = new Set(rawChunks.map((c) => c.chunk_index));
  if (indexSet.size !== rawChunks.length) {
    return abortedUnchanged(anon, "duplicate chunk_index in SQLite");
  }

  // Prepare new rows (fully validated, ready to write).
  const newRows = rawChunks.map((c, i) => ({
    pageSlug,
    chunkIndex: c.chunk_index,
    content: c.content,
    vector: new Float32Array(embedResults[i].embedding),
  }));

  // Step 4: strict-open the live chunks table. Missing/unreadable → fallback.
  try {
    await lance.openChunksStrict();
  } catch (e) {
    if (e instanceof LanceTableMissingError) {
      return fallbackRequired(anon, "live chunks table missing");
    }
    return fallbackRequired(anon, `live chunks table unreadable: ${sanitizeError(e)}`);
  }

  // Step 5: snapshot existing raw rows (with vectors) + L1, BEFORE any mutation.
  let oldRows: RawVectorRow[];
  let l1Before: Array<{ content: string }>;
  try {
    oldRows = await lance.readRawVectorRows(pageSlug);
    l1Before = (await lance.readL1Rows(pageSlug)).map((r) => ({ content: r.content }));
  } catch (e) {
    return fallbackRequired(anon, `cannot read existing rows: ${sanitizeError(e)}`);
  }

  // Step 6: replace — delete target raw rows, then add the prepared new rows.
  try {
    await lance.deleteRawChunksByPageSlug(pageSlug);
    await lance.addChunks(newRows);
  } catch (e) {
    return await onWriteFailure(lance, pageSlug, anon, oldRows, l1Before, `write failed: ${sanitizeError(e)}`);
  }

  // Step 7: verify count, key set, content, and L1 integrity.
  const verify = await verifyResult(db, lance, pageSlug, l1Before);
  if (!verify.ok) {
    return await onWriteFailure(lance, pageSlug, anon, oldRows, l1Before, `verification failed: ${verify.reason}`);
  }

  return { status: "rebuilt", chunkCount: newRows.length, anonymizedSlug: anon };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Restore the snapshot, then report the appropriate status based on restore success. */
async function onWriteFailure(
  lance: LanceDBManager,
  pageSlug: string,
  anon: string,
  oldRows: RawVectorRow[],
  l1Before: Array<{ content: string }>,
  reason: string,
): Promise<PageVectorRebuildResult> {
  const restored = await tryRestore(lance, pageSlug, oldRows, l1Before);
  return restored
    ? failedRolledBack(anon, `${reason}; live rows restored`)
    : { status: "rollback_failed", chunkCount: 0, anonymizedSlug: anon, reason: `${reason}; RESTORE ALSO FAILED — high-risk state, inspect live index` };
}

/** Compare two float vectors strictly. The snapshot is already a Float32Array
 * read back from LanceDB; restoring writes those same Float32 values back, and
 * the re-read goes through the identical normalization path, so values are
 * expected to be bit-identical — a strict comparison catches any drift. */
function vectorsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Re-check L1 against the pre-write snapshot. A raw replace never touches L1
 * (`deleteRawChunksByPageSlug` only removes `chunkIndex >= 0`), so if L1 no
 * longer matches the snapshot it was damaged by the failed write. We cannot
 * restore it (no L1 vector snapshot) and must NOT pretend we did — the caller
 * treats `false` as `rollback_failed` and routes the operator to a full rebuild.
 */
async function l1Consistent(
  lance: LanceDBManager,
  pageSlug: string,
  l1Before: Array<{ content: string }>,
): Promise<boolean> {
  try {
    const l1After = (await lance.readL1Rows(pageSlug)).map((r) => r.content);
    if (l1After.length !== l1Before.length) return false;
    const beforeContent = new Set(l1Before.map((r) => r.content));
    for (const c of l1After) {
      if (!beforeContent.has(c)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort restore: clear the page's raw rows and re-add the snapshot.
 * Returns true ONLY if the restored key set, content, vectors (dimension +
 * values), AND L1 ALL still match the snapshot. Count/content/vector matching
 * alone is not enough:
 *   - a restore that lands wrong vectors would be silently reported as
 *     `failed_rolled_back` (a lie) → vector mismatch must fail;
 *   - a write that also damaged L1 cannot be repaired here (no L1 snapshot) →
 *     an L1 mismatch must surface as `rollback_failed`, not `failed_rolled_back`.
 */
async function tryRestore(
  lance: LanceDBManager,
  pageSlug: string,
  oldRows: RawVectorRow[],
  l1Before: Array<{ content: string }>,
): Promise<boolean> {
  try {
    await lance.deleteRawChunksByPageSlug(pageSlug);
    if (oldRows.length > 0) {
      await lance.addChunks(
        oldRows.map((r) => ({
          pageSlug: r.pageSlug,
          chunkIndex: r.chunkIndex,
          content: r.content,
          vector: r.vector,
        })),
      );
    }
    const restored = await lance.readRawVectorRows(pageSlug);
    if (restored.length !== oldRows.length) return false;
    const byIndex = new Map(restored.map((r) => [r.chunkIndex, r]));
    for (const o of oldRows) {
      const got = byIndex.get(o.chunkIndex);
      if (!got || got.content !== o.content) return false;
      if (!vectorsEqual(got.vector, o.vector)) return false;
    }
    // raw restored — but a COMPLETE rollback also requires L1 to still match.
    if (!(await l1Consistent(lance, pageSlug, l1Before))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Verify the post-write live state matches SQLite exactly, and L1 is unchanged. */
async function verifyResult(
  db: CBrainDB,
  lance: LanceDBManager,
  pageSlug: string,
  l1Before: Array<{ content: string }>,
): Promise<{ ok: boolean; reason?: string }> {
  let after: RawVectorRow[];
  try {
    after = await lance.readRawVectorRows(pageSlug);
  } catch {
    return { ok: false, reason: "post-write read failed" };
  }

  const sqlChunks = db.getChunksByPage(pageSlug, { summaryLevel: 0 });
  if (after.length !== sqlChunks.length) {
    return { ok: false, reason: `row count ${after.length} != ${sqlChunks.length}` };
  }
  const afterByIndex = new Map(after.map((r) => [r.chunkIndex, r.content]));
  for (const c of sqlChunks) {
    if (afterByIndex.get(c.chunk_index) !== c.content) {
      return { ok: false, reason: `content mismatch at chunk ${c.chunk_index}` };
    }
  }

  let l1After: Array<{ content: string }>;
  try {
    l1After = (await lance.readL1Rows(pageSlug)).map((r) => ({ content: r.content }));
  } catch {
    return { ok: false, reason: "L1 read failed" };
  }
  if (l1After.length !== l1Before.length) {
    return { ok: false, reason: "L1 row count changed" };
  }
  const beforeContent = new Set(l1Before.map((r) => r.content));
  for (const r of l1After) {
    if (!beforeContent.has(r.content)) return { ok: false, reason: "L1 content changed" };
  }

  return { ok: true };
}

// ── Output sanitization ─────────────────────────────────────────────────

/** Stable, anonymized page id for logs/output — never the raw slug or path. */
export function anonymizeSlug(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (Math.imul(h, 31) + slug.charCodeAt(i)) | 0;
  }
  return `page:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Strip paths, emails, API keys, and cap length. Never leak stack traces. */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const cleaned = raw
    .replace(/\/[\w./@-]+/g, "<path>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b(sk-|gl-|Bearer )[A-Za-z0-9]{8,}/g, "<key>")
    .replace(/\n[\s\S]*/g, ""); // drop anything after the first newline (stack-ish)
  return cleaned.slice(0, 200) || "unknown error";
}

function skipped(anon: string, reason: string): PageVectorRebuildResult {
  return { status: "skipped", chunkCount: 0, anonymizedSlug: anon, reason };
}
function abortedUnchanged(anon: string, reason: string): PageVectorRebuildResult {
  return { status: "aborted_unchanged", chunkCount: 0, anonymizedSlug: anon, reason };
}
function failedRolledBack(anon: string, reason: string): PageVectorRebuildResult {
  return { status: "failed_rolled_back", chunkCount: 0, anonymizedSlug: anon, reason };
}
function fallbackRequired(anon: string, reason: string): PageVectorRebuildResult {
  return { status: "fallback_required", chunkCount: 0, anonymizedSlug: anon, reason };
}
