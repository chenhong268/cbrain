/**
 * Atomic LanceDB index rebuilder.
 *
 * Builds a fresh index in a staging directory, verifies it matches SQLite
 * source data exactly, then atomically swaps with the live directory.
 * Never touches live data until the replacement is verified and complete.
 *
 * Tables rebuilt:
 *   - `chunks`    from SQLite chunks (all summary_levels: L0 raw + L1 summary)
 *   - `insights`  from SQLite insights (status = 'active')
 *
 * Invariants:
 *   - Any embedding, write, or verification error → abort, clean staging, live untouched
 *   - Empty SQLite + existing live → no-op
 *   - Staging row counts must exactly match SQLite source counts
 *   - No partial success: all-or-nothing
 */
import { existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";
import type { CBrainDB } from "./sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { EmbeddingResult } from "../embedding/provider.js";
import { assertStorableVector, vectorIndexIdentity, vectorSchemas, writeIndexIdentity, DOCUMENT_ENCODING_VERSION } from "./lance-identity.js";
import type { VectorIndexIdentity } from "./lance-identity.js";
import { normalizeVector } from "./lancedb.js";

// ── Types ───────────────────────────────────────────────────

export interface RebuildResult {
  /** Number of pages whose chunks were successfully rebuilt */
  readonly chunksRebuilt: number;
  /** Number of insight vectors rebuilt */
  readonly insightsRebuilt: number;
  /** Always 0 on success; on throw, check error message */
  readonly errors: number;
  readonly errorDetails: readonly string[];
  /** Path to backup of old live directory, or null */
  readonly backupPath: string | null;
  /**
   * #545: true when nothing was rebuilt because SQLite held no source data.
   * The live index (and its identity) were kept as-is — a no-op is NOT a model
   * migration and must never be reported as one.
   */
  readonly noOp: boolean;
}

/** Filesystem operations — injectable for testing */
export interface FsOps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, opts: { recursive: boolean }): void;
}

const defaultFs: FsOps = { existsSync, mkdirSync, renameSync, rmSync };

export type RebuildProgressPhase = "chunks" | "insights";

export interface RebuildProgress {
  readonly phase: RebuildProgressPhase;
  readonly processed: number;
  readonly total: number;
  readonly batch: number;
  readonly batches: number;
}

export interface RebuildOptions {
  readonly chunkBatchSize?: number;
  readonly insightBatchSize?: number;
  readonly onProgress?: (progress: RebuildProgress) => void;
  /**
   * #545: identity of the embedding model producing these vectors. Written into
   * the staging directory after verification, so the new index always carries
   * the model that built it (and a failed rebuild changes nothing).
   */
  readonly identity?: VectorIndexIdentity;
}

export const DEFAULT_REBUILD_BATCH_SIZE = 256;

function normalizeBatchSize(value: number | undefined, label: string): number {
  const size = value ?? DEFAULT_REBUILD_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1) throw new Error(`${label} must be a positive integer`);
  return size;
}

function notifyProgress(observer: RebuildOptions["onProgress"], progress: RebuildProgress): void {
  if (!observer) return;
  try {
    observer(progress);
  } catch {
    // Observability must never decide whether an atomic recovery commits.
  }
}

