import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { MergeWorkflow } from "../../src/core/merge-workflow.js";

const testDir = "/tmp/cbrain-test-merge-wf";
const dbPath = join(testDir, "test.sqlite");
const vaultPath = join(testDir, "vault");
let db: CBrainDB;
let pm: PageManager;
let wf: MergeWorkflow;

// ── Helpers ───────────────────────────────────────────────────────────

function seedPageWithVault(
  slug: string,
  title: string,
  type: string,
  body: string,
  tags: string[] = [],
) {
  // Write vault file
  const filePath = `${slug.replace(/\//g, "_")}.md`;
  const dir = join(vaultPath, filePath.substring(0, filePath.lastIndexOf("/")));
  if (dir !== vaultPath) mkdirSync(dir, { recursive: true });

  const tagLine = tags.length > 0 ? `\ntags:\n${tags.map((t) => `  - ${t}`).join("\n")}` : "";
  writeFileSync(
    join(vaultPath, filePath),
    `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}${tagLine}\n---\n${body}`,
  );

  // Insert DB row
  db.rawDb
    .prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(slug, type, title, filePath, "h1");
}

function pageCount(): number {
  return (
    db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number }
  ).c;
}

function linkCount(): number {
  return (
    db.rawDb.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number }
  ).c;
}

function insertLink(from: string, to: string, relation: string) {
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
    .run(from, to, relation);
}

function insertTimeline(slug: string, eventDate: string, summary: string) {
  db.rawDb
    .prepare(
      "INSERT INTO timeline (page_slug, event_date, summary) VALUES (?, ?, ?)",
    )
    .run(slug, eventDate, summary);
}

function insertAlias(slug: string, alias: string) {
  db.rawDb
    .prepare("INSERT INTO aliases (page_slug, alias) VALUES (?, ?)")
    .run(slug, alias);
}

function insertTag(slug: string, tag: string) {
  db.rawDb
    .prepare("INSERT INTO tags (page_slug, tag) VALUES (?, ?)")
    .run(slug, tag);
}

/** Derive the absolute vault path for a slug (matches seedPageWithVault convention). */
function slugToVaultPath(slug: string): string {
  return join(vaultPath, `${slug.replace(/\//g, "_")}.md`);
}

// ── Lifecycle ─────────────────────────────────────────────────────────

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(vaultPath, { recursive: true });
  db = new CBrainDB(dbPath);
  pm = new PageManager(db, vaultPath);
  wf = new MergeWorkflow(db, pm, vaultPath);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ── planMerge: dry run ────────────────────────────────────────────────

