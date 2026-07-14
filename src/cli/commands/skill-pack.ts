/**
 * `cbrain skill-pack` — Verify and report Hermes skill pack status.
 *
 * Resolves the installed pack location, checks all required files exist,
 * validates entrypoint size, and outputs a stable JSON or human-readable report.
 * Read-only. No mutations, no network, no LLM calls.
 *
 * Pure helpers (`resolveSkillsDir`, `verifySkillPack`, `formatHuman`)
 * are exported for testing.
 */
import type { Command } from "commander";
import { existsSync, readFileSync, statSync, readdirSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "url";
import { version } from "../../version.js";

// ── Constants ──

/** Files required for a valid skill pack (legacy hardcoded subset; superseded by MANIFEST-driven verify). */
export const REQUIRED_FILES = [
  "SKILL.md",
  "hermes-cbrain-brief.md",
  "RESOLVER.md",
  "recall-resolver.md",
  "response-contract.routing-eval.jsonl",
  "agent-facing.routing-eval.jsonl",
] as const;

/**
 * Hard-coded entry-file subset the manifest must always contain, so a
 * hand-edited manifest cannot silently drop a critical entrypoint.
 * The full file list is driven by `skills/MANIFEST.json` (see {@link loadManifest}).
 */
export const ENTRY_FILES = [
  "SKILL.md",
  "hermes-cbrain-brief.md",
  "RESOLVER.md",
  "recall-resolver.md",
] as const;

const MANIFEST_FILENAME = "MANIFEST.json";

export interface PackManifest {
  readonly packVersion: string;
  readonly files: readonly string[];
}

const SIZE_WARN = 30_000;
const SIZE_ERROR = 100_000;

// ── Types ──

export type FileStatus = "present" | "missing" | "not_file" | "not_readable";
export type SizeStatus = "ok" | "warn" | "error";
export type VerificationStatus = "pass" | "warn" | "fail";
export type TargetFileState = "current" | "stale" | "missing" | "incompatible" | "unverified";
export type TargetStatus = "current" | "stale" | "missing" | "incompatible" | "unverified";
export type CommandStatus = "pass" | "warn" | "fail";

export interface VerifiedFile {
  readonly name: string;
  readonly status: FileStatus;
  readonly absolutePath?: string;
}

export interface TargetFileCheck {
  readonly name: string;
  readonly state: TargetFileState;
}

export interface SkillPackReport {
  readonly version: string;
  readonly packPath: string;
  readonly entrypointPath: string;
  readonly requiredFiles: readonly VerifiedFile[];
  readonly missingFiles: readonly string[];
  readonly sizeStatus: SizeStatus;
  readonly entrypointChars: number;
  readonly verificationStatus: VerificationStatus;
  /** Aggregate command status — agrees with exit code (pass → 0, warn/fail → 1). */
  readonly status: CommandStatus;
  readonly guidance: {
    readonly copyCommand: string;
    readonly symlinkCommand: string;
  };
  readonly target?: {
    readonly path: string;
    readonly status: TargetStatus;
    readonly files: readonly TargetFileCheck[];
    readonly staleFiles: readonly string[];
    readonly missingTargetFiles: readonly string[];
    readonly unverifiedFiles: readonly string[];
    readonly incompatibleFiles?: readonly string[];
  };
}

/** Structured error envelope for --json failure output. */
export interface SkillPackError {
  readonly version: string;
  readonly packPath: string;
  readonly verificationStatus: "fail";
  readonly status: "fail";
  readonly code: string;
  readonly error: string;
}

// ── Skills directory resolution ──

/**
 * Resolve the `skills/` directory relative to this module file.
 * Works from both source checkout and packed installs because
 * `import.meta.url` always points to the actual file on disk.
 */
export function resolveSkillsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/");
}

// ── Manifest ──

/**
 * Load and validate `skills/MANIFEST.json`.
 * @throws Error with code-bearing message prefix on schema/inventory/version failure.
 */
