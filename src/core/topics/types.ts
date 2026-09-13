import type { CBrainDB } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "../ingestion/pipeline.js";
import type { VersionManager } from "../version.js";
import type { LanceDBManager } from "../../storage/lancedb.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { Logger } from "../logger.js";

/** Ontology page type for generated source-backed topic pages (#509). */
export const TOPIC_PAGE_TYPE = "topic";

/** Frontmatter manifest schema version persisted on every topic page. */
export const TOPIC_SCHEMA_VERSION = 1;

/** Hard bounds for topic compilation. Oversize inputs are rejected, never truncated. */
export interface TopicBudgets {
  /** Distinct record sources per topic (upper bound). */
  maxSourcesPerTopic: number;
  /** Distinct valid record sources required to CREATE a new topic. */
  minNewTopicSources: number;
  /** Total source material characters sent to the model. */
  maxTotalMaterialChars: number;
  /** Governance FACTS offered to the model per source. Bounds the prompt
   *  only — the governance fingerprint always covers every relevant row. */
  maxPromptFactsPerSource: number;
  maxOverviewClaims: number;
  maxObservations: number;
  maxDetails: number;
  maxOpenQuestions: number;
  maxItemChars: number;
  maxQuoteChars: number;
}

export const DEFAULT_TOPIC_BUDGETS: TopicBudgets = {
  maxSourcesPerTopic: 12,
  minNewTopicSources: 3,
  maxTotalMaterialChars: 150_000,
  maxPromptFactsPerSource: 50,
  maxOverviewClaims: 3,
  maxObservations: 12,
  maxDetails: 16,
  maxOpenQuestions: 8,
  maxItemChars: 600,
  maxQuoteChars: 280,
};

/** Claim labels distinguish what a source says from what the user thinks or
 *  suspects. A model may label, but never promote a claim to a trust state. */
export type TopicClaimKind = "observation" | "user_thought" | "candidate";

/** Untrusted model-output claim. Every claim — including every overview
 *  assertion — must cite one selected source with an exact excerpt from that
 *  source's current body. */
export interface TopicClaim {
  text: string;
  kind: TopicClaimKind;
  sourceSlug: string;
  quote: string;
}

/** Raw (untrusted) structured model output before validation. Overview is a
 *  bounded claim array: there is no uncited free-text summary section. */
export interface TopicModelOutput {
  overview: TopicClaim[];
  observations: TopicClaim[];
  details: TopicClaim[];
  open_questions: TopicClaim[];
}

/** One governance link row touching a source (endpoint or provenance
 *  origin), captured with its trust state and provenance fields. */
export interface TopicGovernanceLink {
  id: number;
  direction: "out" | "in" | "provenance";
  fromSlug: string;
  toSlug: string;
  relation: string;
  trustState: string | null;
  sourceType: string | null;
  sourcePageSlug: string | null;
  evidence: string | null;
  context: string | null;
  confidence: number;
  active: boolean;
}

export interface TopicGovernanceTimeline {
  id: number;
  eventDate: string | null;
  summary: string;
  trustState: string | null;
  source: string | null;
  sourcePageSlug: string | null;
  evidence: string | null;
}

export interface TopicGovernanceProvenance {
  writeMode: string;
  actorClass: string;
  creationReason: string;
  originKind: string | null;
}

/** Governance state of a source page: every link/timeline row touching it
 *  (endpoint OR source_page_slug) plus tags and write provenance. Hashed in
 *  full into the freshness fingerprint — never truncated. */
export interface TopicSourceGovernance {
  tags: string[];
  links: TopicGovernanceLink[];
  timeline: TopicGovernanceTimeline[];
  provenance: TopicGovernanceProvenance | null;
}

/** A source fact that is still usable as compile material: active, and not
 *  derived (NER) or unconfirmed (candidate). Rejected/superseded rows
 *  disqualify the ENTIRE source (see TopicSourceSnapshot.disqualified);
 *  candidates stay in the fingerprint but never reach the model. */
export interface TopicUsableFact {
  kind: "link" | "timeline";
  text: string;
  eventDate: string | null;
  trustState: string | null;
}

/** Fresh disk read of one record source, taken at compile time.
 *  `disqualified` marks a source conservatively unusable for synthesis: a
 *  relevant governance row (link or timeline, endpoint or provenance) is
 *  rejected/superseded, so its raw body may restate a user correction. */
export interface TopicSourceSnapshot {
  slug: string;
  title: string;
  filePath: string;
  contentHash: string;
  bodyHash: string;
  body: string;
  governanceHash: string;
  governance: TopicSourceGovernance;
  usableFacts: TopicUsableFact[];
  disqualified: "governance_rejected" | null;
}

/** Stable per-source identity persisted in the manifest. */
export interface TopicManifestSource {
  slug: string;
  title: string;
  snapshot_id: string;
  content_hash: string;
  body_hash: string;
  governance_hash: string;
}

/** A source removed from the selection on refresh. Kept — with its last known
 *  snapshot — for recovery/reconciliation; never silently dropped. */
export interface TopicRetiredSource extends TopicManifestSource {
  retired_at: string;
}

/** Topic-owned durable publication proof. `pending` is written BEFORE the
 *  indexes; only after index success + source/target/cancellation checks
 *  does the compile synchronously flip it to `committed`. A clean pipeline
 *  content hash alone cannot certify a pending topic, and a crash-left
 *  pending topic stays unavailable after restart. */
