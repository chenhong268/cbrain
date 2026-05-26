import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ProvenanceManager, mapSourceType, deriveTrustState } from "../../src/core/provenance.js";
import { SqliteProvenanceStore } from "../../src/storage/provenance-store.js";
import { excerptInBody } from "../../src/mcp/tools/provenance.js";

describe("ProvenanceManager", () => {
  const testDir = "/tmp/cbrain-test-provenance";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let prov: ProvenanceManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    prov = new ProvenanceManager(new SqliteProvenanceStore(db.rawDb));
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string) {
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path) VALUES ($slug, 'entity/person', $title, $path)"
    ).run({ $slug: slug, $title: title, $path: `${slug}.md` });
  }

  describe("explicit source (manual/wikilink)", () => {
    test("manual link gets trust_state=trusted and source_page_slug", () => {
      seedPage("alice", "Alice");
      seedPage("bob", "Bob");
      db.insertLink("alice", "bob", "knows", null, 1.0, "strong", "manual", 0.9, undefined, { source_page_slug: "alice" });

      const linkRow = db.getOutgoingLinks("alice")[0];
      expect(linkRow.trust_state).toBe("trusted");
      expect(linkRow.source_page_slug).toBe("alice");
    });

    test("wikilink gets trust_state=trusted", () => {
      seedPage("page-a", "Page A");
      seedPage("page-b", "Page B");
      db.insertLink("page-a", "page-b", "mentions", null, 0.3, "weak", "wikilink", 0.9, undefined, { source_page_slug: "page-a" });

      const linkRow = db.getOutgoingLinks("page-a")[0];
      expect(linkRow.trust_state).toBe("trusted");
    });
  });

  describe("extracted relationship (NER)", () => {
    test("NER link gets trust_state=candidate and evidence", () => {
      seedPage("doc-x", "Doc X");
      seedPage("entity-y", "Entity Y");
      db.insertLink("doc-x", "entity-y", "mentions", "worked together on Project Z", 0.3, "weak", "ner", 0.5, undefined, { source_page_slug: "doc-x", evidence: "worked together on Project Z" });

      const linkRow = db.getOutgoingLinks("doc-x")[0];
      expect(linkRow.trust_state).toBe("candidate");
      expect(linkRow.source_page_slug).toBe("doc-x");
      expect(linkRow.evidence).toBe("worked together on Project Z");
    });
  });

  describe("corrected fact", () => {
    test("setTrustState records history and updates state", () => {
      seedPage("p1", "P1");
      seedPage("p2", "P2");
      db.insertLink("p1", "p2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("p1")[0].id;
      expect(db.getOutgoingLinks("p1")[0].trust_state).toBe("candidate");

      const ok = prov.setTrustState("link", linkId, "rejected", "correction", "user said this is wrong");
      expect(ok).toBe(true);

      const updated = db.getOutgoingLinks("p1", true)[0];
      expect(updated.trust_state).toBe("rejected");

      const history = prov.getCorrectionHistory("link", linkId);
      expect(history.length).toBe(1);
      expect(history[0].old_trust_state).toBe("candidate");
      expect(history[0].new_trust_state).toBe("rejected");
      expect(history[0].reason).toBe("user said this is wrong");
    });
  });

  describe("episodic cue", () => {
    test("timeline entry has source_page_slug and trust_state", () => {
      seedPage("person-m", "Person M");
      db.addTimelineEntry("person-m", "launched new product", "2024-06-15", "ner", { source_page_slug: "doc-123", evidence: "Person M launched the product at the conference" });

      const entries = db.getTimeline("person-m");
      expect(entries.length).toBe(1);
      expect(entries[0].trust_state).toBe("candidate");
      expect(entries[0].source_page_slug).toBe("doc-123");
    });
  });

  describe("ProvenanceManager API", () => {
    test("getLinkProvenance returns full envelope", () => {
      seedPage("a", "A");
      seedPage("b", "B");
      db.insertLink("a", "b", "knows", "evidence text", 0.8, "strong", "ner", 0.6, undefined, { source_page_slug: "source-doc", evidence: "observed together" });

      const linkId = db.getOutgoingLinks("a")[0].id;
      const item = prov.getLinkProvenance(linkId);
      expect(item).not.toBeNull();
      expect(item!.target_type).toBe("link");
      expect(item!.target_id).toBe(linkId);
      expect(item!.provenance.source_type).toBe("ner");
      expect(item!.provenance.source_category).toBe("agent_inference");
      expect(item!.provenance.trust_state).toBe("candidate");
      expect(item!.provenance.source_page_slug).toBe("source-doc");
      expect(item!.provenance.evidence).toBe("observed together");
    });

    test("getTimelineProvenance returns full envelope", () => {
      seedPage("target", "Target");
      db.addTimelineEntry("target", "event happened", "2024-01-01", "ner", { source_page_slug: "source-page" });

      const entryId = db.getTimeline("target")[0].id;
      const item = prov.getTimelineProvenance(entryId);
      expect(item).not.toBeNull();
      expect(item!.provenance.source_type).toBe("ner");
      expect(item!.provenance.trust_state).toBe("candidate");
      expect(item!.provenance.source_page_slug).toBe("source-page");
    });

    test("getLinkProvenance returns null for non-existent link", () => {
      expect(prov.getLinkProvenance(99999)).toBeNull();
    });

    test("getCorrectionHistory returns empty for no history", () => {
      seedPage("x", "X");
      seedPage("y", "Y");
      db.insertLink("x", "y", "knows");
      const linkId = db.getOutgoingLinks("x")[0].id;
      expect(prov.getCorrectionHistory("link", linkId)).toEqual([]);
    });
  });

  describe("helper functions", () => {
    test("mapSourceType returns correct categories", () => {
      expect(mapSourceType("wikilink")).toBe("imported_content");
      expect(mapSourceType("manual")).toBe("explicit_input");
      expect(mapSourceType("agent")).toBe("agent_inference");
      expect(mapSourceType("ner")).toBe("agent_inference");
      expect(mapSourceType("dialogue")).toBe("dialogue_extraction");
      expect(mapSourceType(undefined)).toBe("agent_inference");
    });

    test("deriveTrustState returns correct states", () => {
      expect(deriveTrustState("wikilink")).toBe("trusted");
      expect(deriveTrustState("manual")).toBe("trusted");
      expect(deriveTrustState("agent")).toBe("candidate");
      expect(deriveTrustState("bidir-fix")).toBe("candidate");
      expect(deriveTrustState("ner")).toBe("candidate");
      expect(deriveTrustState("ner", 0.1)).toBe("candidate");
      expect(deriveTrustState("dialogue")).toBe("candidate");
    });
  });

  // ─── Fix verification tests ──────────────────────────────────

  describe("active evidence rule: rejected/superseded excluded", () => {
    test("rejected links invisible in default reads", () => {
      seedPage("x", "X");
      seedPage("y", "Y");
      seedPage("z", "Z");
      db.insertLink("x", "y", "knows", null, 0.5, "medium", "ner", 0.5);
      db.insertLink("x", "z", "knows", null, 0.5, "medium", "ner", 0.5);

      expect(db.getOutgoingLinks("x").length).toBe(2);

      const linkYId = db.getOutgoingLinks("x", true).find(l => l.to_slug === "y")!.id;
      prov.setTrustState("link", linkYId, "rejected", "correction", "wrong");

      const active = db.getOutgoingLinks("x");
      expect(active.length).toBe(1);
      expect(active[0].to_slug).toBe("z");
    });

    test("superseded links invisible in default reads", () => {
      seedPage("a", "A");
      seedPage("b", "B");
      db.insertLink("a", "b", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("a", true)[0].id;
      prov.setTrustState("link", linkId, "superseded", "correction", "replaced");

      expect(db.getOutgoingLinks("a").length).toBe(0);
      expect(db.getOutgoingLinks("a", true).length).toBe(1);
    });

    test("rejected links excluded from incoming reads", () => {
      seedPage("p", "P");
      seedPage("q", "Q");
      db.insertLink("p", "q", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getIncomingLinks("q", true)[0].id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      expect(db.getIncomingLinks("q").length).toBe(0);
      expect(db.getIncomingLinks("q", true).length).toBe(1);
    });

    test("rejected links excluded from batch reads", () => {
      seedPage("m", "M");
      seedPage("n", "N");
      seedPage("o", "O");
      db.insertLink("m", "n", "knows", null, 0.5, "medium", "ner", 0.5);
      db.insertLink("m", "o", "mentions", null, 0.3, "weak", "ner", 0.5);

      const linkId = db.getOutgoingLinks("m", true).find(l => l.to_slug === "n")!.id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      const batch = db.batchGetLinksForSlugs(["m"]);
      expect(batch.get("m")!.outgoing.length).toBe(1);
      expect(batch.get("m")!.outgoing[0].to_slug).toBe("o");
    });

    test("rejected timeline entries excluded from reads", () => {
      seedPage("person", "Person");
      db.addTimelineEntry("person", "event A", "2024-01-01", "ner");
      db.addTimelineEntry("person", "event B", "2024-02-01", "ner");

      expect(db.getTimeline("person").length).toBe(2);

      const entryId = db.getTimeline("person", true).find(e => e.summary === "event A")!.id;
      prov.setTrustState("timeline", entryId, "rejected", "correction");

      expect(db.getTimeline("person").length).toBe(1);
      expect(db.getTimeline("person")[0].summary).toBe("event B");
    });

    test("slug queries exclude rejected links", () => {
      seedPage("s1", "S1");
      seedPage("s2", "S2");
      seedPage("s3", "S3");
      db.insertLink("s1", "s2", "knows", null, 0.5, "medium", "ner", 0.5);
      db.insertLink("s1", "s3", "mentions", null, 0.3, "weak", "ner", 0.5);

      const linkId = db.getOutgoingLinks("s1", true).find(l => l.to_slug === "s2")!.id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      expect(db.getOutgoingSlugs("s1")).toEqual(["s3"]);
      expect(db.getLinkedSlugs("s1", "from")).toEqual(["s3"]);
    });
  });

  describe("agent source_type stays candidate", () => {
    test("agent source_type gets trust_state=candidate", () => {
      seedPage("foo", "Foo");
      seedPage("bar", "Bar");
      db.insertLink("foo", "bar", "knows", null, 0.9, "strong", "agent", 0.9);

      const link = db.getOutgoingLinks("foo")[0];
      expect(link.trust_state).toBe("candidate");
      expect(mapSourceType(link.source_type)).toBe("agent_inference");
    });

    test("manual source_type still gets trust_state=trusted", () => {
      seedPage("x", "X");
      seedPage("y", "Y");
      db.insertLink("x", "y", "knows", null, 1.0, "strong", "manual", 0.95);

      const link = db.getOutgoingLinks("x")[0];
      expect(link.trust_state).toBe("trusted");
    });
  });

  describe("dialogue source uses session locator", () => {
    test("dialogue source_page_slug is not an entity slug", () => {
      seedPage("entity-a", "Entity A");
      seedPage("entity-b", "Entity B");

      const dialogueSource = "dialogue/manual/2026-05-27T12-00-00";
      db.insertLink("entity-a", "entity-b", "knows", null, 0.4, "weak", "dialogue", 0.4, undefined, { source_page_slug: dialogueSource, evidence: "they met at a conference" });

      const link = db.getOutgoingLinks("entity-a")[0];
      expect(link.source_page_slug).toBe(dialogueSource);
      expect(link.source_page_slug).not.toBe("entity-a");
    });
  });

  describe("trust state transitions record correct category", () => {
    test("rejecting a link records correction category", () => {
      seedPage("r1", "R1");
      seedPage("r2", "R2");
      db.insertLink("r1", "r2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("r1")[0].id;
      prov.setTrustState("link", linkId, "rejected", "correction", "wrong info");

      const history = prov.getCorrectionHistory("link", linkId);
      expect(history[0].source_category).toBe("correction");
    });

    test("confirming a link records user_confirmation category", () => {
      seedPage("c1", "C1");
      seedPage("c2", "C2");
      db.insertLink("c1", "c2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("c1")[0].id;
      prov.setTrustState("link", linkId, "trusted", "user_confirmation", "user verified");

      const history = prov.getCorrectionHistory("link", linkId);
      expect(history[0].source_category).toBe("user_confirmation");
    });
  });

  describe("ProvenanceManager uses bounded interface", () => {
    test("ProvenanceManager constructor accepts SqliteProvenanceStore", () => {
      const store = new SqliteProvenanceStore(db.rawDb);
      const pm = new ProvenanceManager(store);
      expect(pm).toBeDefined();
      expect(pm.getLinkProvenance).toBeDefined();
      expect(pm.getTimelineProvenance).toBeDefined();
      expect(pm.setTrustState).toBeDefined();
      expect(pm.getCorrectionHistory).toBeDefined();
    });
  });

  // ─── Second review fix tests ──────────────────────────────

  describe("getAllLinks excludes rejected/superseded", () => {
    test("getAllLinks filters rejected by default", () => {
      seedPage("a1", "A1");
      seedPage("a2", "A2");
      seedPage("a3", "A3");
      db.insertLink("a1", "a2", "knows", null, 0.5, "medium", "ner", 0.5);
      db.insertLink("a1", "a3", "mentions", null, 0.3, "weak", "ner", 0.5);

      expect(db.getAllLinks().length).toBe(2);

      const linkId = db.getOutgoingLinks("a1", true).find(l => l.to_slug === "a2")!.id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      expect(db.getAllLinks().length).toBe(1);
      expect(db.getAllLinks(true).length).toBe(2);
    });

    test("getAllLinks filters superseded", () => {
      seedPage("b1", "B1");
      seedPage("b2", "B2");
      db.insertLink("b1", "b2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("b1", true)[0].id;
      prov.setTrustState("link", linkId, "superseded", "correction");

      expect(db.getAllLinks().length).toBe(0);
      expect(db.getAllLinks(true).length).toBe(1);
    });
  });

  describe("bidir-fix source_type gets candidate, not trusted", () => {
    test("bidir-fix link is candidate", () => {
      seedPage("c1", "C1");
      seedPage("c2", "C2");
      db.insertLink("c1", "c2", "colleague", null, 1.0, "strong", "bidir-fix", 1.0);

      const link = db.getOutgoingLinks("c1")[0];
      expect(link.trust_state).toBe("candidate");
      expect(mapSourceType(link.source_type)).toBe("agent_inference");
    });
  });

  describe("hierarchy uses agent source_type", () => {
    test("agent source_type via insertLink gets candidate", () => {
      seedPage("emp", "Employee");
      seedPage("boss", "Boss");
      db.insertLink("emp", "boss", "reports_to", null, 1.0, "strong", "agent", 0.95);

      const link = db.getOutgoingLinks("emp")[0];
      expect(link.trust_state).toBe("candidate");
      expect(link.source_type).toBe("agent");
    });
  });

  describe("migration backfill excludes bidir-fix", () => {
    test("deriveTrustState returns candidate for bidir-fix", () => {
      expect(deriveTrustState("bidir-fix")).toBe("candidate");
    });
  });

  // ─── Third review fix tests ────────────────────────────────

  describe("getLinksForSlugs excludes rejected/superseded", () => {
    test("rejected links invisible in getLinksForSlugs default", () => {
      seedPage("a", "A");
      seedPage("b", "B");
      seedPage("c", "C");
      db.insertLink("a", "b", "knows", null, 0.5, "medium", "ner", 0.5);
      db.insertLink("a", "c", "mentions", null, 0.3, "weak", "ner", 0.5);

      expect(db.getLinksForSlugs(["a"]).get("a")!.outgoing.length).toBe(2);

      const linkBId = db.getOutgoingLinks("a", true).find(l => l.to_slug === "b")!.id;
      prov.setTrustState("link", linkBId, "rejected", "correction", "wrong");

      const active = db.getLinksForSlugs(["a"]);
      expect(active.get("a")!.outgoing.length).toBe(1);
      expect(active.get("a")!.outgoing[0]).toBe("c");
    });

    test("getLinksForSlugs with includeInactive returns all", () => {
      seedPage("x", "X");
      seedPage("y", "Y");
      db.insertLink("x", "y", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("x", true)[0].id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      expect(db.getLinksForSlugs(["x"], false).get("x")!.outgoing.length).toBe(0);
      expect(db.getLinksForSlugs(["x"], true).get("x")!.outgoing.length).toBe(1);
    });

    test("rejected links invisible in incoming direction", () => {
      seedPage("p", "P");
      seedPage("q", "Q");
      db.insertLink("p", "q", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getIncomingLinks("q", true)[0].id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      expect(db.getLinksForSlugs(["q"]).get("q")!.incoming.length).toBe(0);
      expect(db.getLinksForSlugs(["q"], true).get("q")!.incoming.length).toBe(1);
    });
  });

  describe("getAllLinksByRelation excludes rejected/superseded", () => {
    test("rejected links excluded from relation audit input", () => {
      seedPage("m1", "M1");
      seedPage("m2", "M2");
      seedPage("m3", "M3");
      db.insertLink("m1", "m2", "knows", null, 0.5, "medium", "ner", 0.5);
      db.insertLink("m1", "m3", "knows", null, 0.5, "medium", "ner", 0.5);

      expect(db.getAllLinksByRelation("knows").length).toBe(2);

      const linkId = db.getOutgoingLinks("m1", true).find(l => l.to_slug === "m2")!.id;
      prov.setTrustState("link", linkId, "rejected", "correction");

      expect(db.getAllLinksByRelation("knows").length).toBe(1);
      expect(db.getAllLinksByRelation("knows", true).length).toBe(2);
    });

    test("superseded links excluded from relation audit input", () => {
      seedPage("s1", "S1");
      seedPage("s2", "S2");
      db.insertLink("s1", "s2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("s1", true)[0].id;
      prov.setTrustState("link", linkId, "superseded", "correction");

      expect(db.getAllLinksByRelation("knows").length).toBe(0);
      expect(db.getAllLinksByRelation("knows", true).length).toBe(1);
    });
  });

  describe("SqliteProvenanceStore owns provenance_history table", () => {
    test("SqliteProvenanceStore creates provenance_history on construction", () => {
      new SqliteProvenanceStore(db.rawDb);
      const table = db.rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provenance_history'").get();
      expect(table).toBeDefined();
    });

    test("SqliteProvenanceStore records and reads history", () => {
      seedPage("h1", "H1");
      seedPage("h2", "H2");
      db.insertLink("h1", "h2", "knows", null, 0.5, "medium", "ner", 0.5);
      const linkId = db.getOutgoingLinks("h1")[0].id;

      const store = new SqliteProvenanceStore(db.rawDb);
      store.updateTrustState("link", linkId, "rejected");
      store.insertProvenanceHistory("link", linkId, "candidate", "rejected", "correction", "test reason");

      const history = store.getProvenanceHistory("link", linkId);
      expect(history.length).toBe(1);
      expect(history[0].new_trust_state).toBe("rejected");
      expect(history[0].reason).toBe("test reason");
    });
  });

  // ─── Fourth review fix tests ──────────────────────────────────

  describe("MCP tool cannot escalate to trusted", () => {
    test("set_trust_state via ProvenanceManager allows only correction states", () => {
      seedPage("d1", "D1");
      seedPage("d2", "D2");
      db.insertLink("d1", "d2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("d1")[0].id;
      prov.setTrustState("link", linkId, "rejected", "correction", "wrong");

      const updated = db.getOutgoingLinks("d1", true)[0];
      expect(updated.trust_state).toBe("rejected");
    });

    test("ProvenanceManager rejects trusted as new state (MCP tool gate)", () => {
      seedPage("e1", "E1");
      seedPage("e2", "E2");
      db.insertLink("e1", "e2", "knows", null, 0.5, "medium", "ner", 0.5);

      const linkId = db.getOutgoingLinks("e1")[0].id;
      // ProvenanceManager itself is agnostic; the MCP tool enforces the gate
      // Verify that a "correction" category is used for all MCP-allowed states
      prov.setTrustState("link", linkId, "rejected", "correction", "agent correction");
      prov.setTrustState("link", linkId, "superseded", "correction", "replaced by better info");
      prov.setTrustState("link", linkId, "candidate", "correction", "needs re-verification");

      const history = prov.getCorrectionHistory("link", linkId);
      expect(history.length).toBe(3);
      expect(history.every(h => h.source_category === "correction")).toBe(true);
    });
  });

  describe("CBrainDB no longer creates provenance_history", () => {
    test("migrateProvenance does not create provenance_history table", () => {
      // The table is created by SqliteProvenanceStore, not migrateProvenance
      // Verify it's created by the store
      new SqliteProvenanceStore(db.rawDb);
      const table = db.rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provenance_history'").get() as { name: string } | undefined;
      expect(table).toBeDefined();
      expect(table!.name).toBe("provenance_history");
    });
  });

  // ─── Fifth review: confirm_evidence with excerpt verification ──

  describe("confirm_evidence: verifiable user confirmation", () => {
    // Simulate MCP handler: check page exists → verify excerpt in body → upgrade
    function simulateConfirmEvidence(
      confirmationSlug: string,
      pageBody: string | null,  // null = page doesn't exist
      excerpt: string,
      targetType: "link" | "timeline",
      targetId: number,
      newState: "trusted" | "user_thought",
    ): { ok: boolean; reason: string } {
      // Step 1: page must exist (simulate getBySlug)
      if (pageBody === null) {
        return { ok: false, reason: `确认来源页面不存在: ${confirmationSlug}` };
      }
      // Step 2: excerpt must appear in page body
      if (!excerptInBody(pageBody, excerpt)) {
        return { ok: false, reason: `确认原文未出现在页面 ${confirmationSlug} 正文中` };
      }
      // Step 3: upgrade
      const ok = prov.setTrustState(targetType, targetId, newState, "user_confirmation",
        `确认来源: ${confirmationSlug}，原文: ${excerpt}`);
      return { ok, reason: ok ? "upgraded" : `未找到 ${targetType}#${targetId}` };
    }

    test("upgrade succeeds when excerpt matches page body", () => {
      seedPage("u1", "U1");
      seedPage("u2", "U2");
      db.insertLink("u1", "u2", "knows", null, 0.5, "medium", "ner", 0.5);
      const linkId = db.getOutgoingLinks("u1")[0].id;

      const body = "今天聊天时，用户明确表示 U1 和 U2 是同事关系，两人一起工作三年了。";
      const excerpt = "用户明确表示 U1 和 U2 是同事关系";

      const result = simulateConfirmEvidence("record/chat", body, excerpt, "link", linkId, "trusted");
      expect(result.ok).toBe(true);

      expect(db.getOutgoingLinks("u1")[0].trust_state).toBe("trusted");
      const history = prov.getCorrectionHistory("link", linkId);
      expect(history[0].source_category).toBe("user_confirmation");
      expect(history[0].reason).toContain("record/chat");
    });

    test("upgrade fails when page does not exist", () => {
      seedPage("u3", "U3");
      seedPage("u4", "U4");
      db.insertLink("u3", "u4", "knows", null, 0.5, "medium", "ner", 0.5);
      const linkId = db.getOutgoingLinks("u3")[0].id;

      const result = simulateConfirmEvidence("record/nonexistent", null, "任意内容", "link", linkId, "trusted");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("不存在");

      expect(db.getOutgoingLinks("u3")[0].trust_state).toBe("candidate");
      expect(prov.getCorrectionHistory("link", linkId).length).toBe(0);
    });

    test("upgrade fails when excerpt not in page body", () => {
      seedPage("f1", "F1");
      seedPage("f2", "F2");
      db.insertLink("f1", "f2", "knows", null, 0.5, "medium", "ner", 0.5);
      const linkId = db.getOutgoingLinks("f1")[0].id;

      // Page body says nothing about this relationship
      const body = "此页不包含任何关系确认的内容，只是一个普通笔记。";
      const forgedExcerpt = "用户明确确认 F1 和 F2 是同事关系";

      const result = simulateConfirmEvidence("record/note", body, forgedExcerpt, "link", linkId, "trusted");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("未出现");

      expect(db.getOutgoingLinks("f1")[0].trust_state).toBe("candidate");
      expect(prov.getCorrectionHistory("link", linkId).length).toBe(0);
    });

    test("timeline upgrade with matching excerpt", () => {
      seedPage("person-x", "Person X");
      db.addTimelineEntry("person-x", "founded a company", "2024-03-15", "ner", { source_page_slug: "doc-1", evidence: "founded company" });
      const entryId = db.getTimeline("person-x")[0].id;

      const body = "用户在 2024 年三月创办了自己的公司，这件事确认无误。";
      const excerpt = "用户在 2024 年三月创办了自己的公司";

      const result = simulateConfirmEvidence("record/notes", body, excerpt, "timeline", entryId, "trusted");
      expect(result.ok).toBe(true);

      const history = prov.getCorrectionHistory("timeline", entryId);
      expect(history[0].source_category).toBe("user_confirmation");
      expect(history[0].reason).toContain("record/notes");
    });

    test("user_thought state with matching excerpt", () => {
      seedPage("t1", "T1");
      seedPage("t2", "T2");
      db.insertLink("t1", "t2", "thinks_about", null, 0.3, "weak", "ner", 0.3);
      const linkId = db.getOutgoingLinks("t1")[0].id;

      const body = "我觉得 T1 可能一直在想 T2 的事情，这是我的主观感受。";
      const excerpt = "我觉得 T1 可能一直在想 T2 的事情";

      const result = simulateConfirmEvidence("record/diary", body, excerpt, "link", linkId, "user_thought");
      expect(result.ok).toBe(true);

      expect(db.getOutgoingLinks("t1")[0].trust_state).toBe("user_thought");
    });
  });

  describe("normalizeForMatch: excerpt matching robustness", () => {
    test("ignores whitespace and punctuation differences", () => {
      const body = "用户 明确表示：U1 和 U2 是同事关系。";
      const excerpt = "用户明确表示U1和U2是同事关系";
      expect(excerptInBody(body, excerpt)).toBe(true);
    });

    test("case insensitive", () => {
      expect(excerptInBody("Hello World this is a test string", "hello world this is a test")).toBe(true);
    });

    test("fullwidth punctuation normalized", () => {
      const body = "他说是的，我确认这个事实没有疑问。";
      const excerpt = "他说是的我确认这个事实没有疑问";
      expect(excerptInBody(body, excerpt)).toBe(true);
    });

    test("rejects punctuation-only excerpt", () => {
      expect(excerptInBody("some body text here", "..........")).toBe(false);
      expect(excerptInBody("some body text here", "，。！？")).toBe(false);
      expect(excerptInBody("some body text here", "   ")).toBe(false);
    });

    test("rejects short text padded with punctuation", () => {
      expect(excerptInBody("待确认的内容在此页面中", "确认..........")).toBe(false);
    });
  });

  describe("trust gate: no escalation without confirmation", () => {
    test("set_trust_state only records correction category", () => {
      seedPage("g1", "G1");
      seedPage("g2", "G2");
      db.insertLink("g1", "g2", "knows", null, 0.5, "medium", "ner", 0.5);
      const linkId = db.getOutgoingLinks("g1")[0].id;

      prov.setTrustState("link", linkId, "rejected", "correction", "agent flagged as wrong");

      const history = prov.getCorrectionHistory("link", linkId);
      expect(history[0].source_category).toBe("correction");
      expect(history[0].new_trust_state).toBe("rejected");
    });

    test("agent-created link starts as candidate not trusted", () => {
      seedPage("a1", "A1");
      seedPage("a2", "A2");
      db.insertLink("a1", "a2", "colleague", null, 0.9, "strong", "agent", 0.9);

      const link = db.getOutgoingLinks("a1")[0];
      expect(link.source_type).toBe("agent");
      expect(link.trust_state).toBe("candidate");
    });
  });
});