export function loadManifest(skillsDir: string): PackManifest {
  const manifestPath = resolve(skillsDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`MANIFEST_MISSING: ${MANIFEST_FILENAME} not found in ${skillsDir}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new Error(`MANIFEST_INVALID: ${MANIFEST_FILENAME} is not valid JSON`);
  }
  const m = parsed as { packVersion?: unknown; files?: unknown };
  if (typeof m.packVersion !== "string" || m.packVersion.length === 0) {
    throw new Error(`MANIFEST_INVALID: packVersion must be a non-empty string`);
  }
  if (!Array.isArray(m.files) || m.files.some((f) => typeof f !== "string")) {
    throw new Error(`MANIFEST_INVALID: files must be an array of strings`);
  }
  const files = m.files as string[];
  const seen = new Set<string>();
  for (const name of files) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.startsWith("/") || name === MANIFEST_FILENAME) {
      throw new Error(`MANIFEST_INVALID: unsafe or self-referential file entry "${name}"`);
    }
    if (seen.has(name)) {
      throw new Error(`MANIFEST_INVALID: duplicate file entry "${name}"`);
    }
    seen.add(name);
  }
  for (const entry of ENTRY_FILES) {
    if (!seen.has(entry)) {
      throw new Error(`MANIFEST_INVALID: entry file "${entry}" missing from manifest`);
    }
  }
  const onDisk = new Set(
    readdirSync(skillsDir)
      .filter((f) => statSync(resolve(skillsDir, f)).isFile())
      .filter((f) => f !== MANIFEST_FILENAME),
  );
  const manifestSet = new Set(files);
  if (manifestSet.size !== onDisk.size || ![...manifestSet].every((f) => onDisk.has(f))) {
    throw new Error(`INVENTORY_MISMATCH: manifest files[] does not equal skills/ top-level files`);
  }
  if (m.packVersion !== version) {
    throw new Error(`VERSION_MISMATCH: manifest packVersion ${m.packVersion} ≠ runtime ${version}`);
  }
  return { packVersion: m.packVersion, files };
}

// ── Verification ──

/**
 * Verify a skill pack directory. Pure function — only reads from filesystem.
 *
 * @throws Error if `skillsDir` does not exist or is not a directory.
 */
export function verifySkillPack(skillsDir: string): SkillPackReport {
  const resolvedDir = resolve(skillsDir);

  if (!existsSync(resolvedDir)) {
    throw new Error(`Skills directory not found: ${resolvedDir}`);
  }

  const dirStat = statSync(resolvedDir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Skills path is not a directory: ${resolvedDir}`);
  }

  // Load manifest (validates schema, exact-inventory, version) then check each file
  const manifest = loadManifest(resolvedDir);
  const requiredFiles: VerifiedFile[] = manifest.files.map((name) => {
    const absPath = resolve(resolvedDir, name);

    if (!existsSync(absPath)) {
      return { name, status: "missing" as const };
    }

    const st = statSync(absPath);
    if (!st.isFile()) {
      return { name, status: "not_file" as const };
    }

    // Readability check
    try {
      readFileSync(absPath, "utf-8");
    } catch {
      return { name, status: "not_readable" as const };
    }

    return { name, status: "present" as const, absolutePath: absPath };
  });

  const missingFiles = requiredFiles
    .filter((f) => f.status !== "present")
    .map((f) => f.name);

  // Entrypoint size check
  const entrypointPath = resolve(resolvedDir, "SKILL.md");
  let entrypointChars = 0;
  let sizeStatus: SizeStatus = "ok";

  if (existsSync(entrypointPath) && statSync(entrypointPath).isFile()) {
    try {
      const content = readFileSync(entrypointPath, "utf-8");
      entrypointChars = content.length;
    } catch {
      // Can't read — chars stay 0
    }

    if (entrypointChars >= SIZE_ERROR) {
      sizeStatus = "error";
    } else if (entrypointChars >= SIZE_WARN) {
      sizeStatus = "warn";
    }
  }

  // Overall verification status
  let verificationStatus: VerificationStatus;
  if (missingFiles.length > 0 || sizeStatus === "error") {
    verificationStatus = "fail";
  } else if (sizeStatus === "warn") {
    verificationStatus = "warn";
  } else {
    verificationStatus = "pass";
  }

  const status: CommandStatus = verificationStatus === "fail" ? "fail"
    : verificationStatus === "warn" ? "warn"
    : "pass";

  return {
    version,
    packPath: resolvedDir,
    entrypointPath,
    requiredFiles,
    missingFiles,
    sizeStatus,
    entrypointChars,
    verificationStatus,
    status,
    guidance: {
      copyCommand: `cp -r "${resolvedDir}/" "<target>/"`,
      symlinkCommand: `ln -s "${resolvedDir}" "<target>"`,
    },
  };
}