export type TopicPublicationState = "pending" | "committed";

/** Stable seed identity of a managed topic (#510 Task 2): which tag or
 *  entity/concept page discovery created it from. Persisted in the manifest
 *  so scheduled maintenance re-derives the SAME selection instead of
 *  re-ranking. `key` is `tag:<tag>` / `entity:<slug>`. */
export interface TopicSeed {
  kind: "tag" | "entity";
  key: string;
}

/** Versioned manifest persisted in the topic page frontmatter under `topic`. */
export interface TopicManifest {
  schema_version: number;
  title: string;
  generated_at: string;
  output_hash: string;
  /** Missing (legacy/corrupt) parses as "pending" — fail closed. */
  state: TopicPublicationState;
  sources: TopicManifestSource[];
  retired_sources: TopicRetiredSource[];
  /** #510 Task 2: seed identity for scheduled maintenance (optional — Task 1
   *  manifests and direct compiles have none; selection is then retained
   *  as-is). */
  seed?: TopicSeed;
  /** #510 Task 2: DB record-catalog fingerprint this topic was last
   *  reconciled against. A mismatch only means "needs reconciliation", never
   *  per-topic invalidity — the per-source checks above decide that. */
  catalog?: string;
}

/** Read-only catalog entry for one eligible original-record source. */
export interface TopicSourceCatalogEntry {
  slug: string;
  title: string;
  updatedAt: string;
  contentHash: string;
  bodyChars: number;
  tags: string[];
  actorClass: string | null;
  originKind: string | null;
  activeLinks: number;
  timelineEntries: number;
}

export type TopicBlockReason =
  | "invalid_title"
  | "too_few_sources"
  | "too_many_sources"
  | "source_not_found"
  | "source_not_record"
  | "source_governance_rejected"
  | "title_conflict"
  | "material_over_budget"
  | "target_edited"
  | "target_changed_during_compile"
  | "source_changed_during_compile"
  | "zero_valid_sources"
  | "output_invalid";

export type TopicCompileResult =
  | { status: "created"; slug: string; sources: number; chunks: number }
  | { status: "refreshed"; slug: string; sources: number; chunks: number; droppedSources: string[] }
  | { status: "unchanged"; slug: string }
  | { status: "blocked"; slug?: string; reason: TopicBlockReason; detail?: string };

export interface TopicFreshnessReport {
  slug: string;
  state: "fresh" | "stale" | "invalid";
  generatedAt: string | null;
  editedByUser: boolean;
  reasons: string[];
  sources: Array<{ slug: string; ok: boolean; reason?: string }>;
  /** #511: manifest carries a Task 2 record-catalog attestation. Present only
   *  when attested; a mismatch adds `catalog_changed` to reasons and blocks
   *  READS, but never flips `state` (maintenance reattestation stays
   *  eligible without the model). */
  catalogAttested?: boolean;
  catalogChanged?: boolean;
}

export interface TopicCompileRequest {
  title: string;
  sourceSlugs: string[];
  /** Cooperative cancellation; checked before the model call, after it, and
   *  immediately before commit. Also forwarded to the LLM provider. */
  signal?: AbortSignal;
  checkCancelled?: () => void;
  /** #510 Task 2: seed identity persisted into the manifest so scheduled
   *  maintenance preserves the selection. */
  seed?: TopicSeed;
  /** #510 Task 2: catalog fingerprint attested in the manifest at compile
   *  time. */
  catalogFingerprint?: string;
}

export interface TopicManagerDeps {
  db: CBrainDB;
  pages: PageManager;
  pipeline: ContentPipeline;
  versions: VersionManager;
  lance: LanceDBManager;
  llm: LLMProvider;
  logger?: Logger;
  budgets?: Partial<TopicBudgets>;
}

/** Index write failed AFTER the page mutated, but the deterministic
 *  compensation fully restored the previous state. Safe to retry. */
export class TopicIndexFailedError extends Error {
  constructor(original: unknown) {
    const message = original instanceof Error ? original.message : String(original);
    super(`TOPIC_INDEX_FAILED: indexing failed, previous topic content restored. cause=${message}`);
    this.name = "TopicIndexFailedError";
  }
}

/** Index write failed AND the compensation could not fully restore the
 *  previous state. Manual reindex/repair is required. */
export class TopicRollbackError extends Error {
  readonly originalError: Error;
  readonly rollbackErrors: Error[];

  constructor(original: unknown, rollbackErrors: Error[]) {
    const orig = original instanceof Error ? original : new Error(String(original));
    const details = rollbackErrors.map((e) => e.message).join("; ");
    super(`TOPIC_ROLLBACK_INCOMPLETE: original=${orig.message}; rollback failures=[${details}]; reindex required`);
    this.name = "TopicRollbackError";
    this.originalError = orig;
    this.rollbackErrors = rollbackErrors;
  }
}

/** A source could not be read as an original record. */
export class TopicSourceReadError extends Error {
  readonly code: "not_found" | "not_record" | "path_unsafe";

  constructor(code: "not_found" | "not_record" | "path_unsafe", slug: string) {
    super(`TOPIC_SOURCE_${code.toUpperCase()}: ${slug}`);
    this.name = "TopicSourceReadError";
    this.code = code;
  }
}
