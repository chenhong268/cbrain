// src/core/ingestion/ner-backfill.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "./pipeline.js";
import { isNerTimeoutError } from "./ner.js";
import type { LLMProvider } from "../../llm/provider.js";
import { EntityFactsTimeoutError, extractEntityFacts } from "./entity-facts.js";
import { deriveZeroLinkSource, inspectZeroLinkRepairControl } from "../maintenance/zero-link-backfill.js";
import type { DeferredNerSubmitResult } from "./ner-backfill-contract.js";
import { NER_BACKFILL_JOB } from "./ner-backfill-contract.js";
/** Stale-running recovery TTL — aligned with Dream lock TTL (dream.ts). */
export const NER_BACKFILL_STALE_TTL_MS = 30 * 60 * 1000;

export { NER_BACKFILL_JOB } from "./ner-backfill-contract.js";
export const NER_BACKFILL_MAX_ITEMS = 50;

export interface NerBackfillCounts {
  processed: number;
  failed: number;
  timed_out: number;
  skipped: number;
}

export function emptyNerBackfillCounts(): NerBackfillCounts {
  return { processed: 0, failed: 0, timed_out: 0, skipped: 0 };
}

export interface DeferredNerInput {
  slug: string;
  contentHash?: string;
  pageType?: string;
  /** Absent preserves legacy NER jobs. */
  kind?: "ner" | "entity_facts";
}

/**
 * #252: minimal interface IngestManager depends on. Decouples ingest from the
 * full JobQueue.work() lifecycle and from buildContext construction order.
 */
export interface DeferredNerSubmitter {
  submitDeferredNer(input: DeferredNerInput): DeferredNerSubmitResult;
}

/** Adapter over CBrainDB: dedup then submit. */
export class JobQueueNerSubmitter implements DeferredNerSubmitter {
  constructor(private db: CBrainDB) {}

