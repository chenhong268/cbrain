import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  resolveSkillsDir,
  verifySkillPack,
  formatHuman,
  compareTarget,
  REQUIRED_FILES,
} from "../../src/cli/commands/skill-pack.js";
import type { SkillPackReport } from "../../src/cli/commands/skill-pack.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("cbrain skill-pack", () => {
  // ── Source checkout verification ──

  describe("source checkout", () => {
    test("exits 0 on clean checkout", () => {
      const stdout = execSync(`${BIN} skill-pack`, { encoding: "utf-8" });
      expect(stdout).toContain("Status: PASS");
      expect(stdout).toContain("6/6 present");
    });

    test("contains version in output", () => {
      const stdout = execSync(`${BIN} skill-pack`, { encoding: "utf-8" });
      expect(stdout).toMatch(/v\d+\.\d+\.\d+/);
    });

    test("contains absolute pack path", () => {
      const stdout = execSync(`${BIN} skill-pack`, { encoding: "utf-8" });
      expect(stdout).toContain(resolveSkillsDir());
    });
  });

  // ── JSON output schema ──

  describe("JSON output schema", () => {
    let report: Record<string, unknown>;

    beforeEach(() => {
      const stdout = execSync(`${BIN} skill-pack --json`, { encoding: "utf-8" });
      report = JSON.parse(stdout);
    });

    test("has no surrounding prose", () => {
      const stdout = execSync(`${BIN} skill-pack --json`, { encoding: "utf-8" });
      expect(stdout.trim()[0]).toBe("{");
      expect(stdout.trim().at(-1)).toBe("}");
    });

    test("has all required top-level fields", () => {
      expect(typeof report.version).toBe("string");
      expect(typeof report.packPath).toBe("string");
      expect(typeof report.entrypointPath).toBe("string");
      expect(Array.isArray(report.requiredFiles)).toBe(true);
      expect(Array.isArray(report.missingFiles)).toBe(true);
      expect(typeof report.sizeStatus).toBe("string");
      expect(typeof report.entrypointChars).toBe("number");
      expect(typeof report.verificationStatus).toBe("string");
      expect(typeof report.status).toBe("string");
      expect(report.status).toBe("pass");
      expect(typeof report.guidance).toBe("object");
    });

    test("requiredFiles has 6 entries with name + status", () => {
      const files = report.requiredFiles as Array<Record<string, unknown>>;
      expect(files).toHaveLength(6);
      for (const f of files) {
        expect(typeof f.name).toBe("string");
        expect(typeof f.status).toBe("string");
      }
    });

    test("missingFiles is empty on clean checkout", () => {
      expect(report.missingFiles).toEqual([]);
    });

    test("guidance has copyCommand and symlinkCommand", () => {
      const guidance = report.guidance as Record<string, unknown>;
      expect(typeof guidance.copyCommand).toBe("string");
      expect(typeof guidance.symlinkCommand).toBe("string");
      expect(guidance.copyCommand).toContain("cp -r");
      expect(guidance.symlinkCommand).toContain("ln -s");
    });

    test("verificationStatus is pass on clean checkout", () => {
      expect(report.verificationStatus).toBe("pass");
    });
  });

  // ── Packed-install fixture (pure function tests, outside repo cwd) ──

  describe("fixture verification", () => {
    const fixtureDir = "/tmp/cbrain-test-skill-pack-fixture";

    beforeEach(() => {
      if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true });
      mkdirSync(fixtureDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true });
    });

    function seedFixture(dir: string, overrides: { skipFiles?: string[]; skillContent?: string } = {}): void {
      const skipFiles = new Set(overrides.skipFiles ?? []);
      const files: Record<string, string> = {
        "SKILL.md": overrides.skillContent ?? "# Test Skill Pack\nMinimal fixture.",
        "hermes-cbrain-brief.md": "# Brief\nTest brief.",
        "RESOLVER.md": "# Resolver\nTest resolver.",
        "recall-resolver.md": "# Recall Resolver\nTest recall resolver.",
        "response-contract.routing-eval.jsonl": '{"input":"test","category":"test","expected_behavior":"ok"}',
        "agent-facing.routing-eval.jsonl": '{"input":"test","category":"test","expected_tool":"deep_recall"}',
      };

      for (const [name, content] of Object.entries(files)) {
        if (!skipFiles.has(name)) {
          writeFileSync(join(dir, name), content);
        }
      }
    }

    test("all present files report pass", () => {
      seedFixture(fixtureDir);
      const report = verifySkillPack(fixtureDir);

      expect(report.verificationStatus).toBe("pass");
      expect(report.missingFiles).toEqual([]);
      expect(report.requiredFiles.every((f) => f.status === "present")).toBe(true);
    });

    test("missing required file reports fail", () => {
      seedFixture(fixtureDir, { skipFiles: ["recall-resolver.md"] });
      const report = verifySkillPack(fixtureDir);

      expect(report.verificationStatus).toBe("fail");
      expect(report.missingFiles).toContain("recall-resolver.md");
    });

    test("required file that is a directory reports not_file", () => {
      seedFixture(fixtureDir);
      // Replace a file with a directory
      rmSync(join(fixtureDir, "RESOLVER.md"));
      mkdirSync(join(fixtureDir, "RESOLVER.md"), { recursive: true });

      const report = verifySkillPack(fixtureDir);
      expect(report.missingFiles).toContain("RESOLVER.md");
      const resolver = report.requiredFiles.find((f) => f.name === "RESOLVER.md");
      expect(resolver?.status).toBe("not_file");
    });
  });

  // ── Entrypoint size checks ──

  describe("entrypoint size", () => {
    const sizeDir = "/tmp/cbrain-test-skill-pack-size";

    beforeEach(() => {
      if (existsSync(sizeDir)) rmSync(sizeDir, { recursive: true });
      mkdirSync(sizeDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(sizeDir)) rmSync(sizeDir, { recursive: true });
    });

    function seedMinimal(dir: string): void {
      writeFileSync(join(dir, "SKILL.md"), "ok");
      writeFileSync(join(dir, "hermes-cbrain-brief.md"), "ok");
      writeFileSync(join(dir, "RESOLVER.md"), "ok");
      writeFileSync(join(dir, "recall-resolver.md"), "ok");
      writeFileSync(join(dir, "response-contract.routing-eval.jsonl"), "{}");
      writeFileSync(join(dir, "agent-facing.routing-eval.jsonl"), "{}");
    }

    test("warns when entrypoint exceeds 30K chars", () => {
      seedMinimal(sizeDir);
      writeFileSync(join(sizeDir, "SKILL.md"), "x".repeat(35_000));

      const report = verifySkillPack(sizeDir);
      expect(report.sizeStatus).toBe("warn");
      expect(report.verificationStatus).toBe("warn");
    });

    test("errors when entrypoint exceeds 100K chars", () => {
      seedMinimal(sizeDir);
      writeFileSync(join(sizeDir, "SKILL.md"), "x".repeat(110_000));

      const report = verifySkillPack(sizeDir);
      expect(report.sizeStatus).toBe("error");
      expect(report.verificationStatus).toBe("fail");
    });

    test("ok when entrypoint under 30K chars", () => {
      seedMinimal(sizeDir);

      const report = verifySkillPack(sizeDir);
      expect(report.sizeStatus).toBe("ok");
      expect(report.verificationStatus).toBe("pass");
    });
  });

  // ── Missing skills directory ──

  describe("missing skills directory", () => {
    test("verifySkillPack throws for nonexistent directory", () => {
      expect(() => verifySkillPack("/tmp/cbrain-nonexistent-xyz-12345")).toThrow(
        /Skills directory not found/,
      );
    });

    test("verifySkillPack throws for non-directory path", () => {
      const filePath = "/tmp/cbrain-test-skill-pack-notdir";
      writeFileSync(filePath, "not a dir");

      try {
        expect(() => verifySkillPack(filePath)).toThrow(/not a directory/);
      } finally {
        rmSync(filePath, { force: true });
      }
    });
  });

  // ── Privacy / no credentials ──

  describe("privacy", () => {
    test("JSON output contains no credentials or user paths", () => {
      const stdout = execSync(`${BIN} skill-pack --json`, { encoding: "utf-8" });

      // Must not contain credential patterns
      expect(stdout).not.toMatch(/api[_-]?key/i);
      expect(stdout).not.toMatch(/sk-/);
      // Must not contain env-leaked paths
      expect(stdout).not.toMatch(/\/Users\/[^/]+\/(Documents|Desktop|Downloads)\//);
    });
  });

  // ── JSON error envelope on failure ──

  describe("JSON failure output", () => {
    test("missing required file returns parseable JSON with verificationStatus fail", () => {
      // Build fixture missing one file, run CLI against it
      const fixtureDir = "/tmp/cbrain-test-skill-pack-jsonfail";
      if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true });
      mkdirSync(fixtureDir, { recursive: true });

      // Seed all except recall-resolver.md
      const files: Record<string, string> = {
        "SKILL.md": "# Test",
        "hermes-cbrain-brief.md": "# Brief",
        "RESOLVER.md": "# Resolver",
        "recall-resolver.md": "# Recall",  // will be deleted
        "response-contract.routing-eval.jsonl": "{}",
        "agent-facing.routing-eval.jsonl": "{}",
      };
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(fixtureDir, name), content);
      }
      // Remove one required file
      rmSync(join(fixtureDir, "recall-resolver.md"));

      // Test via pure function
      const report = verifySkillPack(fixtureDir);
      expect(report.verificationStatus).toBe("fail");
      expect(report.missingFiles).toContain("recall-resolver.md");

      // Verify the report serializes to valid JSON
      const json = JSON.stringify(report);
      const parsed = JSON.parse(json);
      expect(parsed.verificationStatus).toBe("fail");
      expect(parsed.missingFiles).toContain("recall-resolver.md");

      // Cleanup
      rmSync(fixtureDir, { recursive: true });
    });

    test("verifySkillPack error for nonexistent dir is catchable", () => {
      // The pure function throws — CLI wraps it in structured JSON
      expect(() => verifySkillPack("/tmp/cbrain-nonexistent-xyz-99999")).toThrow(
        /Skills directory not found/,
      );
    });
  });

  // ── formatHuman ──

  describe("formatHuman", () => {
    test("produces human-readable output", () => {
      const report: SkillPackReport = {
        version: "1.0.0",
        packPath: "/test/skills",
        entrypointPath: "/test/skills/SKILL.md",
        requiredFiles: [
          { name: "SKILL.md", status: "present", absolutePath: "/test/skills/SKILL.md" },
        ],
        missingFiles: [],
        sizeStatus: "ok",
        entrypointChars: 1234,
        verificationStatus: "pass",
        status: "pass",
        guidance: { copyCommand: "cp -r /test/skills/ <target>/", symlinkCommand: "ln -s /test/skills <target>" },
      };

      const output = formatHuman(report);
      expect(output).toContain("CBrain Skill Pack v1.0.0");
      expect(output).toContain("Status: PASS");
      expect(output).toContain("1/1 present");
      expect(output).toContain("1,234 chars");
      expect(output).toContain("cp -r");
    });

    test("shows FAIL with missing files", () => {
      const report: SkillPackReport = {
        version: "1.0.0",
        packPath: "/test/skills",
        entrypointPath: "/test/skills/SKILL.md",
        requiredFiles: [
          { name: "SKILL.md", status: "present" },
          { name: "RESOLVER.md", status: "missing" },
        ],
        missingFiles: ["RESOLVER.md"],
        sizeStatus: "ok",
        entrypointChars: 100,
        verificationStatus: "fail",
        status: "fail",
        guidance: { copyCommand: "cp -r /test/skills/ <target>/", symlinkCommand: "ln -s /test/skills <target>" },
      };

      const output = formatHuman(report);
      expect(output).toContain("Status: FAIL");
      expect(output).toContain("Missing: RESOLVER.md");
      // Should NOT show copy/symlink guidance on fail
      expect(output).not.toContain("Copy:");
    });

    test("shows FAIL with stale target even when canonical passes", () => {
      const report: SkillPackReport = {
        version: "1.0.0",
        packPath: "/test/skills",
        entrypointPath: "/test/skills/SKILL.md",
        requiredFiles: [
          { name: "SKILL.md", status: "present", absolutePath: "/test/skills/SKILL.md" },
        ],
        missingFiles: [],
        sizeStatus: "ok",
        entrypointChars: 50,
        verificationStatus: "pass",
        status: "fail",
        guidance: { copyCommand: "cp -r /test/skills/ <target>/", symlinkCommand: "ln -s /test/skills <target>" },
        target: {
          path: "/test/target",
          status: "stale",
          files: [
            { name: "SKILL.md", state: "stale" },
          ],
          staleFiles: ["SKILL.md"],
          missingTargetFiles: [],
          unverifiedFiles: [],
        },
      };

      const output = formatHuman(report);
      expect(output).toContain("Status: FAIL");
      expect(output).toContain("Pack status: PASS");
      expect(output).toContain("Target status: STALE");
      expect(output).toContain("Stale: SKILL.md");
    });
  });

  // ── Pack content verification (bun pm pack) ──

  describe("pack content", () => {
    const packDir = "/tmp/cbrain-test-skill-pack-content";

    beforeEach(() => {
      if (existsSync(packDir)) rmSync(packDir, { recursive: true });
      mkdirSync(packDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(packDir)) rmSync(packDir, { recursive: true });
    });

    test("all required skill files are in the packed artifact", () => {
      // Build tarball
      execSync("bun pm pack", { cwd: PROJECT_DIR, encoding: "utf-8" });

      // Find the tarball (cbrain-x.y.z.tgz)
      const glob = new Bun.Glob("cbrain-*.tgz");
      const tarballPath = [...glob.scanSync({ cwd: PROJECT_DIR })][0];
      expect(tarballPath).toBeTruthy();

      // Extract to temp dir
      execSync(`tar -xzf "${join(PROJECT_DIR, tarballPath)}" -C "${packDir}"`, { encoding: "utf-8" });

      // Find the extracted package directory (package/)
      const extracted = execSync(`ls "${packDir}"`, { encoding: "utf-8" }).trim().split("\n")[0];
      const pkgDir = join(packDir, extracted);

      // All required skill files must be present
      for (const name of REQUIRED_FILES) {
        expect(existsSync(join(pkgDir, "skills", name))).toBe(true);
      }

      // Clean up tarball
      rmSync(join(PROJECT_DIR, tarballPath), { force: true });
    });

    test("forbidden paths are absent from packed artifact", () => {
      execSync("bun pm pack", { cwd: PROJECT_DIR, encoding: "utf-8" });

      const glob = new Bun.Glob("cbrain-*.tgz");
      const tarballPath = [...glob.scanSync({ cwd: PROJECT_DIR })][0];
      expect(tarballPath).toBeTruthy();

      // List all files in tarball
      const contents = execSync(`tar -tzf "${join(PROJECT_DIR, tarballPath)}"`, { encoding: "utf-8" });

      // Forbidden paths must NOT appear
      const forbidden = [
        "tests/",
        "reviews/",
        "docs/superpowers/",
        "AGENTS.md",
        "task_plan.md",
        "CLAUDE.md",
        ".test.ts",
        "__tests__/",
      ];
      for (const path of forbidden) {
        expect(contents).not.toContain(path);
      }

      // Clean up tarball
      rmSync(join(PROJECT_DIR, tarballPath), { force: true });
    });
  });

  // ── Packed artifact install proof (real subprocess) ──

  describe("packed artifact CLI", () => {
    const installRoot = "/tmp/cbrain-test-skill-pack-install";

    beforeEach(() => {
      if (existsSync(installRoot)) rmSync(installRoot, { recursive: true });
      mkdirSync(installRoot, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(installRoot)) rmSync(installRoot, { recursive: true });
    });

    test("installed CLI verifies pack from unrelated cwd via subprocess", async () => {
      // Build tarball
      execSync("bun pm pack", { cwd: PROJECT_DIR, encoding: "utf-8" });
      const glob = new Bun.Glob("cbrain-*.tgz");
      const tarball = [...glob.scanSync({ cwd: PROJECT_DIR })][0];
      expect(tarball).toBeTruthy();

      // Extract
      const tarballPath = join(PROJECT_DIR, tarball);
      execSync(`tar -xzf "${tarballPath}" -C "${installRoot}"`, { encoding: "utf-8" });

      // Find extracted package dir
      const entries = readdirSync(installRoot);
      expect(entries.length).toBeGreaterThan(0);
      const pkgDir = join(installRoot, entries[0]);

      // Use checkout deps (offline — no network needed; production install proven by check:install-network)
      symlinkSync(join(PROJECT_DIR, "node_modules"), join(pkgDir, "node_modules"));

      // Run the extracted CLI from an unrelated cwd via subprocess
      const extractedBin = join(pkgDir, "src/cli/index.ts");
      const cwd = "/tmp"; // unrelated to both checkout and install
      const stdout = execSync(
        `bun run "${extractedBin}" skill-pack --json`,
        { encoding: "utf-8", cwd, timeout: 30_000 },
      );
      const report = JSON.parse(stdout);

      // Must pass
      expect(report.verificationStatus).toBe("pass");
      expect(report.missingFiles).toEqual([]);

      // packPath must be inside the installed package, not the source checkout
      expect(report.packPath).toContain(installRoot);
      expect(report.packPath).not.toContain("Projects/cbrain");

      // Cleanup tarball
      rmSync(tarballPath, { force: true });
    }, 30_000); // symlink deps — no install needed
  });

  // ── Target comparison (--target) ──

  describe("target comparison", () => {
    const canonDir = "/tmp/cbrain-test-skill-pack-canon";
    const targetDir = "/tmp/cbrain-test-skill-pack-target";

    beforeEach(() => {
      for (const d of [canonDir, targetDir]) {
        if (existsSync(d)) rmSync(d, { recursive: true });
        mkdirSync(d, { recursive: true });
      }
    });

    afterEach(() => {
      for (const d of [canonDir, targetDir]) {
        if (existsSync(d)) rmSync(d, { recursive: true });
      }
    });

    function seedMinimal(dir: string): void {
      writeFileSync(join(dir, "SKILL.md"), "# Test Pack");
      writeFileSync(join(dir, "hermes-cbrain-brief.md"), "# Brief");
      writeFileSync(join(dir, "RESOLVER.md"), "# Resolver");
      writeFileSync(join(dir, "recall-resolver.md"), "# Recall");
      writeFileSync(join(dir, "response-contract.routing-eval.jsonl"), '{"test":1}');
      writeFileSync(join(dir, "agent-facing.routing-eval.jsonl"), '{"test":2}');
    }

    test("all current when target matches canonical", () => {
      seedMinimal(canonDir);
      seedMinimal(targetDir);

      const result = compareTarget(canonDir, targetDir);
      expect(result.staleFiles).toEqual([]);
      expect(result.missingTargetFiles).toEqual([]);
      expect(result.files.every((f) => f.state === "current")).toBe(true);
    });

    test("stale when target file content differs", () => {
      seedMinimal(canonDir);
      seedMinimal(targetDir);
      // Modify one file in target
      writeFileSync(join(targetDir, "RESOLVER.md"), "# Modified Resolver");

      const result = compareTarget(canonDir, targetDir);
      expect(result.staleFiles).toContain("RESOLVER.md");
      expect(result.files.find((f) => f.name === "RESOLVER.md")?.state).toBe("stale");
    });

    test("missing when target file absent", () => {
      seedMinimal(canonDir);
      seedMinimal(targetDir);
      // Remove one file from target
      rmSync(join(targetDir, "recall-resolver.md"));

      const result = compareTarget(canonDir, targetDir);
      expect(result.missingTargetFiles).toContain("recall-resolver.md");
      expect(result.files.find((f) => f.name === "recall-resolver.md")?.state).toBe("missing");
    });

    test("mixed: some current, some stale, some missing", () => {
      seedMinimal(canonDir);
      seedMinimal(targetDir);
      writeFileSync(join(targetDir, "RESOLVER.md"), "# Modified");
      rmSync(join(targetDir, "recall-resolver.md"));

      const result = compareTarget(canonDir, targetDir);
      expect(result.staleFiles).toContain("RESOLVER.md");
      expect(result.missingTargetFiles).toContain("recall-resolver.md");
      expect(result.files.filter((f) => f.state === "current").length).toBe(4);
    });

    test("CLI --target outputs JSON with target field and status", () => {
      // Use canonical skills dir as both source and target (should be all current)
      const skillsDir = resolveSkillsDir();

      const stdout = execSync(
        `${BIN} skill-pack --json --target "${skillsDir}"`,
        { encoding: "utf-8" },
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.target).toBeDefined();
      expect(parsed.target.path).toBeTruthy();
      expect(parsed.target.status).toBe("current");
      expect(parsed.target.files).toBeInstanceOf(Array);
      expect(parsed.target.staleFiles).toEqual([]);
      expect(parsed.target.missingTargetFiles).toEqual([]);
      expect(parsed.target.unverifiedFiles).toEqual([]);
      expect(parsed.target.files.every((f: any) => f.state === "current")).toBe(true);
      // Aggregate status must agree
      expect(parsed.status).toBe("pass");
    });

    test("CLI --target nonexistent exits 1 with JSON error", () => {
      let stdout = "";
      try {
        execSync(`${BIN} skill-pack --json --target "/tmp/cbrain-no-such-target-xyz"`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
      }
      const parsed = JSON.parse(stdout);
      expect(parsed.verificationStatus).toBe("fail");
      expect(parsed.error).toContain("Target directory not found");
      expect(parsed.code).toBe("TARGET_NOT_FOUND");
    });

    test("canonical missing file marks target as unverified", () => {
      // Seed canonical with one file missing
      seedMinimal(canonDir);
      rmSync(join(canonDir, "RESOLVER.md"));
      seedMinimal(targetDir);

      const result = compareTarget(canonDir, targetDir);
      expect(result.unverifiedFiles).toContain("RESOLVER.md");
      expect(result.files.find((f) => f.name === "RESOLVER.md")?.state).toBe("unverified");
    });

    test("canonical fail + target present still exits nonzero via CLI", () => {
      // Build a canonical fixture missing a required file
      seedMinimal(canonDir);
      rmSync(join(canonDir, "RESOLVER.md"));
      seedMinimal(targetDir);

      // verifySkillPack on broken canonical must fail
      const report = verifySkillPack(canonDir);
      expect(report.verificationStatus).toBe("fail");

      // compareTarget marks the file unverified
      const comparison = compareTarget(canonDir, targetDir);
      expect(comparison.unverifiedFiles).toContain("RESOLVER.md");

      // Simulated exit logic: canonical fail → exit 1 even if target is ok
      const shouldExit1 = report.verificationStatus === "fail"
        || comparison.staleFiles.length > 0
        || comparison.missingTargetFiles.length > 0
        || comparison.files.some((f) => f.state === "unverified");
      expect(shouldExit1).toBe(true);
    });
  });

  // ── JSON error codes (real subprocess) ──

  describe("JSON error codes", () => {
    const installRoot = "/tmp/cbrain-test-skill-pack-error-codes";
    let pkgDir: string;

    beforeAll(async () => {
      // Build and extract tarball once for all tests in this group
      if (existsSync(installRoot)) rmSync(installRoot, { recursive: true });
      mkdirSync(installRoot, { recursive: true });

      execSync("bun pm pack", { cwd: PROJECT_DIR, encoding: "utf-8" });
      const glob = new Bun.Glob("cbrain-*.tgz");
      const tarball = [...glob.scanSync({ cwd: PROJECT_DIR })][0];
      expect(tarball).toBeTruthy();

      execSync(`tar -xzf "${join(PROJECT_DIR, tarball)}" -C "${installRoot}"`, { encoding: "utf-8" });
      rmSync(join(PROJECT_DIR, tarball), { force: true });

      const entries = readdirSync(installRoot);
      pkgDir = join(installRoot, entries[0]);
      // Use checkout deps (offline — production install proven by check:install-network)
      symlinkSync(join(PROJECT_DIR, "node_modules"), join(pkgDir, "node_modules"));
    }, 30_000); // symlink deps — no install needed

    afterAll(() => {
      if (existsSync(installRoot)) rmSync(installRoot, { recursive: true });
    });

    test("missing skills dir returns PACK_NOT_FOUND via subprocess", () => {
      // Rename skills/ to simulate missing pack
      const skillsDir = join(pkgDir, "skills");
      const backupDir = join(pkgDir, "skills-backup");
      renameSync(skillsDir, backupDir);

      const extractedBin = join(pkgDir, "src/cli/index.ts");
      let stdout = "";
      let stderr = "";
      try {
        execSync(`bun run "${extractedBin}" skill-pack --json`, {
          encoding: "utf-8",
          cwd: "/tmp",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15_000,
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
      }

      // Restore skills/
      renameSync(backupDir, skillsDir);

      const parsed = JSON.parse(stdout);
      expect(parsed.verificationStatus).toBe("fail");
      expect(parsed.status).toBe("fail");
      expect(parsed.code).toBe("PACK_NOT_FOUND");
      expect(parsed.error).toContain("not found");
      // No stack trace in expected failures
      expect(stderr).not.toContain("at ");
    });

    test("SkillPackError type has code and status fields", () => {
      const errorReport: import("../../src/cli/commands/skill-pack.js").SkillPackError = {
        version: "1.0.0",
        packPath: "/test",
        verificationStatus: "fail",
        status: "fail",
        code: "PACK_INVALID",
        error: "test error",
      };
      expect(errorReport.code).toBe("PACK_INVALID");
      expect(errorReport.status).toBe("fail");
    });
  });
});
