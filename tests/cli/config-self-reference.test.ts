import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfigInsideOwnVault, loadConfigWithPath } from "../../src/cli/context.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "cbrain-config-self-ref-"));
}

function writeConfig(dir: string, vaultPath: string, provider: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cbrain.json");
  writeFileSync(path, JSON.stringify({ vaultPath, embedding: { provider } }));
  return path;
}

function captureWarn(run: () => unknown): { lines: string[]; result: unknown } {
  const previous = console.warn;
  const lines: string[] = [];
  let result: unknown;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    result = run();
  } finally {
    console.warn = previous;
  }
  return { lines, result };
}

describe("isConfigInsideOwnVault (#561)", () => {
  test("true when the config dir equals the vault", () => {
    expect(isConfigInsideOwnVault("/r/vault/cbrain.json", "/r/vault")).toBe(true);
  });

  test("true when the config sits in a nested vault subdirectory", () => {
    expect(isConfigInsideOwnVault("/r/vault/notes/config/cbrain.json", "/r/vault")).toBe(true);
  });

  test("false for the normal layout: config above the vault (repo root)", () => {
    expect(isConfigInsideOwnVault("/r/cbrain.json", "/r/vault")).toBe(false);
  });

  test("false for a sibling whose name merely shares a prefix with the vault", () => {
    expect(isConfigInsideOwnVault("/r/vault-backup/cbrain.json", "/r/vault")).toBe(false);
  });

  test("false when vaultPath is missing, blank or not a string", () => {
    expect(isConfigInsideOwnVault("/r/vault/cbrain.json", undefined)).toBe(false);
    expect(isConfigInsideOwnVault("/r/vault/cbrain.json", "   ")).toBe(false);
    expect(isConfigInsideOwnVault("/r/vault/cbrain.json", 42 as unknown as string)).toBe(false);
  });

  test("does not throw when the vault directory does not exist yet", () => {
    expect(isConfigInsideOwnVault("/r/vault/cbrain.json", "/r/does-not-exist")).toBe(false);
  });

  test("follows symlinks: a symlinked vault still matches the real config dir", () => {
    const root = makeRoot();
    try {
      mkdirSync(join(root, "real-vault"));
      const configPath = writeConfig(join(root, "real-vault"), join(root, "real-vault"), "ollama");
      symlinkSync(join(root, "real-vault"), join(root, "link-vault"));
      expect(isConfigInsideOwnVault(configPath, join(root, "link-vault"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("config self-reference warning (#561)", () => {
  test("normal layout: the repo-root config loads silently", () => {
    const root = makeRoot();
    try {
      const vault = join(root, "vault");
      writeConfig(root, vault, "ollama");
      const { lines, result } = captureWarn(() => loadConfigWithPath(root));
      expect(lines).toEqual([]);
      expect((result as { config: { embedding: { provider: string } } }).config.embedding.provider).toBe("ollama");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cwd walk from inside the vault picks the stale copy, switches provider and warns with fixed text only", () => {
    const root = makeRoot();
    try {
      const vault = join(root, "vault");
      mkdirSync(join(vault, "notes", "daily"), { recursive: true });
      writeConfig(root, vault, "ollama"); // active config at the repo root
      writeConfig(vault, vault, "zhipu"); // stale forked copy inside its own vault

      const { lines, result } = captureWarn(() => loadConfigWithPath(join(vault, "notes", "daily")));
      const loaded = result as { configPath: string; config: { embedding: { provider: string } } };

      // the drift the issue describes: the walk landed on the stale copy
      // (resolveConfigPath realpaths the hit, and macOS /var is a symlink to /private/var)
      expect(loaded.configPath).toBe(realpathSync(join(vault, "cbrain.json")));
      expect(loaded.config.embedding.provider).toBe("zhipu");
      // the warning is emitted, exactly once, and leaks no path (#383)
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("located inside the vault it manages");
      expect(lines[0]).toContain("CBRAIN_CONFIG");
      expect(lines[0]).not.toContain(root);
      expect(lines[0]).not.toContain("zhipu");
      expect(lines[0]).not.toContain("ollama");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicit CBRAIN_CONFIG that points at the in-vault copy is flagged too", () => {
    const root = makeRoot();
    try {
      const vault = join(root, "vault");
      const stale = writeConfig(vault, vault, "zhipu");
      writeConfig(root, vault, "ollama");
      const { lines, result } = captureWarn(() => loadConfigWithPath(root, stale));
      // the explicit path is realpaths as well; assert the resolved form, not the raw input
      expect((result as { configPath: string }).configPath).toBe(realpathSync(stale));
      expect(lines).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns once per config path per process", () => {
    const root = makeRoot();
    try {
      const vault = join(root, "vault");
      writeConfig(vault, vault, "zhipu");
      const first = captureWarn(() => loadConfigWithPath(vault));
      const second = captureWarn(() => loadConfigWithPath(vault));
      const third = captureWarn(() => loadConfigWithPath(vault, join(vault, "cbrain.json")));
      expect(first.lines).toHaveLength(1);
      expect(second.lines).toEqual([]);
      expect(third.lines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing config still exits through the existing not-found path, with no self-reference warning", () => {
    const root = makeRoot();
    try {
      const { lines } = captureWarn(() => {
        const previousExit = process.exit;
        let exitCode: number | string | null = null;
        process.exit = ((code?: number | string | null): never => {
          exitCode = code ?? 0;
          throw new Error("captured process.exit");
        }) as typeof process.exit;
        try {
          loadConfigWithPath(root);
        } catch {
          // expected: captured process.exit
        } finally {
          process.exit = previousExit;
        }
        return exitCode;
      });
      expect(lines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
