// src/core/ner-backfill.ts
import type { CBrainDB } from "../storage/sqlite.js";
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
