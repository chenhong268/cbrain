import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;
const PKG = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8"));

describe("CLI", () => {
  const testDir = "/tmp/cbrain-test-cli";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("init", () => {
    test("creates config and vault directories", () => {
      const brainDir = join(testDir, "mybrain");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      expect(existsSync(join(brainDir, "cbrain.json"))).toBe(true);
      expect(existsSync(join(brainDir, "vault/records"))).toBe(true);
      expect(existsSync(join(brainDir, "vault/brain/entities"))).toBe(true);
      expect(existsSync(join(brainDir, "vault/brain/insights"))).toBe(true);
      expect(existsSync(join(brainDir, "vault/brain/concepts"))).toBe(true);
      expect(existsSync(join(brainDir, "runtime"))).toBe(true);
      expect(existsSync(join(brainDir, "brain.sqlite"))).toBe(true);
    });

    test("writes correct config", () => {
      const brainDir = join(testDir, "mybrain");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      const config = JSON.parse(readFileSync(join(brainDir, "cbrain.json"), "utf-8"));
      expect(config.vaultPath).toBe(join(brainDir, "vault"));
      expect(config.dbPath).toBe(join(brainDir, "brain.sqlite"));
      expect(config.lancePath).toBe(join(brainDir, "lancedb"));
      expect(config.embedding.provider).toBe("zhipu");
    });

    test("refuses to overwrite existing config", () => {
      const brainDir = join(testDir, "mybrain");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      expect(() => {
        execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8", stdio: "pipe" });
      }).toThrow();
    });

    test("--json outputs valid InitResult JSON", () => {
      const brainDir = join(testDir, "mybrain-json");
      const stdout = execSync(`${BIN} init --dir ${brainDir} --json`, { encoding: "utf-8" });

      const result = JSON.parse(stdout);
      expect(result.status).toBe("ok");
      expect(result.created).toBe(true);
      expect(result.configPath).toBeTruthy();
      expect(result.readinessState).toBe("missing_creds");
      expect(result.nextAction.id).toBe("set_credentials");
      expect(result.nextAction.command).toBeTruthy();
      expect(result.nextAction.message).toBeTruthy();
    });

    test("--json returns missing_index when creds present", () => {
      const brainDir = join(testDir, "mybrain-creds");
      const stdout = execSync(`${BIN} init --dir ${brainDir} --json`, {
        encoding: "utf-8",
        env: { ...process.env, ZHIPU_API_KEY: "test-key" },
      });

      const result = JSON.parse(stdout);
      expect(result.status).toBe("ok");
      expect(result.readinessState).toBe("missing_index");
      expect(result.nextAction.id).toBe("sync_index");
    });

    test("--json has no surrounding prose", () => {
      const brainDir = join(testDir, "mybrain-clean");
      const stdout = execSync(`${BIN} init --dir ${brainDir} --json`, { encoding: "utf-8" });

      expect(stdout.trim()[0]).toBe("{");
      expect(stdout.trim().at(-1)).toBe("}");
    });

    test("--force overwrites existing config", () => {
      const brainDir = join(testDir, "mybrain-force");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      // Second init without --force should fail
      expect(() => {
        execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8", stdio: "pipe" });
      }).toThrow();

      // With --force should succeed
      const stdout = execSync(`${BIN} init --dir ${brainDir} --force --json`, { encoding: "utf-8" });
      const result = JSON.parse(stdout);
      expect(result.status).toBe("ok");
    });

    test("writes runtimePath in generated config", () => {
      const brainDir = join(testDir, "mybrain-rt");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      const config = JSON.parse(readFileSync(join(brainDir, "cbrain.json"), "utf-8"));
      expect(config.runtimePath).toBe(join(brainDir, "runtime"));
    });

    test("handles paths with spaces", () => {
      const brainDir = join(testDir, "my brain");
      const stdout = execSync(`${BIN} init --dir "${brainDir}" --json`, { encoding: "utf-8" });

      const result = JSON.parse(stdout);
      expect(result.status).toBe("ok");
      expect(existsSync(join(brainDir, "cbrain.json"))).toBe(true);
      expect(existsSync(join(brainDir, "vault/records"))).toBe(true);
    });

    test("--json error has no surrounding prose on failure", () => {
      const brainDir = join(testDir, "mybrain-err");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      let stdout = "";
      try {
        execSync(`${BIN} init --dir ${brainDir} --json`, { encoding: "utf-8", stdio: "pipe" });
      } catch (e: any) {
        stdout = e.stdout ?? "";
      }

      const result = JSON.parse(stdout);
      expect(result.status).toBe("error");
      expect(result.errorMessage).toBeTruthy();
    });
  });

  describe("help", () => {
    test("shows version", () => {
      const output = execSync(`${BIN} --version`, { encoding: "utf-8" });
      expect(output.trim()).toBe(PKG.version);
    });

    test("shows help text", () => {
      const output = execSync(`${BIN} --help`, { encoding: "utf-8" });
      expect(output).toContain("init");
      expect(output).toContain("doctor");
      expect(output).toContain("ingest");
      expect(output).toContain("query");
      expect(output).toContain("sync");
      expect(output).toContain("serve");
      expect(output).toContain("graph-query");
      expect(output).toContain("enrich");
    });
  });

  describe("commands requiring config", () => {
    test("exits with error when no config found", () => {
      expect(() => {
        execSync(`${BIN} doctor`, {
          cwd: testDir,
          encoding: "utf-8",
          stdio: "pipe",
        });
      }).toThrow(/No cbrain.json found/);
    });
  });

  describe("enrich with config", () => {
    test("runs enrich via CLI", () => {
      const brainDir = join(testDir, "mybrain");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      const db = new CBrainDB(join(brainDir, "brain.sqlite"));
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`
      ).run("entities/test", "Test", "test.md", "h1", 5, 3);
      db.close();

      const output = execSync(`${BIN} enrich`, {
        cwd: brainDir,
        encoding: "utf-8",
      });

      const results = JSON.parse(output);
      expect(results.length).toBe(1);
      expect(results[0].upgraded).toBe(true);
      expect(results[0].newTier).toBe(2);
    });
  });

  describe("graph-query with config", () => {
    test("runs graph-query via CLI", () => {
      const brainDir = join(testDir, "mybrain");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      const db = new CBrainDB(join(brainDir, "brain.sqlite"));
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");
      db.close();

      const output = execSync(`${BIN} graph-query --mode traverse entities/a`, {
        cwd: brainDir,
        encoding: "utf-8",
      });

      const results = JSON.parse(output);
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("entities/b");
    });

    test("backlinks mode via CLI", () => {
      const brainDir = join(testDir, "mybrain");
      execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

      const db = new CBrainDB(join(brainDir, "brain.sqlite"));
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/b", "entities/a", "mentions");
      db.close();

      const output = execSync(`${BIN} graph-query --mode backlinks entities/a`, {
        cwd: brainDir,
        encoding: "utf-8",
      });

      const results = JSON.parse(output);
      expect(results.length).toBe(1);
      expect(results[0].from_slug).toBe("entities/b");
    });
  });
});
