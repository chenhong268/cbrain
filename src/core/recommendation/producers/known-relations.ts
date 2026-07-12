import type { RuleDefinition } from "../types.js";

/**
 * Reference producer (spec §4.3, §7.2): the maintenance.known_relations rule.
 * Surfaces reports_to edges still in the `candidate` trust state and proposes a dry_run review.
 * This is the Phase 1 vertical slice; fsck/discovery/action-candidate producers are out of scope.
 */
export const KNOWN_RELATIONS_DEF: RuleDefinition = {
  rule_id: "health:known_relations",
  rule_version: "1.0.0",
  registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
  readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
  candidateTrustState: "candidate",
  evidenceSource: "health",
  evidenceRefTemplate: "health:known_relations:{from}:{to}",
  abstainReason: "insufficient_evidence",
  propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "存在待确认的汇报关系候选边，建议人工复核" },
};
