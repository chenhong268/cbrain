import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, renameSync, symlinkSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  resolveSkillsDir,
  verifySkillPack,
  formatHuman,
  compareTarget,
  loadManifest,
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
      expect(stdout).toContain("33/33 present");
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
      // guidance is optional — absent without --target (spec §3.4)
      expect(report.guidance).toBeUndefined();
    });

    test("requiredFiles has 33 entries with name + status", () => {
      const files = report.requiredFiles as Array<Record<string, unknown>>;
      expect(files).toHaveLength(33);
      for (const f of files) {
        expect(typeof f.name).toBe("string");
        expect(typeof f.status).toBe("string");
      }
    });

    test("missingFiles is empty on clean checkout", () => {
      expect(report.missingFiles).toEqual([]);
    });

    test("guidance absent without --target (no install hint on bare canonical check)", () => {
      expect(report.guidance).toBeUndefined();
    });

    test("guidance present only when --target is missing", () => {
      let stdout = "";
      try {
        execSync(`${BIN} skill-pack --json --target /tmp/cbrain-no-such-target-xyz`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
      }
      const r = JSON.parse(stdout);
      expect(r.target.status).toBe("missing");
      expect(typeof r.guidance).toBe("object");
      expect(r.guidance.copyCommand).toContain("cp -r");
      expect(r.guidance.symlinkCommand).toContain("ln -s");
    });

    test("guidance absent for stale target (no overwrite hint, spec §3.4)", () => {
      const t = "/tmp/cbrain-test-guidance-stale";
      if (existsSync(t)) rmSync(t, { recursive: true });
      mkdirSync(t, { recursive: true });
      const canon = resolveSkillsDir();
      for (const f of loadManifest(canon).files) writeFileSync(join(t, f), readFileSync(join(canon, f)));
      writeFileSync(join(t, "MANIFEST.json"), readFileSync(join(canon, "MANIFEST.json")));
      writeFileSync(join(t, "SKILL.md"), "tampered");
      let stdout = "";
      try {
        execSync(`${BIN} skill-pack --json --target ${t}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
      }
      rmSync(t, { recursive: true });
      const r = JSON.parse(stdout);
      expect(r.target.status).toBe("stale");
      expect(r.guidance).toBeUndefined();
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

    function seedFixture(dir: string, overrides: { skipFiles?: string[]; skillContent?: string; manifest?: string } = {}): void {
      const skipFiles = new Set(overrides.skipFiles ?? []);
      const canon = resolveSkillsDir();
      const manifest = loadManifest(canon);
      for (const name of manifest.files) {
        if (skipFiles.has(name)) continue;
        const content = name === "SKILL.md" && overrides.skillContent ? overrides.skillContent : readFileSync(join(canon, name));
        writeFileSync(join(dir, name), content);
      }
      writeFileSync(join(dir, "MANIFEST.json"), overrides.manifest ?? readFileSync(join(canon, "MANIFEST.json")));
    }

    test("all present files report pass", () => {
      seedFixture(fixtureDir);
      const report = verifySkillPack(fixtureDir);

      expect(report.verificationStatus).toBe("pass");
      expect(report.missingFiles).toEqual([]);
      expect(report.requiredFiles.every((f) => f.status === "present")).toBe(true);
    });

    test("missing required file breaks exact-inventory (INVENTORY_MISMATCH)", () => {
      seedFixture(fixtureDir, { skipFiles: ["recall-resolver.md"] });
      expect(() => verifySkillPack(fixtureDir)).toThrow(/INVENTORY_MISMATCH/);
    });

    test("required file that is a directory breaks exact-inventory (INVENTORY_MISMATCH)", () => {
      seedFixture(fixtureDir);
      // Replace a file with a directory — isFile() false → onDisk excludes it
      rmSync(join(fixtureDir, "RESOLVER.md"));
      mkdirSync(join(fixtureDir, "RESOLVER.md"), { recursive: true });

      expect(() => verifySkillPack(fixtureDir)).toThrow(/INVENTORY_MISMATCH/);
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
      const canon = resolveSkillsDir();
      const manifest = loadManifest(canon);
      for (const name of manifest.files) {
        writeFileSync(join(dir, name), readFileSync(join(canon, name)));
      }
      writeFileSync(join(dir, "MANIFEST.json"), readFileSync(join(canon, "MANIFEST.json")));
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
    test("canonical missing file throws INVENTORY_MISMATCH (exact-inventory gate)", () => {
      const fdir = "/tmp/cbrain-test-skill-pack-jsonfail";
      if (existsSync(fdir)) rmSync(fdir, { recursive: true });
      mkdirSync(fdir, { recursive: true });

      // Seed full canonical pack + MANIFEST, then remove one required file
      const canon = resolveSkillsDir();
      const manifest = loadManifest(canon);
      for (const name of manifest.files) {
        writeFileSync(join(fdir, name), readFileSync(join(canon, name)));
      }
      writeFileSync(join(fdir, "MANIFEST.json"), readFileSync(join(canon, "MANIFEST.json")));
      rmSync(join(fdir, "recall-resolver.md"));

      // Manifest still lists recall-resolver.md → exact-inventory fails
      expect(() => verifySkillPack(fdir)).toThrow(/INVENTORY_MISMATCH/);

      rmSync(fdir, { recursive: true });
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
        target: {
          path: "/test/target",
          status: "missing",
          files: [],
          staleFiles: [],
          missingTargetFiles: [],
          unverifiedFiles: [],
        },
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
      // Should NOT show copy/symlink guidance on fail (policy labels absent)
      expect(output).not.toContain("Copy (recommended");
      expect(output).not.toContain("Symlink (dev only");
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
      // stale target must NOT show install commands (no overwrite hint, spec §3.4)
      expect(output).not.toContain("Copy (recommended");
      expect(output).not.toContain("Symlink (dev only");
    });

    test("shows Copy/Symlink when target missing (canonical pass)", () => {
      const report: SkillPackReport = {
        version: "1.0.0",
        packPath: "/test/skills",
        entrypointPath: "/test/skills/SKILL.md",
        requiredFiles: [{ name: "SKILL.md", status: "present", absolutePath: "/test/skills/SKILL.md" }],
        missingFiles: [],
        sizeStatus: "ok",
        entrypointChars: 50,
        verificationStatus: "pass",
        status: "fail",
        guidance: { copyCommand: "cp -r /test/skills/ <target>/", symlinkCommand: "ln -s /test/skills <target>" },
        target: {
          path: "/test/target",
          status: "missing",
          files: [],
          staleFiles: [],
          missingTargetFiles: [],
          unverifiedFiles: [],
        },
      };
      const output = formatHuman(report);
      // policy labels: copy = recommended/production default, symlink = dev-only
      expect(output).toMatch(/Copy[ (].*?(recommended|production)/i);
      expect(output).toMatch(/Symlink[ (].*?dev/i);
      expect(output).toContain("Target status: MISSING");
    });

    test("does not show install guidance for current/incompatible/unverified targets", () => {
      for (const status of ["current", "incompatible", "unverified"] as const) {
        const report: SkillPackReport = {
          version: "1.0.0",
          packPath: "/test/skills",
          entrypointPath: "/test/skills/SKILL.md",
          requiredFiles: [{ name: "SKILL.md", status: "present", absolutePath: "/test/skills/SKILL.md" }],
          missingFiles: [],
          sizeStatus: "ok",
          entrypointChars: 50,
          verificationStatus: "pass",
          status: "pass",
          guidance: { copyCommand: "cp -r /test/skills <target>", symlinkCommand: "ln -s /test/skills <target>" },
          target: { path: "/test/target", status, files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] },
        };
        const output = formatHuman(report);
        expect(output).not.toContain("Copy (recommended");
        expect(output).not.toContain("Symlink (dev only");
      }
    });

    test("CLI source stays read-only: node:fs read-allowlist + no async write/exec imports", () => {
      const src = readFileSync(join(PROJECT_DIR, "src/cli/commands/skill-pack.ts"), "utf-8");
      // node:fs imports must be the read-only allowlist only
      const fsMatch = src.match(/import\s*\{([^}]*?)\}\s*from\s*["']node:fs["']/);
      expect(fsMatch !== null, "expected a node:fs import").toBe(true);
      const READ_ALLOW = new Set(["existsSync", "readFileSync", "statSync", "readdirSync", "lstatSync"]);
      for (const spec of fsMatch![1].split(",").map((s) => s.trim()).filter(Boolean)) {
        expect(READ_ALLOW.has(spec), `node:fs import "${spec}" not in read-only allowlist`).toBe(true);
      }
      // forbid async write / exec entry modules
      for (const bad of ["node:fs/promises", "Bun.write", "child_process"]) {
        expect(src).not.toContain(bad);
      }
      // forbid mutating sync calls + exec/spawn call sites (belt-and-suspenders)
      for (const bad of ["writeFileSync", "mkdirSync", "unlinkSync", "symlinkSync", "renameSync", "rmSync", "cpSync", "copyFileSync", "appendFileSync", "execSync", "spawnSync"]) {
        expect(src).not.toContain(bad);
      }
      for (const bad of ["exec(", "spawn("]) {
        expect(src).not.toContain(bad);
      }
      // no install/force/overwrite/deploy flags
      expect(src).not.toMatch(/--install|--force|--overwrite|--deploy|--backup|--migrate/);
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
      const canon = resolveSkillsDir();
      const manifest = loadManifest(canon);
      for (const name of manifest.files) {
        writeFileSync(join(dir, name), readFileSync(join(canon, name)));
      }
      writeFileSync(join(dir, "MANIFEST.json"), readFileSync(join(canon, "MANIFEST.json")));
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

    test("target file deleted → stale (missing-target file, spec §3.2)", () => {
      seedMinimal(canonDir);
      seedMinimal(targetDir);
      // Remove one file from target — version+files[] match, but file missing
      rmSync(join(targetDir, "recall-resolver.md"));

      const result = compareTarget(canonDir, targetDir);
      expect(result.status).toBe("stale");
      expect(result.missingTargetFiles).toContain("recall-resolver.md");
    });

    test("multiple stale files (no deletion) → stale", () => {
      seedMinimal(canonDir);
      seedMinimal(targetDir);
      writeFileSync(join(targetDir, "RESOLVER.md"), "# Modified");
      writeFileSync(join(targetDir, "query.md"), "# Modified");

      const result = compareTarget(canonDir, targetDir);
      expect(result.status).toBe("stale");
      expect(result.staleFiles).toContain("RESOLVER.md");
      expect(result.staleFiles).toContain("query.md");
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

    test("CLI --target nonexistent -> target.status=missing (not error envelope)", () => {
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
      expect(parsed.target.status).toBe("missing");
      expect(parsed.verificationStatus).toBe("pass");
      expect(parsed.status).toBe("fail");
      expect(parsed.code).toBeUndefined();
    });

    test("canonical missing file → target unverified (no baseline)", () => {
      // Seed canonical with one file missing (breaks canonical exact-inventory)
      seedMinimal(canonDir);
      rmSync(join(canonDir, "RESOLVER.md"));
      seedMinimal(targetDir);

      const result = compareTarget(canonDir, targetDir);
      expect(result.status).toBe("unverified");
    });

    test("canonical fail + target present → unverified, exits nonzero", () => {
      // Build a canonical fixture missing a required file (breaks exact-inventory)
      seedMinimal(canonDir);
      rmSync(join(canonDir, "RESOLVER.md"));
      seedMinimal(targetDir);

      // verifySkillPack on broken canonical throws INVENTORY_MISMATCH
      expect(() => verifySkillPack(canonDir)).toThrow(/INVENTORY_MISMATCH/);

      // compareTarget cannot use broken canonical as baseline → unverified
      const comparison = compareTarget(canonDir, targetDir);
      expect(comparison.status).toBe("unverified");
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

    test("missing MANIFEST returns MANIFEST_MISSING via subprocess", () => {
      const manifestPath = join(pkgDir, "skills", "MANIFEST.json");
      const backup = join(pkgDir, "skills", "MANIFEST.json.bak");
      renameSync(manifestPath, backup);

      const extractedBin = join(pkgDir, "src/cli/index.ts");
      let stdout = "";
      try {
        execSync(`bun run "${extractedBin}" skill-pack --json`, {
          encoding: "utf-8",
          cwd: "/tmp",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15_000,
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
      }
      renameSync(backup, manifestPath);

      const parsed = JSON.parse(stdout);
      expect(parsed.verificationStatus).toBe("fail");
      expect(parsed.code).toBe("MANIFEST_MISSING");
    });

    test("CLI --target with broken canonical -> target.status=unverified (not error envelope)", () => {
      const manifestPath = join(pkgDir, "skills", "MANIFEST.json");
      const backup = join(pkgDir, "skills", "MANIFEST.json.bak");
      renameSync(manifestPath, backup);

      const extractedBin = join(pkgDir, "src/cli/index.ts");
      let stdout = "";
      try {
        execSync(`bun run "${extractedBin}" skill-pack --json --target "${join(pkgDir, "skills")}"`, {
          encoding: "utf-8",
          cwd: "/tmp",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15_000,
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
      }
      renameSync(backup, manifestPath);

      const parsed = JSON.parse(stdout);
      expect(parsed.target.status).toBe("unverified");
      expect(parsed.verificationStatus).toBe("fail");
      expect(parsed.code).toBeUndefined();
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

  // ── Manifest-driven verify ──

  describe("manifest-driven verify", () => {
    const dir = "/tmp/cbrain-test-manifest-verify";

    beforeEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true }); mkdirSync(dir, { recursive: true }); });
    afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true }); });

    function seedFull(d: string, manifestOverride?: string): void {
      const canon = resolveSkillsDir();
      const manifest = loadManifest(canon);
      for (const f of manifest.files) writeFileSync(join(d, f), readFileSync(join(canon, f)));
      writeFileSync(join(d, "MANIFEST.json"), manifestOverride ?? readFileSync(join(canon, "MANIFEST.json")));
    }

    test("missing MANIFEST -> MANIFEST_MISSING", () => {
      const canon = resolveSkillsDir();
      for (const f of loadManifest(canon).files) writeFileSync(join(dir, f), readFileSync(join(canon, f)));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_MISSING/);
    });

    test("packVersion mismatch -> VERSION_MISMATCH", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: "0.0.0-wrong", files }));
      expect(() => verifySkillPack(dir)).toThrow(/VERSION_MISMATCH/);
    });

    test("duplicate file entry -> MANIFEST_INVALID", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, files[0]] }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*duplicate/);
    });

    test("basename '..' -> MANIFEST_INVALID (unsafe)", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, ".."] }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*unsafe/);
    });

    test("inventory mismatch (manifest missing a disk file) -> INVENTORY_MISMATCH", () => {
      const files = loadManifest(resolveSkillsDir()).files.slice(0, -1);
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files }));
      expect(() => verifySkillPack(dir)).toThrow(/INVENTORY_MISMATCH/);
    });

    test("ENTRY_FILES dropped from manifest -> MANIFEST_INVALID", () => {
      const files = loadManifest(resolveSkillsDir()).files.filter((f) => f !== "RESOLVER.md");
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*entry file/);
    });

    test("absolute path entry -> MANIFEST_INVALID (unsafe)", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, "/etc/passwd"] }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*unsafe/);
    });

    test("MANIFEST self-reference entry -> MANIFEST_INVALID (unsafe)", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, "MANIFEST.json"] }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*unsafe/);
    });

    test("empty-string entry -> MANIFEST_INVALID (unsafe)", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, ""] }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*unsafe/);
    });

    test("invalid JSON MANIFEST -> MANIFEST_INVALID", () => {
      const canon = resolveSkillsDir();
      for (const f of loadManifest(canon).files) writeFileSync(join(dir, f), readFileSync(join(canon, f)));
      writeFileSync(join(dir, "MANIFEST.json"), "{not valid json");
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*not valid JSON/);
    });

    test("non-string packVersion -> MANIFEST_INVALID", () => {
      const files = loadManifest(resolveSkillsDir()).files;
      seedFull(dir, JSON.stringify({ packVersion: 207, files }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*packVersion/);
    });

    test("non-array files -> MANIFEST_INVALID", () => {
      seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: "not-an-array" }));
      expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*files must be an array/);
    });

    test("clean canonical pack passes with 33 required files", () => {
      seedFull(dir);
      const r = verifySkillPack(dir);
      expect(r.verificationStatus).toBe("pass");
      expect(r.requiredFiles).toHaveLength(33);
    });
  });

  // ── compareTarget states (incompatible dimension) ──

  describe("compareTarget states", () => {
    const canon = resolveSkillsDir();
    const dir = "/tmp/cbrain-test-compare-states";

    beforeEach(() => { rmSync(dir, { recursive: true, force: true }); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    function seedTargetCurrent(): void {
      mkdirSync(dir, { recursive: true });
      for (const f of loadManifest(canon).files) writeFileSync(join(dir, f), readFileSync(join(canon, f)));
      writeFileSync(join(dir, "MANIFEST.json"), readFileSync(join(canon, "MANIFEST.json")));
    }

    test("target path absent -> missing", () => {
      expect(compareTarget(canon, join(dir, "nope")).status).toBe("missing");
    });

    test("empty dir -> incompatible", () => {
      mkdirSync(dir, { recursive: true });
      expect(compareTarget(canon, dir).status).toBe("incompatible");
    });

    test("dir without MANIFEST -> incompatible", () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "x");
      expect(compareTarget(canon, dir).status).toBe("incompatible");
    });

    test("broken symlink at target -> incompatible", () => {
      symlinkSync("/tmp/cbrain-does-not-exist-xyz-334", dir);
      expect(compareTarget(canon, dir).status).toBe("incompatible");
    });

    test("target MANIFEST packVersion mismatch -> incompatible", () => {
      seedTargetCurrent();
      writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ packVersion: "9.9.9", files: loadManifest(canon).files }));
      expect(compareTarget(canon, dir).status).toBe("incompatible");
    });

    test("target manifest files[] shorter than canonical (different pack) -> incompatible", () => {
      seedTargetCurrent();
      const files = loadManifest(canon).files;
      const last = files[files.length - 1];
      rmSync(join(dir, last)); // remove from disk so target inventory stays consistent
      writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ packVersion: "2.0.7", files: files.slice(0, -1) }));
      expect(compareTarget(canon, dir).status).toBe("incompatible");
    });

    test("version+files match, one file content changed -> stale", () => {
      seedTargetCurrent();
      writeFileSync(join(dir, "SKILL.md"), "tampered");
      expect(compareTarget(canon, dir).status).toBe("stale");
    });

    test("full match -> current", () => {
      seedTargetCurrent();
      expect(compareTarget(canon, dir).status).toBe("current");
    });

    test("unreadable target dir -> incompatible (no stack leak)", () => {
      const t = "/tmp/cbrain-test-unreadable-dir-334";
      rmSync(t, { recursive: true, force: true });
      mkdirSync(t, { recursive: true });
      writeFileSync(join(t, "SKILL.md"), "x");
      try {
        chmodSync(t, 0o000);
        if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms
        expect(compareTarget(canon, t).status).toBe("incompatible");
      } finally {
        chmodSync(t, 0o755);
        rmSync(t, { recursive: true, force: true });
      }
    });
  });
});
