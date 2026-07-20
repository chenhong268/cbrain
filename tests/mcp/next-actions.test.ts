import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

// Synthetic sentinels only (entity/aN). No real names or paths.

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % Math.max(text.length, 1)) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % Math.max(t.length, 1)) ?? 0) / 65536),
        tokenCount: t.length,
      })),
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

function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

interface ToolResponse { content: Array<{ type: string; text: string }> }

/** Backdate a discovery row for #315 stale-gate tests. Test-only raw SQL via the public rawDb handle. */
function backdateDiscovery(db: CBrainDB, id: number, days: number, occurrenceCount?: number): void {
  const occClause = occurrenceCount !== undefined ? `, occurrence_count = ${occurrenceCount}` : "";
  const rawDb = (db as unknown as { rawDb: { prepare: (q: string) => { run: (p: Record<string, unknown>) => void } } }).rawDb;
  rawDb.prepare(`UPDATE discoveries SET detected_at = datetime('now','-${days} days'), last_detected_at = datetime('now','-${days} days')${occClause} WHERE id = $id`).run({ $id: id });
}

describe("next_actions MCP (#309)", () => {
  const dir = "/tmp/cbrain-test-next-actions";
  const dbPath = join(dir, "test.sqlite");
  const vaultPath = join(dir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("returns at most 3 items from a discovery-heavy queue; no slug/score leakage", async () => {
    for (let i = 0; i < 6; i++) {
      db.upsertDiscovery("bridge", [`entity/a${i}`, `entity/b${i}`], 0.9, undefined, undefined, "high", false, {});
    }
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items.length).toBeLessThanOrEqual(3);
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    expect(payload.display).not.toContain("similar_entity");
    expect(payload.summary.shownCount).toBeLessThanOrEqual(3);
  });

  test("mixed discovery groups expose distinct bounded confirmation-gated actions", async () => {
    db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, "合成关联建议", "high", false, {});
    db.upsertDiscovery("trend", ["entity/c"], 0.9, undefined, "合成趋势建议", "high", false, {});
    db.upsertDiscovery("gap", ["entity/d"], 0.9, undefined, undefined, "high", false, {});
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);

    expect(payload.summary.shownCount).toBe(3);
    expect(payload.display).toContain("潜在关联");
    expect(payload.display).toContain("关注变化");
    expect(payload.display).toContain("待补全");
    expect(payload.display).not.toContain("有一条发现值得复核");
    expect(payload.display).not.toContain("打开对应发现");
    expect(payload.display.match(/最多 3 条/g)?.length).toBe(3);
    expect(payload.display.match(/确认前不修改/g)?.length).toBe(3);
    for (const item of payload.items) {
      expect(Object.keys(item).sort()).toEqual(["evidence_count", "severity", "source"]);
    }
  });

  test("every supported discovery action has an existing read-only detail handoff", async () => {
    const cases = [
      ["bridge", ["entity/a", "entity/b"], "合成关联建议", {}],
      ["trend", ["entity/c"], "合成趋势建议", { direction: "trend_rising", delta: 2 }],
      ["gap", ["entity/d"], undefined, { mention_count: 4, link_count: 0 }],
      ["contradiction", ["entity/e"], "合成冲突建议", { explanation: "合成来源不一致" }],
      ["knowledge_map_isolation", ["entity/f"], undefined, {}],
      ["knowledge_map_bridge", ["entity/g"], undefined, {}],
    ] as const;
    for (const [type, entities, suggestion, metadata] of cases) {
      const { id } = db.upsertDiscovery(type, [...entities], 0.9, undefined, undefined, "high", false, metadata);
      if (suggestion) db.updateDiscoverySuggestion(id, suggestion);
    }
    const before = JSON.stringify(db.getUnseenDiscoveries(100));
    const server = createServer(deps);

    for (const [type] of cases) {
      const detail = await getTools(server).read_discoveries.handler({ typeFilter: type, limit: 3, debug: false }) as ToolResponse;
      const payload = JSON.parse(detail.content[0].text);
      const cardCount = (payload.cards?.length ?? 0) + (payload.knowledge_map_cards?.length ?? 0);
      expect(cardCount, `${type} detail handoff should return a card`).toBeGreaterThanOrEqual(1);
      expect(cardCount, `${type} detail handoff should stay capped`).toBeLessThanOrEqual(3);
      expect(payload).not.toHaveProperty("_debug");
    }

    expect(JSON.stringify(db.getUnseenDiscoveries(100))).toBe(before);
  });

  test("empty detail handoff reports no current discovery without writing", async () => {
    const server = createServer(deps);
    const before = JSON.stringify(db.getUnseenDiscoveries(100));
    const detail = await getTools(server).read_discoveries.handler({ typeFilter: "bridge", limit: 3, debug: false }) as ToolResponse;
    const payload = JSON.parse(detail.content[0].text);
    expect(payload.cards).toHaveLength(0);
    expect(payload.display).toContain("暂无");
    expect(JSON.stringify(db.getUnseenDiscoveries(100))).toBe(before);
  });

  test("similar-entity candidates stay silent until their detail handoff works", async () => {
    db.upsertDiscovery(
      "similar_entity",
      ["entity/a", "entity/b"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      { match_kind: "name_exact" },
    );
    const server = createServer(deps);
    const result = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(result.content[0].text);
    expect(payload.items).toHaveLength(0);
    expect(payload.display).toContain("无需");

    db.upsertDiscovery(
      "action_review_discovery",
      ["discovery:synthetic-similar"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      {
        source: "discovery",
        source_type: "similar_entity",
        source_occurrence_count: 2,
      },
    );
    const persistedResult = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const persistedPayload = JSON.parse(persistedResult.content[0].text);
    expect(persistedPayload.items).toHaveLength(0);
    expect(persistedPayload.display).toContain("无需");
  });

  test("default envelope rejects hostile fresh and persisted discovery material", async () => {
    const forbidden = [
      "entity/private-a",
      "entities/private-b",
      "brain/entities/private-c",
      "/synthetic/private/path",
      "C:\\synthetic\\private\\path",
      "SYNTHETIC_RAW_SUGGESTION_SENTINEL",
      "Bearer synthetic-credential-sentinel",
      "synthetic\u202Econtrol",
    ];
    db.upsertDiscovery(
      "bridge",
      forbidden.slice(0, 3),
      0.9,
      undefined,
      forbidden[5],
      "high",
      false,
      { private_path: forbidden[3], windows_path: forbidden[4], credential: forbidden[6], control: forbidden[7] },
    );
    db.upsertDiscovery(
      "action_review_discovery",
      ["discovery:synthetic-trend"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      {
        source: "discovery",
        source_type: "trend",
        source_occurrence_count: 1,
        display_title: forbidden[2],
        display_reason: forbidden[6],
        suggested_action: forbidden[5],
        source_metadata: { private_path: forbidden[3], windows_path: forbidden[4], control: forbidden[7] },
      },
    );
    const server = createServer(deps);
    const result = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(result.content[0].text);
    const envelope = JSON.stringify(payload);

    expect(payload.raw).toBeNull();
    for (const marker of forbidden) expect(envelope).not.toContain(marker);
  });

  test("include_raw preserves its exact audit shape without copying hostile prose", async () => {
    db.upsertDiscovery(
      "bridge",
      ["entity/private-a", "entities/private-b"],
      0.9,
      undefined,
      "SYNTHETIC_RAW_SUGGESTION_SENTINEL",
      "high",
      false,
      { credential: "Bearer synthetic-credential-sentinel" },
    );
    db.upsertDiscovery(
      "action_review_discovery",
      ["discovery:synthetic-trend"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      {
        source: "discovery",
        source_type: "trend",
        source_occurrence_count: 1,
        display_title: "SYNTHETIC_PERSISTED_PRIVATE_TITLE",
        display_reason: "Bearer synthetic-persisted-credential",
        suggested_action: "SYNTHETIC_PERSISTED_RAW_SUGGESTION",
      },
    );
    const server = createServer(deps);
    const result = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
    const payload = JSON.parse(result.content[0].text);

    expect(Object.keys(payload.raw).sort()).toEqual([
      "allItemsRanked",
      "audit",
      "observeOnlyItems",
      "staleItems",
    ]);
    for (const item of payload.raw.allItemsRanked) {
      expect(Object.keys(item).sort()).toEqual([
        "detectedAt",
        "evidenceCount",
        "freshness",
        "groupKey",
        "lastDetectedAt",
        "occurrenceCount",
        "reason",
        "severity",
        "source",
        "sourceRefs",
        "suggestion",
        "title",
      ]);
      const prose = JSON.stringify([item.title, item.reason, item.suggestion]);
      expect(prose).not.toContain("SYNTHETIC_RAW_SUGGESTION_SENTINEL");
      expect(prose).not.toContain("Bearer synthetic-credential-sentinel");
      expect(prose).not.toContain("SYNTHETIC_PERSISTED_PRIVATE_TITLE");
      expect(prose).not.toContain("Bearer synthetic-persisted-credential");
      expect(prose).not.toContain("SYNTHETIC_PERSISTED_RAW_SUGGESTION");
    }
    expect(Object.keys(payload.raw.audit).sort()).toEqual([
      "byFreshness",
      "bySeverity",
      "bySource",
      "hiddenObserveOnlyCount",
      "hiddenStaleCount",
      "rankedInputCount",
      "suppressedBeyondCapCount",
      "totalInput",
      "visibleCount",
    ]);
    expect(JSON.stringify(payload.raw.audit)).not.toContain("SYNTHETIC_RAW_SUGGESTION_SENTINEL");
    expect(JSON.stringify(payload.raw.audit)).not.toContain("Bearer synthetic-credential-sentinel");
  });

  test("never writes DB or filesystem (default sources incl health, no checkAll)", async () => {
    db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    const beforePending = db.getUnseenDiscoveries(50).length;
    const server = createServer(deps);
    await getTools(server).next_actions.handler({}); // default sources incl health
    expect(db.getUnseenDiscoveries(50).length).toBe(beforePending);
    expect(db.getDiscoveriesByType("action_review_discovery", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_health_review", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_repair_preview", 50)).toHaveLength(0);
    // next_actions must NOT run HealthChecker.checkAll — that would mkdirSync(outputsDir/health).
    const healthDir = join(deps.runtimePath, "health");
    expect(existsSync(healthDir)).toBe(false);
  });

  test("dismissed discovery never surfaces", async () => {
    const { id } = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    db.updateDiscoveryStatus(id, "dismissed");
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items).toHaveLength(0);
    expect(payload.display).toContain("无需");
  });

  test("include_raw exposes raw audit object", async () => {
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.raw).toBeTruthy();
    expect(payload.raw.observeOnlyItems).toBeInstanceOf(Array);
    expect(payload.raw.allItemsRanked).toBeInstanceOf(Array);
  });

  test("health-only stream reads persisted health candidate rows (no checkAll FS write)", async () => {
    db.upsertDiscovery(
      "action_health_review",
      ["health:结构一致性:needs_review:entity/a"],
      0.6,
      undefined,
      undefined,
      "high",
      false,
      {
        display_title: "有一项健康问题需要人工确认",
        display_reason: "这项信号可能影响知识质量。",
        suggested_action: "人工确认后再决定。",
        source: "health",
        repair_group: "needs_review",
        dimension: "结构一致性",
        evidence: [{ source: "health", ref: "health:结构一致性:needs_review:entity/a", kind: "needs_review" }],
      },
    );
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["health"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items.length).toBeGreaterThanOrEqual(1);
    expect(payload.items[0].source).toBe("health");
    expect(payload.items[0].severity).toBe("needs_review");
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    // health path must not run checkAll either
    expect(existsSync(join(deps.runtimePath, "health"))).toBe(false);
  });

  test("hostile persisted display metadata never leaks into display or items[] (#309 review)", async () => {
    // Simulate a corrupted/migrated persisted row carrying hostile display text — including
    // the secret class the first review missed (Bearer/sk-/password). All markers below must
    // be caught by assertSafeActionDisplay and fall back to fixed copy.
    const hostile = "entity/private-a score=0.99 /Users/example/private SELECT * FROM pages Bearer sk-test-marker-abcdef password=hunter2";
    db.upsertDiscovery(
      "action_health_review",
      ["health:结构一致性:needs_review:entity/private-a"],
      0.6,
      undefined,
      undefined,
      "high",
      false,
      {
        display_title: hostile,
        display_reason: hostile,
        suggested_action: hostile,
        source: "health",
        repair_group: "needs_review",
        dimension: "结构一致性",
        evidence: [{ source: "health", ref: "health:结构一致性:needs_review:entity/private-a", kind: "needs_review" }],
      },
    );
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["health"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    // display must not leak any hostile marker — including the secret class
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toContain("/Users/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    expect(payload.display).not.toMatch(/SELECT\s+\*\s+FROM/i);
    expect(payload.display).not.toContain("Bearer");
    expect(payload.display).not.toContain("sk-test");
    expect(payload.display).not.toContain("hunter2");
    // items[] carries only metadata {severity, source, evidence_count}; the prose fields
    // (title/reason/suggestion) were removed (#359), so there is no field that could echo
    // hostile text. Assert both the exact key set and that no hostile marker reaches items[].
    for (const it of payload.items) {
      expect(Object.keys(it).sort()).toEqual(["evidence_count", "severity", "source"]);
    }
    const itemsJson = JSON.stringify(payload.items);
    expect(itemsJson).not.toContain("entity/");
    expect(itemsJson).not.toContain("/Users/");
    expect(itemsJson).not.toMatch(/\bscore\b/i);
    expect(itemsJson).not.toMatch(/SELECT\s+\*\s+FROM/i);
    expect(itemsJson).not.toContain("Bearer");
    expect(itemsJson).not.toContain("sk-test");
    expect(itemsJson).not.toContain("hunter2");
  });

  test("items[] carries only metadata; natural-language prose lives in display, not items (#359)", async () => {
    const safeTitle = "有一项健康问题需要人工确认";
    const safeReason = "这项信号可能影响知识质量。";
    const safeSuggestion = "人工确认后再决定。";
    db.upsertDiscovery(
      "action_health_review",
      ["health:结构一致性:needs_review:entity/a"],
      0.6,
      undefined,
      undefined,
      "high",
      false,
      {
        display_title: safeTitle,
        display_reason: safeReason,
        suggested_action: safeSuggestion,
        source: "health",
        repair_group: "needs_review",
        dimension: "结构一致性",
        evidence: [{ source: "health", ref: "health:结构一致性:needs_review:entity/a", kind: "needs_review" }],
      },
    );
    const server = createServer(deps);

    // default mode: compact items[]
    const resDefault = await getTools(server).next_actions.handler({ sources: ["health"] }) as ToolResponse;
    const def = JSON.parse(resDefault.content[0].text);
    expect(def.items.length).toBeGreaterThanOrEqual(1);
    for (const it of def.items) {
      // exact metadata key set — title/reason/suggestion are gone
      expect(Object.keys(it).sort()).toEqual(["evidence_count", "severity", "source"]);
      expect(it).not.toHaveProperty("title");
      expect(it).not.toHaveProperty("reason");
      expect(it).not.toHaveProperty("suggestion");
    }
    // prose lives in display, NOT duplicated into items[]
    expect(def.display).toContain(safeTitle);
    expect(def.display).toContain(safeReason);
    expect(def.display).toContain(safeSuggestion);
    const defItemsJson = JSON.stringify(def.items);
    expect(defItemsJson).not.toContain(safeTitle);
    expect(defItemsJson).not.toContain(safeReason);
    expect(defItemsJson).not.toContain(safeSuggestion);

    // include_raw=true keeps the public items[] shape compact;
    // the separate raw audit intentionally retains complete NextAction details.
    const resRaw = await getTools(server).next_actions.handler({ sources: ["health"], include_raw: true }) as ToolResponse;
    const raw = JSON.parse(resRaw.content[0].text);
    for (const it of raw.items) {
      expect(Object.keys(it).sort()).toEqual(["evidence_count", "severity", "source"]);
      expect(it).not.toHaveProperty("title");
      expect(it).not.toHaveProperty("reason");
      expect(it).not.toHaveProperty("suggestion");
    }
    const rawItemsJson = JSON.stringify(raw.items);
    expect(rawItemsJson).not.toContain(safeTitle);
    expect(rawItemsJson).not.toContain(safeReason);
    expect(rawItemsJson).not.toContain(safeSuggestion);
  });

  test("default sources merges health + discovery and stays within cap", async () => {
    for (let i = 0; i < 4; i++) {
      db.upsertDiscovery("bridge", [`entity/a${i}`, `entity/b${i}`], 0.9, undefined, undefined, "high", false, {});
    }
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({}) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items.length).toBeLessThanOrEqual(3);
    expect(payload.display).not.toContain("entity/");
  });

  test("stale low-occurrence discovery is hidden by default; hiddenStale counted (#315)", async () => {
    const { id } = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, id, 30); // occurrence_count stays 1
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items).toHaveLength(0);
    expect(payload.summary.hiddenStale).toBe(1);
    expect(payload.display).toContain("无需");
  });

  test("stale discovery with occurrence_count >= 3 stays visible (#315)", async () => {
    const { id } = db.upsertDiscovery("bridge", ["entity/c", "entity/d"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, id, 30, 3);
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items).toHaveLength(1);
    expect(payload.summary.hiddenStale).toBe(0);
  });

  test("include_raw exposes stale audit but display/items leak nothing (#315)", async () => {
    const { id } = db.upsertDiscovery("bridge", ["entity/private-a", "entity/private-b"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, id, 30);
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.summary.hiddenStale).toBe(1);
    expect(payload.raw.staleItems).toBeInstanceOf(Array);
    expect(payload.raw.staleItems.length).toBe(1);
    // display + items[] must not leak internal identifiers
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toContain("/Users/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    expect(payload.display).not.toContain("dedup_key");
    for (const it of payload.items) {
      expect(JSON.stringify(it)).not.toContain("entity/");
      expect(JSON.stringify(it)).not.toContain("dedup_key");
    }
  });

  test("next_actions stays read-only even with a stale candidate present (#315)", async () => {
    const { id } = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, id, 30);
    const beforePending = db.getUnseenDiscoveries(50).length;
    const server = createServer(deps);
    await getTools(server).next_actions.handler({});
    expect(db.getUnseenDiscoveries(50).length).toBe(beforePending);
    // next_actions must NOT run HealthChecker.checkAll — that would mkdirSync(outputsDir/health).
    expect(existsSync(join(deps.runtimePath, "health"))).toBe(false);
  });

  test("display notes hidden stale count when fresh items remain (#315)", async () => {
    // 1 fresh + 1 stale; fresh stays visible, stale hidden + mentioned in display.
    db.upsertDiscovery("bridge", ["entity/f1", "entity/f2"], 0.9, undefined, undefined, "high", false, {});
    const stale = db.upsertDiscovery("gap", ["entity/s1"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, stale.id, 30);
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items).toHaveLength(1);
    expect(payload.summary.hiddenStale).toBe(1);
    expect(payload.display).toContain("隐藏");
  });

  test("include_raw=true exposes scalar-only raw.audit with exact partition (#319)", async () => {
    for (let i = 0; i < 2; i++) {
      db.upsertDiscovery("bridge", [`entity/a${i}`, `entity/b${i}`], 0.9, undefined, undefined, "high", false, {});
    }
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.raw).toBeTruthy();
    expect(payload.raw.audit).toBeTruthy();
    const audit = payload.raw.audit;

    // all scalar values are numbers
    for (const v of [
      audit.totalInput, audit.rankedInputCount, audit.visibleCount,
      audit.hiddenObserveOnlyCount, audit.hiddenStaleCount, audit.suppressedBeyondCapCount,
    ]) {
      expect(typeof v).toBe("number");
    }
    // fixed enum keys present
    expect(audit.bySource).toHaveProperty("health");
    expect(audit.bySource).toHaveProperty("discovery");
    expect(audit.bySeverity).toHaveProperty("blocked");
    expect(audit.bySeverity).toHaveProperty("auto_repairable");
    expect(audit.bySeverity).toHaveProperty("needs_review");
    expect(audit.bySeverity).toHaveProperty("observe_only");
    expect(audit.byFreshness).toHaveProperty("fresh");
    expect(audit.byFreshness).toHaveProperty("recurring");
    expect(audit.byFreshness).toHaveProperty("stale");
    // partition invariant holds on the wire
    expect(
      audit.visibleCount + audit.hiddenObserveOnlyCount + audit.hiddenStaleCount + audit.suppressedBeyondCapCount,
    ).toBe(audit.rankedInputCount);

    // scalar-only: no item-derived strings leak into the audit blob
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain("entity/");
    expect(auditJson).not.toContain("discovery:");
    expect(auditJson).not.toMatch(/\bscore\b/i);
    expect(auditJson).not.toContain("dedup_key");
    expect(auditJson).not.toContain("/Users/");
  });

  test("default call leaves raw null and exposes no audit key (#319)", async () => {
    db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.raw).toBeNull();
    // audit must not exist anywhere on the default response
    expect(payload).not.toHaveProperty("audit");
    expect(payload.items.length).toBeLessThanOrEqual(3);
    expect(payload.display).not.toContain("entity/");
  });

  test("include_raw=true path stays read-only: no DB write, no FS write, no candidate insert (#319)", async () => {
    const { id } = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, id, 30); // stale candidate exercises the audit path
    const beforePending = db.getUnseenDiscoveries(50).length;
    const server = createServer(deps);
    await getTools(server).next_actions.handler({ include_raw: true }); // default sources + raw
    // no discovery status flip
    expect(db.getUnseenDiscoveries(50).length).toBe(beforePending);
    // no action candidate insertion
    expect(db.getDiscoveriesByType("action_review_discovery", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_health_review", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_repair_preview", 50)).toHaveLength(0);
    // no HealthChecker.checkAll FS write
    expect(existsSync(join(deps.runtimePath, "health"))).toBe(false);
  });
});