// ── Target comparison ──

function fileHash(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * lstat that treats a thrown error as "does not exist". lstatSync succeeds on
 * a broken symlink (the link entry itself exists), so a broken symlink at the
 * target path counts as "exists" and is classified `incompatible`, not `missing`.
 */
function lstatSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare a target directory against the canonical pack.
 *
 * Precedence: unverified (canonical cannot serve as baseline) > missing
 * (target path absent) > incompatible (target exists but is empty / non-dir /
 * broken symlink / no or bad MANIFEST / version or files[] mismatch) > stale
 * (version+files match but a file hash differs) > current.
 *
 * Read-only — does not modify the target.
 */
export function compareTarget(
  skillsDir: string,
  targetDir: string,
): { status: TargetStatus; files: readonly TargetFileCheck[]; staleFiles: readonly string[]; missingTargetFiles: readonly string[]; unverifiedFiles: readonly string[] } {
  // Canonical must be loadable to serve as comparison baseline.
  let canonicalManifest: PackManifest;
  try {
    canonicalManifest = loadManifest(skillsDir);
  } catch {
    return { status: "unverified", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }

  // Target path existence: lstat sees broken symlinks (path entry exists).
  if (!lstatSafe(targetDir)) {
    return { status: "missing", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }

  // Target must be a non-empty directory; empty dir / non-dir / broken symlink → incompatible.
  let isDir = false;
  try {
    isDir = statSync(targetDir).isDirectory();
  } catch {
    // broken symlink: lstat succeeded but stat throws
  }
  if (!isDir) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }
  if (readdirSync(targetDir).length === 0) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }

  // Target MANIFEST must be present + match canonical version + files[].
  let targetManifest: PackManifest;
  try {
    targetManifest = loadManifest(targetDir);
  } catch {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }
  if (targetManifest.packVersion !== canonicalManifest.packVersion) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }
  if (
    targetManifest.files.length !== canonicalManifest.files.length
    || !targetManifest.files.every((f, i) => f === canonicalManifest.files[i])
  ) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [] };
  }

  // Per-file hash compare (inventory already guaranteed all files present).
  const files: TargetFileCheck[] = canonicalManifest.files.map((name) => {
    const canonicalHash = fileHash(resolve(skillsDir, name));
    const targetHash = fileHash(resolve(targetDir, name));
    if (targetHash === null) return { name, state: "missing" as const };
    if (canonicalHash === null) return { name, state: "unverified" as const };
    if (targetHash === canonicalHash) return { name, state: "current" as const };
    return { name, state: "stale" as const };
  });

  const staleFiles = files.filter((f) => f.state === "stale").map((f) => f.name);
  const missingTargetFiles = files.filter((f) => f.state === "missing").map((f) => f.name);
  const unverifiedFiles = files.filter((f) => f.state === "unverified").map((f) => f.name);

  let targetStatus: TargetStatus = "current";
  if (unverifiedFiles.length > 0) targetStatus = "unverified";
  else if (missingTargetFiles.length > 0) targetStatus = "missing";
  else if (staleFiles.length > 0) targetStatus = "stale";

  return { status: targetStatus, files, staleFiles, missingTargetFiles, unverifiedFiles };
}

// ── Human formatter ──

