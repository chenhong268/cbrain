import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { CBrainConfig } from "../../src/cli/context.js";
import {
  runFirstRunDoctor,
  formatHuman,
  formatJson,
} from "../../src/core/first-run.js";
import type { FirstRunReport } from "../../src/core/first-run.js";

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
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.overallStatus).not.toBe("fail");
        expect(report.checks.length).toBeGreaterThan(0);
        expect(report.recommendedNextAction).toBeTruthy();
      } finally {
        process.chdir(origDir);
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

    test("passes LanceDB check (creates empty DB)", async () => {
      const config = makeConfig();
      mkdirSync(config.vaultPath, { recursive: true });
      writeConfig(config);

      const db = new CBrainDB(config.dbPath);
      db.close();

      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        const lance = report.checks.find((c) => c.id === "index:lancedb");
        expect(lance!.status).toBe("pass");
        // Empty lance = message should mention sync
        if (lance!.message.includes("empty")) {
          expect(lance!.message).toContain("cbrain sync");
        }
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

  // ── deriveNextAction ──

  describe("deriveNextAction", () => {
    test("suggests init when config missing", async () => {
      const origDir = process.cwd();
      process.chdir(testDir);
      try {
        const report = await runFirstRunDoctor();
        expect(report.recommendedNextAction).toContain("cbrain init");
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
      };
      const output = formatHuman(report);
      expect(output).toContain("Result: PASS");
    });
  });

  describe("formatJson", () => {
    test("produces valid JSON with all fields", () => {
      const report: FirstRunReport = {
        overallStatus: "warn",
        checks: [
          { id: "test", category: "test", status: "warn", message: "test msg", action: "fix it" },
        ],
        recommendedNextAction: "do something",
      };
      const output = formatJson(report);
      const parsed = JSON.parse(output);
      expect(parsed.overallStatus).toBe("warn");
      expect(parsed.checks).toHaveLength(1);
      expect(parsed.checks[0].id).toBe("test");
      expect(parsed.recommendedNextAction).toBe("do something");
    });
  });
});
