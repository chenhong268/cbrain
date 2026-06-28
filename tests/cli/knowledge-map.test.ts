import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { buildProgram } from "../../src/cli/program.js";

const tmp = "/tmp/cbrain-test-knowledge-map-cli";

/** Capture console.log output from fn. */
function captureLog(fn: () => void): string {
  const orig = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

/** Seed an anonymous 2-entity graph (entity/concept scope) via CBrainDB. */
function seedGraph(dbPath: string): void {
  const db = new CBrainDB(dbPath);
  const ins = db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  ins.run("entity/a", "entity/person", "实体A", "a.md", "h1", 1, 1);
  ins.run("entity/b", "entity/person", "实体B", "b.md", "h2", 1, 1);
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation, source_type) VALUES (?, ?, ?, ?)")
    .run("entity/a", "entity/b", "mentions", "wikilink");
  db.close();
}

function writeConfig(configPath: string, vaultPath: string, dbPath: string, runtimePath: string): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      vaultPath,
      dbPath,
      lancePath: join(tmp, "lancedb"),
      runtimePath,
      embedding: { provider: "deterministic" },
      ner: { enabled: false },
    }),
  );
}

describe("cbrain knowledge-map CLI (#241)", () => {
  beforeEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true });
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true });
    delete process.env.CBRAIN_CONFIG;
  });

  test("writes Markdown under runtime/output (not the vault), read-only on pages, titles not slugs", () => {
    const dbPath = join(tmp, "brain.sqlite");
    const vaultPath = join(tmp, "vault");
    const runtimePath = join(tmp, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    seedGraph(dbPath);
    const configPath = join(tmp, "cbrain.json");
    writeConfig(configPath, vaultPath, dbPath, runtimePath);

    const out = captureLog(() => {
      process.env.CBRAIN_CONFIG = configPath;
      buildProgram().parse(["knowledge-map"], { from: "user" });
    });

    // Prints a summary + the output path.
    expect(out).toContain("知识图谱");
    expect(out).toMatch(/报告已写入/);

    // Report lives under runtime/knowledge-map, never inside the vault.
    const today = new Date().toISOString().slice(0, 10);
    const reportFile = join(runtimePath, "knowledge-map", `knowledge-map-${today}.md`);
    expect(existsSync(reportFile)).toBe(true);
    expect(existsSync(join(vaultPath, "knowledge-map"))).toBe(false);

    // Read-only: page rows unchanged.
    const verify = new Database(dbPath);
    expect((verify.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number }).c).toBe(2);
    verify.close();

    // Default report shows human titles, never slugs.
    const md = readFileSync(reportFile, "utf-8");
    expect(md).toContain("实体A");
    expect(md).not.toContain("entity/");
  });

  test("--json prints raw analysis and writes no report file", () => {
    const dbPath = join(tmp, "brain.sqlite");
    const vaultPath = join(tmp, "vault");
    const runtimePath = join(tmp, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    seedGraph(dbPath);
    const configPath = join(tmp, "cbrain.json");
    writeConfig(configPath, vaultPath, dbPath, runtimePath);

    const out = captureLog(() => {
      process.env.CBRAIN_CONFIG = configPath;
      buildProgram().parse(["knowledge-map", "--json"], { from: "user" });
    });

    // Raw JSON analysis printed (carries slugs — that's the point of --json).
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBe(2);

    // No Markdown report written in JSON mode.
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(runtimePath, "knowledge-map", `knowledge-map-${today}.md`))).toBe(false);
  });
});
