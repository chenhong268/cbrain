import { createHash } from "node:crypto";

/**
 * #386 — Page Writer Provenance (record 创建者溯源)
 *
 * Unforgable, append-only attribution for who created a `record` page and how.
 * Distinct from {@link ProvenanceManager} (link/timeline trust state) and from
 * `ingest_log` (mutable operation log) — this is the immutable creation-truth row.
 *
 * Scope (v1): only `type=record` page CREATION is attributed. entity/concept/
 * insight pages and dialogue auto-extraction are future extensions.
 *
 * Anti-forgery: `RecordWriterContext` / `PageCreationProvenanceInput` are
 * INTERNAL input shapes only — they must never appear in an MCP tool's public
 * zod inputSchema. The actor is decided by the adapter layer (MCP → agent,
 * CLI → operator, watcher → unknown_writer), never self-reported by the caller.
 */

export type PageWriteMode =
  | "ingest"
  | "put_page"
  | "external_direct_write"
  | "unknown_write_path";

export type PageActorClass =
  | "operator"
  | "agent"
  | "system"
  | "unknown_writer";

export type PageCreationReason =
  | "explicit_ingest"
  | "explicit_page_create"
  | "vault_file_discovered"
  | "unattributed_internal_create";

export type PageWriteOrigin = {
  kind: "session" | "job";
  ref: string;
};

/**
 * The "who" of a single write, carried by the adapter layer through internal
 * `CreatePageInput` / `IngestInput`. Internal only — never exposed to MCP callers.
 */
export interface RecordWriterContext {
  actorClass: PageActorClass;
  origin?: PageWriteOrigin;
}

/**
 * The full row written to `page_write_provenance`. Built by the adapter by
 * combining a {@link RecordWriterContext} with the write method's intrinsic
 * writeMode + creationReason.
 */
export interface PageCreationProvenanceInput {
  writeMode: PageWriteMode;
  actorClass: PageActorClass;
  creationReason: PageCreationReason;
  origin?: PageWriteOrigin;
}

/** Row shape returned by {@link CBrainDB.getPageWriteProvenance}. */
export interface PageWriteProvenanceRow {
  page_slug: string;
  write_mode: PageWriteMode;
  actor_class: PageActorClass;
  creation_reason: PageCreationReason;
  origin_kind: "session" | "job" | null;
  origin_ref: string | null;
  created_at: string;
}

/** Ingest via MCP/CLI: `agent`/`operator` carried by writer; mode=ingest, reason=explicit_ingest. */
export function forIngest(writer: RecordWriterContext): PageCreationProvenanceInput {
  return {
    writeMode: "ingest",
    actorClass: writer.actorClass,
    creationReason: "explicit_ingest",
    ...(writer.origin ? { origin: writer.origin } : {}),
  };
}

/** put_page (explicit page create): mode=put_page, reason=explicit_page_create. */
export function forPutPage(writer: RecordWriterContext): PageCreationProvenanceInput {
  return {
    writeMode: "put_page",
    actorClass: writer.actorClass,
    creationReason: "explicit_page_create",
    ...(writer.origin ? { origin: writer.origin } : {}),
  };
}

/** sync/watcher first discovers an external vault file: unattributed, mode=external_direct_write. */
export function forVaultDiscovery(): PageCreationProvenanceInput {
  return {
    writeMode: "external_direct_write",
    actorClass: "unknown_writer",
    creationReason: "vault_file_discovered",
  };
}

/**
 * A new record page was created with NO caller context (no writer). Per #386 the
 * new write must NOT mix into the historical gap — it is explicitly attributed
 * to an unknown internal path. Only pre-#386 / genuinely historical pages may
 * have no row at all.
 */
export function forUnattributed(): PageCreationProvenanceInput {
  return {
    writeMode: "unknown_write_path",
    actorClass: "unknown_writer",
    creationReason: "unattributed_internal_create",
  };
}

/** Structural equality of a stored row vs an input (excludes created_at). */
export function provenanceMatchesRow(row: PageWriteProvenanceRow, input: PageCreationProvenanceInput): boolean {
  return (
    row.write_mode === input.writeMode &&
    row.actor_class === input.actorClass &&
    row.creation_reason === input.creationReason &&
    (row.origin_kind ?? null) === (input.origin?.kind ?? null) &&
    (row.origin_ref ?? null) === (input.origin?.ref ?? null)
  );
}

/** Project a camelCase input into the snake_case shape used by the conflict
 *  error (write_mode / actor_class / creation_reason — origin_ref excluded). */
export function toConflictFields(
  p: { writeMode: string; actorClass: string; creationReason: string },
): { write_mode: string; actor_class: string; creation_reason: string } {
  return { write_mode: p.writeMode, actor_class: p.actorClass, creation_reason: p.creationReason };
}

// origin_ref must be a UUID or ULID — explicit opaque-ID formats that NO
// credential/token shape matches. Credential detection rules can never be
// exhaustive (new token formats appear constantly), so rather than detect-and-
// reject secrets, storage restricts origin_ref to formats a secret cannot take.
// This makes "no credential is ever persisted" a structural guarantee. #386.
const ORIGIN_REF_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$|^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * #386: origin_ref must be a UUID or ULID. Enforced at the storage write
 * boundary so no caller can persist a credential (no credential matches these
 * formats). origin_ref is currently never set by any adapter — this is pure
 * future-proofing of the "no secret in SQLite" invariant.
 */
export function validateOriginRef(ref: string): void {
  if (!ORIGIN_REF_RE.test(ref)) {
    throw new Error(
      "Invalid origin_ref: must be a UUID or ULID (explicit opaque-ID format). " +
        "Arbitrary strings, paths, and credential-like values are rejected so no secret can be persisted.",
    );
  }
}

/**
 * #386: Defense-in-depth for the READ path. The display value is ALWAYS digested
 * to a short hash — never the raw ref — so that even a value inserted by a
 * direct-DB bypass (skipping validateOriginRef) can never leak via display. The
 * digest is stable (same ref → same digest) so it stays correlatable within a
 * session without echoing content.
 */
export function redactOriginRefForDisplay(ref: string | null): string | null {
  if (ref == null) return null;
  return createHash("sha256").update(ref, "utf8").digest("hex").slice(0, 12);
}

/**
 * Raised when an append-only row already exists with DIFFERENT attribution —
 * re-attribution is refused (unforgable). A row with identical content is an
 * idempotent retry (no error). Message excludes origin_ref (could be sensitive).
 */
export class PageWriteProvenanceConflictError extends Error {
  readonly slug: string;
  readonly existing: { write_mode: string; actor_class: string; creation_reason: string };
  readonly attempted: { write_mode: string; actor_class: string; creation_reason: string };
  constructor(
    slug: string,
    existing: { write_mode: string; actor_class: string; creation_reason: string },
    attempted: { write_mode: string; actor_class: string; creation_reason: string },
  ) {
    super(
      `page_write_provenance conflict for ${slug}: append-only row exists ` +
        `(${existing.actor_class}/${existing.write_mode}/${existing.creation_reason}), ` +
        `refusing re-attribution to (${attempted.actor_class}/${attempted.write_mode}/${attempted.creation_reason})`,
    );
    this.name = "PageWriteProvenanceConflictError";
    this.slug = slug;
    this.existing = existing;
    this.attempted = attempted;
  }
}
