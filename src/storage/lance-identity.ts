/**
 * #545: vector index identity — a lightweight, per-index record of the model
 * that produced the vectors, stored next to the LanceDB tables.
 *
 * Why: a dimension check alone cannot distinguish two models that emit the same
 * width. Switching `embedding.provider` from a cloud model to a local one (or
 * between two 2048d models) keeps every row readable but makes recall garbage,
 * because the vector spaces differ. The identity file is the only durable
 * evidence of what actually wrote the index.
 *
 * Invariants:
 *   - Written only when an index is created or rebuilt (never on a read path).
 *   - Committed together with the verified staging directory, so a failed
 *     rebuild always leaves the live index and its identity untouched.
 *   - Malformed or schema-inconsistent identity fails closed; it is never
 *     silently repaired, backfilled, or ignored.
 */
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Document encoding strategy. Bump when how documents are encoded changes. */
export const DOCUMENT_ENCODING_VERSION = 1;

/** Legacy index width that predates the identity file (Zhipu / deterministic). */
export const LEGACY_VECTOR_DIMENSIONS = 2048;

export const INDEX_IDENTITY_FILENAME = "cbrain-index-identity.json";

export interface VectorIndexIdentity {
  /** Embedding provider id: "zhipu" | "ollama" | "deterministic". */
  readonly provider: string;
  /** Provider model id, e.g. "embedding-3" or "qwen3-embedding:0.6b". */
  readonly model: string;
  readonly dimensions: number;
  /** Version of the document encoding strategy used for these vectors. */
  readonly documentEncoding: number;
  /**
   * Local model digest, recorded when the model server can report it. Absent
   * means "not resolved" (offline), never "matches anything with a digest".
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
  const vector = () => new FixedSizeList(dimensions, new Field("item", new Float32(), false));
  return {
    chunks: new Schema([
      new Field("pageSlug", new Utf8(), false),
      new Field("chunkIndex", new Int32(), false),
      new Field("content", new Utf8(), false),
      new Field("vector", vector(), false),
    ]),
    insights: new Schema([
      new Field("id", new Int32(), false),
      new Field("content", new Utf8(), false),
      new Field("vector", vector(), false),
    ]),
  };
}

export function vectorIndexIdentity(input: {
  provider: string;
  model: string;
  dimensions: number;
  documentEncoding?: number;
  modelDigest?: string;
}): VectorIndexIdentity {
  if (!input.provider) throw new VectorIdentityError("index identity requires a provider id");
  if (!input.model) throw new VectorIdentityError("index identity requires a model id");
  if (!Number.isInteger(input.dimensions) || input.dimensions < 1) {
    throw new VectorIdentityError(`index identity requires a positive integer dimension, got ${input.dimensions}`);
  }
  const identity: VectorIndexIdentity = {
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    documentEncoding: input.documentEncoding ?? DOCUMENT_ENCODING_VERSION,
    ...(input.modelDigest ? { modelDigest: input.modelDigest } : {}),
  };
  return identity;
}

export function identityFilePath(indexPath: string): string {
  return join(indexPath, INDEX_IDENTITY_FILENAME);
}

function parseIdentity(raw: string, path: string): VectorIndexIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new VectorIdentityError(
      `LANCE_IDENTITY_CORRUPT: ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}). `
      + "Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.",
    );
  }
  const value = parsed as Partial<VectorIndexIdentity> | null;
  const ok = value && typeof value === "object"
    && typeof value.provider === "string" && value.provider.length > 0
    && typeof value.model === "string" && value.model.length > 0
    && Number.isInteger(value.dimensions) && (value.dimensions as number) > 0
    && Number.isInteger(value.documentEncoding)
    && (value.modelDigest === undefined || typeof value.modelDigest === "string");
  if (!ok) {
    throw new VectorIdentityError(
      `LANCE_IDENTITY_CORRUPT: ${path} is missing required identity fields. `
      + "Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.",
    );
  }
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
  return `provider=${identity.provider} model=${identity.model} dimensions=${identity.dimensions}`
    + ` encoding=${identity.documentEncoding}${identity.modelDigest ? ` digest=${identity.modelDigest.slice(0, 12)}` : ""}`;
}

const REBUILD_HINT = "Recovery: stop serve/watcher → cbrain sync --reindex-vectors → restart.";

/**
 * Fail closed unless the stored identity is compatible with the expected one
 * and with the dimensions actually present in the table schema.
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
    // the legacy Zhipu 2048 layout, verified by schema. It is never relabelled
    // on a read path, and it is never treated as the configured local model.
    if (expected.provider === "zhipu" && expected.dimensions === LEGACY_VECTOR_DIMENSIONS
      && schemaDimensions === LEGACY_VECTOR_DIMENSIONS) {
      return;
    }
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
  // Digest drift is only decidable when both sides resolved one.
  if (stored.modelDigest && expected.modelDigest && stored.modelDigest !== expected.modelDigest) {
    mismatches.push(`model digest ${stored.modelDigest.slice(0, 12)} != ${expected.modelDigest.slice(0, 12)}`);
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
