import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  escapeLocalDetailPath,
  inspectMisplacedVaultArtifacts,
  resolveTrustedVaultBoundary,
  type MisplacedInspectorDeps,
} from "../../src/core/maintenance/misplaced-vault-artifacts.js";

const roots: string[] = [];

function fixture(vaultName = "vault") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cbrain-misplaced-test-")));
  roots.push(root);
  const vaultPath = join(root, vaultName);
  mkdirSync(join(root, ".obsidian"));
  mkdirSync(vaultPath);
  return { root, vaultPath };
}

function boundaryFor(root: string, vaultPath: string) {
  const boundary = resolveTrustedVaultBoundary({ configRoot: root, vaultPath });
  expect(boundary).toBeDefined();
  return boundary!;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveTrustedVaultBoundary", () => {
  test("requires a real .obsidian directory", () => {
    const { root, vaultPath } = fixture();
    rmSync(join(root, ".obsidian"), { recursive: true });
    expect(resolveTrustedVaultBoundary({ configRoot: root, vaultPath })).toBeUndefined();

    const outside = mkdtempSync(join(tmpdir(), "cbrain-obsidian-test-"));
    roots.push(outside);
    symlinkSync(outside, join(root, ".obsidian"));
    expect(resolveTrustedVaultBoundary({ configRoot: root, vaultPath })).toBeUndefined();
  });

  test("requires an existing non-symlink vault", () => {
    const { root, vaultPath } = fixture();
    rmSync(vaultPath, { recursive: true });
    expect(resolveTrustedVaultBoundary({ configRoot: root, vaultPath })).toBeUndefined();

    const outside = mkdtempSync(join(tmpdir(), "cbrain-vault-test-"));
    roots.push(outside);
    symlinkSync(outside, vaultPath);
    expect(resolveTrustedVaultBoundary({ configRoot: root, vaultPath })).toBeUndefined();
  });

  test("rejects a lexical child whose physical vault is elsewhere", () => {
    const { root, vaultPath } = fixture();
    rmSync(vaultPath, { recursive: true });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "cbrain-vault-parent-test-")));
    roots.push(outside);
    mkdirSync(join(outside, "vault"));
    symlinkSync(outside, join(root, "alias"));
    expect(resolveTrustedVaultBoundary({
      configRoot: root,
      vaultPath: join(root, "alias", "vault"),
    })).toBeUndefined();
  });

  test("requires the physical vault to be a direct child", () => {
    const { root, vaultPath } = fixture();
    const nested = join(vaultPath, "nested");
    mkdirSync(nested);
    expect(resolveTrustedVaultBoundary({ configRoot: root, vaultPath: nested })).toBeUndefined();
  });
});

