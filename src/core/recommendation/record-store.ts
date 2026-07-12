import { canonicalJson } from "./canonical.js";
import { checkIntegrity, computeFingerprint, computeInputsHash, normalizePayloadProse } from "./integrity.js";
import { SUPPRESSION_REOPENED, defaultSuppressedUntil, validateTimestamp } from "./policy.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FreshnessStatus, LifecycleStatus, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

interface Row {
  record_id: string;
  maintenance_key: string;
  fingerprint: string;
  inputs_hash: string;
  payload: string;
  created_at: string;
  last_revalidated_at: string;
  lifecycle_status: string;
  freshness_status: string;
  suppressed_until: string | null;
}

/** Monotonic lifecycle transitions (spec §5.2). Terminals cannot regress; no freshness mixed in. */
const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  pending: ["current", "superseded", "rejected", "invalidated"],
  current: ["superseded", "rejected", "invalidated"],
  superseded: ["invalidated"],
  rejected: ["invalidated"],
  invalidated: [],
};

export class RecommendationStore {
  /** CBrainDB.prepare is private; all SQL goes through the public rawDb getter (sqlite.ts:167).
   *  CBrainDB.transaction (sqlite.ts:583) is public and auto-invokes fn — no trailing (). */
  constructor(private db: CBrainDB) {}

  activeCountFor(key: string): number {
    return (this.db.rawDb.prepare("SELECT COUNT(*) c FROM recommendation_records WHERE maintenance_key=$key AND lifecycle_status IN ('pending','current')").get({ $key: key }) as { c: number }).c;
  }