async function embedInBatches<T>(input: {
  rows: readonly T[];
  content: (row: T) => string;
  embedding: EmbeddingProvider;
  batchSize: number;
  dimensions: number;
  phase: RebuildProgressPhase;
  onProgress?: RebuildOptions["onProgress"];
}): Promise<EmbeddingResult[]> {
  const out: EmbeddingResult[] = [];
  const batches = Math.ceil(input.rows.length / input.batchSize);
  for (let offset = 0; offset < input.rows.length; offset += input.batchSize) {
    const rows = input.rows.slice(offset, offset + input.batchSize);
    const embedded = await input.embedding.embedBatch(rows.map(input.content));
    if (embedded.length !== rows.length) {
      throw new Error(`EMBEDDING_COUNT_MISMATCH: ${input.phase} batch returned ${embedded.length}, expected ${rows.length}`);
    }
    // #545 R2: the staging schema is built from the provider's declared width, so
    // a provider that returns another width — or a NaN / Infinity / Float32
    // overflow value — must fail here, before any row reaches the table.
    for (const [index, result] of embedded.entries()) {
      assertStorableVector(result.embedding, input.dimensions, `${input.phase} provider row ${offset + index}`);
    }
    out.push(...embedded);
    const batch = Math.floor(offset / input.batchSize) + 1;
    notifyProgress(input.onProgress, {
      phase: input.phase,
      processed: Math.min(offset + rows.length, input.rows.length),
      total: input.rows.length,
      batch,
      batches,
    });
  }
  return out;
}

/**
 * #545 R2: check the vectors the staging index actually stores — not only the
 * ones the provider returned. Reading them back catches a store that silently
 * pads, truncates, or coerces a row. Paged, so a large index does not need a
 * second full copy of every vector in memory.
 */
async function verifyStoredVectors(input: {
  conn: lancedb.Connection;
  tableName: "chunks" | "insights";
  dimensions: number;
  expectedRows: number;
}): Promise<void> {
  const pageSize = 1024;
  const table = await input.conn.openTable(input.tableName);
  let verified = 0;
  for (let offset = 0; offset < input.expectedRows; offset += pageSize) {
    const rows = await table.query().select(["vector"]).limit(pageSize).offset(offset).toArray();
    if (rows.length === 0) break;
    rows.forEach((row, index) => {
      assertStorableVector(
        normalizeVector((row as Record<string, unknown>).vector),
        input.dimensions,
        `stored ${input.tableName} row ${offset + index}`,
      );
    });
    verified += rows.length;
  }
  if (verified !== input.expectedRows) {
    throw new Error(`VERIFY_FAIL: ${input.tableName} stored ${verified} vectors, expected ${input.expectedRows}`);
  }
}

// ── Main rebuilder ──────────────────────────────────────────

/**
 * Atomically rebuild the LanceDB index from SQLite data.
 *
 * 1. Check: empty SQLite + existing live → no-op
 * 2. Create staging directory
 * 3. Embed + write chunks table
 * 4. Embed + write insights table
 * 5. Verify staging matches SQLite exactly (row counts + key sets)
 * 6. Swap: live → backup, staging → live
 * 7. On any failure: clean staging, leave live untouched
 */
