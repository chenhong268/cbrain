import { describe, test, expect, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "bin", "check-install-smoke.sh");

/**
 * Build a fake local install root with a mock `cbrain` executable
 * and a mock LanceDB module. Returns the fixture path.
 */
function buildFixture(opts: {
  version?: string;
  lancedbLoadable?: boolean;
  noExecutable?: boolean;
  hoistedLayout?: boolean;
}): string {
  const fixtureDir = join("/tmp", `cbrain-smoke-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const binDir = join(fixtureDir, "bin");
  mkdirSync(binDir, { recursive: true });

  if (!opts.noExecutable) {
    const version = opts.version ?? "1.9.4";
    writeFileSync(join(binDir, "cbrain"), `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "${version}"; exit 0; fi
if [[ "$1" == "--help" ]]; then echo "Usage: cbrain <command>"; exit 0; fi
if [[ "$1" == "doctor" && "$2" == "--help" ]]; then echo "Usage: cbrain doctor"; exit 0; fi
exit 0
`);
    execSync(`chmod +x "${join(binDir, "cbrain")}"`);
  }

  if (opts.hoistedLayout) {
    // Hoisted layout: cbrain package and @lancedb are siblings in node_modules
    const pkgDir = join(fixtureDir, "node_modules", "cbrain");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "cbrain", version: opts.version ?? "1.9.4" }));

    const lancedbDir = join(fixtureDir, "node_modules", "@lancedb", "lancedb");
    mkdirSync(lancedbDir, { recursive: true });
    if (opts.lancedbLoadable !== false) {
      writeFileSync(join(lancedbDir, "index.js"), "module.exports = { connect: () => ({}) };\n");
    } else {
      writeFileSync(join(lancedbDir, "index.js"), "throw new Error('LanceDB native module failed to load: incompatible platform');\n");
    }
  } else {
    // Simple layout: @lancedb directly under node_modules (no cbrain package)
    const lancedbDir = join(fixtureDir, "node_modules", "@lancedb", "lancedb");
    mkdirSync(lancedbDir, { recursive: true });
    if (opts.lancedbLoadable !== false) {
      writeFileSync(join(lancedbDir, "index.js"), "module.exports = { connect: () => ({}) };\n");
    } else {
      writeFileSync(join(lancedbDir, "index.js"), "throw new Error('LanceDB native module failed to load: incompatible platform');\n");
    }
  }

  return fixtureDir;
}

function cleanupFixture(path: string) {
  if (existsSync(path)) rmSync(path, { recursive: true });
}

function runScript(args: string[], env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash "${SCRIPT}" ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e: any) {
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function runLocalFixture(fixture: string, extraArgs: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  return runScript(["--local", fixture, ...extraArgs]);
}

/** Parse tmpdir path from script stdout — always emitted, success or failure */
function parseTmpdir(stdout: string): string {
  const match = stdout.match(/tmpdir:\s*(\/\S+)/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("check-install-smoke.sh — offline argument validation", () => {
  test("no arguments → usage error (exit 2)", () => {
    const result = runScript([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no install ref");
  });

  test("--help → exit 0 with usage text", () => {
    const result = runScript(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("check-install-smoke.sh");
    expect(result.stdout).toContain("INSTALL_REF");
  });

  test("branch ref 'main' → rejected (exit 2)", () => {
    const result = runScript(["main"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("non-immutable ref");
    expect(result.stderr).toContain("main");
  });

  test("branch ref 'latest' → rejected (exit 2)", () => {
    const result = runScript(["latest"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("non-immutable ref");
  });

  test("branch ref 'develop' → rejected (exit 2)", () => {
    const result = runScript(["develop"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("non-immutable ref");
    expect(result.stderr).toContain("develop");
  });

  test("--expected-version without value → exit 2", () => {
    const result = runScript(["--expected-version"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--expected-version requires a value");
  });

  test("--local without path → exit 2", () => {
    const result = runScript(["--local"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--local requires a path");
  });
});

describe("check-install-smoke.sh — offline local fixture", () => {
  let fixture: string;

  afterEach(() => {
    if (fixture) cleanupFixture(fixture);
  });

  test("successful local fixture run", () => {
    fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SMOKE TEST PASSED");
    expect(result.stdout).toContain("version matches 1.9.4");
    expect(result.stdout).toContain("cbrain --help");
    expect(result.stdout).toContain("cbrain doctor --help");
  });

  test("version mismatch fails", () => {
    fixture = buildFixture({ version: "1.9.3", lancedbLoadable: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("version mismatch");
    expect(result.stderr).toContain("1.9.3");
  });

  test("exact version match — not substring", () => {
    fixture = buildFixture({ version: "11.9.40", lancedbLoadable: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("version mismatch");
  });

  test("LanceDB import failure fails the test", () => {
    fixture = buildFixture({ version: "1.9.4", lancedbLoadable: false });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("import failed");
  });

  test("missing executable fails", () => {
    fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true, noExecutable: true });

    const result = runLocalFixture(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cbrain not found on PATH");
  });

  test("nonexistent local path fails", () => {
    const result = runScript(["--local", "/tmp/cbrain-smoke-nonexistent-xyz"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("local path does not exist");
  });

  test("executable resolving outside isolated root fails", () => {
    // Place a fake cbrain on PATH *outside* the isolated BUN_INSTALL
    const externalBinDir = join("/tmp", `cbrain-external-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(externalBinDir, { recursive: true });
    writeFileSync(
      join(externalBinDir, "cbrain"),
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "1.9.4"; exit 0; fi
if [[ "$1" == "--help" ]]; then echo "Usage: cbrain <command>"; exit 0; fi
exit 0
`,
    );
    execSync(`chmod +x "${join(externalBinDir, "cbrain")}"`);

    // Fixture has no cbrain — so the script finds the external one instead
    fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true, noExecutable: true });

    const result = runScript(
      ["--local", fixture, "--expected-version", "1.9.4"],
      { PATH: `${externalBinDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("resolved outside isolated root");

    cleanupFixture(fixture);
    rmSync(externalBinDir, { recursive: true });
  });
});

