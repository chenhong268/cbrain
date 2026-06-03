/**
 * Shared validation limits for MCP tool string parameters.
 *
 * Centralising these avoids magic numbers and ensures consistency
 * across all 21+ tool files.
 */

// --- Slug identifiers (page/entity slugs, aliases, type names) ---
export const SLUG_MAX = 500;

// --- Search / recall / research queries ---
export const QUERY_MAX = 1000;

// --- Full content payloads (ingest, put_page, append_page) ---
export const CONTENT_MAX = 500_000;

// --- Short context / annotation strings ---
export const CONTEXT_MAX = 10_000;

// --- Relation types (提及, 属于, etc.) ---
export const RELATION_MAX = 100;

// --- Session identifiers ---
export const SESSION_ID_MAX = 200;

// --- Page / entity titles ---
export const TITLE_MAX = 500;

// --- Tags ---
export const TAG_MAX = 200;

// --- Summary / event descriptions ---
export const SUMMARY_MAX = 2000;

// --- Evidence / note text ---
export const NOTE_MAX = 10_000;

// --- Job names ---
export const JOB_NAME_MAX = 200;

// --- Excerpt text ---
export const EXCERPT_MAX = 10_000;

// --- Reason text ---
export const REASON_MAX = 2000;

// --- Profile entry content ---
export const PROFILE_CONTENT_MAX = 50_000;
