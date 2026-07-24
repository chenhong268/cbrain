import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import {
  PageWriteProvenanceConflictError,
  forIngest,
  forPutPage,
  forUnattributed,
  forVaultDiscovery,
  redactOriginRefForDisplay,
  validateOriginRef,
  type RecordWriterContext,
} from "../../src/core/page-write-provenance.js";

const testDir = "/tmp/cbrain-test-page-write-provenance";
const dbPath = join(testDir, "test.sqlite");

function seedPage(db: CBrainDB, slug: string, type: string, title?: string): void {
  db.insertPage({
    slug,
    type,
    title: title ?? slug,
    filePath: `${slug}.md`,
    contentHash: "hash-" + slug,
  });
}

describe("page_write_provenance storage (#386)", () => {
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("recordPageWriteProvenance writes a row readable by getPageWriteProvenance", () => {
    seedPage(db, "records/test-note-abc", "record");
    const writer: RecordWriterContext = {
      actorClass: "agent",
      origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" },
    };
    const wrote = db.recordPageWriteProvenance("records/test-note-abc", forIngest(writer));

    expect(wrote).toBe(true);
    const row = db.getPageWriteProvenance("records/test-note-abc");
    expect(row).not.toBeNull();
    expect(row!.page_slug).toBe("records/test-note-abc");
    expect(row!.write_mode).toBe("ingest");
    expect(row!.actor_class).toBe("agent");
    expect(row!.creation_reason).toBe("explicit_ingest");
    expect(row!.origin_kind).toBe("session");
    expect(row!.origin_ref).toBe("11111111-2222-4333-8444-555555555555");
    expect(row!.created_at).toBeTruthy();
  });

  test("forPutPage helper maps to put_page / explicit_page_create", () => {
    seedPage(db, "records/test-note-def", "record");
    const wrote = db.recordPageWriteProvenance(
      "records/test-note-def",
      forPutPage({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    );
    expect(wrote).toBe(true);
    const row = db.getPageWriteProvenance("records/test-note-def")!;
    expect(row.write_mode).toBe("put_page");
    expect(row.actor_class).toBe("operator");
    expect(row.creation_reason).toBe("explicit_page_create");
    expect(row.origin_ref).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("forVaultDiscovery helper maps to external_direct_write / unknown_writer / vault_file_discovered", () => {
    seedPage(db, "records/test-note-ghi", "record");
    db.recordPageWriteProvenance("records/test-note-ghi", forVaultDiscovery());
    const row = db.getPageWriteProvenance("records/test-note-ghi")!;
    expect(row.write_mode).toBe("external_direct_write");
    expect(row.actor_class).toBe("unknown_writer");
    expect(row.creation_reason).toBe("vault_file_discovered");
    expect(row.origin_kind).toBeNull();
    expect(row.origin_ref).toBeNull();
  });

  test("append-only: identical retry is idempotent (returns false, no throw)", () => {
    seedPage(db, "records/test-note-jkl", "record");
    const first = db.recordPageWriteProvenance(
      "records/test-note-jkl",
      forIngest({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    );
    // Same attribution retried — idempotent, returns false, no throw.
    const second = db.recordPageWriteProvenance(
      "records/test-note-jkl",
      forIngest({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = db.getPageWriteProvenance("records/test-note-jkl")!;
    expect(row.actor_class).toBe("operator");
  });

  test("append-only: DIFFERENT attribution throws (re-attribution refused, unforgable)", () => {
    seedPage(db, "records/test-note-reattr", "record");
    db.recordPageWriteProvenance(
      "records/test-note-reattr",
      forIngest({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    );
    // Attempt to re-attribute to agent — must throw, row stays operator.
    expect(() =>
      db.recordPageWriteProvenance("records/test-note-reattr", forPutPage({ actorClass: "agent" })),
    ).toThrow(PageWriteProvenanceConflictError);
    const row = db.getPageWriteProvenance("records/test-note-reattr")!;
    expect(row.actor_class).toBe("operator");
    expect(row.write_mode).toBe("ingest");
    expect(row.creation_reason).toBe("explicit_ingest");
  });

  test("forUnattributed maps to unknown_write_path / unknown_writer / unattributed_internal_create", () => {
    seedPage(db, "records/test-note-unattr", "record");
    db.recordPageWriteProvenance("records/test-note-unattr", forUnattributed());
    const row = db.getPageWriteProvenance("records/test-note-unattr")!;
    expect(row.write_mode).toBe("unknown_write_path");
    expect(row.actor_class).toBe("unknown_writer");
    expect(row.creation_reason).toBe("unattributed_internal_create");
  });

  test("origin_ref rejects anything that is not a UUID/ULID — incl. credentials and paths", () => {
    seedPage(db, "records/test-note-origin", "record");
    // All of these fail the UUID/ULID format gate — credentials cannot match it,
    // so no secret is ever persisted, regardless of token format.
    const badRefs = [
      "/Users/someone/secret/vault.md", // absolute path
      "relative/path/to/file", // relative path
      "sk-proj-abcdefgh1234567890abcdef", // sk- credential
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // 40+ hex token
      "ghp_0123456789abcdef0123456789abcdef01234567", // GitHub PAT
      "AIzaSyA" + "9".repeat(33), // Google API key shape (rule-undetected, UUID gate rejects)
      "xoxb-" + "1".repeat(50), // Slack token (rule-undetected, UUID gate rejects)
      "github_pat_" + "0".repeat(22), // GitHub fine-grained PAT
      "sess-abc123", // free-form session id (no longer allowed — must be UUID/ULID)
      "cli", // free-form
      "has spaces",
      "a:b:c",
    ];
    for (const bad of badRefs) {
      expect(() =>
        db.recordPageWriteProvenance(
          "records/test-note-origin",
          forIngest({ actorClass: "agent", origin: { kind: "session", ref: bad } }),
        ),
      ).toThrow(/UUID|ULID|origin_ref/i);
    }
    // Nothing was persisted for this slug.
    expect(db.getPageWriteProvenance("records/test-note-origin")).toBeNull();
  });

  test("origin_ref accepts a UUID (lower- or upper-case hex)", () => {
    seedPage(db, "records/test-note-okref", "record");
    const uuid = "11111111-2222-4333-8444-555555555555";
    const wrote = db.recordPageWriteProvenance(
      "records/test-note-okref",
      forIngest({ actorClass: "agent", origin: { kind: "session", ref: uuid } }),
    );
    expect(wrote).toBe(true);
    expect(db.getPageWriteProvenance("records/test-note-okref")!.origin_ref).toBe(uuid);
    // Upper-case hex UUID also accepted.
    seedPage(db, "records/test-note-upper", "record");
    expect(() =>
      db.recordPageWriteProvenance(
        "records/test-note-upper",
        forIngest({ actorClass: "agent", origin: { kind: "session", ref: "ABCDEF12-3456-7890-ABCD-EF1234567890" } }),
      ),
    ).not.toThrow();
  });

  test("getPageWriteProvenance returns null when no row exists (honest absence, no backfill)", () => {
    seedPage(db, "records/test-note-mno", "record");
    expect(db.getPageWriteProvenance("records/test-note-mno")).toBeNull();
    expect(db.getPageWriteProvenance("records/never-created")).toBeNull();
  });

  test("cascade: deleting the page removes the provenance row", () => {
    seedPage(db, "records/test-note-pqr", "record");
    db.recordPageWriteProvenance("records/test-note-pqr", forVaultDiscovery());
    expect(db.getPageWriteProvenance("records/test-note-pqr")).not.toBeNull();

    db.deletePageCascaded("records/test-note-pqr");
    expect(db.getPageWriteProvenance("records/test-note-pqr")).toBeNull();
  });

  test("listRecordPagesWithoutWriteProvenance lists only record pages lacking a row", () => {
    // record WITH provenance → excluded
    seedPage(db, "records/has-prov", "record");
    db.recordPageWriteProvenance("records/has-prov", forVaultDiscovery());
    // record WITHOUT provenance → included
    seedPage(db, "records/no-prov", "record", "No Prov Note");
    // entity page → excluded regardless of provenance (scope = record)
    seedPage(db, "brain/entities/someone", "entity/person");
    // concept page → excluded
    seedPage(db, "brain/concepts/something", "concept");

    const missing = db.listRecordPagesWithoutWriteProvenance();
    expect(missing.map((r) => r.slug)).toEqual(["records/no-prov"]);
    expect(missing[0].title).toBe("No Prov Note");
  });

  test("listRecordPagesWithoutWriteProvenance respects limit", () => {
    for (let i = 0; i < 5; i++) {
      seedPage(db, `records/batch-${i}`, "record", `Batch ${i}`);
    }
    const missing = db.listRecordPagesWithoutWriteProvenance(2);
    expect(missing).toHaveLength(2);
  });

  test("countRecordPagesWithoutWriteProvenance returns the total (not limited)", () => {
    for (let i = 0; i < 5; i++) seedPage(db, `records/cnt-${i}`, "record");
    seedPage(db, "records/cnt-prov", "record");
    db.recordPageWriteProvenance("records/cnt-prov", forVaultDiscovery());
    // Total is 5 even though a LIMIT 2 list would return 2.
    expect(db.countRecordPagesWithoutWriteProvenance()).toBe(5);
    expect(db.listRecordPagesWithoutWriteProvenance(2)).toHaveLength(2);
  });

  test("listAndCountRecordPagesWithoutWriteProvenance returns a consistent snapshot", () => {
    for (let i = 0; i < 3; i++) seedPage(db, `records/snap-${i}`, "record");
    // list + total from one read-only transaction: missing never exceeds total.
    const { missing, total } = db.listAndCountRecordPagesWithoutWriteProvenance(2);
    expect(total).toBe(3);
    expect(missing).toHaveLength(2);
    expect(missing.length).toBeLessThanOrEqual(total);
  });

  test("movePage migrates page_write_provenance to the new slug (no FK failure)", () => {
    seedPage(db, "records/move-src", "record");
    db.recordPageWriteProvenance("records/move-src", forVaultDiscovery());
    expect(db.getPageWriteProvenance("records/move-src")).not.toBeNull();

    // Previously this threw 'foreign key check failed: page_write_provenance -> pages'.
    db.movePage("records/move-src", "records/move-dst", "record", "records/move-dst.md");

    expect(db.getPage("records/move-src")).toBeNull();
    expect(db.getPage("records/move-dst")).not.toBeNull();
    // Provenance row followed the page to the new slug.
    const row = db.getPageWriteProvenance("records/move-dst")!;
    expect(row.actor_class).toBe("unknown_writer");
    expect(db.getPageWriteProvenance("records/move-src")).toBeNull();

    // No lingering FK violations after the move.
    const violations = (db as unknown as { rawDb: { prepare: (s: string) => { all: () => unknown[] } } })
      .rawDb.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toEqual([]);
  });

  test("immutable: direct UPDATE of attribution fields is aborted by the DB trigger", () => {
    seedPage(db, "records/imm-target", "record");
    db.recordPageWriteProvenance(
      "records/imm-target",
      forIngest({ actorClass: "operator", origin: { kind: "session", ref: "11111111-2222-4333-8444-555555555555" } }),
    );
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).rawDb;
    // Bypass the method and attempt raw re-attribution — DB must ABORT.
    expect(() =>
      raw.prepare("UPDATE page_write_provenance SET actor_class = 'agent' WHERE page_slug = ?").run("records/imm-target"),
    ).toThrow(/immutable/i);
    expect(() =>
      raw.prepare("UPDATE page_write_provenance SET write_mode = 'put_page' WHERE page_slug = ?").run("records/imm-target"),
    ).toThrow(/immutable/i);
    expect(() =>
      raw.prepare("UPDATE page_write_provenance SET origin_ref = 'forged' WHERE page_slug = ?").run("records/imm-target"),
    ).toThrow(/immutable/i);
    // Row is unchanged (still operator).
    expect(db.getPageWriteProvenance("records/imm-target")!.actor_class).toBe("operator");
  });

  test("immutable: direct DELETE is aborted (blocks DELETE+INSERT re-attribution)", () => {
    seedPage(db, "records/del-target", "record");
    db.recordPageWriteProvenance("records/del-target", forIngest({ actorClass: "operator" }));
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).rawDb;
    // Direct DELETE while the page still exists — must ABORT (only page deletion
    // may cascade-remove the row). This blocks DELETE+INSERT re-attribution.
    expect(() =>
      raw.prepare("DELETE FROM page_write_provenance WHERE page_slug = ?").run("records/del-target"),
    ).toThrow(/immutable|direct DELETE/i);
    // Row survives.
    expect(db.getPageWriteProvenance("records/del-target")!.actor_class).toBe("operator");
  });

  test("immutable: direct page_slug transfer to another page is aborted", () => {
    // A has operator/ingest provenance; B is a different existing page.
    seedPage(db, "records/transfer-a", "record");
    db.recordPageWriteProvenance("records/transfer-a", forIngest({ actorClass: "operator" }));
    seedPage(db, "records/transfer-b", "record");
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).rawDb;
    // Direct transfer of A's provenance row onto B — must ABORT (page A still
    // exists; only movePage's rename path may update page_slug).
    expect(() =>
      raw.prepare("UPDATE page_write_provenance SET page_slug = ? WHERE page_slug = ?").run("records/transfer-b", "records/transfer-a"),
    ).toThrow(/transfer|movePage/i);
    // A keeps its attribution; B has none (no forgery).
    expect(db.getPageWriteProvenance("records/transfer-a")!.actor_class).toBe("operator");
    expect(db.getPageWriteProvenance("records/transfer-b")).toBeNull();
  });

  test("repairOrphanedDerivedRows repairs orphan page_write_provenance rows (#386)", () => {
    const raw = (db as unknown as {
      rawDb: { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } };
    }).rawDb;
    // Create an orphan provenance row (parent page doesn't exist) via FK-off insert.
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare(
      "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason) VALUES (?, 'ingest', 'agent', 'explicit_ingest')",
    ).run("records/orphan-no-page");
    raw.exec("PRAGMA foreign_keys = ON");

    // FK check detects it.
    const before = db.checkFkViolations();
    expect(before.byTable["page_write_provenance"] ?? 0).toBe(1);

    // Repair removes it (the no_direct_delete trigger allows it: parent is gone).
    const result = db.repairOrphanedDerivedRows();
    expect(result.repairedByTable["page_write_provenance"] ?? 0).toBe(1);
    expect(result.remaining).toBe(0);
    expect(db.checkFkViolations().total).toBe(0);
  });

  test("structural no-credential: raw INSERT of a credential origin_ref is ABORTed at the DB", () => {
    seedPage(db, "records/cred-target", "record");
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).rawDb;
    // Bypass the method and attempt to persist a credential directly.
    expect(() =>
      raw.prepare(
        "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason, origin_kind, origin_ref) VALUES (?, 'ingest', 'agent', 'explicit_ingest', 'session', ?)",
      ).run("records/cred-target", "xoxb-123456789012-private-token"),
    ).toThrow(/UUID|ULID|credential/i);
    // Nothing persisted — getPageWriteProvenance can never return the secret.
    expect(db.getPageWriteProvenance("records/cred-target")).toBeNull();
  });

  test("structural: origin_kind/origin_ref must both be null or both be present", () => {
    seedPage(db, "records/pair-target", "record");
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).rawDb;
    // origin_kind present, origin_ref null → rejected.
    expect(() =>
      raw.prepare(
        "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason, origin_kind, origin_ref) VALUES (?, 'ingest', 'agent', 'explicit_ingent', 'session', NULL)",
      ).run("records/pair-target"),
    ).toThrow(/both be null or both present/i);
    // Both null → OK (the unattributed / vault-discovery case).
    seedPage(db, "records/pair-ok", "record");
    expect(() =>
      raw.prepare(
        "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason) VALUES (?, 'external_direct_write', 'unknown_writer', 'vault_file_discovered')",
      ).run("records/pair-ok"),
    ).not.toThrow();
  });

  test("fresh-DB init: page_write_provenance + 4 triggers exist after migrate, pages intact (#386 regression)", () => {
    // migrate() already ran in beforeEach on a fresh DB. Assert the post-init
    // schema: the table + all four triggers are present, pages still exists, and
    // the setup marker is set. Guards against re-introducing the ordering bug
    // where the table/triggers were created before the pages rebuild.
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { all: () => unknown[]; get: () => unknown } } }).rawDb;
    const tableNames = new Set(
      (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pages','page_write_provenance')").all() as Array<{ name: string }>).map((t) => t.name),
    );
    expect(tableNames.has("pages")).toBe(true);
    expect(tableNames.has("page_write_provenance")).toBe(true);

    const triggerNames = new Set(
      (raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='page_write_provenance'").all() as Array<{ name: string }>).map((t) => t.name),
    );
    for (const t of [
      "page_write_provenance_immutable",
      "page_write_provenance_no_direct_delete",
      "page_write_provenance_no_transfer",
      "page_write_provenance_origin_format",
    ]) {
      expect(triggerNames.has(t)).toBe(true);
    }
  });
});

describe("redactOriginRefForDisplay (#386 read-layer defense)", () => {
  test("always digests — the raw ref is NEVER displayed, safe or hostile", () => {
    // Display is always a short sha256 digest. This holds for safe opaque IDs
    // AND for any credential/path shape (no detection rule covers every token
    // format, so the display layer never echoes raw origin_ref at all).
    const safe = redactOriginRefForDisplay("sess-abc123")!;
    expect(safe).toMatch(/^[a-f0-9]{12}$/);
    expect(safe).not.toBe("sess-abc123");

    // Stable: same ref -> same digest (correlatable within a session).
    expect(redactOriginRefForDisplay("sess-abc123")).toBe(safe);
  });

  test("never echoes raw credential/path tokens — including shapes write-validation misses", () => {
    const hostile = [
      "/Users/someone/secret/vault.md",
      "sk-proj-abcdefgh1234567890abcdef",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "ghp_0123456789abcdef0123456789abcdef01234567",
      // github_pat_/xox are NOT caught by any project credential rule, yet the
      // display digest still guarantees the raw token never appears.
      "github_pat_0123456789abcdef0123456789abcdef",
      "xoxb-1234567890-abcdef",
    ];
    for (const v of hostile) {
      const out = redactOriginRefForDisplay(v)!;
      expect(out).toMatch(/^[a-f0-9]{12}$/);
      expect(out).not.toBe(v);
      expect(out).not.toContain(v);
    }
  });

  test("null passthrough", () => {
    expect(redactOriginRefForDisplay(null)).toBeNull();
  });
});

describe("validateOriginRef (#386 method-layer, aligned with the DB trigger)", () => {
  test("accepts UUID (lower/upper hex) and ULID with first char 0-7", () => {
    expect(() => validateOriginRef("11111111-2222-4333-8444-555555555555")).not.toThrow();
    expect(() => validateOriginRef("ABCDEF12-3456-7890-ABCD-EF1234567890")).not.toThrow();
    // Max legal ULID (first time-char 7, rest Z) — within 128 bits.
    expect(() => validateOriginRef("7" + "Z".repeat(25))).not.toThrow();
  });

  test("rejects an overflow ULID (first char > 7) at the method layer, matching the DB trigger", () => {
    // A 26-char Crockford string starting with Z overflows 128 bits. Previously
    // the method regex accepted it and only the DB trigger rejected it (a
    // SQLiteError); now both layers agree and reject it.
    expect(() => validateOriginRef("Z" + "0".repeat(25))).toThrow(/UUID|ULID/i);
  });
});

describe("migrate ordering: page_write_provenance after pages rebuild (#386)", () => {
  const testDir = "/tmp/cbrain-test-pwp-migrate-order";
  const dbPath = join(testDir, "test.sqlite");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("re-migrate PRESERVES existing provenance rows (no silent data loss on upgrade) (#386 P1)", () => {
    // A prior build created page_write_provenance + rows. Re-opening (re-running
    // migrate) must keep the table and its rows — migrate only drops/recreates
    // the triggers (which reference pages), never the table.
    let db = new CBrainDB(dbPath);
    db.insertPage({ slug: "records/keep-me", type: "record", title: "Keep", filePath: "records/keep-me.md", contentHash: "h" });
    db.recordPageWriteProvenance("records/keep-me", forVaultDiscovery());
    expect(db.getPageWriteProvenance("records/keep-me")?.actor_class).toBe("unknown_writer");
    db.close();

    // Re-open → migrate() runs again (triggers dropped before pages rebuild,
    // recreated after; table untouched). The row must survive.
    db = new CBrainDB(dbPath);
    const row = db.getPageWriteProvenance("records/keep-me");
    expect(row).not.toBeNull();
    expect(row?.actor_class).toBe("unknown_writer");
    expect(row?.write_mode).toBe("external_direct_write");
    // pages row also intact.
    expect(db.getPage("records/keep-me")).not.toBeNull();
    // All 4 triggers present after re-migrate.
    const raw = (db as unknown as { rawDb: { prepare: (s: string) => { all: () => unknown[] } } }).rawDb;
    const triggerNames = new Set(
      (raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='page_write_provenance'").all() as Array<{ name: string }>).map((t) => t.name),
    );
    for (const t of ["page_write_provenance_immutable", "page_write_provenance_no_direct_delete", "page_write_provenance_no_transfer", "page_write_provenance_origin_format"]) {
      expect(triggerNames.has(t)).toBe(true);
    }
    db.close();
  });
});
