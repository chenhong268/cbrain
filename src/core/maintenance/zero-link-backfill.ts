import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isCurrentFactLink } from "../shared.js";
import type { NerSourceKind } from "../ingestion/ner-backfill-contract.js";
export {
  ZERO_LINK_BATCH_MANIFEST_JOB,
  ZERO_LINK_REPAIR_NAME,
  ZERO_LINK_REPAIR_VERSION,
} from "../ingestion/ner-backfill-contract.js";

export const ZERO_LINK_MIN_RAW_CHUNKS = 2;
export const ZERO_LINK_MIN_RAW_CHARS = 1000;
export const ZERO_LINK_MIN_TAGS = 3;
export const ZERO_LINK_JOB_PRIORITY_BASE = 1000;

export interface ZeroLinkDb {
  rawDb: Database;
}

export interface ZeroLinkCandidate {
  slug: string;
  contentHash: string | null;
  contentFingerprint: string | null;
  sourceKind: NerSourceKind | null;
  rawChunkCount: number;
  rawCharCount: number;
  tagCount: number;
}

export interface PublicZeroLinkCandidate {
  rawChunkCount: number;
  rawCharCount: number;
  tagCount: number;
}

interface CandidateAggregateRow {
  slug: string;
  type: string;
  content_hash: string | null;
  raw_chunk_count: number;
  raw_char_count: number;
  tag_count: number;
}

interface SourceChunkRow {
  id: number;
  chunk_index: number;
  content: string;
}

export interface ZeroLinkSource {
  contentFingerprint: string | null;
  sourceKind: NerSourceKind | null;
}

export interface ZeroLinkBackfillReport {
  version: 1;
  mode: "dry_run" | "enqueue";
  status: "ok" | "blocked" | "error";
  batchId?: string;
  total: number;
  actionable: number;
  selected: number;
  newJobs: number;
  requeuedJobs: number;
  active: number;
  cancelled: number;
  resolved: number;
  terminalNoGraphLinks: number;
  blockedSourceUnavailable: number;
  sourceChanged: number;
  invalidTerminal: number;
  commitUnknown: number;
  lostLink: number;
  unverifiableFingerprint: number;
  failed: number;
  staleRunning: number;
  stateConflicts: number;
  queueIntegrityConflicts: number;
  thresholds: { rawChunks: number; rawChars: number; tags: number; union: number };
}

export interface RepairBatchStatus {
  version: 1;
  batchId: string;
  finalized: boolean;
  integrityConflicts: number;
  selected: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  outcomes: {
    resolved: number;
    terminalNoGraphLinks: number;
    blockedSourceUnavailable: number;
    sourceChanged: number;
    invalidTerminal: number;
    commitUnknown: number;
  };
}

