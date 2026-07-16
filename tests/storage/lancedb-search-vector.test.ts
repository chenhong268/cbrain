import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LanceDBManager,
  VECTOR_DIMENSIONS,
  type ChunkData,
} from "../../src/storage/lancedb.js";

function makeVector(first: number, second = 0): Float32Array {
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  vector[0] = first;
  vector[1] = second;
  return vector;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function withTemporaryLance<T>(
  run: (manager: LanceDBManager, directory: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "cbrain-lance-vector-"));
  const manager = new LanceDBManager();
  try {
    await manager.connect(join(directory, "index.lance"));
    return await run(manager, directory);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("LanceDBManager optional vector selection", () => {
  test("selects normalized vectors without changing default keys or squared-L2 order", async () => {
    let temporaryDirectory = "";

    await withTemporaryLance(async (manager, directory) => {
      temporaryDirectory = directory;
      const chunks: ChunkData[] = [
        { pageSlug: "entity/a", chunkIndex: 0, content: "unit", vector: makeVector(1) },
        { pageSlug: "entity/b", chunkIndex: 0, content: "near", vector: makeVector(1, 0.5) },
        { pageSlug: "entity/c", chunkIndex: 0, content: "scaled", vector: makeVector(2) },
        { pageSlug: "entity/d", chunkIndex: 0, content: "zero", vector: makeVector(0) },
      ];
      await manager.addChunks(chunks);

      const query = makeVector(1);
      const omitted = await manager.search(query, 4);
      const explicitlyFalse = await manager.search(query, 4, { includeVector: false });
      const included = await manager.search(query, 4, { includeVector: true });

      for (const result of [...omitted, ...explicitlyFalse]) {
        expect(Object.keys(result)).toEqual(["pageSlug", "chunkIndex", "content", "_distance"]);
        expect("vector" in result).toBe(false);
      }
      for (const result of included) {
        expect(Object.keys(result)).toEqual([
          "pageSlug",
          "chunkIndex",
          "content",
          "_distance",
          "vector",
        ]);
        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.vector).toHaveLength(VECTOR_DIMENSIONS);
      }

      const tuples = (results: typeof omitted) =>
        results.map(({ pageSlug, chunkIndex, _distance }) => [pageSlug, chunkIndex, _distance]);
      expect(tuples(explicitlyFalse)).toEqual(tuples(omitted));
      expect(tuples(included)).toEqual(tuples(omitted));

      expect(omitted.map((result) => result._distance)).toEqual([0, 0.25, 1, 1]);
      expect(omitted.slice(2).map((result) => result.pageSlug).sort()).toEqual([
        "entity/c",
        "entity/d",
      ]);

      const unit = included.find((result) => result.pageSlug === "entity/a")?.vector;
      const scaled = included.find((result) => result.pageSlug === "entity/c")?.vector;
      expect(unit).toBeDefined();
      expect(scaled).toBeDefined();
      expect(cosine(query, unit as Float32Array)).toBeCloseTo(1, 6);
      expect(cosine(query, scaled as Float32Array)).toBeCloseTo(1, 6);
    });

    expect(existsSync(temporaryDirectory)).toBe(false);
  });

  test("closes and removes the temporary database after an injected failure", async () => {
    let temporaryDirectory = "";

    await expect(
      withTemporaryLance(async (manager, directory) => {
        temporaryDirectory = directory;
        await manager.addChunks([
          { pageSlug: "entity/a", chunkIndex: 0, content: "fixture", vector: makeVector(1) },
        ]);
        throw new Error("INJECTED_TEST_FAILURE");
      }),
    ).rejects.toThrow("INJECTED_TEST_FAILURE");

    expect(existsSync(temporaryDirectory)).toBe(false);
  });
});
