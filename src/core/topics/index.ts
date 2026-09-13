/**
 * #509 Task 1 — bounded topic compiler. Narrow public surface for later
 * tasks (discovery, job scheduling, recall integration): everything else is
 * module-internal.
 */
export { TopicManager } from "./manager.js";
export {
  DEFAULT_TOPIC_BUDGETS,
  TOPIC_PAGE_TYPE,
  TOPIC_SCHEMA_VERSION,
  TopicIndexFailedError,
  TopicRollbackError,
  TopicSourceReadError,
} from "./types.js";
export type {
  TopicBudgets,
  TopicClaim,
  TopicClaimKind,
  TopicCompileRequest,
  TopicCompileResult,
  TopicFreshnessReport,
  TopicManifest,
  TopicManagerDeps,
  TopicModelOutput,
  TopicRetiredSource,
  TopicSourceCatalogEntry,
  TopicSourceSnapshot,
} from "./types.js";
