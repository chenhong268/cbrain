import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ts from "typescript";
import {
  escapeLocalDetailPath,
  inspectMisplacedVaultArtifacts,
  resolveTrustedVaultBoundary,
  type MisplacedInspectorDeps,
} from "../../src/core/maintenance/misplaced-vault-artifacts.js";

const roots: string[] = [];
const PROJECT_DIR = join(import.meta.dir, "..", "..");
const INSPECTOR_SOURCE = join(
  PROJECT_DIR,
  "src/core/maintenance/misplaced-vault-artifacts.ts",
);
const ALLOWED_INSPECTOR_RUNTIME_IMPORTS = new Map([
  ["node:fs", new Set(["lstatSync", "readdirSync", "realpathSync"])],
  ["node:path", new Set(["basename", "dirname", "join", "resolve"])],
]);
const ALLOWED_INSPECTOR_TYPE_IMPORTS = new Map([
  ["node:fs", new Set(["Stats"])],
  ["node:path", new Set<string>()],
]);
const FORBIDDEN_CAPABILITY_IDENTIFIERS = new Set([
  "Bun",
  "Deno",
  "Function",
  "createRequire",
  "eval",
  "getBuiltinModule",
  "globalThis",
  "module",
  "process",
  "require",
]);

interface InspectorCapabilityAudit {
  runtimeImports: Array<{ module: string; name: string }>;
  typeImports: Array<{ module: string; name: string }>;
  violations: string[];
}

/**
 * Static regression contract for this deliberately narrow inspector. It is a
 * normal-review guard against capability creep and common loader bypasses, not
 * a claim that arbitrary obfuscated JavaScript can be sandboxed statically.
 */
