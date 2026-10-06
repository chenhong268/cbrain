/**
 * #545: vector index identity — a per-index record of the model that produced
 * the vectors, stored next to the LanceDB tables.
 *
 * A width check cannot distinguish two models that emit the same dimension:
 * switching provider (cloud ↔ local, or between two 2048d models) keeps every row
 * readable but makes recall garbage, because the vector spaces differ.
 *
 * Invariants: written only when an index is created or rebuilt (never on a read
 * path); committed together with the verified staging directory, so a failed
 * rebuild leaves the live index and its identity untouched; malformed or
 * schema-inconsistent identity fails closed and is never repaired or backfilled.
 */
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Document encoding strategy. Bump when how documents are encoded changes. */
export const DOCUMENT_ENCODING_VERSION = 1;
/** Legacy index width that predates the identity file (Zhipu / deterministic). */
export const LEGACY_VECTOR_DIMENSIONS = 2048;
export const INDEX_IDENTITY_FILENAME = "cbrain-index-identity.json";
/** Shared recovery pointer for identity failures. */
export const REBUILD_HINT = "Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.";

export interface VectorIndexIdentity {
  /** Embedding provider id: "zhipu" | "ollama" | "deterministic". */
  readonly provider: string;
  /** Provider model id, e.g. "embedding-3" or "qwen3-embedding:0.6b". */
  readonly model: string;
  readonly dimensions: number;
  /** Version of the document encoding strategy used for these vectors. */
  readonly documentEncoding: number;
  /**
   * Model digest, recorded when the model server can report one. Absent means
   * "not resolved" (offline), never "matches anything with a digest".
   */
  readonly modelDigest?: string;
}

/** Classified identity failure — callers may catch it and report a rebuild path. */
export class VectorIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorIdentityError";
  }
}

export interface VectorSchemaSet {
  readonly chunks: Schema;
  readonly insights: Schema;
}

/** Narrow schema generator shared by the live manager and the full rebuilder. */
export function vectorSchemas(dimensions: number): VectorSchemaSet {
  const vector = () =>
    new Field("vector", new FixedSizeList(dimensions, new Field("item", new Float32(), false)), false);
  return {
    chunks: new Schema([
      new Field("pageSlug", new Utf8(), false),
      new Field("chunkIndex", new Int32(), false),
      new Field("content", new Utf8(), false),
      vector(),
    ]),
    insights: new Schema([new Field("id", new Int32(), false), new Field("content", new Utf8(), false), vector()]),
  };
}

export function vectorIndexIdentity(input: {
  provider: string;
  model: string;
  dimensions: number;
  documentEncoding?: number;
  modelDigest?: string;
}): VectorIndexIdentity {
  if (!input.provider || !input.model) throw new VectorIdentityError("index identity requires a provider id and a model id");
  if (!Number.isInteger(input.dimensions) || input.dimensions < 1) {
    throw new VectorIdentityError(`index identity requires a positive integer dimension, got ${input.dimensions}`);
  }
  return {
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    documentEncoding: input.documentEncoding ?? DOCUMENT_ENCODING_VERSION,
    ...(input.modelDigest ? { modelDigest: input.modelDigest } : {}),
  };
}

export function identityFilePath(indexPath: string): string {
  return join(indexPath, INDEX_IDENTITY_FILENAME);
}

function corrupt(path: string, detail: string): VectorIdentityError {
  return new VectorIdentityError(`LANCE_IDENTITY_CORRUPT: ${path} ${detail}. ${REBUILD_HINT}`);
}

