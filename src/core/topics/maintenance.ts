import type { CBrainDB } from "../../storage/sqlite.js";
import type { JobExecution, JobQueue } from "../jobs.js";
import type { Logger } from "../logger.js";
import { isTopicManagedPath } from "../shared.js";
import { TopicManager } from "./manager.js";
import { TOPIC_PAGE_TYPE } from "./types.js";
import { computeCatalogFingerprint } from "./read.js";
import type { TopicManifest, TopicSeed } from "./types.js";

/** Internal job name for the existing unified job tool. Actions are validated
 *  both at the topic-only submit hook and inside the handler. */
export const TOPIC_JOB_NAME = "topic-wiki";

/** Initial pilot bound: maximum number of MANAGED topic pages in total
 *  (existing + newly created), not per run. */
export const MAX_MANAGED_TOPICS = 5;

/** Maintenance cadence: one scheduled run per 30 minutes while enabled. */
export const TOPIC_TICK_MS = 30 * 60 * 1000;

const ENABLED_CONFIG = "topic.enabled";
const PENDING_SELECTION_CONFIG = "topic.pending_selection";
/** "explicit" once an enable carried candidateKeys: the operator's selection
 *  stays authoritative — scheduled runs never generic-auto-fill past it. */
const SELECTION_MODE_CONFIG = "topic.selection_mode";
const MAX_CANDIDATE_KEYS = 5;
const MAX_KEY_CHARS = 200;
/** Stable per-topic source cap comes from the compiler budget; discovery
 *  re-states it here so preview receipts agree with compile-time admission. */
const MAX_SOURCES_PER_TOPIC = 12;
const MIN_NEW_TOPIC_SOURCES = 3;

export interface TopicCandidateView {
  key: string;
  title: string;
  /** Distinct original-record count backing the seed (uncapped). */
  support: number;
  /** Deterministic capped selection (sorted slugs). */
  sourceSlugs: string[];
  omittedSources: number;
}

export interface TopicPreviewReport {
  enabled: boolean;
  catalogFingerprint: string;
  candidates: TopicCandidateView[];
  managedTopics: Array<{ slug: string; title: string; freshness: string; catalogAttested: boolean }>;
  spareSlots: number;
  excludedCounts: { belowMinimum: number; missingProvenanceLinks: number };
  mergedDuplicateSeeds: Array<{ kept: string; merged: string[] }>;
}

export interface TopicRunReceipt {
  action: "refresh" | "enable";
  catalogFingerprint: string;
  /** Present when the whole run was skipped (disabled / no model). */
  skipped?: string;
  managed: Array<{ slug: string; title: string; outcome: string; reason?: string }>;
  created: Array<{ key?: string; slug: string; title: string }>;
  blocked: Array<{ key?: string; slug?: string; reason: string; detail?: string }>;
  counts: { refreshed: number; unchanged: number; reattested: number; skipped: number; created: number; blocked: number };
}

interface DiscoveryResult {
  candidates: TopicCandidateView[];
  /** FULL sorted record map for EVERY seed (uncapped, any support, including
   *  seeds hidden as duplicates in the preview): existing-topic derivation
   *  and creation retries must follow the seed's real membership, never a
   *  capped or deduplicated view. */
  seedRecords: Map<string, string[]>;
  seedTitles: Map<string, string>;
  excludedCounts: { belowMinimum: number; missingProvenanceLinks: number };
  mergedDuplicateSeeds: Array<{ kept: string; merged: string[] }>;
}

