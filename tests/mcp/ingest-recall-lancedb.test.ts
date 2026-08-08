import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { LanceDBManager, VECTOR_DIMENSIONS } from "../../src/storage/lancedb.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const ANONYMOUS_RECORD = "项目银杏的审批门槛是两位独立审核者共同确认，且不得使用单人例外。审计令牌为 ORBIT-47。复核完成后由记录员归档确认时间和审核编号，任何缺失字段都需要重新发起审批。";

function createDeterministicEmbedding(): EmbeddingProvider {
  const embed = async (text: string) => {
    const embedding = new Array<number>(VECTOR_DIMENSIONS).fill(0);
    for (const [index, character] of Array.from(text).entries()) {
      embedding[index % VECTOR_DIMENSIONS] += character.codePointAt(0) ?? 0;
    }
    return { embedding, tokenCount: text.length };
  };

  return {
    dimensions: VECTOR_DIMENSIONS,
    embed,
    embedBatch: async (texts) => Promise.all(texts.map(embed)),
  };
}

interface McpResult {
  content: Array<{ text: string }>;
}

type McpHandler = (input: Record<string, unknown>) => Promise<McpResult>;

interface IngestEnvelope {
  summary: { status: string };
  raw: { slug: string; created: boolean };
}

interface RecallEnvelope {
  summary: { status: string; count: number };
  raw: { entities: Array<{ title: string; body: string }> };
}

function getTools(server: unknown): Record<string, { handler: McpHandler }> {
  return (server as { _registeredTools: Record<string, { handler: McpHandler }> })._registeredTools;
}

function parse<T>(result: McpResult): T {
  return JSON.parse(result.content[0].text) as T;
}

describe("real MCP ingest-to-recall contract (#408)", () => {
  let directory: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let deps: CBrainDeps;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "cbrain-mcp-ingest-recall-"));
    db = new CBrainDB(join(directory, "cbrain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(directory, "index.lance"));
    deps = {
      db,
      lance,
      embedding: createDeterministicEmbedding(),
      vaultPath: join(directory, "vault"),
      runtimePath: join(directory, "runtime"),
    };
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("returns an MCP-ingested anonymous fact from the persisted SQLite, FTS, and LanceDB indexes", async () => {
    const tools = getTools(createServer(deps));
    const ingest = parse<IngestEnvelope>(await tools.ingest.handler({
      title: "匿名项目银杏复盘",
      pageType: "record",
      skipNer: true,
      content: ANONYMOUS_RECORD,
    }));
    const slug = ingest.raw.slug;

    expect(ingest.summary.status).toBe("recorded");
    expect(ingest.raw.created).toBe(true);
    expect(db.getFtsContentsByPage(slug)).toEqual([ANONYMOUS_RECORD]);
    expect(await lance.getIndexedPageSlugs()).toEqual([slug]);
    const [vectorRow] = await lance.readRawVectorRows(slug);
    expect(vectorRow).toMatchObject({ pageSlug: slug, chunkIndex: 0, content: ANONYMOUS_RECORD });
    expect(vectorRow.vector).toHaveLength(VECTOR_DIMENSIONS);

    const recalled = parse<RecallEnvelope>(await tools.cbrain_recall.handler({
      query: "项目银杏的审批门槛",
      detail: "normal",
    }));

    expect(recalled.summary).toMatchObject({ status: "ok", count: 1 });
    expect(recalled.raw.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "匿名项目银杏复盘",
        body: expect.stringContaining("两位独立审核者共同确认"),
      }),
    ]));
  });

  test("does not present the ingested record for an unsupported anonymous query", async () => {
    const tools = getTools(createServer(deps));
    const ingested = parse<IngestEnvelope>(await tools.ingest.handler({
      title: "匿名项目银杏复盘",
      pageType: "record",
      skipNer: true,
      content: ANONYMOUS_RECORD,
    }));
    expect(ingested.summary.status).toBe("recorded");
    expect(ingested.raw.created).toBe(true);

    const recalled = parse<RecallEnvelope>(await tools.cbrain_recall.handler({
      query: "海岬蓝图的卫星发射窗口是什么？",
      detail: "normal",
    }));

    expect(recalled.summary).toMatchObject({ status: "empty", count: 0 });
    expect(recalled.raw.entities).toEqual([]);
  });
});
