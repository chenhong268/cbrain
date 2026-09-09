import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { rewriteVaultLinks } from "../../src/core/shared.js";
import { registerPageTools } from "../../src/mcp/tools/pages.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/mcp/context.js";
import { safeDeletePage } from "../../src/core/safety/page-delete-safety.js";

describe("raw originals survive link rewrites (#447)", () => {
  let dir: string;
  let vault: string;
  let db: CBrainDB;
  let pm: PageManager;

  beforeEach(() => {
    dir = mkdtempSync("/tmp/cbrain-test-447-raw-links-");
    vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    db = new CBrainDB(join(dir, "brain.sqlite"));
    pm = new PageManager(db, vault);
  });
  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  /**
   * Probe fixture (#447): derived target 实体A, brain linker 概念C, records linker
   * 记录D, and an INDEXED raw original — record page 材料B keeps its records/* slug
   * but its file physically lives at raw/source.md (DB file_path retargeted).
   * The slug says records/, the bytes say raw/ — only the physical path tells the truth.
   */
  function seedRawCandidate() {
    const entity = pm.create({ title: "实体A", type: "entity/person", body: "派生实体" });
    const concept = pm.create({ title: "概念C", type: "concept/concept", body: `参考 [[${entity.slug}]] 的部分` });
    const recordLinker = pm.create({ title: "记录D", type: "record", body: `记录引用 [[${entity.slug}]] 一处` });
    const raw = pm.create({ title: "材料B", type: "record", body: `原始材料 [[${entity.slug}]] 全文引用` });

    mkdirSync(join(vault, "raw"));
    renameSync(join(vault, raw.file_path), join(vault, "raw", "source.md"));
    db.rawDb.prepare("UPDATE pages SET file_path = 'raw/source.md' WHERE slug = ?").run(raw.slug);
    // pm.create does not populate chunks_fts — seed it so rewrite candidate discovery sees these pages.
    for (const p of [concept, recordLinker, raw]) {
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(p.slug, p.body ?? "");
      db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
        .run(p.slug, entity.slug, "related_to");
    }

    const rawPath = join(vault, "raw", "source.md");
    const rawBytes = readFileSync(rawPath);
    // Acceptance: the fixture must prove the raw original AND its index really exist.
    expect(existsSync(rawPath)).toBe(true);
    expect(db.findSlugsByText([`[[${entity.slug}]]`])).toContain(raw.slug);
    expect(db.getPageFilePath(raw.slug)).toBe("raw/source.md");

    return {
      entitySlug: entity.slug,
      conceptSlug: concept.slug,
      recordLinkerSlug: recordLinker.slug,
      rawSlug: raw.slug,
      rawPath,
      rawBytes,
    };
  }

  test("delete keeps raw bytes identical; brain and records references still update", async () => {
    const s = seedRawCandidate();
    const conceptPath = join(vault, db.getPageFilePath(s.conceptSlug)!);
    const recordLinkerPath = join(vault, db.getPageFilePath(s.recordLinkerSlug)!);

    expect(await pm.delete(s.entitySlug)).toBe(true);
    expect(db.getIncomingLinks(s.entitySlug)).toEqual([]);
    expect(db.getOutgoingLinks(s.conceptSlug)).toEqual([]);

    expect(readFileSync(s.rawPath).equals(s.rawBytes)).toBe(true);       // raw original untouched
    expect(db.getPageFilePath(s.entitySlug)).toBeNull();                 // graph cleanup preserved
    expect(db.getPageFilePath(s.rawSlug)).toBe("raw/source.md");         // raw page row intact
    expect(readFileSync(conceptPath, "utf-8")).not.toContain(`[[${s.entitySlug}]]`); // brain ref updated
    expect(readFileSync(recordLinkerPath, "utf-8")).not.toContain(`[[${s.entitySlug}]]`); // records ref still writable
  });

  test("merge keeps raw bytes identical; brain references rewritten to target", async () => {
    const s = seedRawCandidate();
    const target = pm.create({ title: "实体E", type: "entity/person", body: "合并目标" });
    const conceptPath = join(vault, db.getPageFilePath(s.conceptSlug)!);

    const merged = await pm.merge(s.entitySlug, target.slug);

    expect(merged?.slug).toBe(target.slug);
    expect(db.getOutgoingLinks(s.conceptSlug).map(link => link.to_slug)).toEqual([target.slug]);
    expect(db.getIncomingLinks(s.entitySlug)).toEqual([]);
    expect(readFileSync(s.rawPath).equals(s.rawBytes)).toBe(true);       // raw original untouched
    expect(db.getPageFilePath(s.entitySlug)).toBeNull();                 // source page deleted
    const rewritten = readFileSync(conceptPath, "utf-8");
    expect(rewritten).not.toContain(`[[${s.entitySlug}]]`);              // dead link gone
    expect(rewritten).toContain("[[实体e]]");                            // → target short link
  });

  test("MCP merge preserves raw neighbors during post-merge relation projection", async () => {
    const s = seedRawCandidate();
    const target = pm.create({ title: "实体E", type: "entity/person", body: "合并目标" });
    let merge: (args: { source: string; target: string; dryRun: boolean }) => Promise<unknown>;
    registerPageTools({ registerTool(name: string, _schema: unknown, handler: typeof merge) {
      if (name === "merge_pages") merge = handler;
    }} as unknown as McpServer, { db, pages: new PageManager(db, vault) } as ToolContext);
    expect(merge!).toBeDefined();
    const result = await merge!({ source: s.entitySlug, target: target.slug, dryRun: false });
    expect(JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text).success).toBe(true);
    expect(readFileSync(s.rawPath)).toEqual(s.rawBytes);
    expect(db.getOutgoingLinks(s.rawSlug).map(link => link.to_slug)).toEqual([target.slug]);
    expect(readFileSync(join(vault, db.getPageFilePath(s.conceptSlug)!), "utf-8")).toContain("Known Relations");
  });

  test("no-DB rewrite cannot reach raw through a scanned-dir symlink", () => {
    const oldSlug = "brain/entities/person/实体a";
    mkdirSync(join(vault, "raw"), { recursive: true });
    mkdirSync(join(vault, "records"), { recursive: true });
    const rawPath = join(vault, "raw", "actual.md");
    const rawBytes = Buffer.from(`原始材料 [[${oldSlug}]] 全文引用`, "utf-8");
    writeFileSync(rawPath, rawBytes);
    // Lexically a records/ file (ontology scan dir), physically a raw original.
    symlinkSync(join("..", "raw", "actual.md"), join(vault, "records", "link.md"));

    const rewritten = rewriteVaultLinks(vault, [{ oldSlug }]); // no db → ontology directory scan

    expect(rewritten).toBe(0);                                          // symlink candidate skipped
    expect(readFileSync(rawPath).equals(rawBytes)).toBe(true);          // physical raw untouched
  });

  test("delete rollback never rewrites raw — bytes and mtime preserved", async () => {
    const s = seedRawCandidate();
    const conceptPath = join(vault, db.getPageFilePath(s.conceptSlug)!);
    const recordPath = join(vault, db.getPageFilePath(s.recordLinkerSlug)!);
    const conceptBefore = readFileSync(conceptPath);
    const recordBefore = readFileSync(recordPath);
    const oldTime = new Date("2020-06-01T00:00:00.000Z");
    utimesSync(s.rawPath, oldTime, oldTime);

    // Real rewrite runs first, THEN unlink fails — rollback must not touch raw either.
    const failOps = {
      rewriteLinks: (slug: string) => rewriteVaultLinks(vault, [{ oldSlug: slug }], db),
      unlink: () => { throw new Error("unlink boom"); },
    };
    await expect(safeDeletePage(s.entitySlug, { db, vaultPath: vault }, failOps))
      .rejects.toThrow("unlink boom");

    expect(readFileSync(s.rawPath).equals(s.rawBytes)).toBe(true);
    expect(statSync(s.rawPath).mtime.getTime()).toBe(oldTime.getTime()); // not even restored-over
    expect(readFileSync(conceptPath)).toEqual(conceptBefore);
    expect(readFileSync(recordPath)).toEqual(recordBefore);
    expect(db.getOutgoingLinks(s.conceptSlug).map(link => link.to_slug)).toEqual([s.entitySlug]);
  });

  test("page move (updateType) leaves raw bytes untouched — existing behavior", () => {
    const s = seedRawCandidate();

    const newSlug = pm.updateType(s.entitySlug, "entity/company");

    expect(newSlug).not.toBe(s.entitySlug);         // a real directory move happened
    expect(db.getPageFilePath(s.entitySlug)).toBeNull();
    expect(existsSync(join(vault, db.getPageFilePath(newSlug)!))).toBe(true);
    expect(readFileSync(s.rawPath).equals(s.rawBytes)).toBe(true);
  });
});