describe("inspectMisplacedVaultArtifacts", () => {
  test("is ineligible without a boundary and clean with an eligible root", () => {
    expect(inspectMisplacedVaultArtifacts()).toEqual({
      scan: {
        eligible: false,
        zeroByteMarkdownCount: 0,
        reviewRequiredCount: 0,
        unreadableCount: 0,
      },
      localDetails: [],
    });

    const { root, vaultPath } = fixture();
    expect(inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath)).scan).toEqual({
      eligible: true,
      zeroByteMarkdownCount: 0,
      reviewRequiredCount: 0,
      unreadableCount: 0,
    });
  });

  test("classifies zero and nonzero top-level markdown without reading bodies", () => {
    const { root, vaultPath } = fixture();
    writeFileSync(join(root, "empty.md"), "");
    writeFileSync(join(root, "review.md"), "private body");

    const result = inspectMisplacedVaultArtifacts(
      boundaryFor(root, vaultPath),
      { includeLocalDetails: true },
    );
    expect(result.scan).toEqual({
      eligible: true,
      zeroByteMarkdownCount: 1,
      reviewRequiredCount: 1,
      unreadableCount: 0,
    });
    expect(result.localDetails).toEqual([
      { relativePath: "empty.md", classification: "zero_byte_markdown" },
      { relativePath: "review.md", classification: "review_required" },
    ]);
  });

  test("recognizes exact CBrain directories and never enumerates candidates", () => {
    const { root, vaultPath } = fixture();
    for (const name of ["brain", "records", "raw"]) mkdirSync(join(root, name));
    const boundary = boundaryFor(root, vaultPath);
    const seen: string[] = [];
    const deps: Partial<MisplacedInspectorDeps> = {
      readdirSync(path) {
        seen.push(path);
        if (path !== root) throw new Error("candidate traversal");
        return ["brain", "records", "raw", ".obsidian", basename(vaultPath)];
      },
    };

    expect(inspectMisplacedVaultArtifacts(boundary, undefined, deps).scan.reviewRequiredCount).toBe(3);
    expect(seen).toEqual([root]);
  });

  test("accepts only canonical ASCII conflict suffixes from 2 through 99", () => {
    const { root, vaultPath } = fixture();
    const accepted = ["brain 2", "records 9", "raw 10", "brain 99", "vault 2"];
    const rejected = [
      "brain 0", "brain 1", "brain 02", "brain 100", "brain 2026",
      "brain +2", "brain 2.0", "brain ٢", "vault 1", "vault 100",
    ];
    for (const name of [...accepted, ...rejected]) mkdirSync(join(root, name));

    const result = inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath), { includeLocalDetails: true });
    expect(result.scan.reviewRequiredCount).toBe(accepted.length);
    expect(result.localDetails.map((item) => item.relativePath).sort()).toEqual(accepted.sort());
  });

  test("escapes regex-special configured vault basenames", () => {
    const { root, vaultPath } = fixture("vault[1].+");
    mkdirSync(join(root, "vault[1].+ 2"));
    mkdirSync(join(root, "vault1x 2"));
    const result = inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath), { includeLocalDetails: true });
    expect(result.scan.reviewRequiredCount).toBe(1);
    expect(result.localDetails[0]?.relativePath).toBe("vault[1].+ 2");
  });

  test("ignores hidden, runtime, ordinary, and arbitrary siblings", () => {
    const { root, vaultPath } = fixture();
    mkdirSync(join(root, ".hidden"));
    mkdirSync(join(root, ".cbrain"));
    mkdirSync(join(root, "arbitrary"));
    writeFileSync(join(root, ".hidden.md"), "");
    writeFileSync(join(root, "cbrain.json"), "{}");
    writeFileSync(join(root, "ordinary.txt"), "");

    expect(inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath)).scan).toEqual({
      eligible: true,
      zeroByteMarkdownCount: 0,
      reviewRequiredCount: 0,
      unreadableCount: 0,
    });
  });

  test("treats candidate symlinks and broken symlinks as review required", () => {
    const { root, vaultPath } = fixture();
    writeFileSync(join(root, "ordinary.txt"), "x");
    symlinkSync(join(root, "ordinary.txt"), join(root, "linked.md"));
    symlinkSync(join(root, "missing-target"), join(root, "brain 2"));

    const result = inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath), { includeLocalDetails: true });
    expect(result.scan.reviewRequiredCount).toBe(2);
    expect(result.scan.unreadableCount).toBe(0);
  });

  test("keeps details disabled by default", () => {
    const { root, vaultPath } = fixture();
    writeFileSync(join(root, "private-name.md"), "");
    expect(inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath)).localDetails).toEqual([]);
  });

  test("turns root enumeration failure into an eligible incomplete result", () => {
    const { root, vaultPath } = fixture();
    const result = inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath), { includeLocalDetails: true }, {
      readdirSync() {
        throw new Error("secret root error");
      },
    });
    expect(result).toEqual({
      scan: {
        eligible: true,
        zeroByteMarkdownCount: 0,
        reviewRequiredCount: 0,
        unreadableCount: 1,
      },
      localDetails: [],
    });
  });

  test("preserves earlier classifications when candidate metadata later fails", () => {
    const { root, vaultPath } = fixture();
    writeFileSync(join(root, "first.md"), "");
    writeFileSync(join(root, "second.md"), "x");
    const firstPath = join(root, "first.md");
    const secondPath = join(root, "second.md");
    const result = inspectMisplacedVaultArtifacts(boundaryFor(root, vaultPath), { includeLocalDetails: true }, {
      readdirSync(path) {
        expect(path).toBe(root);
        return ["first.md", "second.md"];
      },
      lstatSync(path) {
        if (path === secondPath) throw new Error("private metadata error");
        return lstatSync(path === firstPath ? firstPath : path);
      },
    });
    expect(result.scan).toEqual({
      eligible: true,
      zeroByteMarkdownCount: 1,
      reviewRequiredCount: 0,
      unreadableCount: 1,
    });
    expect(result.localDetails).toEqual([
      { relativePath: "first.md", classification: "zero_byte_markdown" },
      { relativePath: "second.md", classification: "unreadable" },
    ]);
  });

  test("discards names and marks incomplete when root identity changes after enumeration", () => {
    const { root, vaultPath } = fixture();
    writeFileSync(join(root, "private-name.md"), "");
    const boundary = boundaryFor(root, vaultPath);
    let rootChecks = 0;
    const result = inspectMisplacedVaultArtifacts(boundary, { includeLocalDetails: true }, {
      lstatSync(path) {
        const stats = lstatSync(path);
        if (path === root && ++rootChecks === 1) {
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: stats.ino + 1 });
        }
        return stats;
      },
    });
    expect(result.scan.eligible).toBe(true);
    expect(result.scan.zeroByteMarkdownCount).toBe(1);
    expect(result.scan.unreadableCount).toBeGreaterThanOrEqual(1);
    expect(result.localDetails).toEqual([]);
  });

  test("marks vault replacement by symlink, different identity, or absence as incomplete", () => {
    for (const mode of ["symlink", "identity", "missing"] as const) {
      const { root, vaultPath } = fixture(`vault-${mode}`);
      const boundary = boundaryFor(root, vaultPath);
      const result = inspectMisplacedVaultArtifacts(boundary, { includeLocalDetails: true }, {
        lstatSync(path) {
          if (path !== vaultPath) return lstatSync(path);
          if (mode === "missing") throw new Error("gone");
          const stats = lstatSync(path);
          if (mode === "identity") {
            return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: stats.ino + 1 });
          }
          return {
            ...stats,
            isDirectory: () => false,
            isSymbolicLink: () => true,
          } as ReturnType<typeof lstatSync>;
        },
      });
      expect(result.scan.eligible).toBe(true);
      expect(result.scan.unreadableCount).toBeGreaterThanOrEqual(1);
      expect(result.localDetails).toEqual([]);
    }
  });
});

describe("escapeLocalDetailPath", () => {
  test("uses one-line JSON-style escapes for controls, DEL, and bidi controls", () => {
    const unsafe = "line\n\t\u001b\u007f\u202e\u2066end.md";
    const escaped = escapeLocalDetailPath(unsafe);
    expect(escaped).toContain("\\n");
    expect(escaped).toContain("\\t");
    expect(escaped).toContain("\\u001B");
    expect(escaped).toContain("\\u007F");
    expect(escaped).toContain("\\u202E");
    expect(escaped).toContain("\\u2066");
    for (const unsafeCharacter of ["\n", "\r", "\t", "\u001b", "\u007f", "\u202e", "\u2066"]) {
      expect(escaped.includes(unsafeCharacter)).toBe(false);
    }
    expect(escaped.startsWith('"')).toBe(true);
    expect(escaped.endsWith('"')).toBe(true);
  });
});