function isEntityOrConceptType(type: string): boolean {
  return type === "entity" || type.startsWith("entity/")
    || type === "concept" || type.startsWith("concept/");
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── DB record catalog fingerprint (#510 Task 2) ─────────────────────
// Moved to ./read.js for #511 Task 3 (shared read freshness consumes the same
// hash — no duplicate implementation). Re-exported here so the Task 2 API
// surface (tests, callers) is unchanged.

export { computeCatalogFingerprint } from "./read.js";

// ─── Discovery (#510 Task 2) ──────────────────────────────────────────
// Two seed families, both DB-only, both counting DISTINCT record slugs
// (never chunks, generated pages, or mention_count):
//   1. tag seeds — records carrying a tag;
//   2. entity/concept seeds — active links whose provenance points at a
//      record; either entity/concept endpoint seeds. Explicit record→entity
//      提及 edges are the from_slug = source_page_slug shape; entity↔entity
//      relations provenanced from a record seed both endpoints. Legacy
//      record→entity edges with no provenance are excluded and counted.

export function discoverTopicCandidates(db: CBrainDB): DiscoveryResult {
  const seedRecords = new Map<string, Set<string>>();

  // Records living in the reserved generated area are not source material
  // (the Task 1 compiler rejects them too — same classification, discovery
  // side). Cheap DB-side eligibility set, computed once.
  const recordRows = db.rawDb.prepare(
    "SELECT slug, file_path FROM pages WHERE type = 'record'"
  ).all() as Array<{ slug: string; file_path: string | null }>;
  const eligibleRecords = new Set(
    recordRows.filter((r) => !isTopicManagedPath(r.file_path)).map((r) => r.slug),
  );

  const tagRows = db.rawDb.prepare(
    `SELECT t.tag, t.page_slug FROM tags t
     JOIN pages p ON p.slug = t.page_slug AND p.type = 'record'
     ORDER BY t.tag, t.page_slug`
  ).all() as Array<{ tag: string; page_slug: string }>;
  for (const row of tagRows) {
    if (!eligibleRecords.has(row.page_slug)) continue;
    const key = `tag:${row.tag}`;
    let set = seedRecords.get(key);
    if (!set) { set = new Set(); seedRecords.set(key, set); }
    set.add(row.page_slug);
  }

  // Page types of every endpoint involved in provenanced or mention-shaped
  // links (one bounded query).
  const typeRows = db.rawDb.prepare(
    `SELECT DISTINCT p.slug, p.type FROM pages p WHERE p.type = 'record'
       OR p.type = 'entity' OR p.type LIKE 'entity/%'
       OR p.type = 'concept' OR p.type LIKE 'concept/%'`
  ).all() as Array<{ slug: string; type: string }>;
  const typeBySlug = new Map(typeRows.map((r) => [r.slug, r.type]));

  const linkRows = db.rawDb.prepare(
    `SELECT l.from_slug, l.to_slug, l.source_page_slug, l.trust_state
     FROM links l
     WHERE (l.trust_state IS NULL OR l.trust_state NOT IN ('rejected','superseded'))
     ORDER BY l.id`
  ).all() as Array<{ from_slug: string; to_slug: string; source_page_slug: string | null; trust_state: string | null }>;

  let missingProvenanceLinks = 0;
  for (const l of linkRows) {
    const fromType = typeBySlug.get(l.from_slug);
    const toType = typeBySlug.get(l.to_slug);
    const recordFrom = fromType === "record";
    const entityFrom = fromType !== undefined && isEntityOrConceptType(fromType);
    const entityTo = toType !== undefined && isEntityOrConceptType(toType);

    if (recordFrom && entityTo && l.source_page_slug == null) {
      // Legacy record→entity edge without provenance: no source to attribute
      // — exclude and report, never invent one.
      missingProvenanceLinks++;
      continue;
    }
    if (l.source_page_slug == null) continue;
    if (typeBySlug.get(l.source_page_slug) !== "record" || !eligibleRecords.has(l.source_page_slug)) continue;

    // Provenanced edge: every entity/concept endpoint of this link is seeded
    // by the provenance record. This covers explicit record→entity 提及
    // (from = provenance record) and entity↔entity relations alike; the
    // relation name (中文 提及 or anything else) is irrelevant.
    for (const [slug, isEntity] of [[l.from_slug, entityFrom], [l.to_slug, entityTo]] as const) {
      if (!isEntity || slug === l.source_page_slug) continue;
      const key = `entity:${slug}`;
      let set = seedRecords.get(key);
      if (!set) { set = new Set(); seedRecords.set(key, set); }
      set.add(l.source_page_slug);
    }
  }

  // Candidate titles: EVERY new candidate (tag or entity seed) uses the
  // stable local suffix `（主题）` — pages.title is globally UNIQUE, so a
  // tag/entity sharing a name with an existing page must not block the
  // topic, and the existing page is never overwritten or aliased. Keys and
  // membership are unaffected; an occupied suffixed title stays an explicit
  // blocked outcome (no random fallback names).
  const seedTitles = new Map<string, string>();
  for (const key of seedRecords.keys()) {
    if (key.startsWith("tag:")) {
      seedTitles.set(key, `${key.slice("tag:".length)}（主题）`);
    } else {
      const slug = key.slice("entity:".length);
      const title = db.getPageTitle(slug);
      if (!title) continue; // endpoint vanished; no stable title
      seedTitles.set(key, `${title}（主题）`);
    }
  }

  let belowMinimum = 0;
  const prelim: Array<{ key: string; title: string; records: string[] }> = [];
  // ALL seeds keep their full record map (any support, including seeds
  // hidden as duplicates in the preview and seeds that fell below three):
  // an EXISTING topic's derivation must follow its seed's real membership —
  // shrinking or growing — never silently fall back to the stale manifest
  // selection and reattest it.
  const allSeedRecords = new Map<string, string[]>();
  for (const [key, set] of seedRecords) {
    if (!seedTitles.has(key)) continue;
    const records = [...set].sort(compareStrings);
    allSeedRecords.set(key, records);
    if (records.length < MIN_NEW_TOPIC_SOURCES) {
      belowMinimum++;
      continue;
    }
    prelim.push({ key, title: seedTitles.get(key)!, records });
  }

  // Exact FULL source-set duplicate collapse (identical record sets, before
  // any capping). Deterministic representative: lowest key.
  const bySelection = new Map<string, typeof prelim>();
  for (const c of prelim) {
    const selectionKey = c.records.join("\x00");
    const group = bySelection.get(selectionKey);
    if (group) group.push(c);
    else bySelection.set(selectionKey, [c]);
  }
  const mergedDuplicateSeeds: Array<{ kept: string; merged: string[] }> = [];
  const candidates: TopicCandidateView[] = [];
  for (const group of bySelection.values()) {
    group.sort((a, b) => compareStrings(a.key, b.key));
    const kept = group[0];
    if (group.length > 1) {
      mergedDuplicateSeeds.push({ kept: kept.key, merged: group.slice(1).map((g) => g.key) });
    }
    const selection = kept.records.slice(0, MAX_SOURCES_PER_TOPIC);
    candidates.push({
      key: kept.key,
      title: kept.title,
      support: kept.records.length,
      sourceSlugs: selection,
      omittedSources: kept.records.length - selection.length,
    });
  }
  candidates.sort((a, b) => b.support - a.support || compareStrings(a.key, b.key));
  mergedDuplicateSeeds.sort((a, b) => compareStrings(a.kept, b.kept));

  return {
    candidates,
    seedRecords: allSeedRecords,
    seedTitles,
    excludedCounts: { belowMinimum, missingProvenanceLinks },
    mergedDuplicateSeeds,
  };
}

// ─── Job payload validation ───────────────────────────────────────────

type TopicJobAction = "preview" | "refresh" | "enable" | "disable";

interface TopicJobData {
  action: TopicJobAction;
  candidateKeys?: string[];
  scheduled?: boolean;
}

function parseTopicJobData(data: unknown): TopicJobData {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("TOPIC_JOB_INVALID_DATA: payload must be an object");
  }
  const v = data as Record<string, unknown>;
  const action = v.action;
  if (action !== "preview" && action !== "refresh" && action !== "enable" && action !== "disable") {
    throw new Error(`TOPIC_JOB_INVALID_DATA: unknown action ${String(action)}`);
  }
  let candidateKeys: string[] | undefined;
  if (v.candidateKeys !== undefined) {
    // Explicit selections are an ENABLE-only concept: refresh reconciles the
    // persisted selection/seed state and must never silently swallow a
    // caller-supplied subset. Rejecting keeps the payload contract honest.
    if (action !== "enable") {
      throw new Error("TOPIC_JOB_INVALID_DATA: candidateKeys is enable-only");
    }
    if (!Array.isArray(v.candidateKeys) || v.candidateKeys.length > MAX_CANDIDATE_KEYS) {
      throw new Error(`TOPIC_JOB_INVALID_DATA: candidateKeys must be an array of at most ${MAX_CANDIDATE_KEYS}`);
    }
    for (const k of v.candidateKeys) {
      if (typeof k !== "string" || !k || k.length > MAX_KEY_CHARS) {
        throw new Error("TOPIC_JOB_INVALID_DATA: candidateKeys entries must be non-empty strings of at most 200 chars");
      }
    }
    candidateKeys = v.candidateKeys as string[];
  }
  return { action, ...(candidateKeys ? { candidateKeys } : {}), ...(v.scheduled === true ? { scheduled: true } : {}) };
}

// ─── TopicMaintenance ─────────────────────────────────────────────────

export interface TopicMaintenanceDeps {
  db: CBrainDB;
  jobs: JobQueue;
  /** Absent when the runtime has no configured model: preview still works,
   *  refresh/enable report model_unavailable instead of crashing. */
  manager?: TopicManager;
  vaultPath: string;
  logger?: Logger;
}

/**
 * #510 Task 2 — one narrow module owning topic discovery, the `topic-wiki`
 * job registration and the scheduling lifecycle. Reuses the existing
 * JobQueue for execution (serial worker + AbortSignal/checkCancelled) and
 * the existing config table for enablement (`topic.enabled`, default off).
 *
 * Scheduling: a single `tick(now)` seam drives a 30-minute cadence plus one
 * daily reconciliation while enabled. Ticks enqueue at most one pending/
 * running scheduled job (exact SQL check — listJobs caps at 100 rows and
 * cannot prove absence); a daily request arriving while a job is active is
 * retained as a single follow-up, never dropped. Success and failure both
 * count as attempts, so a model failure can never hot-retry: the handler
 * completes the job with an error receipt and the next attempt waits for
 * the next due tick.
 *
 * Shutdown/disable: `stop()`/`disableNow()` clear the timer, cancel pending
 * topic jobs and abort the active topic job through the existing generic
 * `jobs.cancel(id)` (immediate control semantics the serial queue cannot
 * give a queued disable handler). The compiler rechecks cancellation at
 * every awaited mutation boundary, so a cancelled compile determinately
 * never publishes.
 */
export class TopicMaintenance {
  private readonly db: CBrainDB;
  private readonly jobs: JobQueue;
  private readonly manager: TopicManager | undefined;
  private readonly logger: Logger | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private lastAttemptAt = 0;
  private lastReconcileDayKey: string | null = null;
  private deferredReconcile = false;
  private activeExecution: Promise<unknown> | null = null;

  constructor(deps: TopicMaintenanceDeps) {
    this.db = deps.db;
    this.jobs = deps.jobs;
    this.manager = deps.manager;
    this.logger = deps.logger ?? null;
  }

  /** Register the `topic-wiki` handler on the existing queue. */
  register(): void {
    this.jobs.register(TOPIC_JOB_NAME, (data, jobId, execution) => this.handle(data, jobId, execution));
  }

  isEnabled(): boolean {
    return this.db.getConfig(ENABLED_CONFIG) === "true";
  }

  /**
   * Single-writer startup: recover EVERY prior running topic job row
   * regardless of age — this runtime holds the writer lock, so no competing
   * runtime can own a running topic job; any such row is dead work from a
   * crashed process (a TTL-only reset would leave a just-crashed row
   * blocking all future ticks forever). Only the topic job name is ever
   * touched. When enabled, the startup reconciliation goes through the
   * normal coalescing tick.
   */
  startup(now: number = Date.now()): void {
    try {
      this.db.rawDb
        .prepare("UPDATE jobs SET status = 'pending', started_at = NULL, finished_at = NULL WHERE name = ? AND status = 'running'")
        .run(TOPIC_JOB_NAME);
    } catch (e) {
      this.logger?.warn("topic", "启动恢复旧 topic job 失败", { error: String(e) });
    }
    if (this.isEnabled()) this.startTimer();
    this.tick(now);
  }

  /** Start the single cadence timer (idempotent; enabled runs only). */
  startTimer(): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => this.tick(Date.now()), TOPIC_TICK_MS);
    this.tick(Date.now());
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Cadence seam (fake-clock testable). Enqueues at most one scheduled
   * refresh job while enabled and due; returns true iff one was enqueued.
   */
  tick(now: number): boolean {
    if (this.stopping || !this.isEnabled()) return false;
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const dailyDue = dayKey !== this.lastReconcileDayKey;
    const due = now - this.lastAttemptAt >= TOPIC_TICK_MS;
    if (!due && !dailyDue && !this.deferredReconcile) return false;

    if (this.hasActiveJob()) {
      // One scheduled job at a time; a daily request stays pending as a
      // single follow-up instead of being lost.
      if (dailyDue) this.deferredReconcile = true;
      return false;
    }
    const reconcile = dailyDue || this.deferredReconcile;
    this.lastAttemptAt = now;
    this.lastReconcileDayKey = dayKey;
    this.deferredReconcile = false;
    this.db.submitJob(TOPIC_JOB_NAME, { action: "refresh", scheduled: true, reconcile });
    return true;
  }

  private hasActiveJob(): boolean {
    const row = this.db.rawDb
      .prepare("SELECT id FROM jobs WHERE name = ? AND status IN ('pending','running') LIMIT 1")
      .get(TOPIC_JOB_NAME) as { id: number } | null | undefined;
    // bun:sqlite returns null (not undefined) for no rows.
    return row != null;
  }

  /** Pending/running rows of this job name (pending auto work + cancel
   *  targets). The disable row itself is only submitted after cancelling. */
  private listActiveJobs(): Array<{ id: number; status: string; data: string | null }> {
    return this.db.rawDb
      .prepare("SELECT id, status, data FROM jobs WHERE name = ? AND status IN ('pending','running') ORDER BY id")
      .all(TOPIC_JOB_NAME) as Array<{ id: number; status: string; data: string | null }>;
  }

  // ─── Handler ──────────────────────────────────────────────────────

  /** The `topic-wiki` job handler (also directly callable in tests). */
  async handle(data: unknown, _jobId: number, execution: JobExecution): Promise<unknown> {
    const parsed = parseTopicJobData(data);
    if (this.stopping) return { action: parsed.action, skipped: "stopping" };
    const run = this.dispatch(parsed, execution);
    this.activeExecution = run;
    try {
      return await run;
    } finally {
      this.activeExecution = null;
    }
  }

  private async dispatch(parsed: TopicJobData, execution: JobExecution): Promise<unknown> {
    switch (parsed.action) {
      case "preview":
        return this.preview();
      case "refresh":
        return this.runRefresh(parsed, execution);
      case "enable":
        return this.runEnable(parsed, execution);
      case "disable":
        // Idempotent re-apply of the immediate control path.
        this.applyDisableState();
        return { action: "disable", enabled: false };
    }
  }

  // ─── Preview (read-only; never writes config or calls the model) ──

  preview(): TopicPreviewReport {
    const discovery = discoverTopicCandidates(this.db);
    const catalog = computeCatalogFingerprint(this.db);
    const managed = this.listManagedTopics();
    return {
      enabled: this.isEnabled(),
      catalogFingerprint: catalog,
      candidates: discovery.candidates,
      managedTopics: managed.map((t) => ({
        slug: t.slug,
        title: t.manifest.title,
        freshness: this.manager ? (this.manager.inspectFreshness(t.slug)?.state ?? "unknown") : "unknown",
        catalogAttested: t.manifest.catalog === catalog,
      })),
      spareSlots: Math.max(0, MAX_MANAGED_TOPICS - managed.length),
      excludedCounts: discovery.excludedCounts,
      mergedDuplicateSeeds: discovery.mergedDuplicateSeeds,
    };
  }

  // ─── Refresh / reconciliation ─────────────────────────────────────

  private async runRefresh(_parsed: TopicJobData, execution: JobExecution): Promise<TopicRunReceipt> {
    if (!this.isEnabled()) {
      return this.emptyReceipt("refresh", "skipped:disabled");
    }
    if (!this.manager) {
      return this.emptyReceipt("refresh", "skipped:model_unavailable");
    }
    const catalog = computeCatalogFingerprint(this.db);
    const discovery = discoverTopicCandidates(this.db);
    const receipt: TopicRunReceipt = {
      action: "refresh",
      catalogFingerprint: catalog,
      managed: [],
      created: [],
      blocked: [],
      counts: { refreshed: 0, unchanged: 0, reattested: 0, skipped: 0, created: 0, blocked: 0 },
    };

    // 1. Maintain existing topics first: they keep identity and selection;
    //    spare slots are filled only afterwards.
    const managed = this.listManagedTopics();
    for (const topic of managed) {
      if (this.stopping) break;
      const entry = await this.maintainOne(topic, catalog, discovery, execution, receipt);
      receipt.managed.push(entry);
    }

    // 2. Fill spare slots. A retained explicit selection takes priority and
    //    stays AUTHORITATIVE: while an explicit selection was ever made
    //    (topic.selection_mode=explicit), scheduled filling never falls back
    //    to unrelated ranked candidates — not after a partial failure, and
    //    not after every selected topic succeeded (an empty pruned
    //    pending_selection must not silently re-open generic auto-fill).
    let spare = Math.max(0, MAX_MANAGED_TOPICS - managed.length);
    if (spare > 0) {
      const pending = this.readPendingSelection();
      if (pending.length > 0) {
        for (const key of pending) {
          if (spare <= 0 || this.stopping) break;
          const outcome = await this.createForKey(key, discovery, catalog, execution, receipt);
          if (outcome === "created") spare--;
        }
        // Created keys are pruned by createForKey; failed keys stay pending.
      } else if (this.db.getConfig(SELECTION_MODE_CONFIG) !== "explicit") {
        const materialized = new Set(managed.map((t) => t.manifest.seed?.key).filter(Boolean) as string[]);
        for (const candidate of discovery.candidates) {
          if (spare <= 0 || this.stopping) break;
          if (materialized.has(candidate.key)) continue;
          const outcome = await this.createForKey(candidate.key, discovery, catalog, execution, receipt);
          if (outcome === "created") spare--;
        }
      }
    }
    return receipt;
  }

  private async maintainOne(
    topic: { slug: string; manifest: TopicManifest },
    catalog: string,
    discovery: DiscoveryResult,
    execution: JobExecution,
    receipt: TopicRunReceipt,
  ): Promise<{ slug: string; title: string; outcome: string; reason?: string }> {
    const manager = this.manager!;
    const { slug, manifest } = topic;
    const base = { slug, title: manifest.title };

    const freshness = manager.inspectFreshness(slug);
    if (!freshness) return { ...base, outcome: "skipped", reason: "not_a_topic" };
    if (freshness.editedByUser) {
      receipt.counts.skipped++;
      return { ...base, outcome: "skipped", reason: "target_edited" };
    }

    // Re-derive the selection from the persisted seed identity. A seeded
    // topic with ZERO current members derives an EMPTY selection — it stays
    // blocked/stale rather than silently reverting to the old manifest
    // membership (which could reattest a catalog for vanished inputs). Only
    // genuinely seedless (Task 1 / direct compile) topics retain the exact
    // manifest selection.
    const derived = manifest.seed
      ? (discovery.seedRecords.get(manifest.seed.key) ?? [])
      : manifest.sources.map((s) => s.slug);
    const selection = derived.slice(0, MAX_SOURCES_PER_TOPIC).sort(compareStrings);
    const currentSelection = manifest.sources.map((s) => s.slug).sort(compareStrings);
    const sameSelection = selection.length === currentSelection.length
      && selection.every((s, i) => s === currentSelection[i]);

    if (manifest.catalog === catalog) {
      if (freshness.state === "fresh") {
        receipt.counts.unchanged++;
        return { ...base, outcome: "unchanged" };
      }
    } else if (freshness.state === "fresh" && sameSelection) {
      // Catalog changed but this topic's chosen inputs did not: metadata-only
      // reattestation, no model call.
      const reattest = manager.reattestCatalog(slug, catalog);
      if (reattest?.status === "reattested") {
        receipt.counts.reattested++;
        return { ...base, outcome: "reattested" };
      }
      if (reattest?.status === "unchanged") {
        receipt.counts.unchanged++;
        return { ...base, outcome: "unchanged" };
      }
    }

    const result = await this.compileQuietly(
      { title: manifest.title, sourceSlugs: selection, seed: manifest.seed, catalogFingerprint: catalog, checkCancelled: this.combineCancellation(execution), signal: execution.signal },
      receipt,
      { slug, title: manifest.title },
    );
    return { ...base, outcome: result };
  }

  /** Compile with infra failures captured as blocked receipts (never thrown)
   *  so the serial queue does not hot-retry model/index errors. The job's
   *  AbortSignal is threaded through to the compiler AND the LLM provider so
   *  an HTTP shutdown aborts the actual in-flight request promptly —
   *  checkCancelled alone would only be observed between awaits. */
  private async compileQuietly(
    request: { title: string; sourceSlugs: string[]; seed?: TopicSeed; catalogFingerprint?: string; checkCancelled: () => void; signal?: AbortSignal },
    receipt: TopicRunReceipt,
    identity: { key?: string; slug?: string; title?: string },
  ): Promise<string> {
    if (!this.manager) {
      receipt.counts.blocked++;
      receipt.blocked.push({ ...identity, reason: "model_unavailable" });
      return "blocked";
    }
    try {
      const result = await this.manager.compile(request);
      if (result.status === "created") {
        receipt.counts.created++;
        receipt.created.push({ ...(identity.key ? { key: identity.key } : {}), slug: result.slug, title: request.title });
        return "created";
      }
      if (result.status === "refreshed") {
        receipt.counts.refreshed++;
        return "refreshed";
      }
      if (result.status === "unchanged") {
        receipt.counts.unchanged++;
        return "unchanged";
      }
      receipt.counts.blocked++;
      receipt.blocked.push({ ...identity, ...(result.slug ? { slug: result.slug } : {}), reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) });
      return "blocked";
    } catch (e) {
      if (this.stopping) throw e; // cancellation during shutdown must propagate
      receipt.counts.blocked++;
      const reason = e instanceof Error && (e.name === "TopicIndexFailedError" || e.name === "TopicRollbackError")
        ? e.name === "TopicRollbackError" ? "rollback_incomplete" : "index_failed"
        : "model_error";
      receipt.blocked.push({ ...identity, reason });
      this.logger?.warn("topic", "主题编译失败", { reason, error: e instanceof Error ? e.message : String(e) });
      return "blocked";
    }
  }

  private async createForKey(
    key: string,
    discovery: DiscoveryResult,
    catalog: string,
    execution: JobExecution,
    receipt: TopicRunReceipt,
  ): Promise<"created" | "blocked" | "skipped"> {
    const records = discovery.seedRecords.get(key);
    const title = discovery.seedTitles.get(key);
    if (!records || !title || records.length < MIN_NEW_TOPIC_SOURCES) {
      // Not creatable right now. Explicit selections stay pending for retry;
      // ranked candidates simply drop out of this run.
      if (this.readPendingSelection().includes(key)) {
        receipt.counts.blocked++;
        receipt.blocked.push({ key, reason: records ? "too_few_sources" : "unknown_candidate" });
      }
      return "skipped";
    }
    // Seed identity namespace: the manifest persists the FULL candidate key
    // (`tag:<tag>` / `entity:<slug>`) — the same string maintainOne looks up
    // in the discovery map on every later run.
    const seed: TopicSeed = { kind: key.startsWith("tag:") ? "tag" : "entity", key };
    const outcome = await this.compileQuietly(
      { title, sourceSlugs: records.slice(0, MAX_SOURCES_PER_TOPIC), seed, catalogFingerprint: catalog, checkCancelled: this.combineCancellation(execution), signal: execution.signal },
      receipt,
      { key, title },
    );
    if (outcome === "created") this.prunePendingSelection(key);
    return outcome === "created" ? "created" : "blocked";
  }

  // ─── Enable / disable ─────────────────────────────────────────────

  private async runEnable(parsed: TopicJobData, execution: JobExecution): Promise<unknown> {
    if (!this.manager) {
      return { action: "enable", enabled: false, skipped: "model_unavailable" };
    }
    if (parsed.candidateKeys && parsed.candidateKeys.length > 0) {
      // Validate against CURRENT discovery candidates (creatable seeds with
      // a title and >= 3 distinct records) before persisting anything.
      const discovery = discoverTopicCandidates(this.db);
      const candidateKeys = new Set(discovery.candidates.map((c) => c.key));
      const invalidKeys = parsed.candidateKeys.filter((k) => !candidateKeys.has(k));
      if (invalidKeys.length > 0) {
        return { action: "enable", enabled: false, invalidKeys };
      }
    }

    // Durability first: enablement and the explicit selection are persisted
    // BEFORE execution, so a crash mid-creation leaves a scheduler that
    // retries the SAME selection instead of auto-filling generic candidates.
    // An explicit selection is AUTHORITATIVE until the operator re-enables
    // without one: while selection_mode=explicit, scheduled filling never
    // creates generic ranked candidates.
    this.db.setConfig(ENABLED_CONFIG, "true");
    if (parsed.candidateKeys && parsed.candidateKeys.length > 0) {
      this.db.setConfig(PENDING_SELECTION_CONFIG, JSON.stringify(parsed.candidateKeys));
      this.db.setConfig(SELECTION_MODE_CONFIG, "explicit");
    } else {
      try { this.db.deleteConfig(SELECTION_MODE_CONFIG); } catch { /* best effort */ }
    }
    this.startTimer();

    const created: Array<{ key: string; slug: string; title: string }> = [];
    const blocked: Array<{ key: string; reason: string }> = [];
    if (parsed.candidateKeys && parsed.candidateKeys.length > 0) {
      const catalog = computeCatalogFingerprint(this.db);
      const discovery = discoverTopicCandidates(this.db);
      // The MAX_MANAGED_TOPICS pilot bound holds across EVERY creation path,
      // including repeated explicit enables — never only the scheduled fill.
      let spare = Math.max(0, MAX_MANAGED_TOPICS - this.listManagedTopics().length);
      for (const key of parsed.candidateKeys) {
        if (this.stopping) break;
        if (spare <= 0) {
          blocked.push({ key, reason: "at_capacity" });
          continue;
        }
        const receipt: TopicRunReceipt = {
          action: "enable", catalogFingerprint: catalog, managed: [], created: [], blocked: [],
          counts: { refreshed: 0, unchanged: 0, reattested: 0, skipped: 0, created: 0, blocked: 0 },
        };
        await this.createForKey(key, discovery, catalog, execution, receipt);
        if (receipt.counts.created > 0) spare -= receipt.counts.created;
        created.push(...receipt.created.map((c) => ({ key, slug: c.slug, title: c.title })));
        for (const b of receipt.blocked) blocked.push({ key, reason: b.reason });
      }
    }
    return {
      action: "enable",
      enabled: true,
      ...(parsed.candidateKeys ? { requestedKeys: parsed.candidateKeys } : {}),
      created,
      blocked,
      pendingSelection: this.readPendingSelection(),
    };
  }

  /** Immediate disable control semantics (used by the topic-only submit hook
   *  and by the handler's idempotent re-apply): stop scheduling, cancel the
   *  pending scheduled work and ABORT the active topic execution through the
   *  existing generic jobs.cancel — a queued disable handler could never
   *  cancel a refresh that runs before it in the serial queue. */
  disableNow(): void {
    this.applyDisableState();
    const active = this.listActiveJobs();
    for (const job of active) {
      try { this.jobs.cancel(job.id); } catch { /* already terminal */ }
    }
  }

  private applyDisableState(): void {
    this.stopTimer();
    try { this.db.setConfig(ENABLED_CONFIG, "false"); } catch { /* best effort */ }
  }

  /**
   * Shutdown: stop scheduling, cancel pending topic jobs, abort the active
   * topic execution, and hold the caller — which releases the writer lock
   * only after this resolves — until that execution ACTUALLY settles. A
   * cancellation arriving during an index await triggers compensation that
   * itself writes (old raw restore through the pipeline queue), so a
   * deadline race would return an apparent successful drain while writes
   * were still in flight. The abort is threaded to the model provider via
   * the compile signal, so settlement is prompt, but it is never cut short.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopTimer();
    for (const job of this.listActiveJobs()) {
      try { this.jobs.cancel(job.id); } catch { /* already terminal */ }
    }
    const inflight = this.activeExecution;
    if (inflight) {
      await inflight.then(
        () => undefined,
        () => undefined,
      );
    }
  }

  /**
   * Topic-only submit hook for the existing job tool: validates the payload
   * early, gives `disable` its immediate control semantics (while keeping
   * the normal job receipt as the audit row), and coalesces repeated
   * explicit refreshes onto one pending/running REFRESH job. Coalescing is
   * action-scoped: a running preview/enable never swallows a fresh refresh,
   * and an enable with new candidateKeys always submits its own row.
   * Returns null when the plain submit path should handle it (maintenance
   * not registered / invalid payload — the handler then fails the row with
   * a clear error).
   */
  controlSubmit(data: unknown, priority?: number): { id: number; coalesced: boolean } | null {
    let parsed: TopicJobData;
    try {
      parsed = parseTopicJobData(data);
    } catch {
      return null;
    }
    if (this.stopping) return null;
    if (parsed.action === "disable") {
      this.disableNow();
      return { id: this.db.submitJob(TOPIC_JOB_NAME, { action: "disable" }, priority), coalesced: false };
    }
    if (parsed.action === "refresh") {
      const existing = this.listActiveJobs().find((j) => {
        try {
          const d = j.data ? JSON.parse(j.data) as Record<string, unknown> : {};
          return d?.action === "refresh";
        } catch { return false; }
      });
      if (existing) return { id: existing.id, coalesced: true };
    }
    return { id: this.db.submitJob(TOPIC_JOB_NAME, parsed, priority), coalesced: false };
  }

  // ─── Shared helpers ───────────────────────────────────────────────

  private combineCancellation(execution: JobExecution): () => void {
    return () => {
      execution.checkCancelled();
      if (this.stopping) throw new Error("TOPIC_MAINTENANCE_STOPPING");
    };
  }

  private emptyReceipt(action: "refresh", skipped: string): TopicRunReceipt {
    return {
      action,
      catalogFingerprint: computeCatalogFingerprint(this.db),
      skipped,
      managed: [],
      created: [],
      blocked: [],
      counts: { refreshed: 0, unchanged: 0, reattested: 0, skipped: 1, created: 0, blocked: 0 },
    };
  }

  private listManagedTopics(): Array<{ slug: string; manifest: TopicManifest }> {
    return this.db.listPageSlugs({ type: TOPIC_PAGE_TYPE }).flatMap((slug) => {
      if (!this.manager) return [];
      const read = this.manager.readTopicManifest(slug);
      if (!read || !read.manifest) return []; // unmanaged/corrupt: never adopted
      return [{ slug, manifest: read.manifest }];
    });
  }

  private readPendingSelection(): string[] {
    const raw = this.db.getConfig(PENDING_SELECTION_CONFIG);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((k): k is string => typeof k === "string" && k.length > 0);
    } catch {
      return [];
    }
  }

  private prunePendingSelection(createdKey: string): void {
    const remaining = this.readPendingSelection().filter((k) => k !== createdKey);
    if (remaining.length === 0) {
      try { this.db.deleteConfig(PENDING_SELECTION_CONFIG); } catch { /* best effort */ }
    } else {
      this.db.setConfig(PENDING_SELECTION_CONFIG, JSON.stringify(remaining));
    }
  }
}

