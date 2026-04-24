import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import type { Data } from "@lancedb/lancedb";

export interface ChunkData {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  vector?: Float32Array;
}

export interface SearchResult {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  _distance?: number;
}

const TABLE_NAME = "chunks";
const VECTOR_DIMENSIONS = 2048;

export class LanceDBManager {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async connect(path: string): Promise<void> {
    this.db = await lancedb.connect(path);
  }

  private async getOrCreateTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    if (!this.db) throw new Error("LanceDB not connected. Call connect() first.");

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      const schema = new Schema([
        new Field("pageSlug", new Utf8(), false),
        new Field("chunkIndex", new Int32(), false),
        new Field("content", new Utf8(), false),
        new Field(
          "vector",
          new FixedSizeList(VECTOR_DIMENSIONS, new Field("item", new Float32(), false)),
          false
        ),
      ]);

      this.table = await this.db.createTable(TABLE_NAME, [], {
        schema,
        mode: "create",
      });
    }
    return this.table;
  }

  async addChunks(chunks: ChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getOrCreateTable();

    const records: Data = chunks.map((chunk) => ({
      pageSlug: chunk.pageSlug,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      vector: chunk.vector ?? new Float32Array(VECTOR_DIMENSIONS),
    }));

    await table.add(records);
  }

  async search(queryVector: number[] | Float32Array, limit: number = 10): Promise<SearchResult[]> {
    const table = await this.getOrCreateTable();

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

  async fullTextSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    const table = await this.getOrCreateTable();

    const results = await table
      .search(query)
      .limit(limit)
      .select(["pageSlug", "chunkIndex", "content", "_score"])
      .fullTextSearch(query)
      .toArray();

    return results.map((row: Record<string, unknown>) => ({
      pageSlug: row.pageSlug as string,
      chunkIndex: row.chunkIndex as number,
      content: row.content as string,
      _distance: row._distance as number | undefined,
    }));
  }

  async deleteByPageSlug(pageSlug: string): Promise<void> {
    const table = await this.getOrCreateTable();
    await table.delete(`pageSlug = '${pageSlug.replace(/'/g, "''")}'`);
  }

  async createFTSIndex(): Promise<void> {
    const table = await this.getOrCreateTable();
    await table.createIndex("content", {
      config: lancedb.Index.fts(),
    });
  }

  async close(): Promise<void> {
    if (this.table) {
      this.table.close();
      this.table = null;
    }
    this.db = null;
  }
}
