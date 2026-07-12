import { assertSafeActionDisplay } from "../safety/display-safety.js";
import { checkIntegrity } from "./integrity.js";
import { recomputeAndPersistFreshness } from "./freshness.js";
import { ontologyHash } from "./ontology.js";
import { policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";
const FALLBACK_REASON = "有一项建议需要人工复核。";

/** Run the L1 display guard; fall back on any match (never leak internal/credential text). */
function safe(text: string, fallback: string): string {
  try {
    assertSafeActionDisplay(text);
    return text;
  } catch {
    return fallback;
  }
}

function projectDisplay(rec: RecommendationRecord, resolveSafeTitle: (slug: string) => string): { blocked: true } | { blocked: false; target_display: string; reason: string } {
  const active = rec.lifecycle_status === "pending" || rec.lifecycle_status === "current";
  if (!active || rec.freshness_status !== "fresh") return { blocked: true };
  const c = rec.payload.conclusion;
  if (c.kind === "abstain") return { blocked: false, target_display: FALLBACK_DISPLAY, reason: safe(`abstain: ${c.reason}`, FALLBACK_REASON) };
  const slug = c.action.target_ref.split(":").pop() ?? c.action.target_ref;
  return { blocked: false, target_display: safe(resolveSafeTitle(slug) || FALLBACK_DISPLAY, FALLBACK_DISPLAY), reason: safe(c.action.reason, FALLBACK_REASON) };
}

export interface DisplayCtx {
  store: RecommendationStore;
  reader: DeclaredProjectionReader;
  registry: VersionedRuleRegistry;
  now: string;
}

export type DisplayOutcome =
  | { blocked: true; reason: "not_found" | "integrity_failed" | "not_active_fresh" }
  | { blocked: false; target_display: string; reason: string };

/**
 * Sole public display entry (spec §4.4, §5.3, §11.3; rev7 M2b). Hard-depends on production
 * ontologyHash()/policyHash() (no seam), forcing integrity + freshness on every read:
 *   1. integrity check (fingerprint + cross-consistency) — catches tampering
 *   2. recompute freshness from current policy/ontology + version-pinned captureInputs,
 *      persisting freshness_status (the metadata check here is what blocks a record whose
 *      fingerprint is self-consistent but whose producer.code_hash was swapped — integrity cannot)
 *   3. gate on lifecycle ∈ {pending,current} AND freshness == fresh, then project through the
 *      #327 display guard so unsafe text degrades to a generic fallback instead of leaking.
 */
export function loadAndProjectDisplay(recordId: string, ctx: DisplayCtx, resolveSafeTitle: (slug: string) => string): DisplayOutcome {
  const rec = ctx.store.getById(recordId);
  if (!rec) return { blocked: true, reason: "not_found" };
  if (!checkIntegrity(rec).ok) return { blocked: true, reason: "integrity_failed" };
  const current = { policy_version: policyHash(ctx.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };
  recomputeAndPersistFreshness(rec, ctx.reader, ctx.registry, ctx.store, current, ctx.now);
  const reloaded = ctx.store.getById(recordId);
  if (!reloaded) return { blocked: true, reason: "not_found" };
  const out = projectDisplay(reloaded, resolveSafeTitle);
  return out.blocked ? { blocked: true, reason: "not_active_fresh" } : { blocked: false, target_display: out.target_display, reason: out.reason };
}
