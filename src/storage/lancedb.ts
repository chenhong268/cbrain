import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import type { Data } from "@lancedb/lancedb";

export interface ChunkData {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  vector?: Float32Array;
}

export interface InsightVectorData {
  id: number;
  content: string;
  vector?: Float32Array;
}

export interface SearchResult {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  _distance?: number;
}

export interface InsightSearchResult {
  id: number;
  content: string;
  _distance?: number;
}

export const VECTOR_DIMENSIONS = 2048;

export const CHUNKS_SCHEMA = new Schema([
  new Field("pageSlug", new Utf8(), false),
  new Field("chunkIndex", new Int32(), false),
  new Field("content", new Utf8(), false),
  new Field(
    "vector",
    new FixedSizeList(VECTOR_DIMENSIONS, new Field("item", new Float32(), false)),
    false
  ),
]);

export const INSIGHTS_SCHEMA = new Schema([
  new Field("id", new Int32(), false),
  new Field("content", new Utf8(), false),
  new Field(
    "vector",
    new FixedSizeList(VECTOR_DIMENSIONS, new Field("item", new Float32(), false)),
    false
  ),
]);

/**
 * Raised when a strict open is requested for a table that does not exist.
 * Recovery paths MUST NOT silently create a missing live table — this error
 * lets the caller classify the situation as "physical damage → use full rebuild".
 */
export class LanceTableMissingError extends Error {
  constructor(tableName: string) {
    super(`LANCE_TABLE_MISSING: table "${tableName}" does not exist`);
    this.name = "LanceTableMissingError";
  }
}

/** A raw chunk row read back from LanceDB, including its embedded vector. */
export interface RawVectorRow {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  vector: Float32Array;
}

/** Normalize whatever Arrow hands back for a FixedSizeList vector into Float32Array. */
function normalizeVector(v: unknown): Float32Array {
  if (v instanceof Float32Array) return v;
  if (v instanceof Float64Array) return Float32Array.from(v);
  if (Array.isArray(v)) return Float32Array.from(v as number[]);
  if (v && typeof v === "object") {
    const obj = v as { toArray?: unknown; [Symbol.iterator]?: unknown };
    if (typeof obj.toArray === "function") {
      return normalizeVector((obj.toArray as () => unknown).call(v));
    }
    if (typeof obj[Symbol.iterator] === "function") {
      return Float32Array.from(v as Iterable<number>);
    }
  }
  return new Float32Array(0);
}

export class LanceDBManager {
  private db: lancedb.Connection | null = null;
  private tables: Map<string, lancedb.Table> = new Map();

  async connect(path: string): Promise<void> {
    this.db = await lancedb.connect(path);
  }

  private tableInits = new Map<string, Promise<lancedb.Table>>();

  private async getOrCreateTable(name: string, schema: Schema): Promise<lancedb.Table> {
    const cached = this.tables.get(name);
    if (cached) return cached;

    let pending = this.tableInits.get(name);
    if (!pending) {
      pending = this.initTable(name, schema);
      this.tableInits.set(name, pending);
    }
    return pending;
  }

  private async initTable(name: string, schema: Schema): Promise<lancedb.Table> {
    if (!this.db) throw new Error("LanceDB not connected. Call connect() first.");

    const tableNames = await this.db.tableNames();
    let table: lancedb.Table;
    if (tableNames.includes(name)) {
      table = await this.db.openTable(name);
    } else {
      table = await this.db.createTable(name, [], { schema, mode: "create" });
    }
    this.tables.set(name, table);
    return table;
  }

  // ─── Warmup ────────────────────────────────────────────────────

  async warmup(): Promise<{ tables: string[]; elapsedMs: number }> {
    const start = Date.now();
    const loaded: string[] = [];

    const chunksTable = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);
    loaded.push("chunks");

    try {
      await this.getOrCreateTable("insights", INSIGHTS_SCHEMA);
      loaded.push("insights");
    } catch {
      // insights table may not exist yet — not critical
    }

    try {
      await chunksTable.search(new Float32Array(VECTOR_DIMENSIONS)).limit(1).toArray();
    } catch {
      // Empty table — search fails, that's fine
    }

