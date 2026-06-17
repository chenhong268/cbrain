import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { safeDeletePage } from "../../src/core/page-delete-safety.js";
import { rewriteVaultLinks } from "../../src/core/shared.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

describe("safeDeletePage staged rollback (#187)", () => {
  const dir = "/tmp/cbrain-test-safe-delete";
  const dbPath = join(dir, "safe.sqlite");
  const vault = join(dir, "vault");
  let db: CBrainDB;
  let pm: PageManager;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(vault, { recursive: true });
    db = new CBrainDB(dbPath);
    pm = new PageManager(db, vault);
  });
  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  // Seed: target page Beta + linker page Alpha that wikilinks it.
  // rewriteVaultLinks (and the snapshot preflight) discover candidates via chunks_fts,
  // which pm.create does NOT populate — so seed an FTS row for the linker.
  function seedLinker() {
    const beta = pm.create({ title: "Beta", type: "concept/concept", body: "the target" });
    const alpha = pm.create({ title: "Alpha", type: "concept/concept", body: `see [[${beta.slug}]] too` });
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES ($slug, $content)")
      .run({ $slug: alpha.slug, $content: `see [[${beta.slug}]] too` });
    return {
      target: beta.slug,
      linker: alpha.slug,
      targetPath: join(vault, db.getPageFilePath(beta.slug)!),
      linkerPath: join(vault, db.getPageFilePath(alpha.slug)!),
    };
  }

  test("1. link-rewrite failure leaves all vault files, target, SQLite, vectors unchanged", async () => {
    const s = seedLinker();
    const linkerBefore = readFileSync(s.linkerPath, "utf-8");
    const targetBefore = readFileSync(s.targetPath, "utf-8");

    const failOps = {
      rewriteLinks: () => { throw new Error("rewrite boom"); },
      unlink: () => { throw new Error("should not reach unlink"); },
    };

    await expect(safeDeletePage(s.target, { db, vaultPath: vault }, failOps)).rejects.toThrow("rewrite boom");

    expect(readFileSync(s.linkerPath, "utf-8")).toBe(linkerBefore); // restored
    expect(readFileSync(s.targetPath, "utf-8")).toBe(targetBefore);  // untouched
    expect(db.getPageFilePath(s.target)).not.toBeNull();             // SQLite intact
  });

  test("2. target unlink failure restores already-rewritten files; SQLite unchanged", async () => {
    const s = seedLinker();
    const linkerBefore = readFileSync(s.linkerPath, "utf-8");

    // REAL rewrite runs first (actually strips the dead link in the linker file),
    // THEN unlink fails — so restore must revert the genuinely-rewritten bytes.
    const failOps = {
      rewriteLinks: (slug: string) => rewriteVaultLinks(vault, [{ oldSlug: slug }], db),
      unlink: () => { throw new Error("unlink boom"); },
    };

    await expect(safeDeletePage(s.target, { db, vaultPath: vault }, failOps)).rejects.toThrow("unlink boom");

    expect(readFileSync(s.linkerPath, "utf-8")).toBe(linkerBefore); // restored to pre-delete (real rewrite reverted)
    expect(db.getPageFilePath(s.target)).not.toBeNull();            // SQLite intact
  });

  test("3. SQLite failure restores target + rewritten files; no partial SQLite delete", async () => {
    const s = seedLinker();
    const targetBefore = readFileSync(s.targetPath, "utf-8");

    // Inject a SQLite failure on the pages DELETE (exercises the real tx rollback).
    db.rawDb.exec(
      "CREATE TRIGGER stop_del BEFORE DELETE ON pages " +
      "BEGIN SELECT RAISE(ABORT, 'sqlite boom'); END",
    );

    await expect(safeDeletePage(s.target, { db, vaultPath: vault })).rejects.toThrow("sqlite boom");

    expect(existsSync(s.targetPath)).toBe(true);                    // target restored
    expect(readFileSync(s.targetPath, "utf-8")).toBe(targetBefore); // original bytes
    expect(db.getPageFilePath(s.target)).not.toBeNull();            // page row intact
    expect(db.rawDb.prepare("SELECT 1 FROM ingest_log WHERE page_slug = $s").get({ $s: s.target })).toBeNull();
  });

  test("4. Lance cleanup failure reports repair-required truthfully; DB/vault committed", async () => {
    const s = seedLinker();
    const failLance = {
      deleteByPageSlug: mock(async () => { throw new Error("lance boom"); }),
    } as unknown as LanceDBManager;

    const result = await safeDeletePage(s.target, { db, vaultPath: vault, lance: failLance });

    expect(result.committed).toBe(true);            // source-of-truth delete done
    expect(result.lanceCleaned).toBe(false);
    expect(result.lanceRepairRequired).toBe(true);  // truthful partial outcome
    expect(db.getPageFilePath(s.target)).toBeNull();  // page really gone
    expect(existsSync(s.targetPath)).toBe(false);   // target file gone

    // Deterministic recovery state recorded.
    const pending = JSON.parse(db.getConfig("page_delete.lance_pending") ?? "[]") as string[];
    expect(pending).toContain(s.target);
  });

  test("5. successful deletion removes page, dead wikilinks, and clears any pending audit", async () => {
    const s = seedLinker();
    const okLance = { deleteByPageSlug: mock(async () => {}) } as unknown as LanceDBManager;

    // Pretend a prior failed Lance cleanup left a pending audit entry.
    db.setConfig("page_delete.lance_pending", JSON.stringify([s.target]));

    const result = await safeDeletePage(s.target, { db, vaultPath: vault, lance: okLance });

    expect(result.committed).toBe(true);
    expect(result.lanceCleaned).toBe(true);
    expect(result.lanceRepairRequired).toBe(false);
    expect(db.getPageFilePath(s.target)).toBeNull();
    expect(existsSync(s.targetPath)).toBe(false);
    expect(readFileSync(s.linkerPath, "utf-8")).not.toContain(`[[${s.target}]]`); // dead link stripped
    expect(db.getConfig("page_delete.lance_pending")).toBeNull(); // audit cleared
    // linker page itself still present
    expect(db.getPageFilePath(s.linker)).not.toBeNull();
  });

  test("6. missing page is a safe no-op", async () => {
    const result = await safeDeletePage("records/does-not-exist", { db, vaultPath: vault });
    expect(result.committed).toBe(false);
    expect(result.lanceCleaned).toBe(false);
    expect(result.lanceRepairRequired).toBe(false);
  });
});
