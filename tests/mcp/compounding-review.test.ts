import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { CompoundingReviewManager } from "../../src/core/maintenance/compounding-review.js";

const mcpDirs: string[] = [];
function mcpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-test-prb-mcp-")); // MEDIUM #3
  mcpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of mcpDirs) rmSync(d, { recursive: true, force: true });
  mcpDirs.length = 0;
});

const FakeEmb = {
  embed: async (t: string) => ({ embedding: new Array(128).fill(0), tokenCount: t.length }),
  embedBatch: async (ts: string[]) =>
    ts.map((t) => ({ embedding: new Array(128).fill(0), tokenCount: t.length })),
};
const FakeLance = {
  connect: async () => {},
  addChunks: async () => {},
  search: async () => [],
  fullTextSearch: async () => [],
  deleteByPageSlug: async () => {},
  deleteRawChunksByPageSlug: async () => {},
  close: async () => {},
  createFTSIndex: async () => {},
};

async function makeServer(db: CBrainDB, dir: string) {
  const { createServer } = await import("../../src/mcp/server.js");
  return createServer({
    db,
    embedding: FakeEmb as any,
    lance: FakeLance as any,
    vaultPath: dir,
    dbPath: join(dir, "t.sqlite"),
    runtimePath: dir,
  });
}

// Invocation pattern per tests/mcp/hierarchy.test.ts:39-46 — _registeredTools[name].handler(args)
async function callTool(server: any, name: string, args: Record<string, unknown> = {}) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args);
  return { data: JSON.parse(result.content[0].text), isError: result.isError ?? false };
}

function seedProactive(db: CBrainDB, entities: string[]) {
  const meta = {
    source: "proactive_connection",
    signals: { shared_neighbors: 3, cooccurring_sessions: 1, timeline_proximity_days: null },
    evidence: {
      shared_neighbor_slugs: ["concept-x"],
      timeline_event_refs: [{ slug: "entity-alpha", eventId: 1, eventDate: "2026-06-01" }],
      cooccurring_session_refs: ["session-s1"],
    },
    scoring: {
      evidence_strength: 0.85,
      novelty: 0.9,
      recurrence: 0.2,
      actionability: 0.2,
      risk: 0.1,
      quality: 0.7,
      gate_path: "strong_corroborated",
      weights: {},
    },
    pivot: "recently_ingested",
  };
  return db.upsertDiscovery("proactive_connection", entities, 0.7, undefined, undefined, "low", false, meta);
}

function candidateCount(db: CBrainDB): number {
  return (db.rawDb.query("SELECT COUNT(*) as c FROM compounding_review_candidates").get() as { c: number }).c;
}

describe("get_compounding_reviews — refreshProactive", () => {
  test("default (no arg) bridges a strong proactive discovery into review output", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    const { data } = await callTool(server, "get_compounding_reviews", {});
    expect(data.items.length).toBe(1);
    expect(data.items[0].candidate_type).toBe("supported_connection");
    db.close();
  });

  test("refreshProactive:false is pure read — zero candidate writes (hard constraint #8)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const before = candidateCount(db);
    const server = await makeServer(db, dir);
    const { data } = await callTool(server, "get_compounding_reviews", { refreshProactive: false });
    expect(candidateCount(db)).toBe(before); // no write
    expect(data.items.length).toBe(0); // nothing promoted → silence
    db.close();
  });
});

describe("act_on_review_candidate — discovery sync", () => {
  test("accept on a bridged candidate marks source discovery resolved (acceptance #5)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    await callTool(server, "get_compounding_reviews", {}); // promote
    const candId = (db.rawDb.query("SELECT id FROM compounding_review_candidates LIMIT 1").get() as { id: number }).id;
    const { data } = await callTool(server, "act_on_review_candidate", { id: candId, action: "accept" });
    expect(data.new_status).toBe("accepted");
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("resolved");
    db.close();
  });

  test("act never creates pages/links (side-effect attack #5)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    await callTool(server, "get_compounding_reviews", {});
    const candId = (db.rawDb.query("SELECT id FROM compounding_review_candidates LIMIT 1").get() as { id: number }).id;
    await callTool(server, "act_on_review_candidate", { id: candId, action: "reject" });
    expect(db.listPages({ limit: 1000 }).length).toBe(0);
    expect((db.rawDb.query("SELECT COUNT(*) as c FROM links").get() as { c: number }).c).toBe(0);
    db.close();
  });

  test("source missing → fail-open: candidate status succeeds, no error (hard constraint #9)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    const mgr = new CompoundingReviewManager(db);
    const { id } = mgr.upsertCandidate({
      title: "潜在连接候选",
      candidateType: "supported_connection",
      summary: "x",
      scores: { evidence: 5, persistence: 2, novelty: 0.9, action_value: 0.5, trust_risk: 0.1 },
      sourceSlugs: ["entity-gamma", "entity-delta"],
    });
    const server = await makeServer(db, dir);
    const { data, isError } = await callTool(server, "act_on_review_candidate", { id, action: "accept" });
    expect(isError).toBe(false);
    expect(data.new_status).toBe("accepted");
    db.close();
  });

  test("defer then get_compounding_reviews(refreshProactive:true) → not re-emitted, no new row (hard constraint #7)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    const first = await callTool(server, "get_compounding_reviews", {}); // promote
    expect(first.data.items.length).toBe(1);
    const candId = first.data.items[0].id;
    await callTool(server, "act_on_review_candidate", { id: candId, action: "defer" });
    const second = await callTool(server, "get_compounding_reviews", {}); // refreshProactive defaults true
    expect(second.data.items.length).toBe(0); // deferred → excluded from default output
    expect(candidateCount(db)).toBe(1); // no new row (idempotent)
    db.close();
  });
});
