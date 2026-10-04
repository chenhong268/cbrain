import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager, IngestRollbackError } from "../../src/core/ingestion/ingest.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { PageManager } from "../../src/core/page.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

const MENTION = "提及";

function createMockEmbeddingProvider(): EmbeddingProvider {
  const vector = (text: string): number[] => {
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % 128] += text.charCodeAt(i) / 65536;
    return vec;
  };
  return {
    dimensions: 128,
    embed: async (text: string) => ({ embedding: vector(text), tokenCount: text.length }),
    embedBatch: async (texts: string[]) => texts.map((t) => ({ embedding: vector(t), tokenCount: t.length })),
  };
}

function createMockLanceDB() {
  const added: string[] = [];
  return {
    added,
    connect: async () => {},
    addChunks: async (chunks: Array<{ pageSlug: string }>) => {
      for (const chunk of chunks) if (!added.includes(chunk.pageSlug)) added.push(chunk.pageSlug);
    },
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async (pageSlug: string) => {
      const at = added.indexOf(pageSlug);
      if (at >= 0) added.splice(at, 1);
    },
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    getIndexedPageSlugs: async () => [...added],
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    openChunksStrict: async () => {
      throw new Error("mock: no table");
    },
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

/**
 * Same surface as `createMockLanceDB`, but every slug-taking method declares its
 * parameter. A zero-parameter arrow infers `() => never[]`, which a per-slug
 * fault injector cannot be assigned to.
 */
function createFaultableLance() {
  return {
    connect: async () => {},
    addChunks: async (_chunks: Array<{ pageSlug: string }>) => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async (_pageSlug: string) => {},
    deleteRawChunksByPageSlug: async (_pageSlug: string) => {},
    deleteL1VectorByPageSlug: async (_pageSlug: string) => {},
    getIndexedPageSlugs: async () => [],
    readRawVectorRows: async (_pageSlug: string): Promise<never[]> => [],
    readL1VectorRows: async (_pageSlug: string): Promise<never[]> => [],
    openChunksStrict: async () => {
      throw new Error("mock: no table");
    },
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

/**
 * Fixtures omit a frontmatter `slug`: the write path canonicalises it from the
 * page type (entity pages gain the `brain/` vault prefix, records do not), so a
 * hand-written slug would not match the row that is actually created.
 */
function markdown(frontmatter: Record<string, unknown>, body: string): string {
  return ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", "", body].join("\n");
}

function writeMdFile(
  vaultPath: string,
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const fullPath = join(vaultPath, filePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, markdown(frontmatter, body), "utf-8");
}

/** Deterministic NER stub: every body yields the same extraction. */
function fakeNerEngine(entities: Array<{ name: string; type: string; relevance: string }>) {
  return {
    provider: null,
    extract: async () => ({
      entities: entities.map((e) => ({ ...e, context: "夹具上下文" })),
      relations: [],
      events: [],
      facts: [],
      filtered: [],
    }),
  };
}

/**
 * Fail the post-commit bookkeeping step, which runs AFTER the mention
 * increments were committed. Injected once so the rollback path can still
 * write its own state back.
 *
 * Two fixture constraints make this fault point reachable:
 * - only durable pages (record/insight) carry a body hash, so entity pages never
 *   call `updateIngestHash` at all;
 * - the durable-source dedup gate short-circuits when another page already owns
 *   the same body hash, so every record body must be unique across pages.
 */
function failNextIngestHashWrite(db: CBrainDB): void {
  const original = db.updateIngestHash.bind(db);
  let pending = true;
  db.updateIngestHash = (slug: string, hash: string): void => {
    if (pending) {
      pending = false;
      throw new Error("508-test: injected failure after the mention increments committed");
    }
    original(slug, hash);
  };
}

/** Page lookup by title; `rawDb` is the public escape hatch other tests already use. */
function selectPageSlug(db: CBrainDB, title: string): string | null {
  const row = db.rawDb.prepare("SELECT slug FROM pages WHERE title = $t").get({ $t: title }) as
    | { slug: string }
    | null;
  return row?.slug ?? null;
}

function slugByTitle(db: CBrainDB, title: string): string {
  const slug = selectPageSlug(db, title);
  if (!slug) throw new Error(`fixture is broken: no page titled ${title}`);
  return slug;
}

function mentionCount(db: CBrainDB, slug: string): number {
  return db.getPage(slug)?.mention_count ?? Number.NaN;
}

function mentionTargets(db: CBrainDB, slug: string): string[] {
  return db
    .getOutgoingLinks(slug, true)
    .filter((link) => link.relation === MENTION)
    .map((link) => link.to_slug);
}

/**
 * Drop the volatile frontmatter timestamp before comparing a restored vault
 * file. Bumping it is the separately registered `updated_at` drift (NF-1), not
 * part of this issue's compensation contract.
 */
function withoutUpdatedAt(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith("updated_at:"))
    .join("\n");
}

// ─── Vault sync path: idempotency of the projection ───────────────────────

describe("#508 mention counting through the vault sync path", () => {
  let dir: string;
  let vault: string;
  let db: CBrainDB;
  let lance: ReturnType<typeof createMockLanceDB>;
  let embedding: EmbeddingProvider;
  let sync: SyncManager;

  const entityB = { title: "实体B", type: "entity/person" };
  const entityC = { title: "实体C", type: "entity/person" };
  const recordA = { title: "记录A", type: "record" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-508-sync-"));
    vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    db = new CBrainDB(join(dir, "brain.sqlite"));
    lance = createMockLanceDB();
    embedding = createMockEmbeddingProvider();
    sync = new SyncManager(db, embedding, lance as never, {
      chunkSize: 500,
      pages: new PageManager(db, vault),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function syncWithNer(entities: Array<{ name: string; type: string; relevance: string }>): SyncManager {
    return new SyncManager(db, embedding, lance as never, {
      chunkSize: 500,
      pages: new PageManager(db, vault),
      nerEngine: fakeNerEngine(entities) as never,
    });
  }

  /** Create the entity page first so the mention target already exists. */
  async function seedEntity(target: typeof entityB, file = "brain/entities/person/entity-b.md"): Promise<void> {
    writeMdFile(vault, file, target, `${target.title} 的说明`);
    expect((await sync.syncAll(vault)).errors).toBe(0);
  }

  function writeRecord(body: string): void {
    writeMdFile(vault, "records/source-a.md", recordA, body);
  }

  test("repeating an unchanged sync does not inflate mention_count", async () => {
    await seedEntity(entityB);
    writeRecord("这里提到[[实体B]]一次");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    const target = slugByTitle(db, entityB.title);
    const source = slugByTitle(db, recordA.title);
    expect(mentionCount(db, target)).toBe(1);
    expect(mentionTargets(db, source)).toEqual([target]);

    for (let i = 0; i < 3; i++) {
      expect((await sync.syncAll(vault)).errors).toBe(0);
      expect(mentionCount(db, target)).toBe(1);
    }
    expect(mentionTargets(db, source)).toHaveLength(1);
  });

  test("a changed body that still mentions the same target does not increment again", async () => {
    await seedEntity(entityB);
    writeRecord("这里提到[[实体B]]一次");
    expect((await sync.syncAll(vault)).errors).toBe(0);
    const target = slugByTitle(db, entityB.title);
    expect(mentionCount(db, target)).toBe(1);

    writeRecord("正文变了，仍然提到[[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    expect(mentionCount(db, target)).toBe(1);
    expect(mentionTargets(db, slugByTitle(db, recordA.title))).toEqual([target]);
  });

  test("a genuinely new mention target still increments exactly once", async () => {
    await seedEntity(entityB);
    writeRecord("提到[[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);
    await seedEntity(entityC, "brain/entities/person/entity-c.md");

    writeRecord("提到[[实体B]]和[[实体C]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    expect(mentionCount(db, slugByTitle(db, entityB.title))).toBe(1);
    expect(mentionCount(db, slugByTitle(db, entityC.title))).toBe(1);

    expect((await sync.syncAll(vault)).errors).toBe(0);
    expect(mentionCount(db, slugByTitle(db, entityB.title))).toBe(1);
    expect(mentionCount(db, slugByTitle(db, entityC.title))).toBe(1);
  });

  test("one body mentioning the same target twice increments once", async () => {
    await seedEntity(entityB);
    writeRecord("[[实体B]] 和 [[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    const target = slugByTitle(db, entityB.title);
    expect(mentionCount(db, target)).toBe(1);
    expect(mentionTargets(db, slugByTitle(db, recordA.title))).toEqual([target]);
  });

  test("manual mention evidence owns the key, so a wikilink adds no second contribution", async () => {
    await seedEntity(entityB);
    writeRecord("提到[[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    const source = slugByTitle(db, recordA.title);
    const target = slugByTitle(db, entityB.title);
    expect(mentionCount(db, target)).toBe(1);

    db.deleteWikilinkMentions(source);
    db.insertLink(source, target, MENTION, "人工确认", 1, "strong", "manual", 1);
    writeRecord("改了正文，还是提到[[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    const rows = db.getOutgoingLinks(source, true).filter((link) => link.relation === MENTION);
    expect(rows.map((row) => row.source_type)).toEqual(["manual"]);
    expect(rows[0]).toMatchObject({ context: "人工确认", weight: 1, strength: "strong" });
    expect(mentionCount(db, target)).toBe(1);
  });

  test("repeating the same NER extraction does not increment again", async () => {
    const ner = syncWithNer([{ name: "实体B", type: "entity/person", relevance: "high" }]);
    await seedEntity(entityB);
    writeRecord("正文第一版");
    expect((await ner.syncAll(vault)).errors).toBe(0);

    const target = slugByTitle(db, entityB.title);
    expect(mentionCount(db, target)).toBe(1);

    for (const body of ["正文第二版", "正文第三版"]) {
      writeRecord(body);
      expect((await ner.syncAll(vault)).errors).toBe(0);
      expect(mentionCount(db, target)).toBe(1);
    }
  });

  test("the NER self-reference gate: the source's own title yields no edge and no increment", async () => {
    await seedEntity(entityB);
    const target = slugByTitle(db, entityB.title);
    let extractCalls = 0;
    const selfNer = new SyncManager(db, embedding, lance as never, {
      chunkSize: 500,
      pages: new PageManager(db, vault),
      nerEngine: {
        provider: null,
        extract: async () => {
          extractCalls++;
          return {
            entities: [
              { name: recordA.title, type: "record", relevance: "high", context: "夹具上下文" },
              { name: entityB.title, type: "entity/person", relevance: "high", context: "夹具上下文" },
            ],
            relations: [],
            events: [],
            facts: [],
            filtered: [],
          };
        },
      } as never,
    });

    // A record source: the page type whose sync path actually runs NER. An
    // entity page would be skipped, which is why the earlier version of this
    // test never reached the gate it claimed to cover.
    writeRecord("这份正文不含 wikilink");
    expect((await selfNer.syncAll(vault)).errors).toBe(0);

    const source = slugByTitle(db, recordA.title);
    // Precondition proof: the extraction really ran for this page type.
    expect(extractCalls).toBeGreaterThan(0);
    // Same pass, so the same write entry ran: the non-self entity got its mention.
    expect(mentionTargets(db, source)).toEqual([target]);
    expect(mentionCount(db, target)).toBe(1);
    // The self-reference produced neither edge nor increment.
    expect(mentionTargets(db, source)).not.toContain(source);
    expect(mentionCount(db, source)).toBe(0);
  });

  test("an alias and a wikilink landing on the same target contribute once", async () => {
    await seedEntity(entityB);
    const target = slugByTitle(db, entityB.title);
    db.addAlias(target, "小B");

    const ner = syncWithNer([{ name: "小B", type: "entity/person", relevance: "high" }]);
    writeRecord("这里提到[[实体B]]");
    expect((await ner.syncAll(vault)).errors).toBe(0);

    // The wikilink owns the increment; the alias resolving to the same slug
    // must not add a second one, and must not add a second row.
    expect(mentionCount(db, target)).toBe(1);
    const rows = db
      .getOutgoingLinks(slugByTitle(db, recordA.title), true)
      .filter((link) => link.relation === MENTION);
    expect(rows).toHaveLength(1);
  });

  test("an inactive mention row is revived by a wikilink without a second increment", async () => {
    await seedEntity(entityB);
    writeRecord("提到[[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    const source = slugByTitle(db, recordA.title);
    const target = slugByTitle(db, entityB.title);
    expect(mentionCount(db, target)).toBe(1);

    // rejected/superseded rows still occupy the physical unique key.
    db.rawDb
      .prepare("UPDATE links SET trust_state = 'rejected' WHERE from_slug = $f AND to_slug = $t AND relation = $r")
      .run({ $f: source, $t: target, $r: MENTION });
    expect(db.linkExists(source, target, MENTION)).toBe(false);

    writeRecord("改了正文，还是提到[[实体B]]");
    expect((await sync.syncAll(vault)).errors).toBe(0);

    // The key was occupied, so the target is carried over, not counted...
    expect(mentionCount(db, target)).toBe(1);
    // ...while the row itself returns to the activity-scoped view.
    expect(db.linkExists(source, target, MENTION)).toBe(true);
  });
});

// ─── Ingest path: rollback compensation ───────────────────────────────────

describe("#508 mention compensation on the ingest rollback paths", () => {
  let dir: string;
  let vault: string;
  let db: CBrainDB;
  let ingest: IngestManager;

  const entityB = { title: "实体B", type: "entity/person" };
  const entityC = { title: "实体C", type: "entity/person" };
  const recordA = { title: "记录A", type: "record" };
  const recordNew = { title: "记录N", type: "record" };
  const recordOther = { title: "记录O", type: "record" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-508-ingest-"));
    vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    db = new CBrainDB(join(dir, "brain.sqlite"));
    ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, vault);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function ingestPage(frontmatter: Record<string, unknown>, body: string): Promise<string> {
    const result = await ingest.ingest({ content: markdown(frontmatter, body), type: "markdown" });
    return result.slug;
  }

  test("a failed NEW page reverses its own increments and keeps another source's", async () => {
    const target = await ingestPage(entityB, "实体B 的说明");
    await ingestPage(recordA, "提到 [[实体B]]");
    expect(mentionCount(db, target)).toBe(1);

    failNextIngestHashWrite(db);
    await expect(ingestPage(recordNew, "第二段正文，提到 [[实体B]]")).rejects.toThrow();

    // The attempt's own +1 is gone; source-a's legitimate +1 survives.
    expect(selectPageSlug(db, recordNew.title)).toBeNull();
    expect(mentionCount(db, target)).toBe(1);
  });

  test("a failed EXISTING page restores body, edges and counts, and keeps another source's", async () => {
    const sourceA = await ingestPage(recordA, "旧正文，没有任何提及");
    const filePath = join(vault, db.getPageFilePath(sourceA) ?? "");
    const afterFirstIngest = readFileSync(filePath, "utf-8");

    const targetB = await ingestPage(entityB, "实体B 的说明");
    await ingestPage(recordOther, "提到 [[实体B]]");
    expect(mentionCount(db, targetB)).toBe(1);

    const targetC = await ingestPage(entityC, "实体C 的说明");

    failNextIngestHashWrite(db);
    await expect(ingestPage(recordA, "新正文，提到 [[实体C]]")).rejects.toThrow();

    expect(mentionCount(db, targetC)).toBe(0);
    expect(mentionCount(db, targetB)).toBe(1);
    expect(mentionTargets(db, sourceA)).toEqual([]);
    // Exact reconstruction of the restored body — not a weaker substring check.
    const afterFailure = readFileSync(filePath, "utf-8");
    expect(withoutUpdatedAt(afterFailure)).toBe(withoutUpdatedAt(afterFirstIngest));
    // The abandoned body must not survive anywhere in the file.
    expect(afterFailure).not.toContain(entityC.title);
  });

  test("rerunning the failed ingest succeeds and leaves exactly one increment", async () => {
    const target = await ingestPage(entityB, "实体B 的说明");

    failNextIngestHashWrite(db);
    await expect(ingestPage(recordNew, "提到 [[实体B]]")).rejects.toThrow();
    expect(mentionCount(db, target)).toBe(0);

    const newSlug = await ingestPage(recordNew, "提到 [[实体B]]");
    expect(mentionCount(db, target)).toBe(1);
    expect(mentionTargets(db, newSlug)).toEqual([target]);
  });

  test("a nested outer rollback keeps the old target and reverses only the new one", async () => {
    const targetX = await ingestPage(entityB, "实体B 的说明");
    const targetY = await ingestPage(entityC, "实体C 的说明");
    const source = await ingestPage(recordA, "旧正文，提到 [[实体B]]");
    expect(mentionCount(db, targetX)).toBe(1);
    expect(mentionCount(db, targetY)).toBe(0);
    expect(mentionTargets(db, source)).toEqual([targetX]);

    // The wikilink projection commits inside its OWN transaction; this failure
    // lands outside it, so only the ledger decides what is reversed.
    failNextIngestHashWrite(db);
    await expect(ingestPage(recordA, "新正文，提到 [[实体B]] 与 [[实体C]]")).rejects.toThrow();

    // X predates the attempt: contribution and edge both survive.
    expect(mentionCount(db, targetX)).toBe(1);
    expect(mentionTargets(db, source)).toEqual([targetX]);
    // Y was committed by this attempt: count and edge are both reversed (0/0).
    expect(mentionCount(db, targetY)).toBe(0);
    expect(mentionTargets(db, source)).not.toContain(targetY);

    // The PageManager cache must agree with the compensated value.
    const pages = (ingest as unknown as { pages: PageManager }).pages;
    expect(pages.getBySlug(targetY)?.mention_count).toBe(0);
    expect(pages.getBySlug(targetX)?.mention_count).toBe(1);

    // Retry commits exactly one contribution per target (1/1 each).
    await ingestPage(recordA, "新正文，提到 [[实体B]] 与 [[实体C]]");
    expect(mentionCount(db, targetX)).toBe(1);
    expect(mentionCount(db, targetY)).toBe(1);
    expect(mentionTargets(db, source)).toEqual([targetX, targetY]);
  });

  test("a foreign contribution committed after this attempt survives its compensation", async () => {
    const target = await ingestPage(entityB, "实体B 的说明");
    const foreignSource = await ingestPage(recordOther, "记录O 的正文");

    const original = db.incrementMentionCount.bind(db);
    let pending = true;
    db.incrementMentionCount = (slug: string): void => {
      original(slug);
      if (pending && slug === target) {
        pending = false;
        // A different writer legitimately commits its own contribution AFTER
        // this attempt's, and it is deliberately NOT part of this attempt's ledger.
        db.insertLink(foreignSource, target, MENTION, null, 1, "strong", "manual", 1);
        original(target);
      }
    };

    failNextIngestHashWrite(db);
    await expect(ingestPage(recordNew, "提到 [[实体B]]")).rejects.toThrow();

    // Only this attempt's +1 was reversed; the foreign contribution stands.
    expect(mentionCount(db, target)).toBe(1);
    const foreignRows = db
      .getOutgoingLinks(foreignSource, true)
      .filter((link) => link.relation === MENTION && link.source_type === "manual");
    expect(foreignRows).toHaveLength(1);
  });

  test("a failure inside the wikilink transaction leaves neither the edge nor the increment", async () => {
    const target = await ingestPage(entityB, "实体B 的说明");

    const original = db.upsertWikilinkMention.bind(db);
    let pending = true;
    db.upsertWikilinkMention = (from: string, to: string): boolean => {
      const inserted = original(from, to);
      if (inserted && pending) {
        pending = false;
        throw new Error("508-test: wikilink write failed inside its own transaction");
      }
      return inserted;
    };

    await expect(ingestPage(recordNew, "提到 [[实体B]]")).rejects.toThrow();

    // The projection's transaction rolled back, so the +1 never committed and
    // was therefore never published into the attempt ledger.
    expect(mentionCount(db, target)).toBe(0);
    expect(selectPageSlug(db, recordNew.title)).toBeNull();

    await ingestPage(recordNew, "提到 [[实体B]]");
    expect(mentionCount(db, target)).toBe(1);
  });

  test("a failing compensation surfaces IngestRollbackError instead of a silent success", async () => {
    const target = await ingestPage(entityB, "实体B 的说明");
    // The first body carries no wikilink, so the FAILING attempt is the one that
    // introduces a new increment. Without that there is nothing to compensate
    // and the reversal — the path under test — would never run.
    await ingestPage(recordA, "旧正文，没有提及");
    expect(mentionCount(db, target)).toBe(0);

    const original = db.decrementMentionCount.bind(db);
    let pending = true;
    db.decrementMentionCount = (slug: string, amount?: number): void => {
      if (pending) {
        pending = false;
        throw new Error("508-test: compensation write failed");
      }
      original(slug, amount);
    };

    failNextIngestHashWrite(db);
    await expect(ingestPage(recordA, "新正文，提到 [[实体B]]")).rejects.toBeInstanceOf(IngestRollbackError);

    // The reversal aborted together with its transaction, so the count is NOT
    // silently reported as restored — the failure stays observable.
    expect(mentionCount(db, target)).toBe(1);
  });
});

// ─── R4-b: the review's blocking counterexamples, promoted to regression ──

/**
 * These are the three counterexamples the review ran from `/tmp`, reproduced
 * with the same fixtures, the same fault points and the same assertions. They
 * live here so an ordinary `bun test` guards the defects they caught — the
 * `/tmp` copies never run again on their own.
 */
describe("#508 blocking counterexamples from the review (formal regression)", () => {
  let dir: string;
  let vault: string;
  let db: CBrainDB;
  let lance: ReturnType<typeof createFaultableLance>;
  let pages: PageManager;

  const entityA = { title: "实体A", type: "entity/person" };
  const entityB = { title: "实体B", type: "entity/person" };
  const recordA = { title: "记录A", type: "record" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-508-blocking-"));
    vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    db = new CBrainDB(join(dir, "brain.sqlite"));
    lance = createFaultableLance();
    pages = new PageManager(db, vault);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function manager(ner?: unknown): IngestManager {
    return new IngestManager(
      db,
      createMockEmbeddingProvider(),
      lance as never,
      vault,
      undefined,
      ner as never,
    );
  }

  /**
   * The manager's page facade. `IngestManager.pages` is private, and R1's fault
   * is injected into `syncAffectedSlugs` — the first step after the append has
   * committed its mention. Reaching it through a typed narrow cast keeps this a
   * seam, not a second implementation.
   */
  function appendRoutePages(value: IngestManager): PageManager {
    return (value as unknown as { pages: PageManager }).pages;
  }

  /** Furthest-reaching append fault: it fires after `replaceWikilinks` returned. */
  function failNextSyncAffectedSlugs(value: IngestManager): void {
    const route = appendRoutePages(value);
    const original = route.syncAffectedSlugs.bind(route);
    let pending = true;
    route.syncAffectedSlugs = (slugs: Iterable<string>): Array<{ slug: string; error: string }> => {
      if (pending) {
        pending = false;
        throw new Error("508-test: late fault after the append committed its mention");
      }
      return original(slugs);
    };
  }

  function markdownFor(title: string, body: string): string {
    return markdown({ title, type: "record" }, body);
  }

  test("R4-a: a real outer SQLite rollback leaves no compensatable delta", () => {
    const source = pages.create({ ...recordA, body: "旧正文，没有任何提及" });
    const target = pages.create({ ...entityB, body: "目标正文" });
    const pipeline = new ContentPipeline(db, createMockEmbeddingProvider(), lance as never, { pages });

    // The caller owns the transaction, so this call's savepoint release is not a
    // commit. A delta published here would be compensated against a row the
    // rollback already restored — a double decrement.
    let deltas: string[] = [];
    expect(() =>
      db.transaction(() => {
        const projection = pipeline.replaceWikilinks(source.slug, "新正文，提到 [[实体B]]");
        deltas = projection.mentionDeltas;
        // Inside the transaction the increment really did happen ...
        expect(mentionCount(db, target.slug)).toBe(1);
        throw new Error("508-test: outer SQLite rollback");
      }),
    ).toThrow("outer SQLite rollback");

    // ... and after the rollback the database and the published deltas agree.
    expect(mentionCount(db, target.slug)).toBe(0);
    expect(mentionTargets(db, source.slug)).toEqual([]);
    expect(deltas).toEqual([]);
  });

  test("R1: a person append compensates the mention it committed, and the retry reaches 1/1", async () => {
    const ingest = manager();
    const source = pages.create({ ...entityA, body: "原有正文" });
    const target = pages.create({ ...entityB, body: "目标正文" });

    failNextSyncAffectedSlugs(ingest);
    const append = (body: string) =>
      ingest.ingest({ content: markdownFor(entityA.title, body), type: "markdown", skipNer: true });

    await expect(append("追加 [[实体B]]")).rejects.toThrow();
    expect({
      count: mentionCount(db, target.slug),
      edges: mentionTargets(db, source.slug).length,
    }).toEqual({ count: 0, edges: 0 });

    await append("追加 [[实体B]]");
    expect({
      count: mentionCount(db, target.slug),
      edges: mentionTargets(db, source.slug).length,
    }).toEqual({ count: 1, edges: 1 });
  });

  test("R2: a NER counter fault rolls the edge and the increment back together", async () => {
    const source = pages.create({ ...recordA, body: "原有正文" });
    const target = pages.create({ ...entityB, body: "目标正文" });
    const pipeline = new ContentPipeline(db, createMockEmbeddingProvider(), lance as never, {
      pages,
      nerEngine: fakeNerEngine([{ name: entityB.title, type: "person", relevance: "high" }]) as never,
    });

    const original = db.incrementMentionCount.bind(db);
    let pending = true;
    db.incrementMentionCount = (slug: string): void => {
      if (pending) {
        pending = false;
        throw new Error("508-test: NER counter write fault");
      }
      original(slug);
    };

    await expect(pipeline.processNer(source.slug, "匿名输入", "record", true)).rejects.toThrow();
    expect({
      count: mentionCount(db, target.slug),
      edges: mentionTargets(db, source.slug).length,
    }).toEqual({ count: 0, edges: 0 });

    await pipeline.processNer(source.slug, "匿名输入", "record", true);
    expect({
      count: mentionCount(db, target.slug),
      edges: mentionTargets(db, source.slug).length,
    }).toEqual({ count: 1, edges: 1 });
  });

  test("R3: a committed type move retargets the attempt's deltas before the vector await", async () => {
    const ingest = manager(fakeNerEngine([{ name: entityB.title, type: "drug", relevance: "high" }]));
    const target = pages.create({ title: entityB.title, type: "entity/product", body: "目标正文" });
    const seed = await ingest.ingest({
      content: markdownFor(recordA.title, "原有正文不含提及"),
      type: "markdown",
      skipNer: true,
    });

    let vectorFault = false;
    lance.readRawVectorRows = async (pageSlug: string): Promise<never[]> => {
      if (pageSlug !== target.slug && pageSlug.includes("drug") && !vectorFault) {
        vectorFault = true;
        throw new Error("508-test: post-move vector fault");
      }
      return [];
    };

    failNextIngestHashWrite(db);
    const reingest = () =>
      ingest.ingest({ content: markdownFor(recordA.title, "新正文 [[实体B]]"), type: "markdown" });

    await expect(reingest()).rejects.toThrow(
      "injected failure after the mention increments committed",
    );

    // The move committed before the fault, so the attempt's delta must have been
    // retargeted: a reversal aimed at the old slug would match nothing and still
    // look successful.
    const moved = db.getPageByTitle(entityB.title);
    expect(moved).not.toBeNull();
    expect({
      count: mentionCount(db, moved?.slug ?? ""),
      edges: mentionTargets(db, seed.slug).length,
    }).toEqual({ count: 0, edges: 0 });

    await reingest();
    expect(vectorFault).toBe(true);
    expect(moved?.slug).toBe("brain/entities/drug/实体b");
    expect({
      count: mentionCount(db, moved?.slug ?? ""),
      edges: mentionTargets(db, seed.slug).length,
    }).toEqual({ count: 1, edges: 1 });
  });
});
