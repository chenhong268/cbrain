import { Database } from "bun:sqlite";
import type { ProvenanceStore } from "../core/provenance.js";

export class SqliteProvenanceStore implements ProvenanceStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS provenance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK(target_type IN ('link','timeline')),
      target_id INTEGER NOT NULL,
      old_trust_state TEXT NOT NULL,
      new_trust_state TEXT NOT NULL,
      source_category TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_prov_hist_target ON provenance_history(target_type, target_id)");
  }

  getLinkProvenanceRow(id: number): Record<string, unknown> | undefined {
    return this.db.prepare(
      "SELECT id, source_type, confidence, trust_state, source_page_slug, evidence, created_at FROM links WHERE id = $id"
    ).get({ $id: id }) as Record<string, unknown> | undefined;
  }

  getTimelineProvenanceRow(id: number): Record<string, unknown> | undefined {
    return this.db.prepare(
      "SELECT id, source as source_type, trust_state, source_page_slug, evidence, created_at FROM timeline WHERE id = $id"
    ).get({ $id: id }) as Record<string, unknown> | undefined;
  }

  updateTrustState(targetType: "link" | "timeline", id: number, newState: string): boolean {
    const table = targetType === "link" ? "links" : "timeline";
    const r = this.db.prepare(
      `UPDATE ${table} SET trust_state = $new WHERE id = $id`
    ).run({ $new: newState, $id: id });
    return r.changes > 0;
  }

  insertProvenanceHistory(targetType: string, targetId: number, oldState: string, newState: string, sourceCategory: string, reason: string | null): void {
    this.db.prepare(
      "INSERT INTO provenance_history (target_type, target_id, old_trust_state, new_trust_state, source_category, reason) VALUES ($tt, $tid, $old, $new, $sc, $reason)"
    ).run({ $tt: targetType, $tid: targetId, $old: oldState, $new: newState, $sc: sourceCategory, $reason: reason });
  }

  getProvenanceHistory(targetType: string, targetId: number): Array<{ id: number; old_trust_state: string; new_trust_state: string; source_category: string; reason: string | null; created_at: string }> {
    return this.db.prepare(
      "SELECT id, old_trust_state, new_trust_state, source_category, reason, created_at FROM provenance_history WHERE target_type = $tt AND target_id = $tid ORDER BY created_at DESC"
    ).all({ $tt: targetType, $tid: targetId }) as Array<{ id: number; old_trust_state: string; new_trust_state: string; source_category: string; reason: string | null; created_at: string }>;
  }
}