function auditInspectorCapabilityContract(source: string): InspectorCapabilityAudit {
  const result: InspectorCapabilityAudit = {
    runtimeImports: [],
    typeImports: [],
    violations: [],
  };
  const sourceFile = ts.createSourceFile(
    "misplaced-vault-artifacts.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const literalModuleName = (node: ts.Node | undefined): string | undefined => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      return node.text;
    }
    return undefined;
  };

  const describeLoaderArgument = (argument: ts.Node | undefined): string => {
    const moduleName = literalModuleName(argument);
    return moduleName ?? "computed";
  };

  const inspectAllowedImport = (
    moduleName: string,
    clause: ts.ImportClause | undefined,
  ): void => {
    if (!clause) {
      result.violations.push(`${moduleName} side-effect import`);
      return;
    }
    if (clause.name) result.violations.push(`${moduleName} default import`);
    const bindings = clause.namedBindings;
    if (!bindings) {
      result.violations.push(`${moduleName} import without named bindings`);
      return;
    }
    if (ts.isNamespaceImport(bindings)) {
      result.violations.push(`${moduleName} namespace import`);
      return;
    }

    for (const element of bindings.elements) {
      // Inspect the imported name, not the local alias.
      const importedName = (element.propertyName ?? element.name).text;
      const isTypeOnly = clause.isTypeOnly || element.isTypeOnly;
      const imports = isTypeOnly ? result.typeImports : result.runtimeImports;
      const allowed = isTypeOnly
        ? ALLOWED_INSPECTOR_TYPE_IMPORTS.get(moduleName)
        : ALLOWED_INSPECTOR_RUNTIME_IMPORTS.get(moduleName);
      imports.push({ module: moduleName, name: importedName });
      if (!allowed?.has(importedName)) {
        result.violations.push(
          `${moduleName} ${isTypeOnly ? "type" : "runtime"}:${importedName}`,
        );
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = literalModuleName(node.moduleSpecifier);
      if (!moduleName) {
        result.violations.push("non-literal static import");
      } else if (ALLOWED_INSPECTOR_RUNTIME_IMPORTS.has(moduleName)) {
        inspectAllowedImport(moduleName, node.importClause);
      } else {
        result.violations.push(`external import:${moduleName}`);
      }
    } else if (ts.isExportDeclaration(node)) {
      const moduleName = literalModuleName(node.moduleSpecifier);
      if (node.moduleSpecifier) {
        result.violations.push(`external re-export:${moduleName ?? "non-literal"}`);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        result.violations.push(
          `dynamic import:${describeLoaderArgument(node.arguments[0])}`,
        );
      } else if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(sourceFile) === "Reflect"
        && node.expression.name.text === "get"
      ) {
        const reflectedKey = literalModuleName(node.arguments[1]);
        if (reflectedKey && FORBIDDEN_CAPABILITY_IDENTIFIERS.has(reflectedKey)) {
          result.violations.push(`reflective capability:${reflectedKey}`);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const moduleName = ts.isExternalModuleReference(reference)
        ? literalModuleName(reference.expression)
        : undefined;
      result.violations.push(`import equals:${moduleName ?? "computed"}`);
    } else if (
      ts.isIdentifier(node)
      && FORBIDDEN_CAPABILITY_IDENTIFIERS.has(node.text)
    ) {
      result.violations.push(`forbidden capability identifier:${node.text}`);
    } else if (ts.isElementAccessExpression(node)) {
      const key = literalModuleName(node.argumentExpression);
      if (key && FORBIDDEN_CAPABILITY_IDENTIFIERS.has(key)) {
        result.violations.push(`forbidden computed capability:${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return result;
}

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

describe("metadata-only source contract", () => {
  test("allows only the required node:fs metadata and node:path primitives, including aliases", () => {
    const allowed = auditInspectorCapabilityContract(`
      import {
        lstatSync as inspectEntry,
        readdirSync as listRoot,
        realpathSync as resolvePhysicalPath,
        type Stats,
      } from "node:fs";
      import {
        basename as leafName,
        dirname as parentName,
        join as joinPath,
        resolve as resolvePath,
      } from "node:path";
    `);
    expect(allowed.violations).toEqual([]);
    expect(
      allowed.runtimeImports.map(({ module, name }) => `${module}:${name}`).sort(),
    ).toEqual([
      "node:fs:lstatSync",
      "node:fs:readdirSync",
      "node:fs:realpathSync",
      "node:path:basename",
      "node:path:dirname",
      "node:path:join",
      "node:path:resolve",
    ]);
    expect(allowed.typeImports).toEqual([{ module: "node:fs", name: "Stats" }]);
  });

  test("rejects capability creep, body reads, and common loader/global bypasses", () => {
    const forbiddenSources = [
      'import { readFileSync } from "node:fs";',
      'import { readFileSync as lstatSync } from "node:fs";',
      'import { openSync } from "node:fs";',
      'import { createReadStream } from "node:fs";',
      'import { statSync } from "node:fs";',
      'import { statSync as lstatSync } from "node:fs";',
      'import { open } from "node:fs/promises";',
      'import { readFileSync } from "fs";',
      'import { basename } from "path";',
      'import { sep } from "node:path";',
      'import path from "node:path";',
      'import * as path from "node:path";',
      'import "node:path";',
      'import type { ParsedPath } from "node:path";',
      'import { inspect } from "node:util";',
      'import { load } from "./filesystem-adapter.js";',
      'import type { Adapter } from "./filesystem-adapter.js";',
      'import fs from "node:fs";',
      'import * as fs from "node:fs";',
      'import "node:fs";',
      'export { readFileSync } from "node:fs";',
      'export { basename } from "node:path";',
      'export * from "./filesystem-adapter.js";',
      'export * from "node:fs";',
      'await import("node:fs");',
      'await import("node:path");',
      'const specifier = "node:fs"; await import(specifier);',
      'require("node:fs");',
      'const load = require; load("node:fs");',
      '(0, require)("node:fs");',
      'Reflect.apply(require, null, ["node:fs"]);',
      'module.require("node:fs");',
      'import fs = require("node:fs");',
      'import { createRequire as loader } from "node:module";',
      'import * as moduleApi from "node:module";',
      'process.getBuiltinModule("node:fs").readFileSync("entry.md");',
      'process["getBuiltinModule"]("node:fs")["readFileSync"]("entry.md");',
      'this["process"]["getBuiltinModule"]("node:fs");',
      'Reflect.get(this, "process");',
      'Bun.file("entry.md");',
      'Deno.readTextFile("entry.md");',
      'globalThis.process.getBuiltinModule("node:fs");',
      'eval("load filesystem module");',
      '(0, eval)("load filesystem module");',
      'Function("return filesystem module")();',
      'new Function("return filesystem module")();',
    ];

    for (const source of forbiddenSources) {
      const audit = auditInspectorCapabilityContract(source);
      expect(
        audit.violations.length,
        `expected AST guard to reject: ${source}`,
      ).toBeGreaterThan(0);
    }
  });

  test("the production inspector preserves the exact metadata-only allowlist", () => {
    const source = readFileSync(INSPECTOR_SOURCE, "utf8");
    const audit = auditInspectorCapabilityContract(source);
    expect(audit.violations).toEqual([]);
    expect(
      audit.runtimeImports.map(({ module, name }) => `${module}:${name}`).sort(),
    ).toEqual([
      "node:fs:lstatSync",
      "node:fs:readdirSync",
      "node:fs:realpathSync",
      "node:path:basename",
      "node:path:dirname",
      "node:path:join",
      "node:path:resolve",
    ]);
    expect(audit.typeImports).toEqual([{ module: "node:fs", name: "Stats" }]);
  });
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

  test("never turns injected path segments into metadata reads outside the direct root", () => {
    const { root, vaultPath } = fixture();
    writeFileSync(join(root, "valid.md"), "");
    const boundary = boundaryFor(root, vaultPath);
    const inspectedPaths: string[] = [];
    const invalidNames = ["x/../../outside.md", "../outside.md", "/outside.md"];
    const result = inspectMisplacedVaultArtifacts(boundary, { includeLocalDetails: true }, {
      readdirSync() {
        return [...invalidNames, "valid.md"];
      },
      lstatSync(path) {
        inspectedPaths.push(path);
        return lstatSync(path);
      },
    });

    expect(result.scan.zeroByteMarkdownCount).toBe(1);
    expect(result.scan.unreadableCount).toBe(invalidNames.length);
    expect(result.localDetails).toEqual([
      { relativePath: "valid.md", classification: "zero_byte_markdown" },
    ]);
    expect(inspectedPaths).toContain(join(root, "valid.md"));
    for (const path of inspectedPaths) {
      const isIdentityCheck = path === root || path === vaultPath;
      const isDirectCandidate = path.startsWith(`${root}/`)
        && !path.slice(root.length + 1).includes("/");
      expect(isIdentityCheck || isDirectCandidate).toBe(true);
    }
    expect(inspectedPaths.some((path) => path.includes("outside.md"))).toBe(false);
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

  test("detects root and vault device changes even when inode is unchanged", () => {
    for (const target of ["root", "vault"] as const) {
      const { root, vaultPath } = fixture(`vault-dev-${target}`);
      const boundary = boundaryFor(root, vaultPath);
      const changedPath = target === "root" ? root : vaultPath;
      const result = inspectMisplacedVaultArtifacts(boundary, { includeLocalDetails: true }, {
        lstatSync(path) {
          const stats = lstatSync(path);
          if (path !== changedPath) return stats;
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
            dev: stats.dev + 1,
            ino: stats.ino,
          });
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

  test("escapes every C1 control plus Unicode line separators", () => {
    const c1Controls = Array.from({ length: 0x20 }, (_, offset) => String.fromCharCode(0x80 + offset)).join("");
    const unsafe = `prefix${c1Controls}\u2028\u2029suffix.md`;
    const escaped = escapeLocalDetailPath(unsafe);

    for (let codeUnit = 0x80; codeUnit <= 0x9f; codeUnit += 1) {
      expect(escaped).toContain(`\\u${codeUnit.toString(16).toUpperCase().padStart(4, "0")}`);
      expect(escaped.includes(String.fromCharCode(codeUnit))).toBe(false);
    }
    expect(escaped).toContain("\\u2028");
    expect(escaped).toContain("\\u2029");
    expect(escaped.includes("\u2028")).toBe(false);
    expect(escaped.includes("\u2029")).toBe(false);
    expect(escaped.includes("\n")).toBe(false);
    expect(escaped.includes("\r")).toBe(false);
  });
});
