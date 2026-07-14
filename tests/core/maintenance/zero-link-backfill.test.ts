import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  countCurrentGraphLinks,
  deriveZeroLinkSource,
  scanRichRecords,
  scanZeroLinkCandidates,
  toPublicZeroLinkCandidate,
} from "../../../src/core/maintenance/zero-link-backfill";
import { CBrainDB } from "../../../src/storage/sqlite";

const testDir = "/tmp/cbrain-test-zero-link-backfill";
const dbPath = join(testDir, "brain.sqlite");
let db: CBrainDB;

function addPage(slug: string, opts: { type?: string; hash?: string | null; chunks?: string[]; tags?: string[] } = {}): void {
  db.upsertPage({
    slug,
    type: opts.type ?? "record",
    title: slug,
    filePath: `${slug}.md`,
    ...(opts.hash === null ? {} : { contentHash: opts.hash ?? `hash-${slug}` }),
  });
  if (opts.hash === null) db.rawDb.prepare("UPDATE pages SET content_hash = NULL WHERE slug = ?").run(slug);
  for (const [index, content] of (opts.chunks ?? []).entries()) db.insertChunk(slug, index, content);
  db.addTags(slug, opts.tags ?? []);
}

function addLink(from: string, to: string, relation: string, trustState: string): void {
  db.rawDb.prepare(
    `INSERT INTO links (from_slug, to_slug, relation, trust_state)
     VALUES (?, ?, ?, ?)`,
  ).run(from, to, relation, trustState);
}

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new CBrainDB(dbPath);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("rich zero-link scanner (#342)", () => {
  test("uses the threshold union and only returns records", () => {
    addPage("records/by-chunks", { chunks: ["a", "b"] });
    addPage("records/by-chars", { chunks: ["x".repeat(1000)] });
    addPage("records/by-tags", { chunks: ["a"], tags: ["a", "b", "c"] });
    addPage("records/too-small", { chunks: ["a"], tags: ["a", "b"] });
    addPage("insights/not-a-record", { type: "insight", chunks: ["a", "b"] });

    expect(scanRichRecords(db).map((candidate) => candidate.slug)).toEqual([
      "records/by-chars",
      "records/by-chunks",
      "records/by-tags",
    ]);
  });

  test("excludes L1 summaries from richness and seals source selection", () => {
    addPage("records/sealed-small", { chunks: ["raw"] });
    db.insertChunkWithLevel("records/sealed-small", 0, "s".repeat(2000), 1, "summary-hash");
    expect(scanRichRecords(db)).toEqual([]);

    addPage("records/sealed-rich", { hash: "page-hash", chunks: ["first", "second"] });
    db.insertChunkWithLevel("records/sealed-rich", 0, "summary", 1, "summary-hash");
    const candidate = scanRichRecords(db)[0];
    expect(candidate.sourceKind).toBe("raw_chunks");
    expect(candidate.contentFingerprint).toMatch(/^derived:[0-9a-f]{64}$/);
    expect(candidate.contentFingerprint).not.toContain("page-hash");
  });

  test("uses current-fact non-self link semantics", () => {
    const cases = [
      ["rejected", "mentions", "rejected", true],
      ["superseded", "mentions", "superseded", true],
      ["candidate-hierarchy", "reports_to", "candidate", true],
      ["candidate-mention", "mentions", "candidate", false],
      ["trusted-hierarchy", "reports_to", "trusted", false],
    ] as const;
    addPage("entity/target", { type: "entity/person" });
    for (const [suffix, relation, trustState, remainsCandidate] of cases) {
      const slug = `records/${suffix}`;
      addPage(slug, { chunks: ["a", "b"] });
      addLink(slug, "entity/target", relation, trustState);
      expect(countCurrentGraphLinks(db, slug)).toBe(remainsCandidate ? 0 : 1);
    }
    addPage("records/self", { chunks: ["a", "b"] });
    addLink("records/self", "records/self", "mentions", "trusted");
    expect(countCurrentGraphLinks(db, "records/self")).toBe(0);

    expect(scanZeroLinkCandidates(db).map((candidate) => candidate.slug).sort()).toEqual([
      "records/candidate-hierarchy",
      "records/rejected",
      "records/self",
      "records/superseded",
    ]);
  });

  test("pre-aggregates dimensions and applies a deterministic post-order limit", () => {
    addPage("records/z", { chunks: ["1".repeat(600), "2".repeat(600)], tags: ["a", "b", "c"] });
    addPage("records/a", { chunks: ["1".repeat(600), "2".repeat(600)], tags: ["a", "b", "c"] });
    addPage("records/larger", { chunks: ["x".repeat(1300)] });

    const all = scanRichRecords(db);
    expect(all.map((candidate) => candidate.slug)).toEqual(["records/larger", "records/a", "records/z"]);
    expect(all.find((candidate) => candidate.slug === "records/a")).toMatchObject({
      rawChunkCount: 2,
      rawCharCount: 1200,
      tagCount: 3,
    });
    expect(scanZeroLinkCandidates(db, 2).map((candidate) => candidate.slug)).toEqual(["records/larger", "records/a"]);
  });
});

describe("source fingerprints (#342)", () => {
  test("uses a non-empty page hash for an unsealed page", () => {
    addPage("records/page", { hash: "abc123", chunks: ["one", "two"] });
    expect(deriveZeroLinkSource(db, "records/page")).toEqual({
      contentFingerprint: "page:abc123",
      sourceKind: "vault_hash",
    });
  });

  test("hashes canonical ordered raw chunks and sorted tags for sealed pages", () => {
    addPage("records/sealed", { hash: "ignored", chunks: ["line\nvalue", "x|y"] , tags: ["z", "a"] });
    db.insertChunkWithLevel("records/sealed", 0, "summary", 1, "summary-hash");
    const rows = db.rawDb.prepare(
      "SELECT id, chunk_index, content FROM chunks WHERE page_slug = ? AND summary_level = 0 ORDER BY chunk_index, id",
    ).all("records/sealed") as Array<{ id: number; chunk_index: number; content: string }>;
    const canonical = {
      version: 1,
      type: "record",
      chunks: rows.map((row) => ({ index: row.chunk_index, id: row.id, content: row.content })),
      tags: ["a", "z"],
    };
    const digest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
    expect(deriveZeroLinkSource(db, "records/sealed")).toEqual({
      contentFingerprint: `derived:${digest}`,
      sourceKind: "raw_chunks",
    });
  });

  test("returns no source when the selected source is unavailable", () => {
    addPage("records/no-source", { hash: null, tags: ["a", "b", "c"] });
    expect(deriveZeroLinkSource(db, "records/no-source")).toEqual({
      contentFingerprint: null,
      sourceKind: null,
    });
  });

  test("public projection is scalar-only", () => {
    addPage("records/private-sentinel", { chunks: ["private-body", "second"] });
    const projected = toPublicZeroLinkCandidate(scanRichRecords(db)[0]);
    const json = JSON.stringify(projected);
    expect(projected).toEqual({ rawChunkCount: 2, rawCharCount: 18, tagCount: 0 });
    expect(json).not.toContain("private-sentinel");
    expect(json).not.toContain("private-body");
    expect(json).not.toContain("page:");
  });
});
