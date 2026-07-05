import { Database } from "bun:sqlite";

export type DiscoveryDedupKeyFn = (type: string, entities: string[]) => string;

function discoveryColumnNames(db: Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(discoveries)").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function migrateDiscoveries(db: Database): void {
  const names = discoveryColumnNames(db);
  if (!names.has("actionable")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN actionable TEXT DEFAULT 'low'");
  }
  if (!names.has("suggestion")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN suggestion TEXT");
  }
  if (!names.has("proposed_actions")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN proposed_actions TEXT");
  }
  if (!names.has("auto_applicable")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN auto_applicable INTEGER DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_discoveries_actionable ON discoveries(actionable)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_discoveries_score ON discoveries(score)");
  db.exec("UPDATE discoveries SET seen = 0 WHERE seen IS NULL");
}

function migrateDiscoveriesStatus(db: Database): void {
  const names = discoveryColumnNames(db);
  if (!names.has("status")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!names.has("metadata")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN metadata TEXT");
  }
}

function migrateDiscoveriesDedup(db: Database, dedupKey: DiscoveryDedupKeyFn): void {
  const names = discoveryColumnNames(db);

  if (!names.has("dedup_key")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN dedup_key TEXT");
  }
  if (!names.has("last_detected_at")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN last_detected_at TEXT");
  }
  if (!names.has("occurrence_count")) {
    db.exec("ALTER TABLE discoveries ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
  }

  // Everything below is a single recoverable transaction:
  // 1. Drop existing unique index (if any) to avoid backfill collisions
  // 2. Re-canonicalize ALL keys (NULL and non-canonical non-NULL)
  // 3. Consolidate duplicate rows
  // 4. Fill last_detected_at
  // 5. Rebuild unique index
  db.transaction(() => {
    // Step 1: Drop existing index so backfill won't collide with NULL-key dupes
    db.exec("DROP INDEX IF EXISTS idx_discoveries_dedup_key");

    // Step 2: Re-canonicalize ALL rows — NULL keys and non-canonical non-NULL keys
    const allRows = db.prepare(
      "SELECT id, type, entities, dedup_key FROM discoveries",
    ).all() as Array<{ id: number; type: string; entities: string; dedup_key: string | null }>;

    const updateKey = db.prepare("UPDATE discoveries SET dedup_key = $key WHERE id = $id");
    for (const row of allRows) {
      let canonicalKey: string;
      try {
        const parsed = JSON.parse(row.entities);
        canonicalKey = dedupKey(row.type, Array.isArray(parsed) ? parsed : [row.entities]);
      } catch {
        canonicalKey = `${row.type}|${row.entities}`;
      }
      // Only update if key differs (NULL, non-canonical, or from earlier implementation)
      if (row.dedup_key !== canonicalKey) {
        updateKey.run({ $id: row.id, $key: canonicalKey });
      }
    }

    // Step 3: Consolidate duplicate dedup_keys
    const dupes = db.prepare(
      "SELECT dedup_key FROM discoveries WHERE dedup_key IS NOT NULL GROUP BY dedup_key HAVING COUNT(*) > 1",
    ).all() as Array<{ dedup_key: string }>;

    if (dupes.length > 0) {
      const selectAll = db.prepare(
        "SELECT id, type, entities, score, detail, detected_at, dream_run, seen, status, actionable, suggestion, proposed_actions, auto_applicable, metadata, occurrence_count FROM discoveries WHERE dedup_key = $key ORDER BY id ASC",
      );
      const deleteRow = db.prepare("DELETE FROM discoveries WHERE id = $id");
      const updateSurvivor = db.prepare(
        "UPDATE discoveries SET seen = $seen, status = $status, suggestion = $suggestion, proposed_actions = $actions, detected_at = $detected, last_detected_at = $lastDetected, occurrence_count = $occ, score = $score, metadata = $metadata WHERE id = $id",
      );

      for (const { dedup_key } of dupes) {
        const rows = selectAll.all({ $key: dedup_key }) as Array<{
          id: number;
          type: string;
          entities: string;
          score: number;
          detail: string | null;
          detected_at: string;
          dream_run: string | null;
          seen: number;
          status: string;
          actionable: string;
          suggestion: string | null;
          proposed_actions: string | null;
          auto_applicable: number;
          metadata: string | null;
          occurrence_count: number;
        }>;
        if (rows.length <= 1) continue;

        let survivorSeen = 0;
        let survivorStatus = "pending";
        let survivorSuggestion: string | null = null;
        let survivorActions: string | null = null;
        let latestDetected = "";
        let latestScore = 0;
        let latestMeta: string | null = null;
        let totalOccurrences = 0;

        for (const r of rows) {
          if (r.seen === 1) survivorSeen = 1;
          if (r.status === "resolved") survivorStatus = "resolved";
          else if (r.status === "dismissed" && survivorStatus !== "resolved") survivorStatus = "dismissed";
          else if (r.status === "seen" && survivorStatus === "pending") survivorStatus = "seen";
          if (r.suggestion) survivorSuggestion = r.suggestion;
          if (r.proposed_actions) survivorActions = r.proposed_actions;
          if (r.detected_at > latestDetected) {
            latestDetected = r.detected_at;
            latestScore = r.score;
            latestMeta = r.metadata;
          }
          totalOccurrences += r.occurrence_count;
        }

        const survivor = rows[0];
        updateSurvivor.run({
          $id: survivor.id,
          $seen: survivorSeen,
          $status: survivorStatus,
          $suggestion: survivorSuggestion,
          $actions: survivorActions,
          $detected: survivor.detected_at,
          $lastDetected: latestDetected,
          $occ: totalOccurrences,
          $score: latestScore,
          $metadata: latestMeta,
        });

        for (let i = 1; i < rows.length; i++) {
          deleteRow.run({ $id: rows[i].id });
        }
      }
    }

    // Step 4: Fill last_detected_at from detected_at
    db.exec("UPDATE discoveries SET last_detected_at = detected_at WHERE last_detected_at IS NULL");

    // Step 5: Rebuild unique index
    db.exec("CREATE UNIQUE INDEX idx_discoveries_dedup_key ON discoveries(dedup_key)");
  })();
}

export function runDiscoveryMigrations(db: Database, dedupKey: DiscoveryDedupKeyFn): void {
  migrateDiscoveries(db);
  migrateDiscoveriesStatus(db);
  migrateDiscoveriesDedup(db, dedupKey);
}
