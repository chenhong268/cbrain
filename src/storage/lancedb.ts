import * as lancedb from "@lancedb/lancedb";
import type { Data } from "@lancedb/lancedb";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertIndexIdentity,
  readIndexIdentity,
  vectorColumnDimensions,
  vectorSchemas,
  writeIndexIdentity,
  VectorIdentityError,
} from "./lance-identity.js";
import type { VectorIndexIdentity, VectorSchemaSet } from "./lance-identity.js";

export interface CompactReport {
  tables: string[];
  fragmentsRemoved: number;
  fragmentsAdded: number;
  bytesRemoved: number;
  filesRemoved: number;
  /** Sum of local file sizes; null means maintenance did not measure it. */
  diskBytesBefore: number | null;
  diskBytesAfter: number | null;
  /** After minus before: positive means growth, negative means reclaimed space. */
  diskBytesDelta: number | null;
}

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
  vector?: Float32Array;
}

export interface LanceSearchOptions {
  readonly includeVector?: boolean;
}

export interface InsightSearchResult {
  id: number;
  content: string;
  _distance?: number;
}

/**
 * Legacy width used only when a caller supplies no index identity (offline
 * probes, unit tests). Live paths derive the width from the embedding provider
 * via `vectorSchemas()` — see #545.
 */
export const VECTOR_DIMENSIONS = 2048;

/** Tables owned by the vector index. */
export type LanceTableName = "chunks" | "insights";