// ─── Runtime registration (one per runtime, never per MCP session) ────

export interface TopicWorkerDeps {
  db: CBrainDB;
  jobs: JobQueue;
  pages: import("../page.js").PageManager;
  pipeline: import("../ingestion/pipeline.js").ContentPipeline;
  versions: import("../version.js").VersionManager;
  lance: import("../../storage/lancedb.js").LanceDBManager;
  llm?: import("../../llm/provider.js").LLMProvider;
  vaultPath: string;
  logger?: Logger;
}

/**
 * Register the topic worker once per runtime (call from the shared
 * registerDreamWorker site — NOT from attachMcpTools, which runs once per
 * HTTP MCP session). Constructs the compiler from the normal configured NER
 * provider dependency, registers the `topic-wiki` handler, runs the
 * single-writer startup recovery, and starts the cadence timer only when
 * enablement is already on.
 */
export function registerTopicWorker(deps: TopicWorkerDeps): TopicMaintenance {
  const manager = deps.llm
    ? new TopicManager({
        db: deps.db,
        pages: deps.pages,
        pipeline: deps.pipeline,
        versions: deps.versions,
        lance: deps.lance,
        llm: deps.llm,
        logger: deps.logger,
      })
    : undefined;
  const maintenance = new TopicMaintenance({
    db: deps.db,
    jobs: deps.jobs,
    ...(manager ? { manager } : {}),
    vaultPath: deps.vaultPath,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  maintenance.register();
  maintenance.startup();
  return maintenance;
}