function parseIdentity(raw: string, path: string): VectorIndexIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw corrupt(path, `is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const value = parsed as Partial<VectorIndexIdentity> | null;
  const ok = value && typeof value === "object"
    && typeof value.provider === "string" && value.provider.length > 0
    && typeof value.model === "string" && value.model.length > 0
    && Number.isInteger(value.dimensions) && (value.dimensions as number) > 0
    && Number.isInteger(value.documentEncoding)
    && (value.modelDigest === undefined || typeof value.modelDigest === "string");
  if (!ok) throw corrupt(path, "is missing required identity fields");
  return value as VectorIndexIdentity;
}

/** Read the stored identity. Returns null when the index has none (legacy). */
export function readIndexIdentity(indexPath: string): VectorIndexIdentity | null {
  const path = identityFilePath(indexPath);
  if (!existsSync(path)) return null;
  return parseIdentity(readFileSync(path, "utf8"), path);
}

/**
 * Write the identity into an index directory. Called only after staging
 * verification passed and before the directory swap, so a crash leaves either
 * the old index with its old identity or the new index with its new identity.
 */
export function writeIndexIdentity(indexPath: string, identity: VectorIndexIdentity): void {
  const path = identityFilePath(indexPath);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

function describe(identity: VectorIndexIdentity): string {
  const digest = identity.modelDigest ? ` digest=${identity.modelDigest.slice(0, 12)}` : "";
  return `provider=${identity.provider} model=${identity.model} dimensions=${identity.dimensions}`
    + ` encoding=${identity.documentEncoding}${digest}`;
}

/**
 * Fail closed unless the stored identity is compatible with the expected one and
 * with the width really present in the table schema.
 *
 * `expected` is null for callers with no provider context (offline probes); they
 * still get the schema/identity consistency check.
 * `schemaDimensions` is the width found in the on-disk table, or null when the
 * table does not exist yet (creation path).
 */
export function assertIndexIdentity(input: {
  indexPath: string;
  expected: VectorIndexIdentity | null;
  stored: VectorIndexIdentity | null;
  schemaDimensions: number | null;
}): void {
  const { expected, stored, schemaDimensions } = input;

  if (stored && schemaDimensions !== null && stored.dimensions !== schemaDimensions) {
    throw new VectorIdentityError(
      `LANCE_IDENTITY_SCHEMA_MISMATCH: ${input.indexPath} declares ${describe(stored)} but its table `
      + `vector column is ${schemaDimensions}d. The index is damaged. ${REBUILD_HINT}`,
    );
  }
  if (!expected) return;

  if (!stored) {
    // Approved long-term compatibility: an unlabelled index is accepted only for
    // the legacy Zhipu 2048 layout, verified by schema. It is never relabelled on
    // a read path, and never treated as the configured local model.
    const legacy = expected.provider === "zhipu" && expected.dimensions === LEGACY_VECTOR_DIMENSIONS
      && schemaDimensions === LEGACY_VECTOR_DIMENSIONS;
    if (legacy) return;
    throw new VectorIdentityError(
      `LANCE_IDENTITY_MISSING: ${input.indexPath} has no index identity and is not a legacy 2048d Zhipu index `
      + `(expected ${describe(expected)}${schemaDimensions === null ? "" : `, found ${schemaDimensions}d`}). `
      + `The configured model did not build this index. ${REBUILD_HINT}`,
    );
  }

  const mismatches: string[] = [];
  if (stored.provider !== expected.provider) mismatches.push(`provider ${stored.provider} != ${expected.provider}`);
  if (stored.model !== expected.model) mismatches.push(`model ${stored.model} != ${expected.model}`);
  if (stored.dimensions !== expected.dimensions) mismatches.push(`dimensions ${stored.dimensions} != ${expected.dimensions}`);
  if (stored.documentEncoding !== expected.documentEncoding) {
    mismatches.push(`document encoding ${stored.documentEncoding} != ${expected.documentEncoding}`);
  }
  // #545 F2: the digest is part of the identity. An index that recorded none stays
  // readable offline, but a confirmed model must not adopt it online.
  if (stored.modelDigest !== expected.modelDigest) {
    if (stored.modelDigest === undefined) {
      throw new VectorIdentityError(
        `LANCE_IDENTITY_DIGEST_MISSING: ${input.indexPath} records ${describe(stored)} without a model digest, so it `
        + `cannot be confirmed against the configured model. ${REBUILD_HINT}`,
      );
    }
    mismatches.push(`model digest ${stored.modelDigest.slice(0, 12)} != ${expected.modelDigest?.slice(0, 12) ?? "none"}`);
  }
  if (mismatches.length > 0) {
    throw new VectorIdentityError(
      `LANCE_IDENTITY_MISMATCH: ${input.indexPath} was built by ${describe(stored)}, but the configuration `
      + `expects ${describe(expected)} (${mismatches.join("; ")}). Do not mix vector spaces. ${REBUILD_HINT}`,
    );
  }
}

/**
 * Read the width of the `vector` column of an already-open table, or null when
 * the column is not a fixed-size list (damaged schema).
 */
export function vectorColumnDimensions(schema: { fields?: Array<{ name: string; type: unknown }> }): number | null {
  const field = (schema?.fields ?? []).find((f) => f.name === "vector");
  const type = field?.type as { listSize?: unknown } | undefined;
  return typeof type?.listSize === "number" ? type.listSize : null;
}

/**
 * #545 R2: reject a vector the index cannot store faithfully. Width alone is not
 * enough — the store accepts a short vector (and reads it back padded), and it
 * stores NaN / Infinity / Float32 overflow without an error, so recall degrades
 * silently instead of failing. Callers validate a whole batch BEFORE the first
 * row is written, and never pad or truncate a vector to make it fit.
 */
export function assertStorableVector(vector: ArrayLike<number>, dimensions: number, label: string): void {
  if (vector.length !== dimensions) {
    throw new VectorIdentityError(
      `VECTOR_DIMENSION_MISMATCH: ${label} carries ${vector.length}d, the index stores ${dimensions}d. Refusing to `
      + "write a vector that cannot be read back unchanged. Align the embedding provider with the index width, or "
      + "rebuild the index with the configured model. Do not pad or truncate the vector.",
    );
  }
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    const stored = Math.fround(value);
    if (!Number.isFinite(value) || !Number.isFinite(stored)) {
      throw new VectorIdentityError(
        `VECTOR_VALUE_INVALID: ${label}[${i}] is ${value} and would be stored as ${stored}. A value that is not `
        + "finite carries no direction; the provider produced a broken vector. Fix the provider or rebuild the index.",
      );
    }
  }
}