/** Options for a manager handle. */
export interface LanceManagerOptions {
  compactRetentionHours?: number;
  /**
   * Identity of the embedding model this handle is allowed to use. Omit only
   * for offline read-only callers (fsck probe, compact, unit tests); omitting
   * disables the model comparison but never the schema consistency check.
   */
  identity?: VectorIndexIdentity;
}

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
  private dbPath: string | null = null;
  private readonly compactRetentionMs: number;
  private tables: Map<string, lancedb.Table> = new Map();
  /** Expected model identity; null means "no provider context, schema check only". */
  private readonly expectedIdentity: VectorIndexIdentity | null;
  private storedIdentity: VectorIndexIdentity | null = null;
  private dimensions: number;
  private schemas: VectorSchemaSet;
  private identityCommitted = false;

  constructor(options: LanceManagerOptions = {}) {
    const hours = options.compactRetentionHours ?? LanceDBManager.COMPACT_RETENTION_MS / 3600_000;
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
      throw new Error("maintenance.compactRetentionHours must be between 1 and 168 hours");
    }
    this.compactRetentionMs = hours * 3600_000;
    this.expectedIdentity = options.identity ?? null;
    this.dimensions = this.expectedIdentity?.dimensions ?? VECTOR_DIMENSIONS;
    this.schemas = vectorSchemas(this.dimensions);
  }

  /** Vector width in use for this handle (from identity, else legacy default). */
  get vectorDimensions(): number {
    return this.dimensions;
  }

  async connect(path: string): Promise<void> {
    this.db = await lancedb.connect(path);
    this.dbPath = resolve(path);
    this.tables.clear();
    this.tableInits.clear();
    await this.verifyIndexOnConnect();
  }

  /**
   * #545: verify the stored identity and the on-disk schema before any read or
   * write. Fails closed on mismatch; never relabels or repairs an index.
   */
  private async verifyIndexOnConnect(): Promise<void> {
    if (!this.db || !this.dbPath) return;
    const tableNames = await this.db.tableNames();
    this.storedIdentity = readIndexIdentity(this.dbPath);

    if (tableNames.length === 0) {
      if (this.storedIdentity) {
        throw new VectorIdentityError(
          `LANCE_IDENTITY_ORPHANED: ${this.dbPath} has an index identity but no tables. `
          + "Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.",
        );
      }
      return;
    }

    // Every existing vector table must agree on the width; a mixed index means a
    // partially applied migration, which must never be read as if it were whole.
    let width: number | null = null;
    for (const name of ["chunks", "insights"] as const) {
      if (!tableNames.includes(name)) continue;
      const table = await this.db.openTable(name);
      this.tables.set(name, table);
      const dims = vectorColumnDimensions(await table.schema());
      if (dims === null) {
        throw new VectorIdentityError(
          `LANCE_IDENTITY_SCHEMA_MISMATCH: table "${name}" in ${this.dbPath} has no fixed-size vector column.`
          + " Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.",
        );
      }
      if (width === null) width = dims;
      else if (width !== dims) {
        throw new VectorIdentityError(
          `LANCE_IDENTITY_MIXED_SCHEMA: ${this.dbPath} mixes ${width}d and ${dims}d vector tables ("${name}").`
          + " A partially applied migration must be rebuilt. Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.",
        );
      }
    }

    assertIndexIdentity({
      indexPath: this.dbPath,
      expected: this.expectedIdentity,
      stored: this.storedIdentity,
      schemaDimensions: width,
    });

    // Adopt the verified width so creation of a missing sibling table cannot
    // introduce a width that contradicts the index already on disk.
    this.adoptDimensions(this.expectedIdentity?.dimensions ?? this.storedIdentity?.dimensions ?? VECTOR_DIMENSIONS);
  }

  private adoptDimensions(dimensions: number): void {
    if (dimensions === this.dimensions) return;
    this.dimensions = dimensions;
    this.schemas = vectorSchemas(dimensions);
  }

  private tableInits = new Map<string, Promise<lancedb.Table>>();

  private async getOrCreateTable(name: LanceTableName): Promise<lancedb.Table> {
    const cached = this.tables.get(name);
    if (cached) return cached;

    let pending = this.tableInits.get(name);
    if (!pending) {
      pending = this.initTable(name);
      this.tableInits.set(name, pending);
    }
    return pending;
  }

  private async initTable(name: LanceTableName): Promise<lancedb.Table> {
    if (!this.db) throw new Error("LanceDB not connected. Call connect() first.");

    const tableNames = await this.db.tableNames();
    let table: lancedb.Table;
    if (tableNames.includes(name)) {
      table = await this.db.openTable(name);
    } else {
      table = await this.db.createTable(name, [], { schema: this.schemas[name], mode: "create" });
      this.commitIdentityOnCreate();
    }
    this.tables.set(name, table);
    return table;
  }

  /**
   * A newly created index records the model that built it. Only called on the
   * creation path of a directory that held no tables, and only when this handle
   * knows which provider is configured.
   */
  private commitIdentityOnCreate(): void {
    if (this.identityCommitted || !this.expectedIdentity || this.storedIdentity || !this.dbPath) return;
    writeIndexIdentity(this.dbPath, this.expectedIdentity);
    this.storedIdentity = this.expectedIdentity;
    this.identityCommitted = true;
  }

  // ─── Warmup ────────────────────────────────────────────────────

  async warmup(): Promise<{ tables: string[]; elapsedMs: number }> {
    const start = Date.now();
    const loaded: string[] = [];

    const chunksTable = await this.getOrCreateTable("chunks");
    loaded.push("chunks");

    try {
      await this.getOrCreateTable("insights");
      loaded.push("insights");
    } catch {
      // insights table may not exist yet — not critical
    }

    try {
      await chunksTable.search(new Float32Array(this.dimensions)).limit(1).toArray();
    } catch {
      // Empty table — search fails, that's fine
    }

    return { tables: loaded, elapsedMs: Date.now() - start };
  }

  // ─── Chunks table ──────────────────────────────────────────────

  async addChunks(chunks: ChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getOrCreateTable("chunks");

    const records: Data = chunks.map((chunk) => ({
      pageSlug: chunk.pageSlug,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      vector: chunk.vector ?? new Float32Array(this.dimensions),
    }));

    await table.add(records);
  }

  async search(
    queryVector: number[] | Float32Array,
    limit: number = 10,
    options?: LanceSearchOptions,
  ): Promise<SearchResult[]> {
    const table = await this.getOrCreateTable("chunks");
    const columns = ["pageSlug", "chunkIndex", "content", "_distance"];
    if (options?.includeVector) columns.push("vector");

    const query = table
      .search(queryVector)
      .limit(limit)
      .select(columns);

    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => {
      const result: SearchResult = {
        pageSlug: row.pageSlug as string,
        chunkIndex: row.chunkIndex as number,
        content: row.content as string,
        _distance: row._distance as number | undefined,
      };
      if (options?.includeVector) result.vector = normalizeVector(row.vector);
      return result;
    });
  }

  async deleteByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable("chunks");
    await table.delete(`pageSlug = '${pageSlug.replace(/'/g, "''")}'`);
  }

  async getIndexedPageSlugs(): Promise<string[]> {
    try {
      const table = await this.getOrCreateTable("chunks");
      const rows = await table.query().select(["pageSlug"]).toArray();
      return [...new Set(rows.map((r: Record<string, unknown>) => r.pageSlug as string))];
    } catch {
      return [];
    }
  }

  async deleteRawChunksByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable("chunks");
    const escaped = pageSlug.replace(/'/g, "''");
    await table.delete(`pageSlug = '${escaped}' AND chunkIndex >= 0`);
  }

  async deleteL1VectorByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable("chunks");
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
    // connected ⇒ identity already verified; re-verify the width defensively.
    const table = await this.db.openTable("chunks");
    await this.assertStoredWidth(table);
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

  /**
   * Read this page's L1 rows (`chunkIndex === -1`) WITH their vectors, for
   * exact rollback of the empty-body writeIndexes path (which deletes L1
   * vectors). Mirrors readRawVectorRows but filters chunkIndex = -1.
   */
  async readL1VectorRows(pageSlug: string): Promise<RawVectorRow[]> {
    const table = await this.openChunksStrict();
    const escaped = pageSlug.replace(/'/g, "''");
    const rows = await table
      .query()
      .where(`pageSlug = '${escaped}' AND chunkIndex = -1`)
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

  // ─── Insights table ────────────────────────────────────────────

  async addInsightVector(data: InsightVectorData): Promise<void> {
    const table = await this.getOrCreateTable("insights");
    await table.add([{
      id: data.id,
      content: data.content,
      vector: data.vector ?? new Float32Array(this.dimensions),
    }]);
  }

  async searchInsights(queryVector: number[] | Float32Array, limit: number = 10): Promise<InsightSearchResult[]> {
    const table = await this.getOrCreateTable("insights");

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
    const table = await this.getOrCreateTable("insights");
    await table.delete(`id = ${id}`);
  }

  // ─── Maintenance ───────────────────────────────────────────────

  /** Milliseconds of old version retention after compaction. */
  static readonly COMPACT_RETENTION_MS = 6 * 60 * 60 * 1000;
  static readonly COMPACT_ROLLBACK_TAG = "cbrain-compact-rollback";

  private async measureDiskBytes(dir: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += await this.measureDiskBytes(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    }
    return total;
  }

  async compact(): Promise<CompactReport> {
    if (!this.db || !this.dbPath) throw new Error("LanceDB not connected");
    const diskBytesBefore = await this.measureDiskBytes(this.dbPath);
    const tableNames = await this.db.tableNames();
    let fragmentsRemoved = 0;
    let fragmentsAdded = 0;
    let bytesRemoved = 0;
    let filesRemoved = 0;

    for (const name of tableNames) {
      const tbl = await this.db.openTable(name);
      const tags = await tbl.tags();
      const rollbackTag = LanceDBManager.COMPACT_ROLLBACK_TAG;
      if (Object.hasOwn(await tags.list(), rollbackTag)) {
        throw new Error(`Unresolved compact rollback tag "${rollbackTag}" on table "${name}"; inspect and recover before retrying`);
      }

      // Capture row count before optimize for post-compaction validation.
      const countBefore = await tbl.countRows();
      const versionBefore = await tbl.version();
      const current = (await tbl.listVersions()).find(v => v.version === versionBefore);
      if (!current || !Number.isFinite(current.timestamp.getTime())) {
        throw new Error(`Cannot establish rollback version for table "${name}"`);
      }

      // Tags make pruning fail closed if it would remove our recovery point.
      // Leave the tag on any failure; never overwrite an unresolved recovery point.
      await tags.create(rollbackTag, versionBefore);
      // The SDK converts this cutoff to a duration before rewriting, then prunes
      // afterward. A full window before the current version avoids normal idle
      // tables hitting the tag guard as that effective cutoff advances with time.
      // deleteUnverified: false protects files that may belong to in-progress
      // transactions from being deleted prematurely.
      const stats = await tbl.optimize({
        cleanupOlderThan: new Date(Math.min(
          Date.now() - this.compactRetentionMs,
          current.timestamp.getTime() - this.compactRetentionMs,
        )),
        deleteUnverified: false,
      });

      // Post-optimize integrity check: verify row count is preserved and the
      // table is still readable. A mismatch indicates a corrupt compaction.
      const countAfter = await tbl.countRows();
      if (countBefore !== countAfter) {
        throw new Error(
          `LanceDB compact integrity failure on table "${name}": `
          + `row count changed from ${countBefore} to ${countAfter}. `
          + `Version ${versionBefore} is retained for rollback.`,
        );
      }
      await tags.delete(rollbackTag);

      fragmentsRemoved += stats.compaction.fragmentsRemoved;
      fragmentsAdded += stats.compaction.fragmentsAdded;
      bytesRemoved += stats.prune?.bytesRemoved ?? 0;
      filesRemoved += stats.compaction.filesRemoved;
      this.tables.set(name, tbl);
    }

    const diskBytesAfter = await this.measureDiskBytes(this.dbPath);
    return {
      tables: tableNames, fragmentsRemoved, fragmentsAdded, bytesRemoved, filesRemoved,
      diskBytesBefore, diskBytesAfter, diskBytesDelta: diskBytesAfter - diskBytesBefore,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Reject a table whose width contradicts the identity already accepted. */
  private async assertStoredWidth(table: lancedb.Table): Promise<void> {
    const dims = vectorColumnDimensions(await table.schema());
    if (dims !== null && dims !== this.dimensions) {
      throw new VectorIdentityError(
        `LANCE_IDENTITY_SCHEMA_MISMATCH: table width ${dims}d contradicts the verified index width ${this.dimensions}d.`
        + " Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.",
      );
    }
  }

  async close(): Promise<void> {
    for (const table of this.tables.values()) {
      table.close();
    }
    this.tables.clear();
    this.db = null;
    this.dbPath = null;
  }
}
