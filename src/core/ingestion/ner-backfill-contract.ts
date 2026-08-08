export const NER_BACKFILL_JOB = "ner-backfill";
export const ZERO_LINK_REPAIR_NAME = "zero-link-rich-records";
export const ZERO_LINK_REPAIR_VERSION = 1;
export const ZERO_LINK_BATCH_MANIFEST_JOB = "zero-link-backfill-batch";

export type NerSourceKind = "vault_hash" | "raw_chunks";

export interface NerFingerprint {
  fingerprint: string;
  sourceKind: NerSourceKind;
}

export interface ZeroLinkRepairMarker {
  name: typeof ZERO_LINK_REPAIR_NAME;
  version: typeof ZERO_LINK_REPAIR_VERSION;
  contentFingerprint: string;
  sourceKind: NerSourceKind;
  batchId: string;
}

export interface FingerprintedNerJob {
  slug: string;
  kind: "ner";
  sourceFingerprint: string;
  sourceKind: NerSourceKind;
  repair?: ZeroLinkRepairMarker;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DERIVED_FINGERPRINT_RE = /^derived:[0-9a-f]{64}$/;

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The single accepted identity grammar for frozen NER sources. A supplied
 * source kind is a declaration, not a hint: it must agree with the prefix.
 */
export function parseNerFingerprint(
  value: unknown,
  declaredSourceKind?: unknown,
): NerFingerprint | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const sourceKind = value.startsWith("page:") && value.length > "page:".length
    ? "vault_hash"
    : DERIVED_FINGERPRINT_RE.test(value)
      ? "raw_chunks"
      : null;
  if (!sourceKind) return null;
  if (declaredSourceKind !== undefined && declaredSourceKind !== sourceKind) return null;
  return { fingerprint: value, sourceKind };
}

/** Parse the closed repair marker persisted in a zero-link NER job. */
export function parseZeroLinkRepairMarker(value: unknown): ZeroLinkRepairMarker | null {
  const repair = objectValue(value);
  if (!repair || JSON.stringify(Object.keys(repair).sort()) !== JSON.stringify([
    "batchId",
    "contentFingerprint",
    "name",
    "sourceKind",
    "version",
  ])) return null;
  if (repair.name !== ZERO_LINK_REPAIR_NAME || repair.version !== ZERO_LINK_REPAIR_VERSION ||
    typeof repair.batchId !== "string" || !UUID_RE.test(repair.batchId)) return null;
  const fingerprint = parseNerFingerprint(repair.contentFingerprint, repair.sourceKind);
  if (!fingerprint) return null;
  return {
    name: ZERO_LINK_REPAIR_NAME,
    version: ZERO_LINK_REPAIR_VERSION,
    batchId: repair.batchId,
    contentFingerprint: fingerprint.fingerprint,
    sourceKind: fingerprint.sourceKind,
  };
}

/**
 * Parse a non-legacy frozen NER identity. Repair and ordinary fingerprint
 * fields cannot disagree: accepting either would make queue, claim, and run
 * boundaries observe a different source epoch.
 */
export function parseFingerprintedNerJob(data: Record<string, unknown>): FingerprintedNerJob | null {
  if ((data.kind !== undefined && data.kind !== "ner") ||
    typeof data.slug !== "string" || !data.slug.trim()) return null;
  const repair = data.repair === undefined ? undefined : parseZeroLinkRepairMarker(data.repair);
  if (data.repair !== undefined && !repair) return null;
  const rawFingerprint = data.sourceFingerprint;
  const rawSourceKind = data.sourceKind;
  if (rawFingerprint !== undefined && typeof rawFingerprint !== "string") return null;
  const parsedRaw = rawFingerprint === undefined
    ? null
    : parseNerFingerprint(rawFingerprint, rawSourceKind);
  if (rawFingerprint !== undefined && !parsedRaw) return null;
  if (!repair && !parsedRaw) return null;
  if (repair && parsedRaw && repair.contentFingerprint !== parsedRaw.fingerprint) return null;
  const fingerprint = repair
    ? { fingerprint: repair.contentFingerprint, sourceKind: repair.sourceKind }
    : parsedRaw!;
  return {
    slug: data.slug,
    kind: "ner",
    sourceFingerprint: fingerprint.fingerprint,
    sourceKind: fingerprint.sourceKind,
    ...(repair ? { repair } : {}),
  };
}

export type ZeroLinkDisposition =
  | "new"
  | "legacy_requeue"
  | "content_changed_requeue"
  | "stale_requeue"
  | "active"
  | "cancelled"
  | "resolved"
  | "terminal_no_graph_links"
  | "blocked_source_unavailable"
  | "source_changed"
  | "invalid_terminal"
  | "commit_unknown"
  | "lost_link"
  | "unverifiable_fingerprint"
  | "failed";

export type InternalJobDisposition =
  | ZeroLinkDisposition
  | "ordinary_transition_pair_fresh"
  | "ordinary_transition_pair_stale";

export interface AttemptLease {
  version: 1;
  token: string;
  phase: "claimed" | "committing";
}

export interface DeferredNerSubmitResult {
  disposition:
    | "inserted"
    | "existing_active"
    | "already_processed"
    | "superseded_pending"
    | "successor_pending"
    | "rejected";
  jobId: number | null;
  pending: boolean;
}
