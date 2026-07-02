// src/core/ingestion/ner-backfill.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "./pipeline.js";
import { isNerTimeoutError } from "./ner.js";
/** Stale-running recovery TTL — aligned with Dream lock TTL (dream.ts). */
export const NER_BACKFILL_STALE_TTL_MS = 30 * 60 * 1000;

export const NER_BACKFILL_JOB = "ner-backfill";
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
}

/**
 * #252: minimal interface IngestManager depends on. Decouples ingest from the
 * full JobQueue.work() lifecycle and from buildContext construction order.
 */
export interface DeferredNerSubmitter {
  /** Returns job id, or null if deduped (active pending/non-stale-running job for slug exists). */
  submitDeferredNer(input: DeferredNerInput): number | null;
}

/** Adapter over CBrainDB: dedup then submit. */
export class JobQueueNerSubmitter implements DeferredNerSubmitter {
  constructor(private db: CBrainDB) {}

  submitDeferredNer(input: DeferredNerInput): number | null {
    const active = this.db.findActiveNerJobs(input.slug, NER_BACKFILL_STALE_TTL_MS);
    if (active.length > 0) return null;
    return this.db.submitJob(NER_BACKFILL_JOB, input);
  }
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
): { body: string; type: string } | null {
  const page = db.getPage(slug);
  if (!page) return null;
  const type = page.type;

  const rawChunksBody = (): string | null => {
    const raw = db.getChunksByPage(slug, { summaryLevel: 0 });
    return raw.length > 0 ? raw.map((c) => c.content).join("\n\n") : null;
  };

  if (db.isSealedPage(slug)) {
    const body = rawChunksBody();
    return body ? { body, type } : null;
  }
  const body = pages.getBySlug(slug)?.body ?? "";
  if (body.trim()) return { body, type };
  const fallback = rawChunksBody();
  return fallback ? { body: fallback, type } : null;
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
  opts?: { maxItems?: number; staleTtlMs?: number },
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

    let parsed: { slug?: string } = {};
    try { parsed = job.data ? JSON.parse(job.data) : {}; } catch { /* malformed */ }
    const slug = parsed.slug;
    if (!slug) { db.failJob(id, "ner-backfill job missing slug"); counts.failed++; continue; }

    const resolved = resolveNerBody(db, pages, slug);
    if (!resolved) { db.failJob(id, `no usable body for ${slug} (sealed/no raw chunks)`); counts.failed++; continue; }

    try {
      await pipeline.processNer(slug, resolved.body, resolved.type, true, undefined, new Set());
      db.completeJob(id);
      counts.processed++;
    } catch (e) {
      if (isNerTimeoutError(e)) {
        db.failJob(id, "NER_TIMEOUT");
        counts.timed_out++;
      } else {
        db.failJob(id, e instanceof Error ? e.message : String(e));
        counts.failed++;
      }
    }
  }
  return counts;
}
