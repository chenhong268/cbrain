/**
 * MCP tool surface profiles (#251).
 *
 * A profile is an EXPOSURE-LAYER filter only. It never deletes, renames, merges,
 * or rewrites tool handlers. Filtering happens in attachMcpTools at registration
 * time (see src/mcp/server.ts). `full` is the no-op profile = current behavior.
 *
 * Resolution (Phase 1): env CBRAIN_MCP_TOOL_PROFILE > "full". Config-file support
 * is intentionally deferred — add it later as a typed CBrainConfig field, not a cast.
 * Invalid values fail fast so a misconfigured runtime does not silently ship a
 * partial tool surface (which would break e.g. the maintenance cron on /mcp).
 */

export type ToolProfile = "agent" | "maintenance" | "debug" | "full";

export const TOOL_PROFILES = ["agent", "maintenance", "debug", "full"] as const;

/**
 * Canonical HTTP header name for per-session tool-profile selection (#260, #264).
 * The wire lookup in src/http/session-profile.ts lowercases this; MCP clients
 * (`cbrain mcp-config --http`, bin/cbrain-maintenance.sh) emit it verbatim.
 */
export const TOOL_PROFILE_HEADER = "X-CBrain-Tool-Profile";

const VALID_PROFILES: ReadonlySet<ToolProfile> = new Set(TOOL_PROFILES);

/**
 * Bounded, user-facing surface for daily Agents (Hermes etc.).
 * Deliberately excludes low-level search (query, get_chunks), all admin/ops
 * tools (dream_*, sync, health, watcher_quarantine, relation_audit), all job_*
 * tools, and provenance tools.
 */
const AGENT_ALLOWLIST = [
  "cbrain_recall",
  "deep_recall",
  "recall_episode",
  "ingest",
  "ingest_dialogue",
  "get_page",
  "get_pages",
  "put_page",
  "append_page",
  "resolve_slugs",
  "get_org_tree",
  "graph_query",
  "get_timeline",
  "read_discoveries",
  "update_discovery_status",
  "find_similar_entities",
  "merge_entities",
  "get_profile",
  "read_project_state",
  "status",
] as const;

/**
 * Operational/admin surface for cron + patrol. The maintenance wrapper calls
 * `dream` over HTTP /mcp, and patrol health-checks over /mcp, so this profile
 * MUST keep dream_*, sync, health, job_* reachable.
 */
const MAINTENANCE_ALLOWLIST = [
  "status",
  "health",
  "dream",
  "dream_status",
  "dream_reset",
  "sync",
  "remove_orphans",
  "watcher_quarantine",
  "generate_indexes",
  "enrich",
  "writeback",
  "relation_audit",
  "job",
  "job_submit",
  "job_list",
  "job_status",
  "job_cancel",
  "job_retry",
  "read_knowledge_map",
  "run_action_candidates",
  "read_action_candidates",
  "update_action_candidate_status",
  "wakeup_diff",
  "batch_delete_pages",
  "batch_add_links",
  "batch_merge_pages",
] as const;

/**
 * Low-level inspection surface for debugging. Raw search, chunk/page listing,
 * provenance, and add/remove helpers. Excludes the high-level recall frontdoor
 * and ingest write paths on purpose.
 */
const DEBUG_ALLOWLIST = [
  "query",
  "get_chunks",
  "list_pages",
  "get_page",
  "get_pages",
  "get_links",
  "link",
  "get_tags",
  "tag",
  "timeline",
  "alias",
  "get_versions",
  "get_ingest_log",
  "get_provenance",
  "set_trust_state",
  "confirm_evidence",
  "profile",
  "add_link",
  "remove_link",
  "add_tag",
  "remove_tag",
  "add_alias",
  "remove_alias",
] as const;

export const TOOL_PROFILE_ALLOWLISTS: Record<Exclude<ToolProfile, "full">, readonly string[]> = {
  agent: AGENT_ALLOWLIST,
  maintenance: MAINTENANCE_ALLOWLIST,
  debug: DEBUG_ALLOWLIST,
};

function normalize(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "" ? undefined : v;
}

/** Three-state parse: absent (no signal) / ok (valid) / invalid (fail-fast).
 *  Shared by env resolution (throwing) and HTTP per-session resolution
 *  (non-throwing, #260). `null` and `undefined` both mean "no signal". */
export type ProfileParseResult =
  | { kind: "absent" }
  | { kind: "ok"; profile: ToolProfile }
  | { kind: "invalid"; raw: string };

export function parseToolProfile(raw: string | null | undefined): ProfileParseResult {
  const normalized = normalize(raw ?? undefined);
  if (normalized === undefined) return { kind: "absent" };
  if (VALID_PROFILES.has(normalized as ToolProfile)) {
    return { kind: "ok", profile: normalized as ToolProfile };
  }
  return { kind: "invalid", raw: normalized };
}

/** Resolve profile from env. Undefined/empty → "full". Invalid → throw (fail fast). */
export function resolveToolProfile(env?: string): ToolProfile {
  const parsed = parseToolProfile(env);
  if (parsed.kind === "absent") return "full";
  if (parsed.kind === "invalid") {
    throw new Error(
      `Invalid CBRAIN_MCP_TOOL_PROFILE=${JSON.stringify(parsed.raw)}. ` +
        `Expected one of: ${TOOL_PROFILES.join(", ")}.`,
    );
  }
  return parsed.profile;
}

/** `full` allows everything; otherwise the name must be in the profile allowlist. */
export function isToolAllowedForProfile(name: string, profile: ToolProfile): boolean {
  if (profile === "full") return true;
  return TOOL_PROFILE_ALLOWLISTS[profile].includes(name);
}
