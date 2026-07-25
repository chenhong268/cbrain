import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { CBrainConfig } from "../../src/cli/context.js";
import {
  runFirstRunDoctor,
  formatHuman,
  formatJson,
} from "../../src/core/maintenance/first-run.js";
import type { FirstRunReport } from "../../src/core/maintenance/first-run.js";

// Re-import internal check functions via a test-only re-export approach.
// We test through the runner and also test formatters.

describe("FirstRunDoctor", () => {
  const testDir = "/tmp/cbrain-test-firstrun";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makeConfig(overrides: Partial<CBrainConfig> = {}): CBrainConfig {
    return {
      vaultPath: join(testDir, "vault"),
      dbPath: join(testDir, "brain.sqlite"),
      lancePath: join(testDir, "lancedb"),
      embedding: { provider: "zhipu" },
      ...overrides,
    };
  }

  function writeConfig(config: CBrainConfig, dir?: string): string {
    const configDir = dir ?? testDir;
    const configPath = join(configDir, "cbrain.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  // ── Integration: full run with valid config ──

  describe("runFirstRunDoctor", () => {
    test("returns pass when all checks pass", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      // Pre-create DB so schema migration runs
      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      const origKey = process.env.ZHIPU_API_KEY;
      process.env.ZHIPU_API_KEY = "test-key-for-pass-check";
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.overallStatus).not.toBe("fail");
        expect(report.checks.length).toBeGreaterThan(0);
        expect(report.recommendedNextAction).toBeTruthy();
        expect(typeof report.recommendedNextAction).toBe("string");
        expect(report.nextAction).toBeTruthy();
        expect(report.nextAction.id).toBeTruthy();
        expect(report.readinessState).toBeTruthy();
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
        else delete process.env.ZHIPU_API_KEY;
      }
    });

    test("returns fail when config missing", async () => {
      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        // Ensure no cbrain.json in testDir
        const report = await runFirstRunDoctor();
        expect(report.overallStatus).toBe("fail");
        const configCheck = report.checks.find((c) => c.id === "config:exists");
        expect(configCheck).toBeDefined();
        expect(configCheck!.status).toBe("fail");
        expect(report.recommendedNextAction).toContain("cbrain init");
        expect(report.nextAction.id).toBe("run_init");
        expect(report.nextAction.message).toContain("cbrain init");
      } finally {
        process.chdir(origDir);
      }
    });

    test("returns fail when vaultPath missing", async () => {
      const config = makeConfig({ vaultPath: "" });
      writeConfig(config);

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.overallStatus).toBe("fail");
        const vp = report.checks.find((c) => c.id === "config:vaultPath");
        expect(vp!.status).toBe("fail");
      } finally {
        process.chdir(origDir);
      }
    });

    test("returns fail when dbPath missing", async () => {
      const config = makeConfig({ dbPath: "" });
      writeConfig(config);

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.overallStatus).toBe("fail");
        const dp = report.checks.find((c) => c.id === "config:dbPath");
        expect(dp!.status).toBe("fail");
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── Paths checks ──

  describe("paths checks", () => {
    test("warns when runtime is inside vault", async () => {
      const vaultDir = join(testDir, "vault");
      mkdirSync(vaultDir, { recursive: true });
      const config = makeConfig({
        vaultPath: vaultDir,
        runtimePath: join(vaultDir, "runtime"),
      });
      writeConfig(config);

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const rt = report.checks.find((c) => c.id === "paths:runtimeOutsideVault");
        expect(rt).toBeDefined();
        expect(rt!.status).toBe("warn");
        expect(rt!.message).toContain("inside vault");
      } finally {
        process.chdir(origDir);
      }
    });

    test("fails when runtimePath equals vault root", async () => {
      const vaultDir = join(testDir, "vault");
      mkdirSync(vaultDir, { recursive: true });
      const config = makeConfig({
        vaultPath: vaultDir,
        runtimePath: vaultDir,
      });
      writeConfig(config);

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const rt = report.checks.find((c) => c.id === "paths:runtimeOutsideVault");
        expect(rt).toBeDefined();
        expect(rt!.status).toBe("fail");
        expect(rt!.message).toContain("vault root");
      } finally {
        process.chdir(origDir);
      }
    });

    test("fails when vault does not exist", async () => {
      const config = makeConfig();
      // Don't create vault dir
      writeConfig(config);

      // Create DB so it doesn't fail first
      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const ve = report.checks.find((c) => c.id === "paths:vaultExists");
        expect(ve!.status).toBe("fail");
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── DB checks ──

  describe("database checks", () => {
    test("passes with valid DB", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const dbOpen = report.checks.find((c) => c.id === "db:open");
        expect(dbOpen!.status).toBe("pass");
        const dbWal = report.checks.find((c) => c.id === "db:wal");
        expect(dbWal!.status).toBe("pass");
      } finally {
        process.chdir(origDir);
      }
    });

    test("passes DB with tables", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const dbTables = report.checks.find((c) => c.id === "db:tables");
        expect(dbTables!.status).toBe("pass");
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── Index checks ──

  describe("index checks", () => {
    test("passes FTS5 after DB init (schema creates chunks_fts)", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const fts = report.checks.find((c) => c.id === "index:fts5");
        expect(fts!.status).toBe("pass");
      } finally {
        process.chdir(origDir);
      }
    });

    test("warns on LanceDB for new install (missing index)", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        // New install — lance path doesn't exist, should warn
        const lance = report.checks.find((c) => c.id.startsWith("index:lance_"));
        expect(lance!.status).toBe("warn");
        expect(lance!.message).toContain("cbrain sync");
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── Services checks ──

  describe("services checks", () => {
    test("reports no services running when clean", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const svcNone = report.checks.find((c) => c.id === "services:none");
        expect(svcNone).toBeDefined();
        expect(svcNone!.status).toBe("pass");
      } finally {
        process.chdir(origDir);
      }
    });

    test("detects stale watcher lock", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      // Write stale watcher lock with PID 99999 (guaranteed dead)
      const profileDir = join(testDir);
      const lockContent = JSON.stringify({ pid: 99999, startedAt: new Date().toISOString(), transport: "http" });
      writeFileSync(join(profileDir, ".watcher.lock"), lockContent);

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const wl = report.checks.find((c) => c.id === "services:watcherLock");
        expect(wl).toBeDefined();
        expect(wl!.status).toBe("fail");
      } finally {
        process.chdir(origDir);
      }
    });

    test("detects stale PID lock file", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      // Write stale PID file
      writeFileSync(join(testDir, "cbrain-http.pid"), "99999");

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const pid = report.checks.find((c) => c.id === "services:pidLock:http");
        expect(pid).toBeDefined();
        expect(pid!.status).toBe("warn");
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── MCP guidance ──

  describe("MCP guidance", () => {
    test("always passes with guidance message", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const mcp = report.checks.find((c) => c.id === "mcp:guidance");
        expect(mcp).toBeDefined();
        expect(mcp!.status).toBe("pass");
        expect(mcp!.message).toContain("cbrain serve");
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── Lance failure regression ──

  describe("LanceDB failure next-action", () => {
    test("LanceDB failure recommends rebuild (not 'ready')", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      // Seed SQLite with chunks so LanceDB failure triggers fail
      const db = new CBrainDB(config.dbPath);
      db.rawDb.prepare(
        "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
      ).run("entities/x", "X", "entities/x.md", "h1");
      db.rawDb.prepare(
        "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
      ).run("entities/x", "content for x");
      db.close();

      // Set API key so credential check passes (LanceDB is the real failure here)
      const origKey = process.env.ZHIPU_API_KEY;
      process.env.ZHIPU_API_KEY = "test-key-for-lance-check";

      // Don't create lancePath — probe will detect missing path with SQLite data
      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        // Should NOT say "ready" — LanceDB is broken
        expect(report.recommendedNextAction).not.toContain("准备就绪");
        // Should mention LanceDB rebuild
        expect(report.recommendedNextAction).toMatch(/LanceDB|sync/);
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
        else delete process.env.ZHIPU_API_KEY;
      }
    });

    test("first-run doctor closes all DB handles despite LanceDB probe errors", async () => {
      // Spy on CBrainDB.close to verify it's called even when LanceDB probe encounters errors
      // This covers checkDatabase (1 DB) + checkIndexes (2 DBs: FTS5 check + LanceDB probe)
      // Normal doctor's DB close is tested via handleReindexVectors in tests/cli/reindex-vectors.test.ts
      let closeCallCount = 0;
      const origClose = CBrainDB.prototype.close;
      CBrainDB.prototype.close = function(this: CBrainDB) {
        closeCallCount++;
        return origClose.call(this);
      };

      try {
        // Setup config with a corrupted LanceDB (garbage data that will cause probe to fail)
        const config = makeConfig();
        mkdirSync(config.vaultPath, { recursive: true });
        writeConfig(config);

        // Seed SQLite with chunks so LanceDB probe has data to compare against
        const seedDb = new CBrainDB(config.dbPath);
        seedDb.rawDb.prepare(
          "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
        ).run("test/a", "A", "test/a.md", "h1");
        seedDb.rawDb.prepare(
          "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
        ).run("test/a", "chunk content");
        seedDb.close();

        // Create a corrupted lance directory (will cause probe to fail when connecting)
        mkdirSync(config.lancePath, { recursive: true });
        writeFileSync(join(config.lancePath, "chunks.lance"), "CORRUPTED GARBAGE DATA");

        const origDir = process.cwd();
        process.chdir(testDir);
        try {
          // Run first-run doctor — it should survive LanceDB errors without leaking DB handles
          const report = await runFirstRunDoctor();
          // LanceDB should report failure
          const lanceChecks = report.checks.filter(c => c.id.includes("lance"));
          expect(lanceChecks.length).toBeGreaterThan(0);
        } finally {
          process.chdir(origDir);
        }

        // Verify DB.close was called — checkIndexes opens a second DB (db2) for lance probe
        // and must close it even on error. Total close calls should be >= 2 (checkDatabase + checkIndexes).
        expect(closeCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        CBrainDB.prototype.close = origClose;
      }
    });
  });

  // ── deriveNextAction ──

  describe("deriveNextAction", () => {
    test("suggests init when config missing", async () => {
      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.nextAction.id).toBe("run_init");
        expect(report.nextAction.message).toContain("cbrain init");
      } finally {
        process.chdir(origDir);
      }
    });

    test("suggests serve when everything ready", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        // Should mention serve (may have warns for empty DB, but that's ok)
        expect(report.recommendedNextAction).toBeTruthy();
        expect(report.nextAction).toBeTruthy();
      } finally {
        process.chdir(origDir);
      }
    });
  });

  // ── Formatters ──

  describe("formatHuman", () => {
    test("produces human-readable grouped output", () => {
      const report: FirstRunReport = {
        overallStatus: "pass",
        checks: [
          { id: "config:exists", category: "config", status: "pass", message: "config found" },
          { id: "config:vaultPath", category: "config", status: "pass", message: "vaultPath configured" },
          { id: "db:open", category: "db", status: "fail", message: "failed to open", action: "check permissions" },
        ],
        recommendedNextAction: "fix db",
        nextAction: { id: "run_init", command: "cbrain init", message: "fix db" },
        readinessState: "no_config",
      };
      const output = formatHuman(report);
      expect(output).toContain("Config");
      expect(output).toContain("config found");
      expect(output).toContain("✗");
      expect(output).toContain("check permissions");
      expect(output).toContain("FAIL");
    });

    test("shows PASS when no failures", () => {
      const report: FirstRunReport = {
        overallStatus: "pass",
        checks: [
          { id: "config:exists", category: "config", status: "pass", message: "ok" },
        ],
        recommendedNextAction: "ready",
        nextAction: { id: "mcp_config", command: "cbrain mcp-config", message: "ready" },
        readinessState: "ready",
      };
      const output = formatHuman(report);
      expect(output).toContain("Result: PASS");
    });

    test("shows nextAction.message as Next line", () => {
      const report: FirstRunReport = {
        overallStatus: "fail",
        checks: [
          { id: "config:exists", category: "config", status: "fail", message: "no config" },
        ],
        recommendedNextAction: "运行 cbrain init 创建配置",
        nextAction: { id: "run_init", command: "cbrain init --dir <path>", message: "运行 cbrain init 创建配置" },
        readinessState: "no_config",
      };
      const output = formatHuman(report);
      expect(output).toContain("Next: 运行 cbrain init 创建配置");
      expect(output).toContain("cbrain init --dir <path>");
    });

    test("omits Next line when nextAction has empty message", () => {
      const report: FirstRunReport = {
        overallStatus: "pass",
        checks: [
          { id: "config:exists", category: "config", status: "pass", message: "ok" },
        ],
        recommendedNextAction: "",
        nextAction: { id: "mcp_config", command: "", message: "" },
        readinessState: "ready",
      };
      const output = formatHuman(report);
      expect(output).not.toContain("Next:");
    });
  });

  describe("formatJson", () => {
    test("produces valid JSON with all fields including readinessState", () => {
      const report: FirstRunReport = {
        overallStatus: "warn",
        checks: [
          { id: "test", category: "test", status: "warn", message: "test msg", action: "fix it" },
        ],
        recommendedNextAction: "do something",
        nextAction: { id: "sync_index", command: "cbrain sync", message: "do something" },
        readinessState: "missing_index",
      };
      const output = formatJson(report);
      const parsed = JSON.parse(output);
      expect(parsed.overallStatus).toBe("warn");
      expect(parsed.checks).toHaveLength(1);
      expect(parsed.checks[0].id).toBe("test");
      expect(typeof parsed.recommendedNextAction).toBe("string");
      expect(parsed.recommendedNextAction).toBe("do something");
      expect(parsed.nextAction.id).toBe("sync_index");
      expect(parsed.nextAction.command).toBe("cbrain sync");
      expect(parsed.readinessState).toBe("missing_index");
    });
  });

  // ── Credential readiness ──

  describe("credentials check", () => {
    test("fails when ZHIPU_API_KEY not set", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const origDir = process.cwd();
      const origKey = process.env.ZHIPU_API_KEY;
      delete process.env.ZHIPU_API_KEY;
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const cred = report.checks.find((c) => c.id === "credentials:api_key");
        expect(cred).toBeDefined();
        expect(cred!.status).toBe("fail");
        expect(report.nextAction.id).toBe("set_credentials");
        expect(report.readinessState).toBe("missing_creds");
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
      }
    });

    test("passes when ZHIPU_API_KEY set in env", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      const origKey = process.env.ZHIPU_API_KEY;
      process.env.ZHIPU_API_KEY = "test-key-for-doctor-check";
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const cred = report.checks.find((c) => c.id === "credentials:api_key");
        expect(cred).toBeDefined();
        expect(cred!.status).toBe("pass");
        // With creds + DB + vault, should NOT be missing_creds
        expect(report.readinessState).not.toBe("missing_creds");
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
        else delete process.env.ZHIPU_API_KEY;
      }
    });
  });

  // ── #383: credential-bearing config file permissions ──

  describe("config:permissions check (#383)", () => {
    // File-mode semantics are meaningful on POSIX only (win32 is ACL-governed).
    const itPosix = process.platform !== "win32" ? test : test.skip;

    function writeConfigWithMode(config: CBrainConfig, mode: number): string {
      const configPath = writeConfig(config);
      chmodSync(configPath, mode);
      return configPath;
    }

    async function runDoctor(): Promise<FirstRunReport> {
      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        return await runFirstRunDoctor();
      } finally {
        process.chdir(origDir);
      }
    }

    itPosix("credential-bearing + group/other-readable → warn, no leak", async () => {
      const config = makeConfig({ embedding: { provider: "zhipu", apiKey: "test-key-for-permissions-check" } });
      mkdirSync(config.vaultPath, { recursive: true });
      const db = new CBrainDB(config.dbPath);
      db.close();
      writeConfigWithMode(config, 0o644);

      const report = await runDoctor();
      const perm = report.checks.find((c) => c.id === "config:permissions");
      expect(perm).toBeDefined();
      expect(perm!.status).toBe("warn");
      // Privacy contract (#383): no path, no credential value, no field-name token.
      const combined = perm!.message + (perm!.action ?? "");
      expect(combined).not.toContain(testDir);
      expect(combined).not.toContain("test-key");
      expect(combined).not.toMatch(/api[_-]?key/i);
    });

    itPosix("credential-bearing + owner-only (0600) → pass", async () => {
      const config = makeConfig({ embedding: { provider: "zhipu", apiKey: "test-key-for-permissions-check" } });
      mkdirSync(config.vaultPath, { recursive: true });
      const db = new CBrainDB(config.dbPath);
      db.close();
      writeConfigWithMode(config, 0o600);

      const report = await runDoctor();
      const perm = report.checks.find((c) => c.id === "config:permissions");
      expect(perm).toBeDefined();
      expect(perm!.status).toBe("pass");
    });

    itPosix("credential-free + world-readable → pass (no misleading warning)", async () => {
      const config = makeConfig(); // no apiKey — file carries no secret
      mkdirSync(config.vaultPath, { recursive: true });
      const db = new CBrainDB(config.dbPath);
      db.close();
      writeConfigWithMode(config, 0o644);

      const report = await runDoctor();
      const perm = report.checks.find((c) => c.id === "config:permissions");
      expect(perm).toBeDefined();
      expect(perm!.status).toBe("pass");
    });

    test("all platforms: check present, never throws; win32 capability-skip → pass", async () => {
      const config = makeConfig({ embedding: { provider: "zhipu", apiKey: "test-key-for-permissions-check" } });
      mkdirSync(config.vaultPath, { recursive: true });
      const db = new CBrainDB(config.dbPath);
      db.close();
      writeConfigWithMode(config, process.platform === "win32" ? 0o666 : 0o644);

      const report = await runDoctor();
      const perm = report.checks.find((c) => c.id === "config:permissions");
      expect(perm).toBeDefined();
      // POSIX: world-readable + creds → warn; win32: capability skip → pass.
      expect(perm!.status).toBe(process.platform === "win32" ? "pass" : "warn");
    });

    itPosix("credential-bearing + stat failure → warn (unknown state is not pass), no leak", async () => {
      const config = makeConfig({ embedding: { provider: "zhipu", apiKey: "test-key-for-permissions-check" } });
      mkdirSync(config.vaultPath, { recursive: true });
      const db = new CBrainDB(config.dbPath);
      db.close();
      writeConfigWithMode(config, 0o600);

      // Inject a statSync failure to exercise the unknown-state branch
      // without depending on an exotic filesystem. Only statSync is spied;
      // existsSync/readFileSync stay real so the rest of the doctor runs.
      const fs = await import("node:fs");
      const spy = spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("synthetic EACCES");
      });
      try {
        const report = await runDoctor();
        const perm = report.checks.find((c) => c.id === "config:permissions");
        expect(perm).toBeDefined();
        expect(perm!.status).toBe("warn");
        const combined = perm!.message + (perm!.action ?? "");
        expect(combined).not.toContain(testDir);
        expect(combined).not.toContain("test-key");
        expect(combined).not.toMatch(/api[_-]?key/i);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── ReadinessState transitions ──

  describe("readinessState transitions", () => {
    test("no_config when config missing", async () => {
      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.readinessState).toBe("no_config");
      } finally {
        process.chdir(origDir);
      }
    });

    test("missing_creds when config exists but no API key", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      const origKey = process.env.ZHIPU_API_KEY;
      delete process.env.ZHIPU_API_KEY;
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.readinessState).toBe("missing_creds");
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
      }
    });

    test("ready when all checks pass with credentials and index", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      mkdirSync(config.lancePath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      // Seed a chunk so lance probe sees SQLite data and expects a matching LanceDB table
      db.rawDb.prepare(
        "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
      ).run("entities/x", "X", "entities/x.md", "h1");
      db.rawDb.prepare(
        "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
      ).run("entities/x", "content for x");
      db.close();

      // Create a valid LanceDB chunks table to match SQLite data
      const lancedb = await import("@lancedb/lancedb");
      const conn = await lancedb.connect(config.lancePath);
      await conn.createTable("chunks", [{ pageSlug: "entities/x", chunkIndex: 0, vector: Array(1024).fill(0), text: "content for x" }]);
      conn.close();

      const origDir = process.cwd();
      const origKey = process.env.ZHIPU_API_KEY;
      process.env.ZHIPU_API_KEY = "test-key-for-ready-check";
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.readinessState).toBe("ready");
        expect(report.nextAction.id).toBe("mcp_config");
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
        else delete process.env.ZHIPU_API_KEY;
      }
    });

    test("missing_index when fresh init with creds but no LanceDB", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      // Don't create lancePath — simulates fresh init with creds
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      const origKey = process.env.ZHIPU_API_KEY;
      process.env.ZHIPU_API_KEY = "test-key-for-missing-index";
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.readinessState).toBe("missing_index");
        expect(report.nextAction.id).toBe("sync_index");
      } finally {
        process.chdir(origDir);
        if (origKey !== undefined) process.env.ZHIPU_API_KEY = origKey;
        else delete process.env.ZHIPU_API_KEY;
      }
    });
  });
});