describe("MergeWorkflow.planMerge", () => {
  test("returns correct identity for source and target", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "实体A的内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "实体B的内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    expect(plan.source.slug).toBe("entities/shiti-a");
    expect(plan.source.title).toBe("实体A");
    expect(plan.source.type).toBe("entity/person");
    expect(plan.target.slug).toBe("entities/shiti-b");
    expect(plan.target.title).toBe("实体B");
    expect(plan.target.type).toBe("entity/person");
  });

  test("resolves type via resolveTypePriority", () => {
    seedPageWithVault("entities/gongsi-d", "公司D", "entity/company", "公司内容");
    seedPageWithVault("entities/jigou-e", "机构E", "entity/organization", "机构内容");

    const plan = wf.planMerge("entities/gongsi-d", "entities/jigou-e")!;

    // entity/company and entity/organization are in same affinity group
    // merge_entities keeps target type, never changes it
    expect(plan.target_type_retained).toBe(true);
  });

  test("sets source_title_becomes_alias when titles differ", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;
    expect(plan.source_title_becomes_alias).toBe(true);
  });

  test("sets source_title_becomes_alias false when titles match", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体A", "entity/person", "内容B");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;
    expect(plan.source_title_becomes_alias).toBe(false);
  });

  test("counts outgoing and incoming links correctly", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容");

    insertLink("entities/shiti-a", "concepts/zhuti-c", "关注");
    insertLink("entities/shiti-a", "entities/shiti-b", "合作");
    insertLink("concepts/zhuti-c", "entities/shiti-a", "提及");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    expect(plan.impact.outgoing_links).toBe(2); // source → C, source → B
    expect(plan.impact.incoming_links).toBe(1); // C → source
  });

  test("counts timeline entries", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    insertTimeline("entities/shiti-a", "2025-01-01", "事件1");
    insertTimeline("entities/shiti-a", "2025-06-01", "事件2");
    insertTimeline("entities/shiti-b", "2025-03-01", "事件3");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;
    expect(plan.impact.timeline_entries).toBe(2);
  });

  test("reports tags and merged tags", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    insertTag("entities/shiti-a", "人物");
    insertTag("entities/shiti-a", "商务");
    insertTag("entities/shiti-b", "人物");
    insertTag("entities/shiti-b", "科技");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    expect(plan.impact.tags.source).toEqual(["人物", "商务"]);
    expect(plan.impact.tags.target).toEqual(["人物", "科技"]);
    expect(plan.impact.tags.merged.sort()).toEqual(["人物", "商务", "科技"].sort());
  });

  test("reports aliases on source", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    insertAlias("entities/shiti-a", "小A");
    insertAlias("entities/shiti-a", "A总");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;
    expect(plan.impact.aliases_on_source.sort()).toEqual(["小A", "A总"].sort());
  });

  test("rejects cross-layer merge with conflict", () => {
    seedPageWithVault("records/record-1", "记录1", "record", "记录内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    const plan = wf.planMerge("records/record-1", "entities/shiti-b")!;

    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.allowed).toBe(false);
  });

  test("rejects cross-affinity-group types with conflict", () => {
    // entity/person and entity/drug are NOT in any affinity group together
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/yaopin-f", "药品F", "entity/drug", "药品内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/yaopin-f")!;

    // entity/person and entity/drug are NOT in any shared affinity group
    // → types cannot merge → conflict
    expect(plan.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(plan.allowed).toBe(false);
  });

  test("allows same-type merge", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    expect(plan.conflicts).toEqual([]);
    expect(plan.allowed).toBe(true);
  });

  test("allows affinity-group merge (company + org)", () => {
    seedPageWithVault("entities/gongsi-d", "公司D", "entity/company", "内容");
    seedPageWithVault("entities/jigou-e", "机构E", "entity/organization", "内容");

    const plan = wf.planMerge("entities/gongsi-d", "entities/jigou-e")!;

    expect(plan.conflicts).toEqual([]);
    expect(plan.allowed).toBe(true);
  });

  test("returns null and sets conflicts when source not found", () => {
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    const plan = wf.planMerge("entities/nonexistent", "entities/shiti-b")!;

    expect(plan).toBeNull();
  });

  test("returns null when target not found", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/nonexistent")!;

    expect(plan).toBeNull();
  });

  test("returns null when source === target", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-a")!;

    expect(plan).toBeNull();
  });

  test("dry run does NOT modify DB or vault", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A", ["人物"]);
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B", ["科技"]);
    insertLink("entities/shiti-a", "entities/shiti-b", "合作");
    insertTimeline("entities/shiti-a", "2025-01-01", "事件");

    const pagesBefore = pageCount();
    const linksBefore = linkCount();

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    // No mutation
    expect(pageCount()).toBe(pagesBefore);
    expect(linkCount()).toBe(linksBefore);
    expect(plan).not.toBeNull();
    expect(plan!.allowed).toBe(true);
  });

  test("target_type_retained is always true and plan never exposes absolute paths", () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    expect(plan.target_type_retained).toBe(true);
    // Internal field should exist but is not serialized to Agent
    expect(plan._source_vault_path).toBeDefined();
    expect(plan._source_vault_path).toContain(vaultPath);
    // The public plan fields should not contain absolute paths
    const publicJson = JSON.stringify({
      source: plan.source,
      target: plan.target,
      target_type_retained: plan.target_type_retained,
      impact: plan.impact,
      conflicts: plan.conflicts,
      warnings: plan.warnings,
      allowed: plan.allowed,
    });
    expect(publicJson).not.toContain("/tmp/");
    expect(publicJson).not.toContain("/Users/");
  });
});

