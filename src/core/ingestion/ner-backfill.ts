// src/core/ingestion/ner-backfill.ts
import { buildNerAttemptIdentity, type CBrainDB, type NerAttemptIdentity } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "./pipeline.js";
import { isNerTimeoutError } from "./ner.js";
import type { LLMProvider } from "../../llm/provider.js";
import { EntityFactsTimeoutError, extractEntityFacts } from "./entity-facts.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { hashContent } from "../shared.js";
import {
  authorizeNerJobClaim,
  countCurrentGraphLinks,
  deriveZeroLinkSource,
  finalizeRepairBatch,
  getRepairBatchAttemptIdentity,
  getNerJobProtection,
  inspectZeroLinkRepairControl,
  loadZeroLinkSourceSnapshot,
  planZeroLinkBackfill,
  prepareRepairBatchJobIds,
  summarizeRepairBatch,
} from "../maintenance/zero-link-backfill.js";
import {
  parseFingerprintedNerJob,
  type DeferredNerSubmitResult,
  type FingerprintedNerJob,
} from "./ner-backfill-contract.js";
/** Stale-running recovery TTL — aligned with Dream lock TTL (dream.ts). */
export const NER_BACKFILL_STALE_TTL_MS = 30 * 60 * 1000;

export { NER_BACKFILL_JOB } from "./ner-backfill-contract.js";
export const NER_BACKFILL_MAX_ITEMS = 50;

export interface NerBackfillCounts {
  processed: number;
  failed: number;
  timed_out: number;
  skipped: number;
  /** Internal CLI handoff; absent unless explicit broad retry was requested. */
  retried_failed?: number;
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
    if (repairControl.queueIntegrityConflicts > 0 || repairControl.stateConflicts > 0) {
      return { disposition: "rejected", jobId: null, pending: false };
    }
    if (repairControl.finalizedFingerprintOwned) {
      return { disposition: "already_processed", jobId: null, pending: false };
    }
    if (repairControl.unfinalizedOwnedJobId !== null) {
      return repairControl.unfinalizedOwnedLive
        ? { disposition: "existing_active", jobId: repairControl.unfinalizedOwnedJobId, pending: true }
        : { disposition: "rejected", jobId: null, pending: false };
    }
    const terminal = slugRows.filter((row) => !row.parsed.repair && row.parsed.sourceFingerprint === source.contentFingerprint && !["pending", "running"].includes(row.status));
    if (terminal.some((row) => row.status === "done" && safeJobData(row.result)?.outcome === "commit_unknown")) {
      return { disposition: "rejected", jobId: null, pending: false };
    }
    if (terminal.some((row) => row.status === "done" && safeJobData(row.result)?.outcome === "processed")) {
      return { disposition: "already_processed", jobId: null, pending: false };
    }
    if (terminal.some((row) => row.status === "failed" || row.status === "cancelled")) {
      return { disposition: "rejected", jobId: null, pending: false };
    }

