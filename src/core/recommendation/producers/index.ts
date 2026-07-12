import type { VersionedRuleRegistry } from "../registry.js";
import type { RuleDefinition } from "../types.js";
import { KNOWN_RELATIONS_DEF } from "./known-relations.js";

/** Register an arbitrary versioned def (used by tests + future upgrade flows). */
export function registerVersion(reg: VersionedRuleRegistry, def: RuleDefinition): void {
  reg.register(def);
}

/** Register the Phase 1 maintenance producers and mark each active. */
export function registerMaintenanceProducers(reg: VersionedRuleRegistry): void {
  reg.register(KNOWN_RELATIONS_DEF);
  reg.setActive(KNOWN_RELATIONS_DEF.rule_id, KNOWN_RELATIONS_DEF.rule_version);
}
