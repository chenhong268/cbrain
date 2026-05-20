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

const VECTOR_DIMENSIONS = 2048;

const CHUNKS_SCHEMA = new Schema([
  new Field("pageSlug", new Utf8(), false),
  new Field("chunkIndex", new Int32(), false),
  new Field("content", new Utf8(), false),
  new Field(
    "vector",
    new FixedSizeList(VECTOR_DIMENSIONS, new Field("item", new Float32(), false)),
    false
  ),
]);

const INSIGHTS_SCHEMA = new Schema([
  new Field("id", new Int32(), false),
  new Field("content", new Utf8(), false),
  new Field(
    "vector",
    new FixedSizeList(VECTOR_DIMENSIONS, new Field("item", new Float32(), false)),
    false
  ),
]);

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

  async compact(): Promise<{ tables: string[]; fragmentsRemoved: number; fragmentsAdded: number; filesRemoved: number }> {
    if (!this.db) throw new Error("LanceDB not connected");
    const tableNames = await this.db.tableNames();
    let fragmentsRemoved = 0;
    let fragmentsAdded = 0;
    let filesRemoved = 0;

    for (const name of tableNames) {
      const tbl = await this.db.openTable(name);
      const stats = await tbl.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
      fragmentsRemoved += stats.compaction.fragmentsRemoved;
      fragmentsAdded += stats.compaction.fragmentsAdded;
      filesRemoved += stats.prune?.bytesRemoved ?? stats.compaction.filesRemoved;
      this.tables.set(name, tbl);
    }

    return { tables: tableNames, fragmentsRemoved, fragmentsAdded, filesRemoved };
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