export function formatHuman(report: SkillPackReport): string {
  const presentCount = report.requiredFiles.filter((f) => f.status === "present").length;
  const totalCount = report.requiredFiles.length;

  const lines: string[] = [
    "",
    `  CBrain Skill Pack v${report.version}`,
    `  Pack:       ${report.packPath}`,
    `  Entrypoint: ${report.entrypointPath} (${report.entrypointChars.toLocaleString()} chars)`,
    "",
    `  Required files: ${presentCount}/${totalCount} present`,
  ];

  if (report.missingFiles.length > 0) {
    lines.push(`  Missing: ${report.missingFiles.join(", ")}`);
  }

  if (report.sizeStatus === "warn") {
    lines.push(`  Size: WARN (entrypoint exceeds ${SIZE_WARN.toLocaleString()} chars)`);
  } else if (report.sizeStatus === "error") {
    lines.push(`  Size: ERROR (entrypoint exceeds ${SIZE_ERROR.toLocaleString()} chars)`);
  }

  const statusLabel = report.status.toUpperCase();
  const packLabel = report.verificationStatus.toUpperCase();
  lines.push("", `  Status: ${statusLabel}`);
  if (packLabel !== statusLabel) {
    lines.push(`  Pack status: ${packLabel}`);
  }
  lines.push("");

  if (report.status !== "fail") {
    lines.push(`  Copy:    ${report.guidance.copyCommand}`);
    lines.push(`  Symlink: ${report.guidance.symlinkCommand}`);
  }

  if (report.target) {
    lines.push("");
    lines.push(`  Target: ${report.target.path}`);
    lines.push(`  Target status: ${report.target.status.toUpperCase()}`);
    const currentCount = report.target.files.filter((f) => f.state === "current").length;
    lines.push(`  Target files: ${currentCount}/${report.target.files.length} current`);
    if (report.target.staleFiles.length > 0) {
      lines.push(`  Stale: ${report.target.staleFiles.join(", ")}`);
    }
    if (report.target.missingTargetFiles.length > 0) {
      lines.push(`  Missing in target: ${report.target.missingTargetFiles.join(", ")}`);
    }
    if (report.target.unverifiedFiles.length > 0) {
      lines.push(`  Unverified (canonical missing): ${report.target.unverifiedFiles.join(", ")}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ── Register ──

export function register(program: Command) {
  program
    .command("skill-pack")
    .description("Verify and report Hermes skill pack status")
    .option("--json", "Output machine-readable JSON")
    .option("--target <path>", "Compare target directory against canonical pack")
    .action((opts) => {
      try {
        const skillsDir = resolveSkillsDir();
        const report = verifySkillPack(skillsDir);

        // Derive aggregate command status
        let status: CommandStatus = report.verificationStatus === "fail" ? "fail"
          : report.verificationStatus === "warn" ? "warn"
          : "pass";

        // If --target provided, run comparison (no throw on absent path —
        // compareTarget classifies it as `missing`; only canonical failure throws).
        if (opts.target) {
          const targetDir = resolve(opts.target);
          const comparison = compareTarget(skillsDir, targetDir);

          // canonical fail propagates as fail regardless of target
          if (report.verificationStatus === "fail") {
            status = "fail";
          } else if (comparison.status !== "current") {
            status = "fail";
          }

          const enriched: SkillPackReport = {
            ...report,
            status,
            target: {
              path: targetDir,
              ...comparison,
            },
          };

          if (opts.json) {
            process.stdout.write(JSON.stringify(enriched, null, 2) + "\n");
          } else {
            process.stdout.write(formatHuman(enriched));
          }

          if (status === "fail" || status === "warn") {
            process.exitCode = 1;
          }
          return;
        }

        const reportWithStatus: SkillPackReport = { ...report, status };

        if (opts.json) {
          process.stdout.write(JSON.stringify(reportWithStatus, null, 2) + "\n");
        } else {
          process.stdout.write(formatHuman(reportWithStatus));
        }

        if (status === "fail" || status === "warn") {
          process.exitCode = 1;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const skillsDir = resolveSkillsDir();

        // Map to stable error code — check most specific patterns first
        let code = "PACK_INVALID";
        if (message.includes("Skills directory not found") || message.includes("Skills path is not a directory")) {
          code = "PACK_NOT_FOUND";
        } else if (message.includes("MANIFEST_MISSING")) {
          code = "MANIFEST_MISSING";
        } else if (message.includes("MANIFEST_INVALID")) {
          code = "MANIFEST_INVALID";
        } else if (message.includes("VERSION_MISMATCH")) {
          code = "VERSION_MISMATCH";
        } else if (message.includes("INVENTORY_MISMATCH")) {
          code = "INVENTORY_MISMATCH";
        }

        if (opts.json) {
          const errorReport: SkillPackError = {
            version,
            packPath: skillsDir,
            verificationStatus: "fail",
            status: "fail",
            code,
            error: message,
          };
          process.stdout.write(JSON.stringify(errorReport, null, 2) + "\n");
        } else {
          process.stderr.write(`Error: ${message}\n`);
        }
        process.exitCode = 1;
      }
    });
}