export async function rebuildLanceIndex(
  lancePath: string,
  db: CBrainDB,
  embedding: EmbeddingProvider,
  fs: FsOps = defaultFs,
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const chunkBatchSize = normalizeBatchSize(options.chunkBatchSize, "chunkBatchSize");
  const insightBatchSize = normalizeBatchSize(options.insightBatchSize, "insightBatchSize");
  // #545: the width comes from the provider that actually produces the vectors.
  const dimensions = embedding.dimensions;
  const schemas = vectorSchemas(dimensions);
  const identity = options.identity
    ? vectorIndexIdentity({ ...options.identity, dimensions, documentEncoding: DOCUMENT_ENCODING_VERSION })
    : null;
  // ── 0. Read source data from SQLite ──
  // #269: rebuild BOTH L0 raw chunks (summary_level = 0) AND L1 summary chunks
  // (summary_level = 1, chunk_index = -1). Filtering to L0 only silently dropped
  // every L1 summary vector on the directory swap, while the fsck probe (which
  // counts any row as coverage) reported the page as covered — a hidden regression.
  const chunkRows = db.rawDb.query(
    "SELECT page_slug, chunk_index, content FROM chunks WHERE summary_level IN (0, 1) ORDER BY page_slug, chunk_index",
  ).all() as Array<Record<string, unknown>>;

  const insightRows = db.rawDb.query(
    "SELECT id, content FROM insights WHERE status = 'active' ORDER BY id",
  ).all() as Array<Record<string, unknown>>;

  const hasSqliteData = chunkRows.length > 0 || insightRows.length > 0;
  const liveExists = fs.existsSync(lancePath);

  // ── No-op: empty SQLite ──
  if (!hasSqliteData) {
    if (liveExists) {
      // Don't replace a working live index with empty staging. The live index
      // keeps its own identity: this preserves an index, it does not migrate one.
      return {
        chunksRebuilt: 0, insightsRebuilt: 0, errors: 0,
        errorDetails: [], backupPath: null, noOp: true,
      };
    }
    // No data anywhere — create an empty live directory. No identity is written:
    // with no tables there is no index to describe yet. The identity is committed
    // when the first table is created and by the first real rebuild.
    fs.mkdirSync(lancePath, { recursive: true });
    return {
      chunksRebuilt: 0, insightsRebuilt: 0, errors: 0,
      errorDetails: [], backupPath: null, noOp: true,
    };
  }

  // ── 1. Create staging directory ──
  const stagingPath = `${lancePath}.rebuild-${randomUUID().slice(0, 8)}`;
  let stagingConn: lancedb.Connection | null = null;

  try {
    fs.mkdirSync(stagingPath, { recursive: true });
    stagingConn = await lancedb.connect(stagingPath);

    // ── 2. Build chunks table ──
    // SQLite already supplies deterministic (page_slug, chunk_index) order.
    // Batch across page boundaries so provider calls scale with chunks, not pages.
    const chunkEmbeddings = await embedInBatches({
      rows: chunkRows,
      content: (row) => row.content as string,
      embedding,
      batchSize: chunkBatchSize,
      dimensions,
      phase: "chunks",
      onProgress: options.onProgress,
    });
    const allChunkData = chunkRows.map((row, index) => ({
      pageSlug: row.page_slug as string,
      chunkIndex: row.chunk_index as number,
      content: row.content as string,
      vector: new Float32Array(chunkEmbeddings[index].embedding),
    }));
    const rebuiltPageCount = new Set(chunkRows.map((row) => row.page_slug as string)).size;

    if (allChunkData.length > 0) {
      await stagingConn.createTable("chunks", allChunkData, { schema: schemas.chunks, mode: "create" });
    }

    // ── 3. Build insights table ──
    if (insightRows.length > 0) {
      const embedResults = await embedInBatches({
        rows: insightRows,
        content: (row) => row.content as string,
        embedding,
        batchSize: insightBatchSize,
        dimensions,
        phase: "insights",
        onProgress: options.onProgress,
      });
      const insightData = insightRows.map((row, i) => ({
        id: row.id as number,
        content: row.content as string,
        vector: new Float32Array(embedResults[i].embedding),
      }));
      await stagingConn.createTable("insights", insightData, { schema: schemas.insights, mode: "create" });
    }

    // ── 4. Verify staging matches SQLite exactly ──
    const tables = await stagingConn.tableNames();

    // Verify chunks: row count + (pageSlug, chunkIndex) set
    if (chunkRows.length > 0) {
      if (!tables.includes("chunks")) {
        throw new Error("VERIFY_FAIL: chunks table missing from staging");
      }
      const chunksTable = await stagingConn.openTable("chunks");
      const stagingChunkCount = await chunksTable.countRows();
      if (stagingChunkCount !== chunkRows.length) {
        throw new Error(`VERIFY_FAIL: chunks staging has ${stagingChunkCount} rows, expected ${chunkRows.length}`);
      }
      // Verify key set
      // Include chunkIndex = -1 (L1 summary) rows so verification covers both
      // tiers — a >= 0 filter would let a missing-L1 rebuild pass verify.
      const stagingRows = await chunksTable.query()
        .select(["pageSlug", "chunkIndex"])
        .toArray();
      const stagingKeys = new Set(stagingRows.map((r: Record<string, unknown>) =>
        `${r.pageSlug}:${r.chunkIndex}`,
      ));
      const sqliteKeys = new Set(chunkRows.map(r => `${r.page_slug}:${r.chunk_index}`));
      if (stagingKeys.size !== sqliteKeys.size) {
        throw new Error(`VERIFY_FAIL: chunks key count ${stagingKeys.size} != ${sqliteKeys.size}`);
      }
      for (const key of sqliteKeys) {
        if (!stagingKeys.has(key)) {
          throw new Error(`VERIFY_FAIL: missing chunk key ${key} in staging`);
        }
      }
    }

    // Verify insights: row count + id set
    if (insightRows.length > 0) {
      if (!tables.includes("insights")) {
        throw new Error("VERIFY_FAIL: insights table missing from staging");
      }
      const insightsTable = await stagingConn.openTable("insights");
      const stagingInsightCount = await insightsTable.countRows();
      if (stagingInsightCount !== insightRows.length) {
        throw new Error(`VERIFY_FAIL: insights staging has ${stagingInsightCount} rows, expected ${insightRows.length}`);
      }
      const stagingInsightRows = await insightsTable.query()
        .select(["id"])
        .toArray();
      const stagingIds = new Set(stagingInsightRows.map((r: Record<string, unknown>) => r.id));
      const sqliteIds = new Set(insightRows.map(r => r.id));
      for (const id of sqliteIds) {
        if (!stagingIds.has(id)) {
          throw new Error(`VERIFY_FAIL: missing insight id ${id} in staging`);
        }
      }
    }

    // #545 R2: validate the vectors staging actually stores, not only the ones
    // the provider returned, before anything can be committed.
    if (chunkRows.length > 0) {
      await verifyStoredVectors({ conn: stagingConn, tableName: "chunks", dimensions, expectedRows: chunkRows.length });
    }
    if (insightRows.length > 0) {
      await verifyStoredVectors({ conn: stagingConn, tableName: "insights", dimensions, expectedRows: insightRows.length });
    }

    // #545: commit the model identity only after staging verified. It travels
    // with the directory swap, so a failed build leaves the old index and its
    // own identity in place.
    if (identity) writeIndexIdentity(stagingPath, identity);

    // Close staging before filesystem operations
    stagingConn.close();
    stagingConn = null;

    // ── 5. Atomic swap ──
    const backupPath = liveExists
      ? `${lancePath}.backup-${Date.now()}-${randomUUID().slice(0, 4)}`
      : null;

    if (liveExists) {
      fs.renameSync(lancePath, backupPath!);
      try {
        fs.renameSync(stagingPath, lancePath);
      } catch (swapErr) {
        // Rollback: restore backup
        try {
          fs.renameSync(backupPath!, lancePath);
        } catch (rollbackErr) {
          throw new Error(
            `SWAP_FAILED_AND_ROLLBACK_FAILED: swap=${swapErr instanceof Error ? swapErr.message : String(swapErr)}, rollback=${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}` +
            `\n  live=${lancePath}` +
            `\n  backup=${backupPath}` +
            `\n  staging=${stagingPath}` +
            `\n  Recovery: mv "${backupPath}" "${lancePath}"`,
          );
        }
        throw new Error(`SWAP_FAILED_ROLLED_BACK: ${swapErr instanceof Error ? swapErr.message : String(swapErr)}`);
      }
    } else {
      fs.renameSync(stagingPath, lancePath);
    }

    return {
      chunksRebuilt: rebuiltPageCount,
      insightsRebuilt: insightRows.length,
      errors: 0,
      errorDetails: [],
      backupPath,
      noOp: false,
  };
  } finally {
    // Always clean up: close staging conn + remove staging dir if it still exists
    if (stagingConn) { try { stagingConn.close(); } catch { /* ignore */ } }
    try {
      if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true });
    } catch { /* ignore */ }
  }
}