// ── verifyMerge: residual checks ──────────────────────────────────────

describe("MergeWorkflow.verifyMerge", () => {
  test("passes after a clean merge", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容");

    insertLink("entities/shiti-a", "concepts/zhuti-c", "关注");
    insertLink("concepts/zhuti-c", "entities/shiti-a", "提及");

    await pm.merge("entities/shiti-a", "entities/shiti-b");
    pm.syncAffectedSlugs(["entities/shiti-b", "concepts/zhuti-c"]);

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.source_links_clean).toBe(true);
    expect(v.source_page_removed).toBe(true);
    expect(v.source_file_removed).toBe(true);
    expect(v.source_wikilinks_clean).toBe(true);
    expect(v.target_kr_synced).toBe(true);
    expect(v.all_passed).toBe(true);
    expect(v.failures).toEqual([]);
  });

  test("detects residual links", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容");

    insertLink("entities/shiti-a", "concepts/zhuti-c", "关注");

    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // Artificially re-insert a link referencing source to simulate residual.
    // FK requires source page to exist, so we bypass FK checks.
    db.rawDb.exec("PRAGMA foreign_keys = OFF");
    insertLink("concepts/zhuti-c", "entities/shiti-a", "残留提及");
    db.rawDb.exec("PRAGMA foreign_keys = ON");

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.source_links_clean).toBe(false);
    expect(v.all_passed).toBe(false);
    expect(v.failures.length).toBeGreaterThan(0);
  });

  test("detects residual source page row", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");

    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // Artificially re-insert source page row
    db.rawDb
      .prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, 'ghost.md', 'h0')`,
      )
      .run("entities/shiti-a", "实体A-幽灵");

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.source_page_removed).toBe(false);
    expect(v.all_passed).toBe(false);
  });

  test("detects residual source vault file when DB row is gone", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");

    // Save the source vault path BEFORE merge deletes it
    const sourcePath = slugToVaultPath("entities/shiti-a");

    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // DB row is gone — re-create the vault file to simulate residual
    writeFileSync(sourcePath, "---\ntitle: 实体A\ntype: entity/person\n---\n残留文件");

    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.source_page_removed).toBe(true); // DB row is gone
    expect(v.source_file_removed).toBe(false); // But file still exists!
    expect(v.all_passed).toBe(false);
    expect(v.failures).toContain(`vault 仍有文件 ${sourcePath}`);
  });

  test("detects residual wikilinks in vault", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容 [[entities/shiti-a]]");

    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // The merge should have rewritten wikilinks, but let's force a residual
    // by writing [[entities/shiti-a]] back into a vault file
    const cFile = slugToVaultPath("concepts/zhuti-c");
    if (existsSync(cFile)) {
      const content = readFileSync(cFile, "utf-8");
      writeFileSync(cFile, content + "\n[[entities/shiti-a]]\n");
    }

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.source_wikilinks_clean).toBe(false);
    expect(v.all_passed).toBe(false);
  });

  test("counts each wikilink file only once (no double-counting)", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容");

    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // Write a single file with the wikilink
    const cFile = slugToVaultPath("concepts/zhuti-c");
    if (existsSync(cFile)) {
      const content = readFileSync(cFile, "utf-8");
      writeFileSync(cFile, content + "\n[[entities/shiti-a]]\n");
    }

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    // Exactly 1 file with residual wikilink, not 2
    expect(v.source_wikilinks_clean).toBe(false);
    expect(v.failures.some((f) => f.includes("1 处 wikilink"))).toBe(true);
    expect(v.failures.some((f) => f.includes("2 处 wikilink"))).toBe(false);
  });

  test("detects target KR not synced", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容");

    insertLink("entities/shiti-a", "concepts/zhuti-c", "关注");

    await pm.merge("entities/shiti-a", "entities/shiti-b");
    // Deliberately NOT calling syncAffectedSlugs

    // The merge rewires links but syncLinksToMarkdown is separate.
    // After merge without sync, target vault file may not have updated KR.
    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    // KR should be out of sync since we didn't run sync
    expect(v.target_kr_synced).toBe(false);
    expect(v.all_passed).toBe(false);
  });

  test("clean merge leaves zero [[source]] wikilinks in entire vault including target", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");
    seedPageWithVault("concepts/zhuti-c", "主题C", "concept/concept", "主题内容");

    await pm.merge("entities/shiti-a", "entities/shiti-b");
    pm.syncAffectedSlugs(["entities/shiti-b", "concepts/zhuti-c"]);

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.all_passed).toBe(true);
    expect(v.source_wikilinks_clean).toBe(true);

    // Verify merge note uses plain text (no dangling wikilink)
    const targetFile = slugToVaultPath("entities/shiti-b");
    const targetContent = readFileSync(targetFile, "utf-8");
    expect(targetContent).not.toContain("[[entities/shiti-a]]");
    expect(targetContent).not.toContain("[[shiti-a]]");
    expect(targetContent).toContain("合并自 实体A（entities/shiti-a）");
  });

  test("residual [[source]] in target file causes verification failure", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B [[entities/shiti-a]]");

    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // rewriteVaultLinks should have cleaned the wikilink, but let's
    // force a residual back into the target file to test detection
    const targetFile = slugToVaultPath("entities/shiti-b");
    const content = readFileSync(targetFile, "utf-8");
    writeFileSync(targetFile, content + "\n[[entities/shiti-a]]\n");

    const sourcePath = slugToVaultPath("entities/shiti-a");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourcePath);

    expect(v.source_wikilinks_clean).toBe(false);
    expect(v.all_passed).toBe(false);
    expect(v.failures.some((f) => f.includes("wikilink"))).toBe(true);
  });
});

// ── migrateAliases ────────────────────────────────────────────────────

describe("MergeWorkflow.migrateAliases", () => {
  test("migrates source aliases to target after merge succeeds", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");

    insertAlias("entities/shiti-a", "别名A");
    insertAlias("entities/shiti-a", "A总");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;

    // Execute merge first — source aliases are cascade-deleted
    await pm.merge("entities/shiti-a", "entities/shiti-b");

    // Now migrate from the saved plan (aliases are gone from DB but preserved in plan)
    wf.migrateAliases(plan);

    // Target should have: source title (added by merge) + migrated aliases
    const targetAliases = db.listAliases("entities/shiti-b");
    expect(targetAliases).toContain("实体A"); // source title → alias (by merge)
    expect(targetAliases).toContain("别名A");
    expect(targetAliases).toContain("A总");
  });

  test("does not duplicate source title alias", async () => {
    seedPageWithVault("entities/shiti-a", "实体A", "entity/person", "内容A");
    seedPageWithVault("entities/shiti-b", "实体B", "entity/person", "内容B");

    // Source has its own title as an alias (edge case)
    insertAlias("entities/shiti-a", "实体A");

    const plan = wf.planMerge("entities/shiti-a", "entities/shiti-b")!;
    await pm.merge("entities/shiti-a", "entities/shiti-b");
    wf.migrateAliases(plan);

    // "实体A" should appear only once on target
    const targetAliases = db.listAliases("entities/shiti-b");
    const titleCount = targetAliases.filter((a) => a === "实体A").length;
    expect(titleCount).toBe(1);
  });
});
