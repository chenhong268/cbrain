import {
  lstatSync as nodeLstatSync,
  readdirSync as nodeReaddirSync,
  realpathSync as nodeRealpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const CONFLICT_SUFFIX = "(?:[2-9]|[1-9][0-9])";
const EXACT_CBRain_DIRECTORIES = new Set(["brain", "records", "raw"]);
const trustedVaultBoundaryBrand: unique symbol = Symbol("TrustedVaultBoundary");

export interface EntryIdentity {
  dev: number;
  ino: number;
  kind: "directory";
}

export interface TrustedVaultBoundary {
  readonly configRoot: string;
  readonly vaultPath: string;
  readonly rootIdentity: EntryIdentity;
  readonly vaultIdentity: EntryIdentity;
  readonly [trustedVaultBoundaryBrand]: true;
}

export interface MisplacedVaultArtifactScan {
  eligible: boolean;
  zeroByteMarkdownCount: number;
  reviewRequiredCount: number;
  unreadableCount: number;
}

export interface MisplacedVaultArtifactLocalDetail {
  relativePath: string;
  classification: "zero_byte_markdown" | "review_required" | "unreadable";
}

export interface MisplacedVaultArtifactInspection {
  scan: MisplacedVaultArtifactScan;
  localDetails: readonly MisplacedVaultArtifactLocalDetail[];
}

/** Internal seam used to simulate filesystem races without touching a live vault. */
export interface MisplacedInspectorDeps {
  lstatSync(path: string): Stats;
  readdirSync(path: string): string[];
  realpathSync(path: string): string;
}

const PRODUCTION_DEPS: MisplacedInspectorDeps = {
  lstatSync: (path) => nodeLstatSync(path),
  readdirSync: (path) => nodeReaddirSync(path),
  realpathSync: (path) => nodeRealpathSync(path),
};

function directoryIdentity(stats: Stats): EntryIdentity | undefined {
  if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
  return { dev: stats.dev, ino: stats.ino, kind: "directory" };
}

function sameIdentity(actual: EntryIdentity | undefined, expected: EntryIdentity): boolean {
  return actual?.dev === expected.dev
    && actual.ino === expected.ino
    && actual.kind === expected.kind;
}

export function resolveTrustedVaultBoundary(input: {
  configRoot: string;
  vaultPath: string;
}): TrustedVaultBoundary | undefined {
  try {
    const configRoot = nodeRealpathSync(resolve(input.configRoot));
    const rootIdentity = directoryIdentity(nodeLstatSync(configRoot));
    if (!rootIdentity) return undefined;

    const obsidianPath = join(configRoot, ".obsidian");
    const obsidianStats = nodeLstatSync(obsidianPath);
    if (obsidianStats.isSymbolicLink() || !obsidianStats.isDirectory()) return undefined;

    const lexicalVaultPath = resolve(input.vaultPath);
    const lexicalVaultStats = nodeLstatSync(lexicalVaultPath);
    if (lexicalVaultStats.isSymbolicLink() || !lexicalVaultStats.isDirectory()) return undefined;

    const vaultPath = nodeRealpathSync(lexicalVaultPath);
    if (dirname(vaultPath) !== configRoot) return undefined;
    const vaultIdentity = directoryIdentity(nodeLstatSync(vaultPath));
    if (!vaultIdentity) return undefined;

    return {
      configRoot,
      vaultPath,
      rootIdentity,
      vaultIdentity,
      [trustedVaultBoundaryBrand]: true,
    };
  } catch {
    return undefined;
  }
}

function emptyInspection(eligible: boolean): MisplacedVaultArtifactInspection {
  return {
    scan: {
      eligible,
      zeroByteMarkdownCount: 0,
      reviewRequiredCount: 0,
      unreadableCount: 0,
    },
    localDetails: [],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecognizedCandidate(name: string, vaultName: string, conflictPattern: RegExp): boolean {
  if (name.startsWith(".") || name === vaultName) return false;
  if (name.endsWith(".md") || EXACT_CBRain_DIRECTORIES.has(name)) return true;
  return conflictPattern.test(name);
}

function identityStillMatches(
  boundary: TrustedVaultBoundary,
  deps: MisplacedInspectorDeps,
): boolean {
  try {
    const rootIdentity = directoryIdentity(deps.lstatSync(boundary.configRoot));
    const vaultIdentity = directoryIdentity(deps.lstatSync(boundary.vaultPath));
    return sameIdentity(rootIdentity, boundary.rootIdentity)
      && sameIdentity(vaultIdentity, boundary.vaultIdentity);
  } catch {
    return false;
  }
}

export function inspectMisplacedVaultArtifacts(
  boundary?: TrustedVaultBoundary,
  options: { includeLocalDetails?: boolean } = {},
  overrides: Partial<MisplacedInspectorDeps> = {},
): MisplacedVaultArtifactInspection {
  if (!boundary || boundary[trustedVaultBoundaryBrand] !== true) return emptyInspection(false);

  const deps: MisplacedInspectorDeps = { ...PRODUCTION_DEPS, ...overrides };
  const result = emptyInspection(true);
  const details: MisplacedVaultArtifactLocalDetail[] = [];
  const vaultName = basename(boundary.vaultPath);
  const conflictBases = ["brain", "records", "raw", vaultName]
    .map(escapeRegex)
    .join("|");
  const conflictPattern = new RegExp(`^(?:${conflictBases}) ${CONFLICT_SUFFIX}$`);

  let names: string[];
  try {
    // This is the inspector's only directory enumeration. Candidate paths are
    // classified exclusively through lstat metadata below.
    names = deps.readdirSync(boundary.configRoot).sort();
  } catch {
    result.scan.unreadableCount = 1;
    return result;
  }

  for (const name of names) {
    if (!isRecognizedCandidate(name, vaultName, conflictPattern)) continue;

    try {
      const stats = deps.lstatSync(join(boundary.configRoot, name));
      if (name.endsWith(".md") && stats.isFile() && stats.size === 0) {
        result.scan.zeroByteMarkdownCount += 1;
        if (options.includeLocalDetails === true) {
          details.push({ relativePath: name, classification: "zero_byte_markdown" });
        }
      } else {
        result.scan.reviewRequiredCount += 1;
        if (options.includeLocalDetails === true) {
          details.push({ relativePath: name, classification: "review_required" });
        }
      }
    } catch {
      result.scan.unreadableCount += 1;
      if (options.includeLocalDetails === true) {
        details.push({ relativePath: name, classification: "unreadable" });
      }
    }
  }

  if (!identityStillMatches(boundary, deps)) {
    result.scan.unreadableCount = Math.max(1, result.scan.unreadableCount);
    return result;
  }

  return {
    scan: result.scan,
    localDetails: options.includeLocalDetails === true ? details : [],
  };
}

function unicodeEscape(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).toUpperCase().padStart(4, "0")}`;
}

function isBidiControl(codeUnit: number): boolean {
  return codeUnit === 0x061c
    || (codeUnit >= 0x200e && codeUnit <= 0x200f)
    || (codeUnit >= 0x202a && codeUnit <= 0x202e)
    || (codeUnit >= 0x2066 && codeUnit <= 0x2069);
}

/** Return a reversible, quoted JSON-style string that is safe on one terminal line. */
export function escapeLocalDetailPath(path: string): string {
  let escaped = '"';
  for (let index = 0; index < path.length; index += 1) {
    const codeUnit = path.charCodeAt(index);
    switch (codeUnit) {
      case 0x08: escaped += "\\b"; break;
      case 0x09: escaped += "\\t"; break;
      case 0x0a: escaped += "\\n"; break;
      case 0x0c: escaped += "\\f"; break;
      case 0x0d: escaped += "\\r"; break;
      case 0x22: escaped += '\\"'; break;
      case 0x5c: escaped += "\\\\"; break;
      default:
        if (codeUnit <= 0x1f || codeUnit === 0x7f || isBidiControl(codeUnit)) {
          escaped += unicodeEscape(codeUnit);
        } else {
          escaped += path[index];
        }
    }
  }
  return `${escaped}"`;
}