  getById(id: string): RecommendationRecord | null {
    const r = this.db.rawDb.prepare("SELECT * FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  createRecord(payload: RecommendationImmutablePayload, now: string): RecommendationRecord {
    validateTimestamp(now, "now");
    if (payload.applicability.auto_execute !== false) throw new Error("record-store: auto_execute must be false");
    const withHash: RecommendationImmutablePayload = { ...payload, inputs_hash: computeInputsHash(payload.decision_inputs) };
    const normalized = normalizePayloadProse(withHash);
    const fingerprint = computeFingerprint(normalized);
    const provisional: RecommendationRecord = { record_id: globalThis.crypto.randomUUID(), payload: normalized, fingerprint, created_at: now, last_revalidated_at: now, lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
    const integrity = checkIntegrity(provisional);
    if (!integrity.ok) throw new Error(`record-store: integrity failed (${integrity.code})`);
    const key = payload.maintenance_key;
    return this.db.transaction(() => {
      const active = this.activeRow(key);
      if (active && active.fingerprint === fingerprint) return fromRow(active);
      const rej = this.db.rawDb.prepare("SELECT 1 FROM recommendation_records WHERE maintenance_key=$key AND fingerprint=$fp AND lifecycle_status='rejected' AND (suppressed_until IS NULL OR suppressed_until > $now) LIMIT 1").get({ $key: key, $fp: fingerprint, $now: now });
      if (rej) throw new Error("record-store: creation suppressed (rejected within suppression window)");
      if (active) {
        this.db.rawDb.prepare("UPDATE recommendation_records SET lifecycle_status='superseded' WHERE record_id=$id").run({ $id: active.record_id });
        this.history(active.record_id, "superseded", active.lifecycle_status, "superseded", undefined, undefined, "replaced by " + provisional.record_id, now);
      }
      this.db.rawDb.prepare("INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ($rid,$key,$fp,$ih,$payload,0,$now,$now,'pending','fresh',NULL)").run({ $rid: provisional.record_id, $key: key, $fp: fingerprint, $ih: normalized.inputs_hash, $payload: canonicalJson(normalized), $now: now });
      this.history(provisional.record_id, "created", undefined, "pending", undefined, undefined, undefined, now);
      return provisional;
    });
  }

  transitionLifecycle(id: string, to: LifecycleStatus, now: string, reason: string, suppressedUntil?: string | null): void {
    validateTimestamp(now, "now");
    let eff: string | null | undefined = suppressedUntil;
    if (to === "rejected" && suppressedUntil === undefined) eff = defaultSuppressedUntil(now);
    if (typeof eff === "string") validateTimestamp(eff, "suppressed_until");
    this.db.transaction(() => {
      const row = this.db.rawDb.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as { l: LifecycleStatus } | undefined;
      if (!row) throw new Error("record-store: record not found");
      if (!LIFECYCLE_TRANSITIONS[row.l].includes(to)) throw new Error(`record-store: illegal lifecycle transition ${row.l} → ${to}`);
      if (to === "rejected" && eff === null) {
        this.db.rawDb.prepare("UPDATE recommendation_records SET lifecycle_status=$to, suppressed_until=NULL WHERE record_id=$id").run({ $to: to, $id: id });
      } else if (to === "rejected" && typeof eff === "string") {
        this.db.rawDb.prepare("UPDATE recommendation_records SET lifecycle_status=$to, suppressed_until=$sut WHERE record_id=$id").run({ $to: to, $sut: eff, $id: id });
      } else {
        this.db.rawDb.prepare("UPDATE recommendation_records SET lifecycle_status=$to WHERE record_id=$id").run({ $to: to, $id: id });
      }
      this.history(id, to, row.l, to, undefined, undefined, reason, now);
    });
  }

  updateFreshness(id: string, to: FreshnessStatus, now: string): void {
    validateTimestamp(now, "now");
    this.db.transaction(() => {
      const row = this.db.rawDb.prepare("SELECT freshness_status AS f, lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as { f: FreshnessStatus; l: LifecycleStatus } | undefined;
      if (!row) throw new Error("record-store: record not found");
      const revalidate = to === "fresh";
      this.db.rawDb.prepare(`UPDATE recommendation_records SET freshness_status=$to${revalidate ? ", last_revalidated_at=$now" : ""} WHERE record_id=$id`).run({ $to: to, $now: now, $id: id });
      this.history(id, `freshness:${to}`, row.l, row.l, row.f, to, undefined, now);
    });
  }

  clearSuppression(id: string, now: string, reason: string): void {
    validateTimestamp(now, "now");
    this.db.transaction(() => {
      const row = this.db.rawDb.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as { l: string } | undefined;
      if (!row) throw new Error("record-store: record not found");
      if (row.l !== "rejected") throw new Error("record-store: clearSuppression only allowed on rejected records");
      const res = this.db.rawDb.prepare("UPDATE recommendation_records SET suppressed_until=$past WHERE record_id=$id AND lifecycle_status='rejected'").run({ $past: SUPPRESSION_REOPENED, $id: id });
      if (res.changes !== 1) throw new Error("record-store: reopen affected no rows");
      this.history(id, "reopen", "rejected", "rejected", undefined, undefined, reason, now);
    });
  }

  private activeRow(key: string): Row | undefined {
    return this.db.rawDb.prepare("SELECT * FROM recommendation_records WHERE maintenance_key=$key AND lifecycle_status IN ('pending','current') ORDER BY rowid DESC LIMIT 1").get({ $key: key }) as Row | undefined;
  }

  private history(id: string, action: string, fl: string | undefined, tl: string, ff: string | undefined, tf: string | undefined, reason: string | undefined, now: string): void {
    this.db.rawDb.prepare("INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, from_freshness, to_freshness, reason, created_at) VALUES ($rid,$action,$fl,$tl,$ff,$tf,$reason,$now)").run({ $rid: id, $action: action, $fl: fl ?? null, $tl: tl, $ff: ff ?? null, $tf: tf ?? null, $reason: reason ?? null, $now: now });
  }
}

function fromRow(r: Row): RecommendationRecord {
  return {
    record_id: r.record_id,
    payload: JSON.parse(r.payload) as RecommendationImmutablePayload,
    fingerprint: r.fingerprint,
    created_at: r.created_at,
    last_revalidated_at: r.last_revalidated_at,
    lifecycle_status: r.lifecycle_status as LifecycleStatus,
    freshness_status: r.freshness_status as FreshnessStatus,
    suppressed_until: r.suppressed_until,
  };
}
