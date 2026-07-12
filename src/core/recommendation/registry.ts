import { assertJsonSafe, canonicalJson } from "./canonical.js";
import { runRule } from "./rule-runtime.js";
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer, RuleDefinition } from "./types.js";

/**
 * The runnable face of a registered rule. Carries ONLY the behavior surface
 * (code_hash + the two pure functions). Producer IDENTITY (rule_id/version/registry_ref)
 * lives on `def` and is sourced from there by directory()/policyManifest()/manager/freshness —
 * the runner never needs to echo it, so RuleRunner does not extend RecommendationProducer. */
export interface RuleRunner {
  code_hash: string;
  captureInputs: (projection: unknown) => DecisionInputs;
  decide: (di: DecisionInputs) => RecommendationConclusion;
}

export type ResolveResult =
  | ({ status: "ok"; runner: RuleRunner; def: RuleDefinition })
  | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };

interface LiveEntry {
  def: RuleDefinition;
  runner: RuleRunner;
}

interface Tombstone {
  tombstone: "purged" | "incompatible";
  code_hash: string;
}

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object") {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}

/** Snapshot a def: validate JSON-safe, deep-clone, deep-freeze. The clone severs the caller's
 *  reference so post-register mutation of the ORIGINAL cannot change replay behavior, code_hash,
 *  or policyManifest (rev7 HIGH 2 attack). */
function snapshotDef(def: RuleDefinition): RuleDefinition {
  assertJsonSafe(def);
  return deepFreeze(JSON.parse(JSON.stringify(def)) as RuleDefinition);
}

/** rev8 MED 1: canonical content equivalence replaces the unreachable `ex.def === def` identity check. */
function sameDefinition(a: RuleDefinition, b: RuleDefinition): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export class VersionedRuleRegistry {
  private live = new Map<string, LiveEntry>();
  private tombstones = new Map<string, Tombstone>();
  private activeVersion = new Map<string, string>();
  private refOwner = new Map<string, string>(); // registry_ref -> key (rev8 MED 2: locator uniqueness)

  private key(id: string, ver: string): string {
    return `${id}@${ver}`;
  }

  register(def: RuleDefinition): void {
    const k = this.key(def.rule_id, def.rule_version);
    // MED 2: a registry_ref (locator) must not bind two different (rule_id, rule_version) keys.
    const owner = this.refOwner.get(def.registry_ref);
    if (owner !== undefined && owner !== k) throw new Error(`registry: registry_ref '${def.registry_ref}' already bound to ${owner}`);
    const ex = this.live.get(k);
    if (ex) {
      // MED 1: canonical equivalence, not object identity. Same content => no-op; different => fail-closed.
      if (sameDefinition(ex.def, def)) return;
      throw new Error(`registry: ${k} already registered with a different definition`);
    }
    if (this.tombstones.has(k)) throw new Error(`registry: ${k} is tombstoned`);
    const frozen = snapshotDef(def);
    this.refOwner.set(def.registry_ref, k);
    this.live.set(k, { def: frozen, runner: runRule(frozen) });
  }

  setActive(id: string, ver: string): void {
    const k = this.key(id, ver);
    if (!this.live.has(k)) throw new Error(`registry: setActive target ${k} not a live runner`);
    this.activeVersion.set(id, ver);
  }

  /** rev8 HIGH 1 + rev9 HIGH: tombstone identity derives ONLY from a live entry.
   *  - Unknown key (no live, no existing tombstone) => throw.
   *  - Same-state repeat => idempotent no-op (keep original hash).
   *  - Different-state overwrite => throw.
   *  - rev9: purge refuses the active version (retention cleanup must switch first); but
   *    incompatible is a SAFETY SHUTDOWN — an active runner confirmed incompatible MUST be taken
   *    offline immediately, clearing active so resolveActive -> unavailable and the manager fail-closes. */
  private tombstone(id: string, ver: string, to: "purged" | "incompatible"): void {
    const k = this.key(id, ver);
    if (this.live.has(k)) {
      const isActive = this.activeVersion.get(id) === ver;
      if (to === "purged" && isActive) throw new Error(`registry: cannot purge active ${id}@${ver}; setActive another first`);
      if (isActive) this.activeVersion.delete(id); // incompatible active: clear so resolveActive -> unavailable
      const code_hash = this.live.get(k)!.runner.code_hash;
      this.live.delete(k);
      this.tombstones.set(k, { tombstone: to, code_hash });
      return;
    }
    const existing = this.tombstones.get(k);
    if (!existing) throw new Error(`registry: cannot ${to} ${id}@${ver}: no live entry and no existing tombstone`);
    if (existing.tombstone === to) return; // idempotent — original hash preserved
    throw new Error(`registry: cannot ${to} ${id}@${ver}: already ${existing.tombstone}`);
  }

  markPurged(id: string, ver: string): void {
    this.tombstone(id, ver, "purged");
  }

  markIncompatible(id: string, ver: string): void {
    this.tombstone(id, ver, "incompatible");
  }

  resolve(id: string, ver: string): ResolveResult {
    const k = this.key(id, ver);
    const e = this.live.get(k);
    if (e) return { status: "ok", runner: e.runner, def: e.def };
    const t = this.tombstones.get(k);
    if (t) return { status: "unavailable", reason: t.tombstone };
    return { status: "unavailable", reason: "unknown" };
  }

  resolveActive(id: string): ResolveResult {
    const v = this.activeVersion.get(id);
    if (v === undefined) return { status: "unavailable", reason: "unknown" };
    return this.resolve(id, v);
  }

  /** Active producers only (for manager.directory / display metadata). */
  directory(): RecommendationProducer[] {
    return [...this.activeVersion.entries()]
      .map(([id, ver]) => {
        const e = this.live.get(this.key(id, ver));
        return e ? { rule_id: e.def.rule_id, rule_version: e.def.rule_version, code_hash: e.runner.code_hash, registry_ref: e.def.registry_ref } : null;
      })
      .filter((x): x is RecommendationProducer => x !== null);
  }

  /** Policy = active versions only. Adding/cleaning inactive stock does NOT change this (rev7 HIGH 1). */
  policyManifest(): string {
    return [...this.activeVersion.entries()]
      .map(([id, ver]) => {
        const e = this.live.get(this.key(id, ver))!;
        return `active:${id}:${ver}:${e.runner.code_hash}:${e.def.registry_ref}`;
      })
      .sort()
      .join("\n");
  }

  /** Full audit: live + tombstones + active mappings (derived-hash tombestones included). */
  registryAuditManifest(): string {
    const lines: string[] = [];
    for (const [k, e] of this.live) lines.push(`${k}:live:${e.runner.code_hash}`);
    for (const [k, t] of this.tombstones) lines.push(`${k}:${t.tombstone}:${t.code_hash}`);
    for (const [id, ver] of this.activeVersion) lines.push(`active:${id}:${ver}`);
    return lines.sort().join("\n");
  }
}
