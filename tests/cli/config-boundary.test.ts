import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadConfig,
  loadConfigSafe,
  loadConfigWithPath,
  type CBrainConfig,
  type LoadedCBrainConfig,
} from "../../src/cli/context.js";

function config(label: string): CBrainConfig {
  return {
    vaultPath: `${label}/vault`,
    dbPath: `${label}/brain.sqlite`,
    lancePath: `${label}/lance`,
    embedding: { provider: "deterministic" },
  };
}

function writeConfig(path: string, value: CBrainConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("trusted config boundary", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-config-boundary-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const scenarios: Array<{
    name: string;
    safe: boolean;
    setup: (root: string) => { startDir: string; explicitPath?: string; expected?: CBrainConfig };
    assert: (result: LoadedCBrainConfig | null, expected?: CBrainConfig) => void;
  }> = [
    {
      name: "strict explicit valid config wins over an upward config",
      safe: false,
      setup(root) {
        const startDir = join(root, "workspace", "nested");
        const explicitPath = join(root, "explicit", "selected.json");
        const expected = config("explicit");
        mkdirSync(startDir, { recursive: true });
        writeConfig(join(root, "workspace", "cbrain.json"), config("upward"));
        writeConfig(explicitPath, expected);
        return { startDir, explicitPath, expected };
      },
      assert(result, expected) {
        expect(result?.config).toEqual(expected);
      },
    },
    {
      name: "safe explicit missing config does not fall back upward",
      safe: true,
      setup(root) {
        const startDir = join(root, "workspace", "nested");
        mkdirSync(startDir, { recursive: true });
        writeConfig(join(root, "workspace", "cbrain.json"), config("upward"));
        return { startDir, explicitPath: join(root, "missing.json") };
      },
      assert(result) {
        expect(result).toBeNull();
      },
    },
    {
      name: "safe explicit malformed config does not fall back upward",
      safe: true,
      setup(root) {
        const startDir = join(root, "workspace", "nested");
        const explicitPath = join(root, "explicit", "malformed.json");
        mkdirSync(startDir, { recursive: true });
        writeConfig(join(root, "workspace", "cbrain.json"), config("upward"));
        mkdirSync(dirname(explicitPath), { recursive: true });
        writeFileSync(explicitPath, "{ invalid json");
        return { startDir, explicitPath };
      },
      assert(result) {
        expect(result).toBeNull();
      },
    },
    {
      name: "strict upward lookup returns the nearest valid config",
      safe: false,
      setup(root) {
        const startDir = join(root, "workspace", "nested");
        const expected = config("nearest");
        mkdirSync(startDir, { recursive: true });
        writeConfig(join(root, "cbrain.json"), config("farther"));
        writeConfig(join(root, "workspace", "cbrain.json"), expected);
        return { startDir, expected };
      },
      assert(result, expected) {
        expect(result?.config).toEqual(expected);
      },
    },
    {
      name: "safe upward malformed config does not search past it",
      safe: true,
      setup(root) {
        const startDir = join(root, "workspace", "nested");
        mkdirSync(startDir, { recursive: true });
        writeConfig(join(root, "cbrain.json"), config("farther"));
        writeFileSync(join(root, "workspace", "cbrain.json"), "{ invalid json");
        return { startDir };
      },
      assert(result) {
        expect(result).toBeNull();
      },
    },
    {
      name: "safe fully missing lookup returns null",
      safe: true,
      setup(root) {
        const startDir = join(root, "workspace", "nested");
        mkdirSync(startDir, { recursive: true });
        return { startDir };
      },
      assert(result) {
        expect(result).toBeNull();
      },
    },
  ];

  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const { startDir, explicitPath, expected } = scenario.setup(root);
      const result = scenario.safe
        ? loadConfigSafe(startDir, explicitPath)
        : loadConfigWithPath(startDir, explicitPath);
      scenario.assert(result, expected);
    });
  }

  test("strict parsing preserves an explicit parse failure", () => {
    const startDir = join(root, "workspace");
    const explicitPath = join(root, "explicit.json");
    mkdirSync(startDir, { recursive: true });
    writeFileSync(explicitPath, "{ explicit invalid");

    expect(() => loadConfigWithPath(startDir, explicitPath)).toThrow(SyntaxError);
  });

  test("strict parsing preserves an upward parse failure", () => {
    const startDir = join(root, "workspace", "nested");
    mkdirSync(startDir, { recursive: true });
    writeFileSync(join(root, "workspace", "cbrain.json"), "{ upward invalid");

    expect(() => loadConfigWithPath(startDir)).toThrow(SyntaxError);
  });

  test("strict fully missing lookup reports no active config", () => {
    const startDir = join(root, "workspace", "nested");
    mkdirSync(startDir, { recursive: true });

    expect(() => loadConfigWithPath(startDir)).toThrow("No cbrain.json found");
  });

  test("strict wrapper exits for an explicit missing config without reading upward", () => {
    const startDir = join(root, "workspace", "nested");
    const missingPath = join(root, "missing.json");
    mkdirSync(startDir, { recursive: true });
    writeConfig(join(root, "workspace", "cbrain.json"), config("must-not-load"));

    const previousConfig = process.env.CBRAIN_CONFIG;
    const previousCwd = process.cwd();
    const previousExit = process.exit;
    const previousError = console.error;
    let exitCode: number | string | null = null;
    process.env.CBRAIN_CONFIG = missingPath;
    process.chdir(startDir);
    process.exit = ((code?: number | string | null): never => {
      exitCode = code ?? 0;
      throw new Error("captured process.exit");
    }) as typeof process.exit;
    console.error = () => undefined;

    try {
      expect(() => loadConfig()).toThrow("captured process.exit");
      expect(Number(exitCode)).toBe(1);
    } finally {
      process.exit = previousExit;
      console.error = previousError;
      process.chdir(previousCwd);
      if (previousConfig === undefined) delete process.env.CBRAIN_CONFIG;
      else process.env.CBRAIN_CONFIG = previousConfig;
    }
  });

  test("config symlinks establish the real config root", () => {
    const startDir = join(root, "workspace");
    const realConfigPath = join(root, "real", "cbrain.json");
    const linkedConfigPath = join(root, "links", "selected.json");
    mkdirSync(startDir, { recursive: true });
    writeConfig(realConfigPath, config("linked"));
    mkdirSync(dirname(linkedConfigPath), { recursive: true });
    symlinkSync(realConfigPath, linkedConfigPath);

    const result = loadConfigWithPath(startDir, linkedConfigPath);

    expect(result.configPath).toBe(realpathSync(realConfigPath));
    expect(result.configRoot).toBe(dirname(realpathSync(realConfigPath)));
  });
});