    const live = slugRows.filter((row) => !row.parsed.repair && (row.status === "pending" || row.status === "running"));
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

function retryableFailedNerData(db: CBrainDB, raw: Record<string, any>): boolean {
  if (typeof raw.slug !== "string" || !raw.slug.trim() || raw.repair || raw.attemptLease) return false;
  if (raw.kind === "entity_facts") return Boolean(db.getPage(raw.slug));
  if (raw.kind !== undefined && raw.kind !== "ner") return false;
  if (typeof raw.sourceFingerprint !== "string") return false;
  const contentHash = Object.hasOwn(raw, "pageContentHash")
    ? raw.pageContentHash
    : raw.contentHash;
  if (contentHash !== null && typeof contentHash !== "string") return false;
  if (!("pageContentHash" in raw) && !("contentHash" in raw)) return false;
  const page = db.getPage(raw.slug);
  if (!page || page.content_hash !== contentHash) return false;
  return deriveZeroLinkSource(db, raw.slug).contentFingerprint === raw.sourceFingerprint;
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

type FingerprintedNerData = FingerprintedNerJob;

type ScheduledSourceResult =
  | { status: "ok"; body: string; type: string; title: string }
  | { status: "unavailable" | "changed" | "invalid" };

function resolveScheduledNerSource(
  db: CBrainDB,
  pages: PageManager,
  data: FingerprintedNerData,
): ScheduledSourceResult {
  const page = db.getPage(data.slug);
  if (!page) return { status: "unavailable" };
  if (data.sourceKind === "vault_hash") {
    let raw: string;
    try { raw = readFileSync(join(pages.vaultPath, page.file_path), "utf8"); } catch { return { status: "unavailable" }; }
    if (`page:${hashContent(raw)}` !== data.sourceFingerprint) return { status: "changed" };
    const { body } = parseFrontmatter(raw);
    if (!body.trim()) return { status: "unavailable" };
    return { status: "ok", body, type: page.type, title: page.title };
  }
  const current = loadZeroLinkSourceSnapshot(db, data.slug);
  if (!current.contentFingerprint) return { status: "unavailable" };
  if (current.sourceKind !== "raw_chunks") return { status: "invalid" };
  if (current.contentFingerprint !== data.sourceFingerprint) return { status: "changed" };
  if (!current.body) return { status: "unavailable" };
  return { status: "ok", body: current.body, type: page.type, title: page.title };
}

function fixedRepairResult(
  data: FingerprintedNerData,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...fields,
    kind: "ner",
    ...(data.repair ? { repair: data.repair } : {}),
  };
}

function unfilteredSnapshot(
  db: CBrainDB,
  limit: number,
  staleTtlMs: number,
  retryFailed = false,
): { ids: number[]; retriedFailed: number } {
  db.rawDb.exec("BEGIN IMMEDIATE");
  try {
    const audit = planZeroLinkBackfill(db, 0);
    if (audit.queueIntegrityConflicts > 0 || audit.stateConflicts > 0) throw new Error("QUEUE_INTEGRITY_CONFLICT");
    const protection = getNerJobProtection(db);
    if (protection.integrityUnknown) throw new Error("QUEUE_INTEGRITY_CONFLICT");
    const rows = db.rawDb.prepare(
      "SELECT id, status, data, result, started_at FROM jobs WHERE name='ner-backfill' ORDER BY priority DESC, id ASC",
    ).all() as Array<{ id: number; status: string; data: string | null; result: string | null; started_at: string | null }>;
    let retriedFailed = 0;
    if (retryFailed) {
      for (const row of rows) {
        const data = safeJobData(row.data);
        const result = safeJobData(row.result);
        if (
          row.status !== "failed" || !data || protection.protectedJobIds.has(row.id) ||
          !retryableFailedNerData(db, data) || result?.outcome === "commit_unknown"
        ) continue;
        const changed = db.rawDb.prepare(
          `UPDATE jobs SET status='pending', attempts=0, error=NULL, started_at=NULL, finished_at=NULL
           WHERE id=? AND name='ner-backfill' AND status='failed' AND data=?`,
        ).run(row.id, row.data);
        retriedFailed += Number(changed.changes);
      }
    }
    const unknownSlugs = new Set<string>();
    for (const row of rows) {
      const data = safeJobData(row.data);
      const result = safeJobData(row.result);
      if (row.status === "done" && result?.outcome === "commit_unknown" && typeof data?.slug === "string") unknownSlugs.add(data.slug);
    }
    for (const row of rows) {
      const data = safeJobData(row.data);
      if (!data || protection.protectedJobIds.has(row.id) || data.repair || row.status !== "running" || !isOrdinaryStaleAt(row.started_at, staleTtlMs)) continue;
      if (data.kind === "entity_facts") {
        const changed = db.rawDb.prepare(
          "UPDATE jobs SET status='pending', started_at=NULL, finished_at=NULL WHERE id=? AND status='running' AND data=?",
        ).run(row.id, row.data);
        if (changed.changes !== 1) throw new Error("QUEUE_INTEGRITY_CONFLICT");
        continue;
      }
      const lease = data.attemptLease as Record<string, unknown> | undefined;
      if (lease?.phase === "committing") {
        const { attemptLease: _removed, ...withoutLease } = data;
        const result = { outcome: "commit_unknown", kind: "ner" };
        const changed = db.rawDb.prepare(
          "UPDATE jobs SET status='done', data=?, result=?, error=NULL, finished_at=datetime('now') WHERE id=? AND status='running' AND data=?",
        ).run(JSON.stringify(withoutLease), JSON.stringify(result), row.id, row.data);
        if (changed.changes !== 1) throw new Error("QUEUE_INTEGRITY_CONFLICT");
        if (typeof data.slug === "string") unknownSlugs.add(data.slug);
        continue;
      }
      const { attemptLease: _removed, ...withoutLease } = data;
      db.rawDb.prepare(
        "UPDATE jobs SET status='pending', data=?, started_at=NULL, finished_at=NULL WHERE id=? AND status='running' AND data=?",
      ).run(JSON.stringify(withoutLease), row.id, row.data);
    }
    const refreshed = db.rawDb.prepare(
      "SELECT id, data FROM jobs WHERE name='ner-backfill' AND status='pending' ORDER BY priority DESC, id ASC",
    ).all() as Array<{ id: number; data: string | null }>;
    const ids = refreshed.filter((row) => {
      const data = safeJobData(row.data);
      return Boolean(data && !protection.protectedJobIds.has(row.id) && !data.repair && (typeof data.slug !== "string" || !unknownSlugs.has(data.slug)));
    }).slice(0, limit).map((row) => row.id);
    const finalAudit = planZeroLinkBackfill(db, 0);
    if (finalAudit.queueIntegrityConflicts > 0 || finalAudit.stateConflicts > 0) throw new Error("QUEUE_INTEGRITY_CONFLICT");
    db.rawDb.exec("COMMIT");
    return { ids, retriedFailed };
  } catch (error) {
    try { db.rawDb.exec("ROLLBACK"); } catch { /* closed */ }
    throw error;
  }
}

/** Governed single-row retry used by MCP compatibility surfaces. */
export function retryFailedNerJob(db: CBrainDB, id: number): boolean {
  db.rawDb.exec("BEGIN IMMEDIATE");
  try {
    const audit = planZeroLinkBackfill(db, 0);
    const protection = getNerJobProtection(db);
    if (audit.queueIntegrityConflicts > 0 || audit.stateConflicts > 0 || protection.integrityUnknown || protection.protectedJobIds.has(id)) {
      db.rawDb.exec("COMMIT");
      return false;
    }
    const row = db.rawDb.prepare(
      "SELECT status,data,result FROM jobs WHERE id=? AND name='ner-backfill'",
    ).get(id) as { status: string; data: string | null; result: string | null } | undefined;
    const data = safeJobData(row?.data ?? null);
    const result = safeJobData(row?.result ?? null);
    if (!row || row.status !== "failed" || !data || !retryableFailedNerData(db, data) || result?.outcome === "commit_unknown") {
      db.rawDb.exec("COMMIT");
      return false;
    }
    const updated = db.rawDb.prepare(
      `UPDATE jobs SET status='pending', attempts=0, error=NULL, started_at=NULL, finished_at=NULL
       WHERE id=? AND name='ner-backfill' AND status='failed' AND data=?`,
    ).run(id, row.data);
    db.rawDb.exec("COMMIT");
    return updated.changes === 1;
  } catch (error) {
    try { db.rawDb.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

function isOrdinaryStaleAt(startedAt: string | null, ttlMs: number): boolean {
  if (!startedAt) return true;
  const timestamp = Date.parse(startedAt.endsWith("Z") ? startedAt : `${startedAt.replace(" ", "T")}Z`);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= ttlMs;
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
  opts?: { maxItems?: number; staleTtlMs?: number; entityFactsLlm?: LLMProvider; batchId?: string; retryFailed?: boolean },
): Promise<NerBackfillCounts> {
  const counts = emptyNerBackfillCounts();
  const maxItems = opts?.maxItems ?? NER_BACKFILL_MAX_ITEMS;
  const staleTtlMs = opts?.staleTtlMs ?? NER_BACKFILL_STALE_TTL_MS;

  const batchId = opts?.batchId;
  const prepared = batchId !== undefined
    ? { ids: prepareRepairBatchJobIds(db, batchId, maxItems, staleTtlMs), retriedFailed: 0 }
    : unfilteredSnapshot(db, maxItems, staleTtlMs, opts?.retryFailed);
  const ids = prepared.ids;
  if (opts?.retryFailed) counts.retried_failed = prepared.retriedFailed;

  for (const id of ids) {
    const rowBeforeClaim = db.getJob(id);
    if (!rowBeforeClaim || rowBeforeClaim.status !== "pending") continue;
    const beforeData = safeJobData(rowBeforeClaim.data);
    const entityFacts = beforeData?.kind === "entity_facts";
    const frozenIdentity: NerAttemptIdentity | undefined = !entityFacts && beforeData
      ? buildNerAttemptIdentity(beforeData) ?? undefined
      : undefined;
    if (batchId !== undefined) {
      const manifestIdentity = getRepairBatchAttemptIdentity(db, batchId, id);
      if (!frozenIdentity || frozenIdentity.slug !== manifestIdentity.slug ||
        frozenIdentity.sourceFingerprint !== manifestIdentity.sourceFingerprint ||
        frozenIdentity.batchId !== manifestIdentity.batchId) throw new Error("BATCH_INTEGRITY_CONFLICT");
    }
    const expectedIdentity = frozenIdentity;
    const job = entityFacts ? db.claimJobById(id) : db.claimNerJobByIdWithLease(id, expectedIdentity, authorizeNerJobClaim);
    if (!job) { counts.skipped++; continue; }
    const leaseToken = "leaseToken" in job && typeof job.leaseToken === "string" ? job.leaseToken : null;
    const leaseDigest = "payloadDigest" in job && typeof job.payloadDigest === "string" ? job.payloadDigest : null;

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

    const fingerprinted = kind === "ner" ? parseFingerprintedNerJob(parsed as Record<string, unknown>) : null;
    const scheduled = fingerprinted ? resolveScheduledNerSource(db, pages, fingerprinted) : null;
    const resolved = scheduled?.status === "ok" ? scheduled : !fingerprinted ? resolveNerBody(db, pages, slug) : null;
    if (fingerprinted && scheduled?.status !== "ok") {
      const graphOutcome = scheduled?.status === "changed" ? "source_changed" : scheduled?.status === "invalid" ? "invalid_terminal" : "blocked_source_unavailable";
      const reason = scheduled?.status === "changed" ? "SOURCE_CHANGED" : scheduled?.status === "invalid" ? "INVALID_JOB" : "SOURCE_UNAVAILABLE";
      if (leaseToken && leaseDigest) db.completeNerJobWithLease(id, leaseToken, "claimed", leaseDigest, fixedRepairResult(fingerprinted, { outcome: "skipped", reason, graphOutcome }));
      counts.skipped++;
      continue;
    }
    if (!resolved) {
      if (leaseToken && leaseDigest) db.completeNerJobWithLease(id, leaseToken, "claimed", leaseDigest, { outcome: "skipped", reason: "SOURCE_UNAVAILABLE" });
      else db.completeJob(id, { outcome: "skipped", reason: "SOURCE_UNAVAILABLE" });
      counts.skipped++;
      continue;
    }

    let committing = false;
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
        if (!leaseToken || !leaseDigest) throw new Error("NER_ATTEMPT_REVOKED");
        const guard = fingerprinted ? (phase: "after_extract" | "before_commit") => {
          if (!db.validateNerJobLease(id, leaseToken, "claimed", leaseDigest)) throw new Error("NER_ATTEMPT_REVOKED");
          const current = resolveScheduledNerSource(db, pages, fingerprinted);
          if (current.status === "unavailable") throw new Error("NER_SOURCE_UNAVAILABLE");
          if (current.status !== "ok") throw new Error("NER_SOURCE_CHANGED");
          if (phase === "before_commit") {
            if (!db.moveNerLeaseToCommitting(id, leaseToken, leaseDigest)) throw new Error("NER_ATTEMPT_REVOKED");
            committing = true;
          }
        } : undefined;
        await pipeline.processNer(
          slug,
          resolved.body,
          resolved.type,
          true,
          undefined,
          new Set(),
          guard,
          batchId !== undefined,
        );
        const activeLinkCount = fingerprinted?.repair ? countCurrentGraphLinks(db, slug) : 0;
        const result = fingerprinted
          ? fixedRepairResult(fingerprinted, {
              outcome: "processed",
              ...(fingerprinted.repair ? { graphOutcome: activeLinkCount > 0 ? "resolved" : "terminal_no_graph_links", activeLinkCount } : {}),
            })
          : { outcome: "processed", kind };
        const phase = committing ? "committing" : "claimed";
        if (!db.completeNerJobWithLease(id, leaseToken, phase, leaseDigest, result)) { counts.skipped++; continue; }
      }
      counts.processed++;
    } catch (e) {
      if (kind === "ner" && leaseToken && leaseDigest) {
        const code = e instanceof Error ? e.message : "";
        if (code === "NER_ATTEMPT_REVOKED") { counts.skipped++; continue; }
        if (code === "NER_SOURCE_CHANGED" || code === "NER_SOURCE_UNAVAILABLE") {
          if (fingerprinted) {
            const graphOutcome = code === "NER_SOURCE_CHANGED" ? "source_changed" : "blocked_source_unavailable";
            db.completeNerJobWithLease(id, leaseToken, "claimed", leaseDigest, fixedRepairResult(fingerprinted, { outcome: "skipped", reason: code === "NER_SOURCE_CHANGED" ? "SOURCE_CHANGED" : "SOURCE_UNAVAILABLE", graphOutcome }));
          }
          counts.skipped++;
          continue;
        }
        if (committing) {
          db.completeNerJobWithLease(id, leaseToken, "committing", leaseDigest, fixedRepairResult(fingerprinted!, { outcome: "commit_unknown" }));
          counts.failed++;
          continue;
        }
      }
      if (isNerTimeoutError(e) || e instanceof EntityFactsTimeoutError) {
        if (kind === "ner" && leaseToken && leaseDigest) db.failNerJobWithLease(id, leaseToken, leaseDigest, "NER_TIMEOUT");
        else db.failJob(id, "ENTITY_FACTS_TIMEOUT");
        counts.timed_out++;
      } else {
        if (kind === "ner" && leaseToken && leaseDigest) db.failNerJobWithLease(id, leaseToken, leaseDigest, "NER_PROVIDER_ERROR");
        else db.failJob(id, "ENTITY_FACTS_PROVIDER_ERROR");
        counts.failed++;
      }
    }
  }
  if (batchId !== undefined) {
    const status = summarizeRepairBatch(db, batchId);
    if (status.pending === 0 && status.running === 0 && status.outcomes.commitUnknown === 0) finalizeRepairBatch(db, batchId);
  }
  return counts;
}
