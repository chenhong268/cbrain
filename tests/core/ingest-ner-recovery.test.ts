import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import { JobQueueNerSubmitter } from "../../src/core/ingestion/ner-backfill.js";
import { NerEngine, NerTimeoutError } from "../../src/core/ingestion/ner.js";
import { PageManager } from "../../src/core/page.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const embedding: EmbeddingProvider = {
  dimensions: 4,
  embed: async () => ({ embedding: [0, 0, 0, 0], tokenCount: 1 }),
  embedBatch: async (texts) => texts.map(() => ({ embedding: [0, 0, 0, 0], tokenCount: 1 })),
};

function createLanceStub() {
  return {
    addChunks: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    deleteByPageSlug: async () => {},
  };
}

const llm: LLMProvider = {
  name: "anonymous-provider",
  chat: async () => '{"entities":[],"relations":[],"events":[]}',
};

class TimeoutNer extends NerEngine {
  async extract(): Promise<never> {
    throw new NerTimeoutError(10);
  }
}

class ProviderFailureNer extends NerEngine {
  async extract(): Promise<never> {
    throw new Error("private provider payload must not be logged");
  }
}

describe("sync NER durable recovery (#329)", () => {
  let dir: string;
  let vaultPath: string;
  let db: CBrainDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-ner-recovery-"));
    vaultPath = join(dir, "vault");
    db = new CBrainDB(join(dir, "brain.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function manager(engine: NerEngine, withSubmitter = true): IngestManager {
    return new IngestManager(
      db,
      embedding,
      createLanceStub() as never,
      vaultPath,
      llm,
      engine,
      {
        nerMode: "sync",
        ...(withSubmitter ? { deferredNerSubmitter: new JobQueueNerSubmitter(db) } : {}),
      },
    );
  }

  async function seedRecord(): Promise<void> {
    const seed = new IngestManager(
      db,
      embedding,
      createLanceStub() as never,
      vaultPath,
      undefined,
      undefined,
      { nerMode: "off" },
    );
    await seed.ingest({
      type: "markdown",
      content: "---\ntitle: 记录A\ntype: record\nslug: records/source\n---\n初始匿名正文。",
    });
    db.upsertPage({
      slug: "brain/entities/topic-a",
      title: "主题A",
      type: "entity/concept",
      filePath: "brain/entities/topic-a.md",
    });
    db.insertLink("records/source", "brain/entities/topic-a", "提及", null, 0.3, "weak", "ner", 0.5);
  }

  const updateInput = {
    type: "markdown" as const,
    allowDuplicate: true,
    content: "---\ntitle: 记录A\ntype: record\nslug: records/source\n---\n更新后的匿名正文。",
  };

  test("timeout keeps prior NER links and queues durable recovery", async () => {
    await seedRecord();

    const result = await manager(new TimeoutNer(llm)).ingest(updateInput);

    expect(result.nerSkipped).toBe("timeout");
    expect(result.nerPending).toBe(true);
    expect(db.listJobs("pending").filter((job) => job.name === "ner-backfill")).toHaveLength(1);
    expect(db.getOutgoingLinks("records/source", true)).toContainEqual(
      expect.objectContaining({ to_slug: "brain/entities/topic-a", source_type: "ner" }),
    );
  });

  test("provider error queues recovery without logging private error text", async () => {
    await seedRecord();

    const result = await manager(new ProviderFailureNer(llm)).ingest(updateInput);

    expect(result.nerSkipped).toBe("error");
    expect(result.nerPending).toBe(true);
    const details = db.getIngestLog(20).map((row) => row.details ?? "").join("\n");
    expect(details).not.toContain("private provider payload");
  });

  test("repeated failures keep one active recovery job", async () => {
    await seedRecord();
    const ingest = manager(new ProviderFailureNer(llm));

    await ingest.ingest(updateInput);
    await ingest.ingest(updateInput);

    expect(db.listJobs("pending").filter((job) => job.name === "ner-backfill")).toHaveLength(1);
  });

  test("missing submitter remains fail-open without claiming pending recovery", async () => {
    await seedRecord();

    const result = await manager(new ProviderFailureNer(llm), false).ingest(updateInput);

    expect(result.outcome).toBe("updated");
    expect(result.nerSkipped).toBe("error");
    expect(result.nerPending).toBeUndefined();
    expect(db.listJobs("pending")).toHaveLength(0);
  });

  test("entity append failure also queues recovery", async () => {
    const person = new PageManager(db, vaultPath).create({
      title: "人物A",
      type: "entity/person",
      slug: "brain/entities/person-a",
      body: "初始资料。",
    });

    const ingest = manager(new TimeoutNer(llm));
    // Entity pages are derived and normally short-circuit before NerEngine.
    // Inject the pipeline failure to lock the append catch/recovery contract.
    const seam = ingest as unknown as {
      pipeline: { processNer: () => Promise<never> };
    };
    seam.pipeline.processNer = async () => {
      throw new NerTimeoutError(10);
    };

    const result = await ingest.ingest({
      type: "text",
      title: "人物A",
      content: "人物A，同事关系的补充资料。",
    });

    expect(result.outcome).toBe("updated");
    expect(result.nerSkipped).toBe("timeout");
    expect(result.nerPending).toBe(true);
    const [job] = db.listJobs("pending");
    expect(JSON.parse(job.data ?? "{}")).toMatchObject({
      slug: person.slug,
      pageType: "entity/person",
    });
  });
});