  submitDeferredNer(input: DeferredNerInput): DeferredNerSubmitResult {
    this.db.rawDb.exec("BEGIN IMMEDIATE");
    try {
      const result = input.kind === "entity_facts"
        ? this.submitEntityFacts(input)
        : this.submitNerEpoch(input);
      this.db.rawDb.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.rawDb.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private submitEntityFacts(input: DeferredNerInput): DeferredNerSubmitResult {
    const rows = this.db.rawDb.prepare(
      "SELECT id, status, data, started_at FROM jobs WHERE name='ner-backfill' AND status IN ('pending','running') ORDER BY id",
    ).all() as Array<{ id: number; status: string; data: string | null; started_at: string | null }>;
    for (const row of rows) {
      const data = safeJobData(row.data);
      if (data?.slug === input.slug && data.kind === "entity_facts" && (row.status === "pending" || !isOrdinaryStale(row.started_at))) {
        return { disposition: "existing_active", jobId: row.id, pending: true };
      }
    }
    const inserted = this.db.rawDb.prepare(
      "INSERT INTO jobs (name, data, priority) VALUES ('ner-backfill', ?, 0)",
    ).run(JSON.stringify({ ...input, kind: "entity_facts" }));
    return { disposition: "inserted", jobId: Number(inserted.lastInsertRowid), pending: true };
  }

  private submitNerEpoch(input: DeferredNerInput): DeferredNerSubmitResult {
    const page = this.db.getPage(input.slug);
    const source = deriveZeroLinkSource(this.db, input.slug);
    if (!page || !source.contentFingerprint) return { disposition: "rejected", jobId: null, pending: false };
    const payload = {
      slug: input.slug,
      pageContentHash: page.content_hash,
      sourceFingerprint: source.contentFingerprint,
      ...(input.pageType ? { pageType: input.pageType } : {}),
      kind: "ner" as const,
    };
    const rows = this.db.rawDb.prepare(
      "SELECT id, status, data, result, started_at FROM jobs WHERE name='ner-backfill' ORDER BY id",
    ).all() as Array<{ id: number; status: string; data: string | null; result: string | null; started_at: string | null }>;
    const slugRows = rows.flatMap((row) => {
      const data = safeJobData(row.data);
      const kind = data?.kind === undefined || data?.kind === "ner" ? "ner" : data?.kind;
      return data?.slug === input.slug && kind === "ner" ? [{ ...row, parsed: data }] : [];
    });

    const repairControl = inspectZeroLinkRepairControl(this.db, input.slug, source.contentFingerprint);
    if (repairControl.queueIntegrityConflicts > 0) {
      return { disposition: "rejected", jobId: null, pending: false };
    }
    if (repairControl.finalizedFingerprintOwned) {
      return { disposition: "already_processed", jobId: null, pending: false };
    }
    const terminal = slugRows.filter((row) => row.parsed.sourceFingerprint === source.contentFingerprint && !["pending", "running"].includes(row.status));
    if (terminal.some((row) => row.status === "done" && safeJobData(row.result)?.outcome === "processed")) {
      return { disposition: "already_processed", jobId: null, pending: false };
    }
    if (terminal.some((row) => row.status === "failed" || row.status === "cancelled")) {
      return { disposition: "rejected", jobId: null, pending: false };
    }

    const live = slugRows.filter((row) => row.status === "pending" || row.status === "running");
    const current = live.filter((row) => row.parsed.sourceFingerprint === source.contentFingerprint);
    if (current.length === 1 && (current[0].status === "pending" || !isOrdinaryStale(current[0].started_at))) {
      return { disposition: "existing_active", jobId: current[0].id, pending: true };
    }
    if (current.length === 1) return { disposition: "rejected", jobId: null, pending: false };
    if (current.length > 1) return { disposition: "rejected", jobId: null, pending: false };
    const old = live.filter((row) => row.parsed.sourceFingerprint !== source.contentFingerprint);
    if (old.length !== 1 || current.length !== 0) {
      if (old.length !== 0) return { disposition: "rejected", jobId: null, pending: false };
    } else {
      const predecessor = old[0];
      if (predecessor.status === "pending") {
        this.db.rawDb.prepare(
          `UPDATE jobs SET data=?, result=NULL, error=NULL, attempts=0,
                           started_at=NULL, finished_at=NULL
           WHERE id=? AND status='pending'`,
        ).run(JSON.stringify(payload), predecessor.id);
        return { disposition: "superseded_pending", jobId: predecessor.id, pending: true };
      }
      if (predecessor.status === "running") {
        const lease = predecessor.parsed.attemptLease as Record<string, unknown> | undefined;
        if (lease?.phase === "committing") return { disposition: "rejected", jobId: null, pending: false };
        if (isOrdinaryStale(predecessor.started_at)) {
          const result = { outcome: "skipped", reason: "SOURCE_CHANGED", kind: "ner" };
          const { attemptLease: _removed, ...withoutLease } = predecessor.parsed;
          this.db.rawDb.prepare(
            "UPDATE jobs SET status='done', data=?, result=?, error=NULL, finished_at=datetime('now') WHERE id=? AND status='running' AND data=?",
          ).run(JSON.stringify(withoutLease), JSON.stringify(result), predecessor.id, predecessor.data);
        }
        const inserted = this.db.rawDb.prepare(
          "INSERT INTO jobs (name, data, priority) VALUES ('ner-backfill', ?, 0)",
        ).run(JSON.stringify(payload));
        return { disposition: "successor_pending", jobId: Number(inserted.lastInsertRowid), pending: true };
      }
    }

    const inserted = this.db.rawDb.prepare(
      "INSERT INTO jobs (name, data, priority) VALUES ('ner-backfill', ?, 0)",
    ).run(JSON.stringify(payload));
    return { disposition: "inserted", jobId: Number(inserted.lastInsertRowid), pending: true };
  }
}

function safeJobData(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function isOrdinaryStale(startedAt: string | null): boolean {
  if (!startedAt) return true;
  const timestamp = Date.parse(startedAt.endsWith("Z") ? startedAt : `${startedAt.replace(" ", "T")}Z`);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= NER_BACKFILL_STALE_TTL_MS;
}

/**
 * #252: resolve body + type for deferred NER. pages table stores no body (it's
 * in the vault file); a sealed page's vault body is the L1 summary. So:
 *   - sealed → concatenate summary_level=0 raw chunks
 *   - else   → vault body (PageManager.getBySlug().body); empty → raw-chunk fallback
 * Returns null when no usable body exists (caller fails the job with a reason).
 */
export function resolveNerBody(
  db: CBrainDB,
  pages: PageManager,
  slug: string,
): { body: string; type: string; title: string } | null {
  const page = db.getPage(slug);
  if (!page) return null;
  const type = page.type;

  const rawChunksBody = (): string | null => {
    const raw = db.getChunksByPage(slug, { summaryLevel: 0 });
    return raw.length > 0 ? raw.map((c) => c.content).join("\n\n") : null;
  };

  if (db.isSealedPage(slug)) {
    const body = rawChunksBody();
    return body ? { body, type, title: page.title } : null;
  }
  const body = pages.getBySlug(slug)?.body ?? "";
  if (body.trim()) return { body, type, title: page.title };
  const fallback = rawChunksBody();
  return fallback ? { body: fallback, type, title: page.title } : null;
}

/**
 * #252: bounded Dream stage 1.5. Recovers stale running jobs, snapshots eligible
 * pending ids ONCE (each processed at most once per run — no retry starvation),
 * and reuses pipeline.processNer (60s timeout / fail-open). No always-on worker.
 */
export async function runNerBackfillStage(
  db: CBrainDB,
  pipeline: ContentPipeline,
  pages: PageManager,
  opts?: { maxItems?: number; staleTtlMs?: number; entityFactsLlm?: LLMProvider },
): Promise<NerBackfillCounts> {
  const counts = emptyNerBackfillCounts();
  const maxItems = opts?.maxItems ?? NER_BACKFILL_MAX_ITEMS;
  const staleTtlMs = opts?.staleTtlMs ?? NER_BACKFILL_STALE_TTL_MS;

  // (a) recover stale running from a crashed previous Dream
  db.resetStaleJobsForNames([NER_BACKFILL_JOB], staleTtlMs);

  // (b) snapshot eligible ids ONCE — each processed at most once this run
  const ids = db.snapshotEligibleJobIds([NER_BACKFILL_JOB], maxItems);

  for (const id of ids) {
    const job = db.claimJobById(id); // null if no longer pending (race-safe)
    if (!job) { counts.skipped++; continue; }

    let parsed: { slug?: unknown; kind?: unknown } = {};
    try { parsed = job.data ? JSON.parse(job.data) : {}; } catch { /* malformed */ }
    const slug = typeof parsed.slug === "string" && parsed.slug.trim() ? parsed.slug : null;
    const kind = parsed.kind === undefined || parsed.kind === "ner"
      ? "ner"
      : parsed.kind === "entity_facts" ? "entity_facts" : null;
    if (!slug || !kind) {
      db.completeJob(id, { outcome: "skipped", reason: "INVALID_JOB" });
      counts.skipped++;
      continue;
    }

    const resolved = resolveNerBody(db, pages, slug);
    if (!resolved) {
      db.completeJob(id, { outcome: "skipped", reason: "SOURCE_UNAVAILABLE" });
      counts.skipped++;
      continue;
    }

    try {
      if (kind === "entity_facts") {
        if (!opts?.entityFactsLlm) {
          db.failJob(id, "ENTITY_FACTS_PROVIDER_UNAVAILABLE");
          counts.failed++;
          continue;
        }
        const result = await extractEntityFacts({
          pages,
          llm: opts.entityFactsLlm,
          slug,
          title: resolved.title,
          type: resolved.type,
          body: resolved.body,
        });
        db.completeJob(id, { outcome: "processed", kind, applied_fields: result.appliedCount });
      } else {
        await pipeline.processNer(slug, resolved.body, resolved.type, true, undefined, new Set());
        db.completeJob(id, { outcome: "processed", kind });
      }
      counts.processed++;
    } catch (e) {
      if (isNerTimeoutError(e) || e instanceof EntityFactsTimeoutError) {
        db.failJob(id, kind === "entity_facts" ? "ENTITY_FACTS_TIMEOUT" : "NER_TIMEOUT");
        counts.timed_out++;
      } else {
        db.failJob(id, kind === "entity_facts" ? "ENTITY_FACTS_PROVIDER_ERROR" : "NER_PROVIDER_ERROR");
        counts.failed++;
      }
    }
  }
  return counts;
}
