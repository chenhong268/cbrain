import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { forVaultDiscovery } from "../../src/core/page-write-provenance.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("CLI writer-audit + show-writer (#386)", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-writer-audit-"));
    brainDir = join(testDir, "mybrain");
    dbPath = join(brainDir, "brain.sqlite");
    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string, type: string): void {
    const db = new CBrainDB(dbPath);
    db.insertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `hash-${slug}` });
    db.close();
  }

  function seedPageWithProv(slug: string, title: string, type: string): void {
    const db = new CBrainDB(dbPath);
    db.insertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `hash-${slug}` });
    db.recordPageWriteProvenance(slug, forVaultDiscovery());
    db.close();
  }

  function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), ...args], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
  }

  test("writer-audit lists only record pages lacking provenance", () => {
    // record WITH provenance → excluded
    seedPageWithProv("records/has-prov", "Has Prov", "record");
    // record WITHOUT provenance → listed
    seedPage("records/no-prov", "No Prov", "record");
    // entity page → excluded (scope = record)
    seedPage("brain/entities/someone", "Someone", "entity/person");

    const { stdout, exitCode } = runCli("writer-audit");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("records/no-prov");
    expect(stdout).not.toContain("records/has-prov");
    expect(stdout).not.toContain("brain/entities/someone");
  });

  test("show-writer prints provenance for a tracked page", () => {
    seedPageWithProv("records/tracked", "Tracked", "record");

    const { stdout, exitCode } = runCli("show-writer", "records/tracked");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("unknown_writer");
    expect(stdout).toContain("external_direct_write");
    expect(stdout).toContain("vault_file_discovered");
  });

  test("show-writer on an untracked page reports honest absence", () => {
    seedPage("records/legacy", "Legacy", "record");

    const { stdout, exitCode } = runCli("show-writer", "records/legacy");

    expect(exitCode).toBe(0);
    // Absence is honest (pre-tracking / untracked) — never a fabricated row.
    expect(stdout.toLowerCase()).toMatch(/untracked|no provenance|未追踪|无溯源/);
  });

  /** Seed a page with a UUID origin_ref (the only shape the DB trigger allows)
   *  to exercise the display path. */
  function seedPageWithUuidOrigin(slug: string, title: string): void {
    const db = new CBrainDB(dbPath);
    db.insertPage({ slug, type: "record", title, filePath: `${slug}.md`, contentHash: `hash-${slug}` });
    (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .rawDb.prepare(
        "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason, origin_kind, origin_ref) VALUES (?, 'ingest', 'agent', 'explicit_ingest', 'session', ?)",
      )
      .run(slug, "11111111-2222-4333-8444-555555555555");
    db.close();
  }

  test("a hostile origin_ref cannot be seeded at all (DB trigger blocks storage)", () => {
    // Structural no-credential guarantee: even raw SQL cannot persist a
    // credential-shaped origin_ref (the method-layer check is only backup).
    const db = new CBrainDB(dbPath);
    db.insertPage({ slug: "records/hostile-block", type: "record", title: "Hostile", filePath: "records/hostile-block.md", contentHash: "h" });
    expect(() =>
      (db as unknown as { rawDb: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
        .rawDb.prepare(
          "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason, origin_kind, origin_ref) VALUES (?, 'ingest', 'agent', 'explicit_ingest', 'session', ?)",
        )
        .run("records/hostile-block", "xoxb-123456789012-private-token"),
    ).toThrow(/UUID|ULID|credential/i);
    db.close();
  });

  test("show-writer displays a UUID origin_ref as a digest (never raw)", () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    seedPageWithUuidOrigin("records/uuid-origin", "Uuid Origin");

    const { stdout, exitCode } = runCli("show-writer", "records/uuid-origin");

    expect(exitCode).toBe(0);
    // The raw UUID is never echoed; display is a 12-hex digest (defense in depth
    // — storage already restricts origin_ref to UUID/ULID).
    expect(stdout).not.toContain(uuid);
    expect(stdout).toMatch(/origin:\s+session=[a-f0-9]{12}/);
  });

  test("writer-audit --json emits stable JSON with missing/total/truncated", () => {
    seedPage("records/json-no-prov", "Json No Prov", "record");
    seedPageWithProv("records/json-has-prov", "Json Has Prov", "record");

    const { stdout, exitCode } = runCli("writer-audit", "--json");

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      missing: Array<{ slug: string }>; count: number; total: number; truncated: boolean;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.missing.map((m) => m.slug)).toEqual(["records/json-no-prov"]);
  });

  test("writer-audit --json marks truncation when total exceeds limit", () => {
    for (let i = 0; i < 5; i++) seedPage(`records/trunc-${i}`, `Trunc ${i}`, "record");
    const { stdout, exitCode } = runCli("writer-audit", "--json", "--limit", "2");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { count: number; total: number; truncated: boolean };
    expect(parsed.count).toBe(2);
    expect(parsed.total).toBe(5);
    expect(parsed.truncated).toBe(true);
  });

  test("writer-audit --limit rejects non-positive / non-integer (exit 2)", () => {
    for (const bad of ["abc", "-1", "0", "1.5", ""]) {
      const { exitCode, stderr } = runCli("writer-audit", "--limit", bad);
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(/positive integer/i);
    }
  });

  test("show-writer --json displays a UUID origin_ref as a digest", () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    seedPageWithUuidOrigin("records/json-uuid", "Json Uuid");

    const { stdout, exitCode } = runCli("show-writer", "records/json-uuid", "--json");

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { slug: string; status: string; provenance: { origin_ref: string } };
    expect(parsed.status).toBe("tracked");
    expect(parsed.provenance.origin_ref).toMatch(/^[a-f0-9]{12}$/);
    expect(parsed.provenance.origin_ref).not.toBe(uuid);
  });

  test("show-writer --json on an untracked page emits status:untracked (exit 0)", () => {
    seedPage("records/json-legacy", "Json Legacy", "record");

    const { stdout, exitCode } = runCli("show-writer", "records/json-legacy", "--json");

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { slug: string; status: string; provenance: unknown };
    expect(parsed.slug).toBe("records/json-legacy");
    expect(parsed.status).toBe("untracked");
    expect(parsed.provenance).toBeNull();
  });

  test("show-writer distinguishes not_found (page missing) from untracked — exit 1", () => {
    // Typo / non-existent slug: NOT 'untracked', it's 'not_found' (exit 1).
    const { stdout, exitCode } = runCli("show-writer", "records/never-existed", "--json");
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { slug: string; status: string };
    expect(parsed.status).toBe("not_found");

    const human = runCli("show-writer", "records/never-existed");
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toMatch(/not found/i);
  });
});
