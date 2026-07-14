export const NER_BACKFILL_JOB = "ner-backfill";
export const ZERO_LINK_REPAIR_NAME = "zero-link-rich-records";
export const ZERO_LINK_REPAIR_VERSION = 1;
export const ZERO_LINK_BATCH_MANIFEST_JOB = "zero-link-backfill-batch";

export type NerSourceKind = "vault_hash" | "raw_chunks";

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
    | "source_unavailable";
  jobId: number | null;
  pending: boolean;
}

