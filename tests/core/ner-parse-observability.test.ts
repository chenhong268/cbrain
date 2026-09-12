import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import { HealthChecker } from "../../src/core/maintenance/health.js";
import { Logger } from "../../src/core/logger.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

const empty = JSON.stringify({ entities: [], events: [], facts: [] });
const entities = JSON.stringify({ entities: [{ name: "实体A", type: "person", context: "参与主题D" }] });
const invalid = "private-response-marker | invalid JSON";
const body = "这里记录主题D的匿名观察，正文包含足够的信息供自动提取，并用于核对原始内容是否仍然可查。";
const embedding: EmbeddingProvider = {
  dimensions: 4,
  embed: async () => ({ embedding: [0, 0, 0, 0], tokenCount: 1 }),
  embedBatch: async texts => texts.map(() => ({ embedding: [0, 0, 0, 0], tokenCount: 1 })),
};
function lanceStub() {
  return { addChunks: async () => {}, deleteRawChunksByPageSlug: async () => {}, deleteL1VectorByPageSlug: async () => {}, deleteByPageSlug: async () => {}, createFTSIndex: async () => {} };
}
function provider(responses: readonly string[]): LLMProvider {
  let i = 0;
  return { name: "anonymous", chat: async () => responses[i++] ?? empty };
}

describe("NER parse failure observability (#491)", () => {
  let dir: string;
  let vault: string;
  let runtime: string;
  let db: CBrainDB;
  let logger: Logger;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-491-"));
    vault = join(dir, "vault");
    runtime = join(dir, "runtime");
    mkdirSync(vault);
    db = new CBrainDB(join(dir, "brain.sqlite"));
    logger = new Logger(runtime);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  test.each([{ responses: [invalid], stage: "stage1" }, { responses: [entities, invalid], stage: "stage2" }])("stage parse failure is coded and logged exactly once", async ({ responses, stage }) => {
    const engine = new NerEngine(provider(responses), logger);
    await expect(engine.extract(body)).rejects.toMatchObject({ code: "NER_PARSE_FAILED", stage });
    const errors = new Logger(runtime).getRecentErrors(7);
    expect(errors).toHaveLength(1);
    expect(errors[0].module).toBe("ner");
    expect(errors[0].message).toContain("NER_PARSE_FAILED");
    expect(JSON.stringify(errors)).not.toContain("private-response-marker");
    const logText = readdirSync(join(runtime, "logs")).map(name => readFileSync(join(runtime, "logs", name), "utf8")).join("\n");
    expect(logText).not.toContain("private-response-marker");
    expect(logText).not.toContain(body);
    const health = await new HealthChecker(db, runtime, new Logger(runtime)).checkAll();
    const system = health.dimensions.find(d => d.name === "系统错误")!;
    expect(system.issues[0].description).toContain("ner");
  });

  test("parallel chunk failures produce one durable error per extraction", async () => {
    let calls = 0;
    const llm: LLMProvider = { name: "anonymous", chat: async () => { calls++; return invalid; } };
    await expect(new NerEngine(llm, logger).extract(body.repeat(120))).rejects.toMatchObject({ code: "NER_PARSE_FAILED" });
    expect(calls).toBeGreaterThan(1);
    expect(logger.getRecentErrors(7)).toHaveLength(1);
  });

  test("a malformed response arriving after timeout does not create a parse error", async () => {
    let complete!: (value: string) => void;
    const llm: LLMProvider = { name: "anonymous", chat: () => new Promise(resolve => { complete = resolve; }) };
    await expect(new NerEngine(llm, logger).extract(body, 10)).rejects.toMatchObject({ code: "NER_TIMEOUT" });
    complete(invalid);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(logger.getRecentErrors(7)).toHaveLength(0);
  });

  test("genuine empty extraction has no failure or durable error", async () => {
    expect((await new NerEngine(provider([empty]), logger).extract(body)).entities).toEqual([]);
    expect(logger.getRecentErrors(7)).toEqual([]);
  });

  test.each([true, false])("ingest internal engine distinguishes parse failure (invalid=%s)", async malformed => {
    const ingest = new IngestManager(db, embedding, lanceStub() as never, vault,
      provider([malformed ? invalid : empty]), undefined, { logger });
    const result = await ingest.ingest({ content: body, type: "text", title: "主题D", pageType: "record" });
    expect(result.created).toBe(true);
    expect(result.nerError).toBe(malformed ? "NER_PARSE_FAILED" : undefined);
    expect(result.nerSkipped).toBe(malformed ? "error" : undefined);
    expect(logger.getRecentErrors(7)).toHaveLength(malformed ? 1 : 0);
  });

  test("single-page sync exposes parse failure without failing content indexing", async () => {
    writeFileSync(join(vault, "note.md"), `---\nslug: note\ntitle: 主题D\ntype: record\n---\n${body}`);
    const sync = new SyncManager(db, embedding, lanceStub() as never, {
      logger, nerEngine: new NerEngine(provider([invalid]), logger),
    });
    const report = await sync.syncPage("note", vault);
    expect(report).toMatchObject({ success: true, nerError: "NER_PARSE_FAILED" });
    expect(logger.getRecentErrors(7)).toHaveLength(1);
  });

  test.each([true, false])("sync counts parse failures separately (invalid=%s)", async malformed => {
    writeFileSync(join(vault, "note.md"), `---\ntitle: 主题D\ntype: record\n---\n${body}`);
    const sync = new SyncManager(db, embedding, lanceStub() as never, {
      logger, nerEngine: new NerEngine(provider([malformed ? invalid : empty]), logger),
    });
    const report = await sync.syncAll(vault);
    expect(report.synced).toBe(1);
    expect(report.nerParseErrors ?? 0).toBe(malformed ? 1 : 0);
    expect(report.nerErrors ?? 0).toBe(0);
    expect(report.nerTimedOut ?? 0).toBe(0);
    expect(logger.getRecentErrors(7)).toHaveLength(malformed ? 1 : 0);
  });
});