describe("check-install-smoke.sh — hoisted layout", () => {
  let fixture: string;

  afterEach(() => {
    if (fixture) cleanupFixture(fixture);
  });

  test("hoisted sibling layout — LanceDB resolves from cbrain package context", () => {
    fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true, hoistedLayout: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SMOKE TEST PASSED");
    expect(result.stdout).toContain("@lancedb/lancedb native module loads successfully");
  });
});

describe("check-install-smoke.sh — cleanup verification", () => {
  test("temp directory cleaned up on success", () => {
    const fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);
    expect(result.exitCode).toBe(0);

    const tmpdir = parseTmpdir(result.stdout);
    expect(existsSync(tmpdir)).toBe(false);

    cleanupFixture(fixture);
  });

  test("temp directory cleaned up on failure", () => {
    const fixture = buildFixture({ version: "wrong", lancedbLoadable: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);
    expect(result.exitCode).toBe(1);

    const tmpdir = parseTmpdir(result.stdout);
    expect(existsSync(tmpdir)).toBe(false);

    cleanupFixture(fixture);
  });
});

describe("check-install-smoke.sh — CBRAIN_CONFIG isolation", () => {
  let fixture: string;

  afterEach(() => {
    if (fixture) cleanupFixture(fixture);
  });

  test("CBRAIN_CONFIG is a valid cbrain.json with isolated paths", () => {
    fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true });

    const result = runLocalFixture(fixture, ["--expected-version", "1.9.4"]);
    expect(result.exitCode).toBe(0);

    // Parse config content from output
    const configMatch = result.stdout.match(/config_content: (\{[^}]+\})/);
    expect(configMatch).not.toBeNull();

    const config = JSON.parse(configMatch![1]);
    expect(config.vaultPath).toBeTruthy();
    expect(config.dbPath).toBeTruthy();
    expect(config.lancePath).toBeTruthy();
    expect(config.runtimePath).toBeTruthy();
    // Guard against old misspelling regression
    expect(config.lancedbPath).toBeUndefined();

    // All paths must be under the tmpdir
    const tmpdir = parseTmpdir(result.stdout);
    expect(config.vaultPath).toContain(tmpdir);
    expect(config.dbPath).toContain(tmpdir);
    expect(config.lancePath).toContain(tmpdir);
    expect(config.runtimePath).toContain(tmpdir);
  });
});

describe("check-install-smoke.sh — host isolation", () => {
  test("host sentinel file is NOT modified", () => {
    const sentinel = join("/tmp", `cbrain-host-sentinel-${Date.now()}`);
    writeFileSync(sentinel, "untouched");

    const fixture = buildFixture({ version: "1.9.4", lancedbLoadable: true });

    runLocalFixture(fixture, ["--expected-version", "1.9.4"]);

    expect(readFileSync(sentinel, "utf-8")).toBe("untouched");

    cleanupFixture(fixture);
    rmSync(sentinel);
  });
});

describe("docs — installation path assertions", () => {
  const readmePath = join(ROOT, "README.md");
  const installDocPath = join(ROOT, "docs", "install-onboarding.md");

  test("README primary install uses explicit tag, not floating ref", () => {
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("bun install -g github:chenhong268/cbrain#v1.9.4");
    expect(readme).not.toContain("Download the latest binary from");
    expect(readme).toContain("bun remove -g cbrain");
    // Must NOT claim binary distribution exists
    expect(readme).not.toContain("binary distribution");
  });

  test("install-onboarding.md primary path uses explicit tag", () => {
    const doc = readFileSync(installDocPath, "utf-8");
    expect(doc).toContain("bun install -g github:chenhong268/cbrain#v1.9.4");
    expect(doc).not.toContain("从 Releases 下载");
    expect(doc).toContain("PATH");
    expect(doc).toContain("bun pm bin -g");
  });

  test("install-onboarding.md has no binary download troubleshooting", () => {
    const doc = readFileSync(installDocPath, "utf-8");
    // The old "quarantine" troubleshooting for downloaded binaries should not exist
    expect(doc).not.toContain("quarantine");
    expect(doc).not.toContain("Gatekeeper");
  });
});