    return { tables: loaded, elapsedMs: Date.now() - start };
  }

  // ─── Chunks table ──────────────────────────────────────────────

  async addChunks(chunks: ChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);

    const records: Data = chunks.map((chunk) => ({
      pageSlug: chunk.pageSlug,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      vector: chunk.vector ?? new Float32Array(VECTOR_DIMENSIONS),
    }));

    await table.add(records);
  }

  async search(queryVector: number[] | Float32Array, limit: number = 10): Promise<SearchResult[]> {
    const table = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);

    const query = table
      .search(queryVector)
      .limit(limit)
      .select(["pageSlug", "chunkIndex", "content", "_distance"]);

    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => ({
      pageSlug: row.pageSlug as string,
      chunkIndex: row.chunkIndex as number,
      content: row.content as string,
      _distance: row._distance as number | undefined,
    }));
  }

  async deleteByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);
    await table.delete(`pageSlug = '${pageSlug.replace(/'/g, "''")}'`);
  }

  async getIndexedPageSlugs(): Promise<string[]> {
    try {
      const table = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);
      const rows = await table.query().select(["pageSlug"]).toArray();
      return [...new Set(rows.map((r: Record<string, unknown>) => r.pageSlug as string))];
    } catch {
      return [];
    }
  }

  async deleteRawChunksByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);
    const escaped = pageSlug.replace(/'/g, "''");
    await table.delete(`pageSlug = '${escaped}' AND chunkIndex >= 0`);
  }

  async deleteL1VectorByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable("chunks", CHUNKS_SCHEMA);
    const escaped = pageSlug.replace(/'/g, "''");
    await table.delete(`pageSlug = '${escaped}' AND chunkIndex = -1`);
  }

  // ─── Per-page recovery (safe single-page vector rebuild) ──────────────────
  //
  // These methods are the narrow API used by the recovery core. They NEVER
  // silently create the chunks table — `openChunksStrict` throws a classified
  // error if it is absent, so a damaged/missing live index surfaces as
  // `fallback_required` instead of a fake-success empty table.

  /**
   * Strictly open the existing `chunks` table. Throws `LanceTableMissingError`
   * (classified, safe to catch) when the table does not exist — never creates it.
   * Caches the table so subsequent recovery reads/deletes/adds reuse the handle.
   */
  async openChunksStrict(): Promise<lancedb.Table> {
    if (!this.db) throw new Error("LanceDB not connected. Call connect() first.");

    const cached = this.tables.get("chunks");
    if (cached) return cached;

    const tableNames = await this.db.tableNames();
    if (!tableNames.includes("chunks")) {
      throw new LanceTableMissingError("chunks");
    }
    const table = await this.db.openTable("chunks");
    this.tables.set("chunks", table);
    return table;
  }

  /**
   * Read this page's raw rows (`chunkIndex >= 0`) WITH their vectors, ordered by
   * `chunkIndex`. Used to snapshot rows before a replace and to verify after.
   * Escapes the slug in the filter predicate.
   */
  async readRawVectorRows(pageSlug: string): Promise<RawVectorRow[]> {
    const table = await this.openChunksStrict();
    const escaped = pageSlug.replace(/'/g, "''");
    const rows = await table
      .query()
      .where(`pageSlug = '${escaped}' AND chunkIndex >= 0`)
      .select(["pageSlug", "chunkIndex", "content", "vector"])
      .toArray();
    return (rows as Array<Record<string, unknown>>)
      .map((r) => ({
        pageSlug: r.pageSlug as string,
        chunkIndex: Number(r.chunkIndex),
        content: r.content as string,
        vector: normalizeVector(r.vector),
      }))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  /**
   * Read this page's L1 rows (`chunkIndex === -1`) for before/after verification.
   * Content only (no vector needed for an integrity check).
   */
  async readL1Rows(
    pageSlug: string,
  ): Promise<Array<{ pageSlug: string; chunkIndex: number; content: string }>> {
    const table = await this.openChunksStrict();
    const escaped = pageSlug.replace(/'/g, "''");
    const rows = await table
      .query()
      .where(`pageSlug = '${escaped}' AND chunkIndex = -1`)
      .select(["pageSlug", "chunkIndex", "content"])
      .toArray();
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      pageSlug: r.pageSlug as string,
      chunkIndex: Number(r.chunkIndex),
      content: r.content as string,
    }));
  }

  // ─── Insights table ────────────────────────────────────────────

  async addInsightVector(data: InsightVectorData): Promise<void> {
    const table = await this.getOrCreateTable("insights", INSIGHTS_SCHEMA);
    await table.add([{
      id: data.id,
      content: data.content,
      vector: data.vector ?? new Float32Array(VECTOR_DIMENSIONS),
    }]);
  }

  async searchInsights(queryVector: number[] | Float32Array, limit: number = 10): Promise<InsightSearchResult[]> {
    const table = await this.getOrCreateTable("insights", INSIGHTS_SCHEMA);

    const query = table
      .search(queryVector)
      .limit(limit)
      .select(["id", "content", "_distance"]);

    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      content: row.content as string,
      _distance: row._distance as number | undefined,
    }));
  }

  async deleteInsightVector(id: number): Promise<void> {
    const table = await this.getOrCreateTable("insights", INSIGHTS_SCHEMA);
    await table.delete(`id = ${id}`);
  }

  // ─── Maintenance ───────────────────────────────────────────────

  /** Milliseconds of old version retention after compaction. */
  static readonly COMPACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  async compact(): Promise<{ tables: string[]; fragmentsRemoved: number; fragmentsAdded: number; bytesRemoved: number; filesRemoved: number }> {
    if (!this.db) throw new Error("LanceDB not connected");
    const tableNames = await this.db.tableNames();
    let fragmentsRemoved = 0;
    let fragmentsAdded = 0;
    let bytesRemoved = 0;
    let filesRemoved = 0;

    for (const name of tableNames) {
      const tbl = await this.db.openTable(name);

      // Capture row count before optimize for post-compaction validation.
      const countBefore = await tbl.countRows();

      // Retain old versions for 7 days so a corrupt compaction can be rolled back.
      // deleteUnverified: false protects files that may belong to in-progress
      // transactions from being deleted prematurely.
      const stats = await tbl.optimize({
        cleanupOlderThan: new Date(Date.now() - LanceDBManager.COMPACT_RETENTION_MS),
        deleteUnverified: false,
      });

      // Post-optimize integrity check: verify row count is preserved and the
      // table is still readable. A mismatch indicates a corrupt compaction.
      const countAfter = await tbl.countRows();
      if (countBefore !== countAfter) {
        throw new Error(
          `LanceDB compact integrity failure on table "${name}": `
          + `row count changed from ${countBefore} to ${countAfter}. `
          + "Old versions are retained for rollback.",
        );
      }

      fragmentsRemoved += stats.compaction.fragmentsRemoved;
      fragmentsAdded += stats.compaction.fragmentsAdded;
      bytesRemoved += stats.prune?.bytesRemoved ?? 0;
      filesRemoved += stats.compaction.filesRemoved;
      this.tables.set(name, tbl);
    }

    return { tables: tableNames, fragmentsRemoved, fragmentsAdded, bytesRemoved, filesRemoved };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async close(): Promise<void> {
    for (const table of this.tables.values()) {
      table.close();
    }
    this.tables.clear();
    this.db = null;
  }
}
