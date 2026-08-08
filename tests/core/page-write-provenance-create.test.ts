import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager, CleanupIncompleteError } from "../../src/core/page.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import {
  PageWriteProvenanceConflictError,
  forIngest,
  forPutPage,
} from "../../src/core/page-write-provenance.js";
import { registerIngestTools } from "../../src/mcp/tools/ingest.js";
import { registerPageTools } from "../../src/mcp/tools/pages.js";
import type { ToolContext } from "../../src/mcp/context.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => {
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % 128] += text.charCodeAt(i) / 65536;
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(128).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 128] += t.charCodeAt(i) / 65536;
        return { embedding: vec, tokenCount: t.length };
      }),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("PageManager.create emits record-page provenance (#386)", () => {
  const testDir = "/tmp/cbrain-test-prov-create";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pages = new PageManager(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("put_page path: record page gets agent/put_page/explicit_page_create", () => {
    const page = pages.create({
      slug: "records/prov-putpage",
      title: "Prov PutPage",
      type: "record",
      body: "body",
      provenance: forPutPage({ actorClass: "agent", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    });
    expect(page.slug).toBe("records/prov-putpage");

    const row = db.getPageWriteProvenance("records/prov-putpage")!;
    expect(row.write_mode).toBe("put_page");
    expect(row.actor_class).toBe("agent");
    expect(row.creation_reason).toBe("explicit_page_create");
    expect(row.origin_ref).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("ingest path: record page gets operator/ingest/explicit_ingest", () => {
    pages.create({
      slug: "records/prov-ingest",
      title: "Prov Ingest",
      type: "record",
      body: "body",
      provenance: forIngest({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    });

    const row = db.getPageWriteProvenance("records/prov-ingest")!;
    expect(row.write_mode).toBe("ingest");
    expect(row.actor_class).toBe("operator");
    expect(row.creation_reason).toBe("explicit_ingest");
  });

  test("scope gate: non-record page (concept) gets NO provenance row", () => {
    pages.create({
      slug: "brain/concepts/prov-concept",
      title: "Prov Concept",
      type: "concept",
      body: "body",
      provenance: forPutPage({ actorClass: "agent" }),
    });
    expect(db.getPageWriteProvenance("brain/concepts/prov-concept")).toBeNull();
  });

  test("default attribution: record page with no caller context gets unattributed provenance", () => {
    // A NEW write never mixes into the historical gap — create() defaults to
    // unknown_write_path so the page is always durably attributed.
    pages.create({
      slug: "records/prov-default",
      title: "Prov Default",
      type: "record",
      body: "body",
    });
    const row = db.getPageWriteProvenance("records/prov-default")!;
    expect(row.write_mode).toBe("unknown_write_path");
    expect(row.actor_class).toBe("unknown_writer");
    expect(row.creation_reason).toBe("unattributed_internal_create");
  });

  test("append-only: a later re-attribution attempt throws and leaves the row unchanged", () => {
    pages.create({
      slug: "records/prov-once",
      title: "Prov Once",
      type: "record",
      body: "body",
      provenance: forIngest({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    });
    // A later code path must not be able to flip it to agent — append-only.
    expect(() =>
      db.recordPageWriteProvenance("records/prov-once", forPutPage({ actorClass: "agent" })),
    ).toThrow(PageWriteProvenanceConflictError);
    expect(db.getPageWriteProvenance("records/prov-once")!.actor_class).toBe("operator");
  });

  test("durable boundary: a provenance write failure rolls back the page + vault file", () => {
    // An invalid origin_ref makes recordPageWriteProvenance throw inside the
    // create() failure boundary → the page row AND vault file must be rolled back.
    expect(() =>
      pages.create({
        slug: "records/prov-rollback",
        title: "Prov Rollback",
        type: "record",
        body: "body",
        provenance: forIngest({ actorClass: "agent", origin: { kind: "session", ref: "/bad/path/secret" } }),
      }),
    ).toThrow(/opaque ID|origin_ref/i);

    // No page row, no vault file, no provenance — atomic failure.
    expect(db.getPage("records/prov-rollback")).toBeNull();
    expect(existsSync(join(vaultPath, "records/prov-rollback.md"))).toBe(false);
    expect(db.getPageWriteProvenance("records/prov-rollback")).toBeNull();
  });

  test("unforgable under corruption: a conflicting pre-existing provenance row blocks creation", () => {
    // Simulate DB corruption: an orphan provenance row with no parent page.
    // Only reachable via FK-off direct INSERT (the FK prevents it in normal flow).
    const raw = (db as unknown as {
      rawDb: { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } };
    }).rawDb;
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare(
      "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason) VALUES (?, 'ingest', 'agent', 'explicit_ingest')",
    ).run("records/cascade-target");
    raw.exec("PRAGMA foreign_keys = ON");

    // create() with a DIFFERENT attribution must throw Conflict BEFORE inserting
    // the page — so the catch's deletePageCascaded can never cascade through the
    // FK and destroy the locked row (the re-attribution-via-corruption path).
    expect(() =>
      pages.create({
        slug: "records/cascade-target",
        title: "Cascade Target",
        type: "record",
        body: "body",
        provenance: forPutPage({ actorClass: "operator" }),
      }),
    ).toThrow(PageWriteProvenanceConflictError);

    // Page was never created; the locked attribution is preserved.
    expect(db.getPage("records/cascade-target")).toBeNull();
    const row = db.getPageWriteProvenance("records/cascade-target")!;
    expect(row.actor_class).toBe("agent");
    expect(row.write_mode).toBe("ingest");
  });

  test("atomic + recovery-required: provenance failure rolls back the page; a file-cleanup failure is surfaced, not swallowed", () => {
    // Inject BOTH a provenance failure (bad origin_ref) AND a failing file
    // cleanup (via the fs test seam). Previously this left a page row + file
    // with no provenance; now the DB transaction rolls the page back atomically
    // and the cleanup failure throws a structured recovery error.
    let unlinkCalled = false;
    pages._setFsOps({
      unlinkSync: () => {
        unlinkCalled = true;
        throw new Error("fs down");
      },
    });

    let thrown: unknown;
    try {
      pages.create({
        slug: "records/atomic-rollback",
        title: "Atomic Rollback",
        type: "record",
        body: "body",
        provenance: forIngest({ actorClass: "agent", origin: { kind: "session", ref: "/bad/path/secret" } }),
      });
    } catch (e) {
      thrown = e;
    }

    // Structured recovery error preserving BOTH the primary DB failure and the
    // cleanup failure (not a plain collapsed message).
    expect(thrown).toBeInstanceOf(CleanupIncompleteError);
    const err = thrown as CleanupIncompleteError;
    expect(err.primaryError).toBeInstanceOf(Error);
    expect(err.cleanupErrors).toHaveLength(1);
    expect(err.cleanupErrors[0].error.message).toBe("fs down");
    expect(err.cleanupErrors[0].path).toBe("records/atomic-rollback.md");

    expect(unlinkCalled).toBe(true);
    // DB is clean — the transaction rolled back insertPage, so no unprovenanced
    // record row survives (the #386 invariant).
    expect(db.getPage("records/atomic-rollback")).toBeNull();
    expect(db.getPageWriteProvenance("records/atomic-rollback")).toBeNull();
  });
});

describe("IngestManager threads writer to record-page provenance (#386)", () => {
  const testDir = "/tmp/cbrain-test-prov-ingest";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let ingest: IngestManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("operator writer (CLI path) creates an operator/ingest provenance row", async () => {
    const result = await ingest.ingest({
      content: "一段需要记录的内容，包含足够的匿名事实背景，用于验证 CLI writer 的记录归属与来源字段。该记录还保留了完整上下文。",
      type: "text",
      title: "Prov CLI Ingest",
      pageType: "record",
      skipNer: true,
      writer: { actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } },
    });
    expect(result.created).toBe(true);

    const row = db.getPageWriteProvenance(result.slug)!;
    expect(row.actor_class).toBe("operator");
    expect(row.write_mode).toBe("ingest");
    expect(row.creation_reason).toBe("explicit_ingest");
    expect(row.origin_ref).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("agent writer (MCP path) creates an agent/ingest provenance row", async () => {
    const result = await ingest.ingest({
      content: "agent submitted content with enough anonymous factual context to verify the MCP writer provenance path.",
      type: "text",
      title: "Prov MCP Ingest",
      pageType: "record",
      skipNer: true,
      writer: { actorClass: "agent" },
    });
    expect(result.created).toBe(true);
    const row = db.getPageWriteProvenance(result.slug)!;
    expect(row.actor_class).toBe("agent");
    expect(row.origin_kind).toBeNull();
  });

  test("no writer: new record still gets unattributed provenance (no historical gap)", async () => {
    const result = await ingest.ingest({
      content: "ingest without a writer context",
      type: "text",
      title: "Prov No Writer",
      pageType: "record",
      skipNer: true,
    });
    expect(result.created).toBe(true);
    const row = db.getPageWriteProvenance(result.slug)!;
    expect(row.write_mode).toBe("unknown_write_path");
    expect(row.actor_class).toBe("unknown_writer");
    expect(row.creation_reason).toBe("unattributed_internal_create");
  });

  test("updating an existing record page does NOT write/overwrite provenance", async () => {
    const first = await ingest.ingest({
      content: "first body with enough anonymous factual context to create the record before testing an update.",
      type: "text",
      title: "Prov Update",
      pageType: "record",
      skipNer: true,
      writer: { actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } },
    });
    // Second ingest to same slug with a DIFFERENT body (so it is NOT a dedup
    // early-return) and a DIFFERENT actor — must hit the update path and still
    // not re-attribute provenance.
    const second = await ingest.ingest({
      content: "first body, revised with enough anonymous factual context to force the update path without re-attribution.",
      type: "text",
      title: "Prov Update",
      pageType: "record",
      skipNer: true,
      writer: { actorClass: "agent" },
    });
    expect(second.created).toBe(false);
    const row = db.getPageWriteProvenance(first.slug)!;
    expect(row.actor_class).toBe("operator");
  });
});

describe("anti-forgery: writer/provenance/actorClass never in MCP input schema (#386)", () => {
  test("ingest and put_page input schemas do not expose actor fields", () => {
    const captured: Record<string, { inputSchema?: Record<string, unknown> }> = {};
    const mockServer = {
      registerTool(name: string, definition: { inputSchema?: Record<string, unknown> }) {
        captured[name] = definition;
      },
    };

    registerIngestTools(mockServer as never, {} as unknown as ToolContext);
    registerPageTools(mockServer as never, {} as unknown as ToolContext);

    for (const toolName of ["ingest", "put_page"]) {
      const keys = Object.keys(captured[toolName]?.inputSchema ?? {});
      expect(keys).not.toContain("writer");
      expect(keys).not.toContain("provenance");
      expect(keys).not.toContain("actorClass");
      expect(keys).not.toContain("actor_class");
    }
  });
});