type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";
interface JobRow {
  id: number;
  name: string;
  status: JobStatus;
  priority: number;
  data: string | null;
  result: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface RepairMarker {
  name: string;
  version: number;
  contentFingerprint: string;
  sourceKind: NerSourceKind;
  batchId: string;
}

interface ParsedNerData {
  slug: string;
  kind: "ner" | "entity_facts";
  contentHash?: string | null;
  sourceFingerprint?: string;
  repair?: RepairMarker;
  attemptLease?: { version: 1; token: string; phase: "claimed" | "committing" };
}

interface OwnershipEntry {
  jobId: number;
  slug: string;
  contentFingerprint: string;
}

interface FinalizedEntry extends OwnershipEntry {
  terminalStatus: "done" | "failed" | "cancelled";
  graphOutcome: "resolved" | "terminal_no_graph_links" | "blocked_source_unavailable" | "source_changed" | "invalid_terminal" | null;
}

interface ParsedManifest {
  row: JobRow;
  batchId: string;
  ownership: OwnershipEntry[];
  finalized: boolean;
  finalizedEntries: FinalizedEntry[];
}

type CandidateDisposition =
  | "new"
  | "legacy_requeue"
  | "content_changed_requeue"
  | "stale_requeue"
  | "active"
  | "cancelled"
  | "resolved"
  | "terminal_no_graph_links"
  | "blocked_source_unavailable"
  | "source_changed"
  | "invalid_terminal"
  | "commit_unknown"
  | "lost_link"
  | "unverifiable_fingerprint"
  | "failed";

interface CandidatePlan {
  candidate: ZeroLinkCandidate;
  disposition: CandidateDisposition;
  rowId?: number;
  staleRunning?: boolean;
  stateConflict?: boolean;
}

interface QueueAudit {
  rows: JobRow[];
  parsedById: Map<number, ParsedNerData>;
  manifests: ParsedManifest[];
  manifestByBatchId: Map<string, ParsedManifest>;
  latestOwnershipByJobId: Map<number, ParsedManifest>;
  queueIntegrityConflicts: number;
  commitUnknown: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set<JobStatus>(["pending", "running"]);
const ACTIONABLE = new Set<CandidateDisposition>(["new", "legacy_requeue", "content_changed_requeue", "stale_requeue"]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try { return objectValue(JSON.parse(raw)); } catch { return null; }
}

function validFingerprint(value: unknown, sourceKind: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (sourceKind === "vault_hash") return value.startsWith("page:") && value.length > 5;
  if (sourceKind === "raw_chunks") return /^derived:[0-9a-f]{64}$/.test(value);
  return false;
}

function parseRepair(value: unknown): RepairMarker | null {
  const repair = objectValue(value);
  if (!repair || repair.name !== "zero-link-rich-records" || repair.version !== 1) return null;
  if (!UUID_RE.test(String(repair.batchId ?? ""))) return null;
  if (!validFingerprint(repair.contentFingerprint, repair.sourceKind)) return null;
  return {
    name: String(repair.name),
    version: Number(repair.version),
    contentFingerprint: String(repair.contentFingerprint),
    sourceKind: repair.sourceKind as NerSourceKind,
    batchId: String(repair.batchId),
  };
}

function parseNerData(raw: string | null): ParsedNerData | null {
  const data = parseJsonObject(raw);
  if (!data || typeof data.slug !== "string" || data.slug.trim().length === 0) return null;
  const kind = data.kind === undefined || data.kind === "ner" ? "ner" : data.kind === "entity_facts" ? "entity_facts" : null;
  if (!kind) return null;
  const parsed: ParsedNerData = { slug: data.slug, kind };
  if (data.contentHash === null || typeof data.contentHash === "string") parsed.contentHash = data.contentHash;
  if (typeof data.sourceFingerprint === "string") parsed.sourceFingerprint = data.sourceFingerprint;
  if (data.repair !== undefined) {
    const repair = parseRepair(data.repair);
    if (!repair || kind !== "ner") return null;
    parsed.repair = repair;
  }
  const lease = objectValue(data.attemptLease);
  if (lease) {
    if (lease.version !== 1 || typeof lease.token !== "string" || lease.token.length === 0 || (lease.phase !== "claimed" && lease.phase !== "committing")) return null;
    parsed.attemptLease = { version: 1, token: lease.token, phase: lease.phase };
  }
  return parsed;
}

function parseOwnership(value: unknown): OwnershipEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seenJobs = new Set<number>();
  const entries: OwnershipEntry[] = [];
  for (const raw of value) {
    const entry = objectValue(raw);
    const jobId = Number(entry?.jobId);
    if (!entry || !Number.isSafeInteger(jobId) || jobId <= 0 || seenJobs.has(jobId) || typeof entry.slug !== "string" || entry.slug.length === 0 || typeof entry.contentFingerprint !== "string" || entry.contentFingerprint.length === 0) return null;
    seenJobs.add(jobId);
    entries.push({ jobId, slug: entry.slug, contentFingerprint: entry.contentFingerprint });
  }
  return entries;
}

function manifestDiscriminator(data: Record<string, unknown> | null): boolean {
  return Boolean(data && data.version === 1 && data.repairName === "zero-link-rich-records" && typeof data.batchId === "string" && Array.isArray(data.ownership));
}

function readAllJobs(db: ZeroLinkDb): JobRow[] {
  return db.rawDb.prepare(
    `SELECT id, name, status, priority, data, result, error, attempts, max_attempts,
            created_at, started_at, finished_at
     FROM jobs ORDER BY id ASC`,
  ).all() as JobRow[];
}

function canonicalLedgerDigest(batchId: string, entries: FinalizedEntry[]): string {
  const canonical = {
    version: 1,
    batchId,
    entries: entries.map((entry) => ({
      jobId: entry.jobId,
      slug: entry.slug,
      contentFingerprint: entry.contentFingerprint,
      terminalStatus: entry.terminalStatus,
      graphOutcome: entry.graphOutcome,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function parseManifestRow(row: JobRow): ParsedManifest | null {
  const data = parseJsonObject(row.data);
  if (!data || data.version !== 1 || data.repairName !== "zero-link-rich-records" || !UUID_RE.test(String(data.batchId ?? ""))) return null;
  const ownership = parseOwnership(data.ownership);
  if (!ownership) return null;
  const result = parseJsonObject(row.result);
  if (!result || typeof result.finalized !== "boolean") return null;
  let finalizedEntries: FinalizedEntry[] = [];
  if (result.finalized) {
    if (!Array.isArray(data.finalizedEntries) || data.finalizedEntries.length !== ownership.length) return null;
    finalizedEntries = [];
    for (let i = 0; i < data.finalizedEntries.length; i++) {
      const value = objectValue(data.finalizedEntries[i]);
      const owner = ownership[i];
      if (!value || Number(value.jobId) !== owner.jobId || value.slug !== owner.slug || value.contentFingerprint !== owner.contentFingerprint) return null;
      if (value.terminalStatus !== "done" && value.terminalStatus !== "failed" && value.terminalStatus !== "cancelled") return null;
      const outcome = value.graphOutcome;
      if (outcome !== null && outcome !== "resolved" && outcome !== "terminal_no_graph_links" && outcome !== "blocked_source_unavailable" && outcome !== "source_changed" && outcome !== "invalid_terminal") return null;
      finalizedEntries.push({ ...owner, terminalStatus: value.terminalStatus, graphOutcome: outcome });
    }
    if (typeof data.ledgerDigest !== "string" || data.ledgerDigest !== canonicalLedgerDigest(String(data.batchId), finalizedEntries)) return null;
  }
  return { row, batchId: String(data.batchId), ownership, finalized: result.finalized, finalizedEntries };
}

function isStale(row: JobRow, now = Date.now(), ttlMs = 30 * 60 * 1000): boolean {
  if (!row.started_at) return true;
  const parsed = Date.parse(row.started_at.endsWith("Z") ? row.started_at : `${row.started_at.replace(" ", "T")}Z`);
  return !Number.isFinite(parsed) || now - parsed >= ttlMs;
}

function readOutcome(row: JobRow): Record<string, unknown> | null {
  return parseJsonObject(row.result);
}

function auditQueue(db: ZeroLinkDb): QueueAudit {
  const rows = readAllJobs(db);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parsedById = new Map<number, ParsedNerData>();
  const manifests: ParsedManifest[] = [];
  const manifestByBatchId = new Map<string, ParsedManifest>();
  const latestOwnershipByJobId = new Map<number, ParsedManifest>();
  let conflicts = 0;

  for (const row of rows) {
    const dataObject = parseJsonObject(row.data);
    const manifestLike = row.name === "zero-link-backfill-batch" || manifestDiscriminator(dataObject);
    if (manifestLike) {
      const parsed = parseManifestRow(row);
      if (!parsed || row.name !== "zero-link-backfill-batch" || row.status !== "done" || manifestByBatchId.has(parsed.batchId)) {
        conflicts++;
        continue;
      }
      manifests.push(parsed);
      manifestByBatchId.set(parsed.batchId, parsed);
      for (const owner of parsed.ownership) {
        const previous = latestOwnershipByJobId.get(owner.jobId);
        if (!previous || previous.row.id < row.id) latestOwnershipByJobId.set(owner.jobId, parsed);
      }
    }
  }

  for (const row of rows) {
    if (row.name !== "ner-backfill") continue;
    const parsed = parseNerData(row.data);
    if (parsed) parsedById.set(row.id, parsed);
    if (ACTIVE_STATUSES.has(row.status) && !parsed) conflicts++;
    const raw = parseJsonObject(row.data);
    if (raw?.repair !== undefined && !parsed?.repair) conflicts++;
    if (parsed?.repair) {
      const manifest = manifestByBatchId.get(parsed.repair.batchId);
      const owner = manifest?.ownership.find((entry) => entry.jobId === row.id);
      if (!manifest || !owner || owner.slug !== parsed.slug || owner.contentFingerprint !== parsed.repair.contentFingerprint) conflicts++;
    }
  }

  for (const manifest of manifests) {
    if (manifest.finalized) continue;
    for (const owner of manifest.ownership) {
      const child = byId.get(owner.jobId);
      const data = parsedById.get(owner.jobId);
      if (!child || child.name !== "ner-backfill" || !data?.repair || data.slug !== owner.slug || data.repair.batchId !== manifest.batchId || data.repair.contentFingerprint !== owner.contentFingerprint) conflicts++;
    }
    for (const [jobId, data] of parsedById) {
      if (data.repair?.batchId === manifest.batchId && !manifest.ownership.some((entry) => entry.jobId === jobId)) conflicts++;
    }
  }

  let commitUnknown = 0;
  for (const row of rows) {
    if (row.name !== "ner-backfill") continue;
    const parsed = parsedById.get(row.id);
    const outcome = readOutcome(row)?.outcome;
    if ((row.status === "done" && outcome === "commit_unknown") || (row.status === "running" && parsed?.attemptLease?.phase === "committing" && isStale(row))) commitUnknown++;
  }

  return { rows, parsedById, manifests, manifestByBatchId, latestOwnershipByJobId, queueIntegrityConflicts: conflicts, commitUnknown };
}

function activeCurrentLinkSlugs(db: ZeroLinkDb): Set<string> {
  const rows = db.rawDb.prepare(
    "SELECT from_slug, to_slug, relation, trust_state FROM links",
  ).all() as Array<{
    from_slug: string;
    to_slug: string;
    relation: string;
    trust_state: string | null;
  }>;
  const connected = new Set<string>();
  for (const row of rows) {
    if (row.from_slug === row.to_slug) continue;
    if (row.trust_state === "rejected" || row.trust_state === "superseded") continue;
    if (!isCurrentFactLink(row)) continue;
    connected.add(row.from_slug);
    connected.add(row.to_slug);
  }
  return connected;
}

function readCandidateAggregates(db: ZeroLinkDb): CandidateAggregateRow[] {
  return db.rawDb.prepare(`
    WITH raw_chunks AS (
      SELECT page_slug,
             COUNT(*) AS raw_chunk_count,
             COALESCE(SUM(LENGTH(content)), 0) AS raw_char_count
      FROM chunks
      WHERE summary_level = 0
      GROUP BY page_slug
    ), tag_counts AS (
      SELECT page_slug, COUNT(*) AS tag_count
      FROM tags
      GROUP BY page_slug
    )
    SELECT p.slug,
           p.type,
           p.content_hash,
           COALESCE(c.raw_chunk_count, 0) AS raw_chunk_count,
           COALESCE(c.raw_char_count, 0) AS raw_char_count,
           COALESCE(t.tag_count, 0) AS tag_count
    FROM pages p
    LEFT JOIN raw_chunks c ON c.page_slug = p.slug
    LEFT JOIN tag_counts t ON t.page_slug = p.slug
    WHERE p.type = 'record'
      AND (
        COALESCE(c.raw_chunk_count, 0) >= $minChunks
        OR COALESCE(c.raw_char_count, 0) >= $minChars
        OR COALESCE(t.tag_count, 0) >= $minTags
      )
    ORDER BY raw_char_count DESC, raw_chunk_count DESC, tag_count DESC, p.slug ASC
  `).all({
    $minChunks: ZERO_LINK_MIN_RAW_CHUNKS,
    $minChars: ZERO_LINK_MIN_RAW_CHARS,
    $minTags: ZERO_LINK_MIN_TAGS,
  }) as CandidateAggregateRow[];
}

export function deriveZeroLinkSource(db: ZeroLinkDb, slug: string): ZeroLinkSource {
  const page = db.rawDb.prepare(
    "SELECT type, content_hash FROM pages WHERE slug = ?",
  ).get(slug) as { type: string; content_hash: string | null } | null;
  if (!page) return { contentFingerprint: null, sourceKind: null };

  const sealed = Boolean(db.rawDb.prepare(
    "SELECT 1 FROM chunks WHERE page_slug = ? AND summary_level = 1 LIMIT 1",
  ).get(slug));

  if (!sealed) {
    const pageHash = page.content_hash?.trim();
    return pageHash
      ? { contentFingerprint: `page:${pageHash}`, sourceKind: "vault_hash" }
      : { contentFingerprint: null, sourceKind: null };
  }

  const chunks = db.rawDb.prepare(
    `SELECT id, chunk_index, content
     FROM chunks
     WHERE page_slug = ? AND summary_level = 0
     ORDER BY chunk_index ASC, id ASC`,
  ).all(slug) as SourceChunkRow[];
  if (chunks.length === 0) return { contentFingerprint: null, sourceKind: null };
  const tags = (db.rawDb.prepare(
    "SELECT tag FROM tags WHERE page_slug = ? ORDER BY tag ASC",
  ).all(slug) as Array<{ tag: string }>).map((row) => row.tag);
  const canonical = {
    version: 1,
    type: page.type,
    chunks: chunks.map((row) => ({ index: row.chunk_index, id: row.id, content: row.content })),
    tags,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return { contentFingerprint: `derived:${digest}`, sourceKind: "raw_chunks" };
}

export function countCurrentGraphLinks(db: ZeroLinkDb, slug: string): number {
  const rows = db.rawDb.prepare(
    `SELECT from_slug, to_slug, relation, trust_state
     FROM links
     WHERE from_slug = ? OR to_slug = ?`,
  ).all(slug, slug) as Array<{
    from_slug: string;
    to_slug: string;
    relation: string;
    trust_state: string | null;
  }>;
  let count = 0;
  for (const row of rows) {
    if (row.from_slug === row.to_slug) continue;
    if (row.trust_state === "rejected" || row.trust_state === "superseded") continue;
    if (isCurrentFactLink(row)) count++;
  }
  return count;
}

export function scanRichRecords(db: ZeroLinkDb): ZeroLinkCandidate[] {
  const connected = activeCurrentLinkSlugs(db);
  return readCandidateAggregates(db)
    .filter((row) => !connected.has(row.slug))
    .map((row) => {
      const source = deriveZeroLinkSource(db, row.slug);
      return {
        slug: row.slug,
        contentHash: row.content_hash,
        ...source,
        rawChunkCount: Number(row.raw_chunk_count),
        rawCharCount: Number(row.raw_char_count),
        tagCount: Number(row.tag_count),
      };
    });
}

export function scanZeroLinkCandidates(db: ZeroLinkDb, limit?: number): ZeroLinkCandidate[] {
  const candidates = scanRichRecords(db);
  return limit === undefined ? candidates : candidates.slice(0, Math.max(0, limit));
}

export function toPublicZeroLinkCandidate(candidate: ZeroLinkCandidate): PublicZeroLinkCandidate {
  return {
    rawChunkCount: candidate.rawChunkCount,
    rawCharCount: candidate.rawCharCount,
    tagCount: candidate.tagCount,
  };
}

function classifyCandidate(db: ZeroLinkDb, audit: QueueAudit, candidate: ZeroLinkCandidate): CandidatePlan {
  const relevant = audit.rows.filter((row) => row.name === "ner-backfill" && audit.parsedById.get(row.id)?.slug === candidate.slug && audit.parsedById.get(row.id)?.kind === "ner");
  const live = relevant.filter((row) => ACTIVE_STATUSES.has(row.status));
  if (live.length === 2 && candidate.contentFingerprint) {
    const predecessor = live.find((row) => row.status === "running");
    const successor = live.find((row) => row.status === "pending");
    const predecessorData = predecessor ? audit.parsedById.get(predecessor.id) : undefined;
    const successorData = successor ? audit.parsedById.get(successor.id) : undefined;
    const sanctionedPair = Boolean(
      predecessor && successor &&
      !predecessorData?.repair && !successorData?.repair &&
      predecessorData?.sourceFingerprint && predecessorData.sourceFingerprint !== candidate.contentFingerprint &&
      successorData?.sourceFingerprint === candidate.contentFingerprint &&
      successorData.contentHash === candidate.contentHash &&
      predecessorData.attemptLease,
    );
    if (sanctionedPair && predecessor && predecessorData?.attemptLease) {
      const stale = isStale(predecessor);
      if (predecessorData.attemptLease.phase === "committing") {
        return { candidate, disposition: stale ? "commit_unknown" : "active", staleRunning: stale };
      }
      return { candidate, disposition: "active", staleRunning: stale };
    }
  }
  if (live.length > 1) return { candidate, disposition: "active", stateConflict: true };
  if (live.length === 1) {
    const row = live[0];
    const data = audit.parsedById.get(row.id)!;
    if (row.status === "running" && data.attemptLease?.phase === "committing") {
      return { candidate, disposition: isStale(row) ? "commit_unknown" : "active", staleRunning: isStale(row) };
    }
    if (row.status === "running" && isStale(row)) {
      if (!candidate.contentFingerprint) return { candidate, disposition: "unverifiable_fingerprint", rowId: row.id, staleRunning: true };
      return data.repair
        ? { candidate, disposition: "active", rowId: row.id, staleRunning: true }
        : { candidate, disposition: "stale_requeue", rowId: row.id, staleRunning: true };
    }
    return { candidate, disposition: "active", rowId: row.id };
  }

  if (!candidate.contentFingerprint) return { candidate, disposition: "unverifiable_fingerprint" };

  const finalizedEntries = audit.manifests
    .filter((manifest) => manifest.finalized)
    .flatMap((manifest) => manifest.finalizedEntries.map((entry) => ({ manifestId: manifest.row.id, entry })))
    .filter(({ entry }) => entry.slug === candidate.slug && entry.contentFingerprint === candidate.contentFingerprint)
    .sort((a, b) => b.manifestId - a.manifestId);
  if (finalizedEntries.length > 0) {
    const entry = finalizedEntries[0].entry;
    if (entry.terminalStatus === "failed") return { candidate, disposition: "failed" };
    if (entry.terminalStatus === "cancelled") return { candidate, disposition: "cancelled" };
    switch (entry.graphOutcome) {
      case "resolved": return { candidate, disposition: countCurrentGraphLinks(db, candidate.slug) > 0 ? "resolved" : "lost_link" };
      case "terminal_no_graph_links": return { candidate, disposition: "terminal_no_graph_links" };
      case "blocked_source_unavailable": return { candidate, disposition: "blocked_source_unavailable" };
      case "source_changed": return { candidate, disposition: "source_changed" };
      default: return { candidate, disposition: "invalid_terminal" };
    }
  }

  const currentOrdinary = relevant.filter((row) => {
    const data = audit.parsedById.get(row.id);
    return !data?.repair && data?.sourceFingerprint === candidate.contentFingerprint && !ACTIVE_STATUSES.has(row.status);
  });
  if (currentOrdinary.length > 1) return { candidate, disposition: "failed", stateConflict: true };
  if (currentOrdinary.length === 1) {
    const row = currentOrdinary[0];
    const outcome = readOutcome(row)?.outcome;
    if (outcome === "commit_unknown") return { candidate, disposition: "commit_unknown" };
    if (row.status === "failed") return { candidate, disposition: "failed" };
    if (row.status === "cancelled") return { candidate, disposition: "cancelled" };
    if (row.status === "done" && outcome === "processed") return { candidate, disposition: countCurrentGraphLinks(db, candidate.slug) > 0 ? "resolved" : "terminal_no_graph_links" };
    return { candidate, disposition: "invalid_terminal" };
  }

  const marked = relevant
    .filter((row) => Boolean(audit.parsedById.get(row.id)?.repair))
    .sort((a, b) => b.id - a.id);
  if (marked.length > 0) {
    const row = marked[0];
    const data = audit.parsedById.get(row.id)!;
    const manifest = audit.manifestByBatchId.get(data.repair!.batchId);
    if (manifest && !manifest.finalized) return { candidate, disposition: "active" };
    if (data.repair!.contentFingerprint !== candidate.contentFingerprint) return { candidate, disposition: "content_changed_requeue", rowId: row.id };
    const result = readOutcome(row);
    if (result?.outcome === "commit_unknown") return { candidate, disposition: "commit_unknown" };
    if (row.status === "failed") return { candidate, disposition: "failed" };
    if (row.status === "cancelled") return { candidate, disposition: "cancelled" };
    switch (result?.graphOutcome) {
      case "resolved": return { candidate, disposition: countCurrentGraphLinks(db, candidate.slug) > 0 ? "resolved" : "lost_link" };
      case "terminal_no_graph_links": return { candidate, disposition: "terminal_no_graph_links" };
      case "blocked_source_unavailable": return { candidate, disposition: "blocked_source_unavailable" };
      case "source_changed": return { candidate, disposition: "source_changed" };
      default: return { candidate, disposition: "invalid_terminal" };
    }
  }

  const legacy = relevant
    .filter((row) => !audit.parsedById.get(row.id)?.sourceFingerprint && !audit.parsedById.get(row.id)?.repair)
    .sort((a, b) => b.id - a.id)[0];
  if (legacy) {
    if (legacy.status === "cancelled") return { candidate, disposition: "cancelled" };
    if (legacy.status === "done" || legacy.status === "failed") return { candidate, disposition: "legacy_requeue", rowId: legacy.id };
  }
  return { candidate, disposition: "new" };
}

function emptyReport(mode: "dry_run" | "enqueue", candidates: ZeroLinkCandidate[]): ZeroLinkBackfillReport {
  return {
    version: 1,
    mode,
    status: "ok",
    total: candidates.length,
    actionable: 0,
    selected: 0,
    newJobs: 0,
    requeuedJobs: 0,
    active: 0,
    cancelled: 0,
    resolved: 0,
    terminalNoGraphLinks: 0,
    blockedSourceUnavailable: 0,
    sourceChanged: 0,
    invalidTerminal: 0,
    commitUnknown: 0,
    lostLink: 0,
    unverifiableFingerprint: 0,
    failed: 0,
    staleRunning: 0,
    stateConflicts: 0,
    queueIntegrityConflicts: 0,
    thresholds: {
      rawChunks: candidates.filter((candidate) => candidate.rawChunkCount >= ZERO_LINK_MIN_RAW_CHUNKS).length,
      rawChars: candidates.filter((candidate) => candidate.rawCharCount >= ZERO_LINK_MIN_RAW_CHARS).length,
      tags: candidates.filter((candidate) => candidate.tagCount >= ZERO_LINK_MIN_TAGS).length,
      union: candidates.length,
    },
  };
}

function buildPlan(db: ZeroLinkDb, mode: "dry_run" | "enqueue", limit?: number): { report: ZeroLinkBackfillReport; plans: CandidatePlan[] } {
  const candidates = scanRichRecords(db);
  const audit = auditQueue(db);
  const plans = candidates.map((candidate) => classifyCandidate(db, audit, candidate));
  const report = emptyReport(mode, candidates);
  report.queueIntegrityConflicts = audit.queueIntegrityConflicts;
  report.commitUnknown = audit.commitUnknown;
  for (const plan of plans) {
    if (plan.stateConflict) report.stateConflicts++;
    if (plan.staleRunning) report.staleRunning++;
    switch (plan.disposition) {
      case "active": report.active++; break;
      case "cancelled": report.cancelled++; break;
      case "resolved": report.resolved++; break;
      case "terminal_no_graph_links": report.terminalNoGraphLinks++; break;
      case "blocked_source_unavailable": report.blockedSourceUnavailable++; break;
      case "source_changed": report.sourceChanged++; break;
      case "invalid_terminal": report.invalidTerminal++; break;
      case "commit_unknown": break;
      case "lost_link": report.lostLink++; break;
      case "unverifiable_fingerprint": report.unverifiableFingerprint++; break;
      case "failed": report.failed++; break;
      default: break;
    }
  }
  const actionable = plans.filter((plan) => ACTIONABLE.has(plan.disposition) && !plan.stateConflict && plan.candidate.contentFingerprint && plan.candidate.sourceKind);
  report.actionable = actionable.length;
  const selectionLimit = limit === undefined ? actionable.length : Math.max(0, limit);
  const selected = actionable.slice(0, selectionLimit);
  report.selected = selected.length;
  report.newJobs = selected.filter((plan) => plan.disposition === "new").length;
  report.requeuedJobs = selected.length - report.newJobs;
  if (report.queueIntegrityConflicts > 0 || report.stateConflicts > 0) {
    report.status = "blocked";
    report.selected = 0;
    report.newJobs = 0;
    report.requeuedJobs = 0;
    return { report, plans: [] };
  }
  return { report, plans: selected };
}

export function planZeroLinkBackfill(db: ZeroLinkDb, limit?: number): ZeroLinkBackfillReport {
  return buildPlan(db, "dry_run", limit).report;
}

/** Internal queue-control view for durable NER submission; never exposes identities publicly. */
export function inspectZeroLinkRepairControl(
  db: ZeroLinkDb,
  slug: string,
  fingerprint: string,
): { queueIntegrityConflicts: number; finalizedFingerprintOwned: boolean } {
  const audit = auditQueue(db);
  return {
    queueIntegrityConflicts: audit.queueIntegrityConflicts,
    finalizedFingerprintOwned: audit.manifests.some(
      (manifest) => manifest.finalized && manifest.finalizedEntries.some(
        (entry) => entry.slug === slug && entry.contentFingerprint === fingerprint,
      ),
    ),
  };
}

function repairPayload(candidate: ZeroLinkCandidate, batchId: string): Record<string, unknown> {
  return {
    slug: candidate.slug,
    kind: "ner",
    contentHash: candidate.contentHash,
    repair: {
      name: "zero-link-rich-records",
      version: 1,
      contentFingerprint: candidate.contentFingerprint,
      sourceKind: candidate.sourceKind,
      batchId,
    },
  };
}

export function enqueueZeroLinkBackfill(db: ZeroLinkDb, limit: number): ZeroLinkBackfillReport {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit >= ZERO_LINK_JOB_PRIORITY_BASE) throw new Error("INVALID_ZERO_LINK_LIMIT");
  db.rawDb.exec("BEGIN IMMEDIATE");
  try {
    const { report, plans } = buildPlan(db, "enqueue", limit);
    if (report.status !== "ok" || plans.length === 0) {
      db.rawDb.exec("COMMIT");
      return report;
    }
    const batchId = randomUUID();
    const ownership: OwnershipEntry[] = [];
    for (const [index, plan] of plans.entries()) {
      const priority = ZERO_LINK_JOB_PRIORITY_BASE + plans.length - index;
      const data = JSON.stringify(repairPayload(plan.candidate, batchId));
      let jobId: number;
      if (plan.disposition === "new") {
        const inserted = db.rawDb.prepare(
          `INSERT INTO jobs (name, status, priority, data, attempts, max_attempts)
           VALUES ('ner-backfill', 'pending', ?, ?, 0, 1)`,
        ).run(priority, data);
        jobId = Number(inserted.lastInsertRowid);
      } else {
        if (!plan.rowId) throw new Error("ZERO_LINK_REQUEUE_ID_MISSING");
        const updated = db.rawDb.prepare(
          `UPDATE jobs
           SET status='pending', priority=?, data=?, result=NULL, error=NULL,
               attempts=0, max_attempts=1, started_at=NULL, finished_at=NULL
           WHERE id=? AND name='ner-backfill'`,
        ).run(priority, data, plan.rowId);
        if (updated.changes !== 1) throw new Error("ZERO_LINK_REQUEUE_RACE");
        jobId = plan.rowId;
      }
      ownership.push({
        jobId,
        slug: plan.candidate.slug,
        contentFingerprint: plan.candidate.contentFingerprint!,
      });
    }
    const manifestData = {
      version: 1,
      repairName: "zero-link-rich-records",
      batchId,
      ownership,
    };
    db.rawDb.prepare(
      `INSERT INTO jobs (name, status, priority, data, result, attempts, max_attempts, finished_at)
       VALUES ('zero-link-backfill-batch', 'done', 0, ?, ?, 0, 1, datetime('now'))`,
    ).run(JSON.stringify(manifestData), JSON.stringify({ finalized: false }));
    db.rawDb.exec("COMMIT");
    return { ...report, batchId };
  } catch (error) {
    try { db.rawDb.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

export function snapshotRepairBatchJobIds(db: ZeroLinkDb, batchId: string, limit: number): number[] {
  const audit = auditQueue(db);
  if (audit.queueIntegrityConflicts > 0) throw new Error("BATCH_INTEGRITY_CONFLICT");
  const manifest = audit.manifestByBatchId.get(batchId);
  if (!manifest) throw new Error("BATCH_NOT_FOUND");
  if (manifest.ownership.length !== limit) throw new Error("BATCH_LIMIT_MISMATCH");
  return manifest.ownership.map((entry) => entry.jobId);
}

export function summarizeRepairBatch(db: ZeroLinkDb, batchId: string): RepairBatchStatus {
  const audit = auditQueue(db);
  const matches = audit.manifests.filter((manifest) => manifest.batchId === batchId);
  if (matches.length !== 1 || audit.queueIntegrityConflicts > 0) {
    return {
      version: 1, batchId, finalized: false, integrityConflicts: Math.max(1, audit.queueIntegrityConflicts),
      selected: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0,
      outcomes: { resolved: 0, terminalNoGraphLinks: 0, blockedSourceUnavailable: 0, sourceChanged: 0, invalidTerminal: 0, commitUnknown: 0 },
    };
  }
  const manifest = matches[0];
  const byId = new Map(audit.rows.map((row) => [row.id, row]));
  const status: RepairBatchStatus = {
    version: 1, batchId, finalized: manifest.finalized, integrityConflicts: 0,
    selected: manifest.ownership.length, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0,
    outcomes: { resolved: 0, terminalNoGraphLinks: 0, blockedSourceUnavailable: 0, sourceChanged: 0, invalidTerminal: 0, commitUnknown: 0 },
  };
  for (const owner of manifest.ownership) {
    const row = byId.get(owner.jobId);
    if (!row) { status.integrityConflicts++; continue; }
    status[row.status]++;
    const result = readOutcome(row);
    if (result?.outcome === "commit_unknown") status.outcomes.commitUnknown++;
    else if (result?.graphOutcome === "resolved") status.outcomes.resolved++;
    else if (result?.graphOutcome === "terminal_no_graph_links") status.outcomes.terminalNoGraphLinks++;
    else if (result?.graphOutcome === "blocked_source_unavailable") status.outcomes.blockedSourceUnavailable++;
    else if (result?.graphOutcome === "source_changed") status.outcomes.sourceChanged++;
    else if (row.status === "done" && result?.graphOutcome !== undefined) status.outcomes.invalidTerminal++;
  }
  return status;
}
