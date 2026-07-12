import { sha256Hex } from "./canonical.js";
import type { VersionedRuleRegistry } from "./registry.js";

/** Policy version = hash of the registry's active-only policyManifest (spec §7.2). Adding or
 *  cleaning INACTIVE stock does not change it; only setActive / tombstone-of-active do. */
export function policyHash(registry: VersionedRuleRegistry): string {
  return sha256Hex(registry.policyManifest());
}
