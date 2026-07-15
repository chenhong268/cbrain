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

export interface ZeroLinkSource {
  contentFingerprint: string | null;
  sourceKind: NerSourceKind | null;
}

export interface ZeroLinkSourceSnapshot extends ZeroLinkSource {
  body: string | null;
  pageType: string | null;
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
  sourceFingerprintPresent: boolean;
  pageContentHashPresent: boolean;
  legacyContentHashPresent: boolean;
  contentHashShapeValid: boolean;
  repair?: RepairMarker;
  attemptLease?: {
    version: 1;
    token: string;
    phase: "claimed" | "committing";
    sourceFingerprint: string | null;
    batchId: string | null;
    slug: string;
    kind: "ner";
    payloadDigest: string;
  };
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
  globalStateConflictSlugs: Set<string>;
  commitUnknown: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  if (JSON.stringify(Object.keys(repair).sort()) !== JSON.stringify(["batchId", "contentFingerprint", "name", "sourceKind", "version"])) return null;
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
  const sourceFingerprintPresent = Object.hasOwn(data, "sourceFingerprint");
  const pageContentHashPresent = Object.hasOwn(data, "pageContentHash");
  const legacyContentHashPresent = Object.hasOwn(data, "contentHash");
  const contentHash = Object.hasOwn(data, "pageContentHash")
    ? data.pageContentHash
    : data.contentHash;
  const parsed: ParsedNerData = {
    slug: data.slug,
    kind,
    sourceFingerprintPresent,
    pageContentHashPresent,
    legacyContentHashPresent,
    contentHashShapeValid: contentHash === undefined || contentHash === null || typeof contentHash === "string",
  };
  if (contentHash === null || typeof contentHash === "string") parsed.contentHash = contentHash;
  if (typeof data.sourceFingerprint === "string") parsed.sourceFingerprint = data.sourceFingerprint;
  if (data.repair !== undefined) {
    const repair = parseRepair(data.repair);
    if (!repair || kind !== "ner") return null;
    parsed.repair = repair;
  }
  const lease = objectValue(data.attemptLease);
  if (lease) {
    const expectedFingerprint = parsed.repair?.contentFingerprint ?? parsed.sourceFingerprint ?? null;
    const expectedBatchId = parsed.repair?.batchId ?? null;
    const { attemptLease: _lease, ...payload } = data;
    const payloadDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    if (
      lease.version !== 1 || typeof lease.token !== "string" || lease.token.length === 0 ||
      (lease.phase !== "claimed" && lease.phase !== "committing") ||
      lease.sourceFingerprint !== expectedFingerprint || lease.batchId !== expectedBatchId ||
      lease.slug !== parsed.slug || lease.kind !== "ner" || parsed.kind !== "ner" ||
      lease.payloadDigest !== payloadDigest
    ) return null;
    parsed.attemptLease = {
      version: 1,
      token: lease.token,
      phase: lease.phase,
      sourceFingerprint: expectedFingerprint,
      batchId: expectedBatchId,
      slug: parsed.slug,
      kind: "ner",
      payloadDigest,
    };
  }
  return parsed;
}

function parseOwnership(value: unknown): OwnershipEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seenJobs = new Set<number>();
  const seenSlugs = new Set<string>();
  const entries: OwnershipEntry[] = [];
  for (const raw of value) {
    const entry = objectValue(raw);
    const jobId = Number(entry?.jobId);
    if (!entry || !Number.isSafeInteger(jobId) || jobId <= 0 || seenJobs.has(jobId) ||
      typeof entry.slug !== "string" || entry.slug.length === 0 || seenSlugs.has(entry.slug) ||
      typeof entry.contentFingerprint !== "string" || entry.contentFingerprint.length === 0) return null;
    seenJobs.add(jobId);
    seenSlugs.add(entry.slug);
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

function aggregateFinalizedEntries(entries: FinalizedEntry[]) {
  const statusCounts = { done: 0, failed: 0, cancelled: 0 };
  const outcomes = { resolved: 0, terminalNoGraphLinks: 0, blockedSourceUnavailable: 0, sourceChanged: 0, invalidTerminal: 0, commitUnknown: 0 };
  for (const entry of entries) {
    statusCounts[entry.terminalStatus]++;
    if (entry.graphOutcome === "resolved") outcomes.resolved++;
    else if (entry.graphOutcome === "terminal_no_graph_links") outcomes.terminalNoGraphLinks++;
    else if (entry.graphOutcome === "blocked_source_unavailable") outcomes.blockedSourceUnavailable++;
    else if (entry.graphOutcome === "source_changed") outcomes.sourceChanged++;
    else if (entry.graphOutcome === "invalid_terminal") outcomes.invalidTerminal++;
  }
  return { statusCounts, outcomes };
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
      if ((value.terminalStatus === "done") !== (outcome !== null)) return null;
      finalizedEntries.push({ ...owner, terminalStatus: value.terminalStatus, graphOutcome: outcome });
    }
    if (typeof data.ledgerDigest !== "string" || data.ledgerDigest !== canonicalLedgerDigest(String(data.batchId), finalizedEntries)) return null;
    const aggregates = aggregateFinalizedEntries(finalizedEntries);
    if (JSON.stringify(result.statusCounts) !== JSON.stringify(aggregates.statusCounts) || JSON.stringify(result.outcomes) !== JSON.stringify(aggregates.outcomes)) return null;
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

/** Only terminal states that prove an epoch was consumed belong to its ledger. */
function isProcessedEpochEvidence(row: JobRow): boolean {
  if (row.status === "failed" || row.status === "cancelled") return true;
  if (row.status !== "done") return false;
  const outcome = readOutcome(row)?.outcome;
  return outcome === "processed" || outcome === "commit_unknown";
}

function finalizedEntryOwnsEpoch(entry: FinalizedEntry): boolean {
  if (entry.terminalStatus === "failed" || entry.terminalStatus === "cancelled") return true;
  return entry.graphOutcome === "resolved" || entry.graphOutcome === "terminal_no_graph_links";
}

function ordinaryFrozenIdentityValid(data: ParsedNerData): boolean {
  if (data.kind !== "ner" || data.repair) return false;
  if (!data.sourceFingerprintPresent || data.sourceFingerprint === undefined ||
    (!data.pageContentHashPresent && !data.legacyContentHashPresent) || !data.contentHashShapeValid ||
    data.contentHash === undefined) return false;
  if (!data.sourceFingerprint.startsWith("page:") && !/^derived:[0-9a-f]{64}$/.test(data.sourceFingerprint)) return false;
  if (data.sourceFingerprint.startsWith("page:") &&
    (typeof data.contentHash !== "string" || data.sourceFingerprint !== `page:${data.contentHash}`)) return false;
  return true;
}

function trueLegacyOrdinary(data: ParsedNerData): boolean {
  return data.kind === "ner" && !data.repair && !data.sourceFingerprintPresent &&
    !data.pageContentHashPresent && data.contentHashShapeValid;
}

function ordinaryCurrentIdentityValid(db: ZeroLinkDb, data: ParsedNerData): boolean {
  if (!ordinaryFrozenIdentityValid(data) || data.sourceFingerprint === undefined) return false;
  const page = db.rawDb.prepare("SELECT content_hash FROM pages WHERE slug=?").get(data.slug) as { content_hash: string | null } | undefined;
  if (!page) return false;
  const current = deriveZeroLinkSource(db, data.slug).contentFingerprint;
  return data.sourceFingerprint === current && data.contentHash === page.content_hash;
}

function ordinaryLiveIdentityValid(db: ZeroLinkDb, data: ParsedNerData): boolean {
  // Pre-#342 contentHash was caller-defined and is not half of the governed identity.
  // Only sourceFingerprint opts an ordinary row into #342 current-source validation.
  if (trueLegacyOrdinary(data)) return true;
  if (!ordinaryFrozenIdentityValid(data)) return false;
  const current = deriveZeroLinkSource(db, data.slug).contentFingerprint;
  return data.sourceFingerprint !== current || ordinaryCurrentIdentityValid(db, data);
}

function ordinaryCommitUnknownValid(row: JobRow, data: ParsedNerData | undefined): boolean {
  const result = readOutcome(row);
  return Boolean(
    row.status === "done" && data && !data.repair && !data.attemptLease && ordinaryFrozenIdentityValid(data) &&
    result?.outcome === "commit_unknown" && result.kind === "ner" &&
    JSON.stringify(Object.keys(result).sort()) === JSON.stringify(["kind", "outcome"]),
  );
}

function auditQueue(db: ZeroLinkDb): QueueAudit {
  const rows = readAllJobs(db);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parsedById = new Map<number, ParsedNerData>();
  const manifests: ParsedManifest[] = [];
  const manifestByBatchId = new Map<string, ParsedManifest>();
  const latestOwnershipByJobId = new Map<number, ParsedManifest>();
  const unfinalizedOwnersByJobId = new Map<number, number>();
  const unfinalizedOwnersBySlug = new Map<string, number>();
  const globalStateConflictSlugs = new Set<string>();
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
        if (!parsed.finalized) {
          unfinalizedOwnersByJobId.set(owner.jobId, (unfinalizedOwnersByJobId.get(owner.jobId) ?? 0) + 1);
          unfinalizedOwnersBySlug.set(owner.slug, (unfinalizedOwnersBySlug.get(owner.slug) ?? 0) + 1);
        }
        const previous = latestOwnershipByJobId.get(owner.jobId);
        if (!previous || previous.row.id < row.id) latestOwnershipByJobId.set(owner.jobId, parsed);
      }
    }
  }

  for (const ownerCount of unfinalizedOwnersByJobId.values()) {
    if (ownerCount > 1) conflicts++;
  }
  for (const ownerCount of unfinalizedOwnersBySlug.values()) {
    if (ownerCount > 1) conflicts++;
  }

  for (const row of rows) {
    if (row.name !== "ner-backfill") continue;
    const parsed = parseNerData(row.data);
    if (parsed) parsedById.set(row.id, parsed);
    if (ACTIVE_STATUSES.has(row.status) && !parsed) conflicts++;
    const raw = parseJsonObject(row.data);
    if (raw?.repair !== undefined && !parsed?.repair) conflicts++;
    if (raw?.attemptLease !== undefined && !parsed?.attemptLease) conflicts++;
    if (row.status === "done" && readOutcome(row)?.outcome === "commit_unknown") {
      if (!parsed || parsed.kind !== "ner" || parsed.attemptLease || (!parsed.repair && !ordinaryCommitUnknownValid(row, parsed))) conflicts++;
    }
    if (parsed?.attemptLease && row.status !== "running") globalStateConflictSlugs.add(parsed.slug);
    if (parsed?.repair) {
      const manifest = manifestByBatchId.get(parsed.repair.batchId);
      const owner = manifest?.ownership.find((entry) => entry.jobId === row.id);
      if (!manifest || !owner || owner.slug !== parsed.slug || owner.contentFingerprint !== parsed.repair.contentFingerprint) conflicts++;
    }
  }

  for (const manifest of manifests) {
    for (const owner of manifest.ownership) {
      if (latestOwnershipByJobId.get(owner.jobId) !== manifest) continue;
      const child = byId.get(owner.jobId);
      const data = parsedById.get(owner.jobId);
      if (!child || child.name !== "ner-backfill" || !data?.repair || data.slug !== owner.slug || data.repair.batchId !== manifest.batchId || data.repair.contentFingerprint !== owner.contentFingerprint) conflicts++;
      if (manifest.finalized && child) {
        const entry = manifest.finalizedEntries.find((candidate) => candidate.jobId === owner.jobId);
        const result = readOutcome(child);
        const rawOutcome = result?.graphOutcome;
        const actualGraphOutcome = child.status === "done"
          ? rawOutcome === "resolved" || rawOutcome === "terminal_no_graph_links" || rawOutcome === "blocked_source_unavailable" || rawOutcome === "source_changed" || rawOutcome === "invalid_terminal"
            ? rawOutcome
            : "invalid_terminal"
          : null;
        if (!entry || child.status !== entry.terminalStatus || result?.outcome === "commit_unknown" ||
          actualGraphOutcome !== entry.graphOutcome) conflicts++;
      }
    }
    if (manifest.finalized) continue;
    for (const [jobId, data] of parsedById) {
      if (data.repair?.batchId === manifest.batchId && !manifest.ownership.some((entry) => entry.jobId === jobId)) conflicts++;
    }
  }

  const liveBySlug = new Map<string, JobRow[]>();
  for (const row of rows) {
    const data = parsedById.get(row.id);
    if (row.name !== "ner-backfill" || !ACTIVE_STATUSES.has(row.status) || data?.kind !== "ner") continue;
    if (!data.repair && !ordinaryLiveIdentityValid(db, data)) globalStateConflictSlugs.add(data.slug);
    const group = liveBySlug.get(data.slug) ?? [];
    group.push(row);
    liveBySlug.set(data.slug, group);
  }
  for (const [slug, live] of liveBySlug) {
    const current = deriveZeroLinkSource(db, slug).contentFingerprint;
    const parsedLive = live.map((row) => ({ row, data: parsedById.get(row.id)! }));
    const hasRepairHistory = manifests.some((manifest) => manifest.ownership.some((owner) => owner.slug === slug));
    const firstRepairManifestId = manifests
      .filter((manifest) => manifest.ownership.some((owner) => owner.slug === slug))
      .reduce<number | null>((first, manifest) => first === null || manifest.row.id < first ? manifest.row.id : first, null);
    if (!current && (hasRepairHistory || parsedLive.some(({ data }) => Boolean(data.sourceFingerprint || data.repair)))) {
      globalStateConflictSlugs.add(slug);
    }
    const marked = parsedLive.filter(({ data }) => Boolean(data.repair));
    const ordinary = parsedLive.filter(({ data }) => !data.repair);
    if (firstRepairManifestId !== null && ordinary.some(({ row, data }) => trueLegacyOrdinary(data) && row.id > firstRepairManifestId)) {
      globalStateConflictSlugs.add(slug);
    }
    if (marked.length > 0 && ordinary.length > 0) globalStateConflictSlugs.add(slug);
    if (live.length > 2) globalStateConflictSlugs.add(slug);
    if (live.length === 2) {
      const predecessor = parsedLive.find(({ row }) => row.status === "running");
      const successor = parsedLive.find(({ row }) => row.status === "pending");
      const sanctioned = Boolean(
        predecessor && successor && !predecessor.data.repair && !successor.data.repair &&
        predecessor.data.attemptLease && predecessor.data.sourceFingerprint &&
        predecessor.data.sourceFingerprint !== current && successor.data.sourceFingerprint === current &&
        ordinaryLiveIdentityValid(db, predecessor.data) && ordinaryLiveIdentityValid(db, successor.data),
      );
      if (!sanctioned) globalStateConflictSlugs.add(slug);
    }
    if (live.length === 1) {
      const { row, data } = parsedLive[0];
      if (row.status === "pending" && data.attemptLease) globalStateConflictSlugs.add(slug);
      if (data.repair) {
        const manifest = manifestByBatchId.get(data.repair.batchId);
        const latest = latestOwnershipByJobId.get(row.id);
        if (!manifest || manifest.finalized || latest !== manifest) globalStateConflictSlugs.add(slug);
      }
    }
    if (current) {
      const currentTerminal = rows.filter((row) => {
        if (row.name !== "ner-backfill" || ACTIVE_STATUSES.has(row.status)) return false;
        const data = parsedById.get(row.id);
        return data?.kind === "ner" && !data.repair && data.slug === slug &&
          data.sourceFingerprint === current && isProcessedEpochEvidence(row);
      });
      if (currentTerminal.length > 1) globalStateConflictSlugs.add(slug);
    }
  }

  let commitUnknown = 0;
  for (const row of rows) {
    if (row.name !== "ner-backfill") continue;
    const parsed = parsedById.get(row.id);
    const outcome = readOutcome(row)?.outcome;
    if ((row.status === "done" && outcome === "commit_unknown") || (row.status === "running" && parsed?.attemptLease?.phase === "committing" && isStale(row))) commitUnknown++;
  }

  return {
    rows,
    parsedById,
    manifests,
    manifestByBatchId,
    latestOwnershipByJobId,
    queueIntegrityConflicts: conflicts,
    globalStateConflictSlugs,
    commitUnknown,
  };
}

export type NerClaimMode = "legacy" | "ordinary" | "repair";

/**
 * Canonical in-transaction authorization for the storage claim CAS.
 * Callers must hold the SQLite write transaction while using this result.
 */
export function authorizeNerJobClaim(db: ZeroLinkDb, jobId: number): NerClaimMode | null {
  const audit = auditQueue(db);
  if (audit.queueIntegrityConflicts > 0) return null;
  const row = audit.rows.find((candidate) => candidate.id === jobId);
  const data = audit.parsedById.get(jobId);
  const raw = row ? parseJsonObject(row.data) : null;
  if (!row || row.name !== "ner-backfill" || row.status !== "pending" || !data || data.kind !== "ner" ||
    !raw || Object.hasOwn(raw, "attemptLease") || audit.globalStateConflictSlugs.has(data.slug)) return null;

  const otherLive = audit.rows.some((candidate) => {
    if (candidate.id === jobId || candidate.name !== "ner-backfill" || !ACTIVE_STATUSES.has(candidate.status)) return false;
    const other = audit.parsedById.get(candidate.id);
    return other?.kind === "ner" && other.slug === data.slug;
  });
  if (otherLive) return null;

  if (data.repair) {
    const manifest = audit.manifestByBatchId.get(data.repair.batchId);
    const latest = audit.latestOwnershipByJobId.get(jobId);
    const owner = manifest?.ownership.find((entry) => entry.jobId === jobId);
    if (!manifest || manifest.finalized || latest !== manifest || !owner || owner.slug !== data.slug ||
      owner.contentFingerprint !== data.repair.contentFingerprint) return null;
    return "repair";
  }

  if (trueLegacyOrdinary(data)) {
    const hasRepairHistory = audit.manifests.some(
      (manifest) => manifest.ownership.some((owner) => owner.slug === data.slug),
    );
    return hasRepairHistory ? null : "legacy";
  }

  return ordinaryLiveIdentityValid(db, data) ? "ordinary" : null;
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

export function loadZeroLinkSourceSnapshot(db: ZeroLinkDb, slug: string): ZeroLinkSourceSnapshot {
  const rows = db.rawDb.prepare(
    `SELECT p.type, p.content_hash,
            EXISTS(SELECT 1 FROM chunks sx WHERE sx.page_slug=p.slug AND sx.summary_level=1) AS sealed,
            c.id AS chunk_id, c.chunk_index, c.content, t.tag
     FROM pages p
     LEFT JOIN chunks c ON c.page_slug=p.slug AND c.summary_level=0
     LEFT JOIN tags t ON t.page_slug=p.slug
     WHERE p.slug=?
     ORDER BY c.chunk_index ASC, c.id ASC, t.tag ASC`,
  ).all(slug) as Array<{
    type: string;
    content_hash: string | null;
    sealed: number;
    chunk_id: number | null;
    chunk_index: number | null;
    content: string | null;
    tag: string | null;
  }>;
  if (rows.length === 0) return { contentFingerprint: null, sourceKind: null, body: null, pageType: null };
  const page = rows[0];
  const pageHash = page.content_hash?.trim();
  if (!page.sealed && pageHash) {
    return { contentFingerprint: `page:${pageHash}`, sourceKind: "vault_hash", body: null, pageType: page.type };
  }

  const chunks = new Map<number, { index: number; id: number; content: string }>();
  const tags = new Set<string>();
  for (const row of rows) {
    if (row.chunk_id !== null && row.chunk_index !== null && row.content !== null && !chunks.has(row.chunk_id)) {
      chunks.set(row.chunk_id, { index: row.chunk_index, id: row.chunk_id, content: row.content });
    }
    if (row.tag !== null) tags.add(row.tag);
  }
  const orderedChunks = [...chunks.values()];
  if (orderedChunks.length === 0) {
    return { contentFingerprint: null, sourceKind: null, body: null, pageType: page.type };
  }
  const canonical = {
    version: 1,
    type: page.type,
    chunks: orderedChunks,
    tags: [...tags].sort(),
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return {
    contentFingerprint: `derived:${digest}`,
    sourceKind: "raw_chunks",
    body: orderedChunks.map((chunk) => chunk.content).join("\n\n"),
    pageType: page.type,
  };
}

export function deriveZeroLinkSource(db: ZeroLinkDb, slug: string): ZeroLinkSource {
  const { contentFingerprint, sourceKind } = loadZeroLinkSourceSnapshot(db, slug);
  return { contentFingerprint, sourceKind };
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

function scanAllRichRecords(db: ZeroLinkDb): ZeroLinkCandidate[] {
  return readCandidateAggregates(db)
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

export function scanRichRecords(db: ZeroLinkDb): ZeroLinkCandidate[] {
  const connected = activeCurrentLinkSlugs(db);
  return scanAllRichRecords(db).filter((candidate) => !connected.has(candidate.slug));
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
    .filter(({ entry }) => finalizedEntryOwnsEpoch(entry))
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
    return !data?.repair && data?.sourceFingerprint === candidate.contentFingerprint &&
      !ACTIVE_STATUSES.has(row.status) && isProcessedEpochEvidence(row);
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
    if (result?.graphOutcome === "blocked_source_unavailable" || result?.graphOutcome === "source_changed" ||
      result?.graphOutcome === "invalid_terminal") {
      return { candidate, disposition: "legacy_requeue", rowId: row.id };
    }
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
  const allRichRecords = scanAllRichRecords(db);
  const connected = activeCurrentLinkSlugs(db);
  const candidates = allRichRecords.filter((candidate) => !connected.has(candidate.slug));
  const audit = auditQueue(db);
  const plans = candidates.map((candidate) => classifyCandidate(db, audit, candidate));
  const report = emptyReport(mode, candidates);
  report.queueIntegrityConflicts = audit.queueIntegrityConflicts;
  report.stateConflicts = audit.globalStateConflictSlugs.size;
  report.commitUnknown = audit.commitUnknown;
  for (const plan of plans) {
    if (plan.stateConflict && !audit.globalStateConflictSlugs.has(plan.candidate.slug)) report.stateConflicts++;
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
  const currentBySlug = new Map(allRichRecords.map((candidate) => [candidate.slug, candidate]));
  const latestRepairEntry = new Map<string, { manifestId: number; entry: FinalizedEntry }>();
  for (const manifest of audit.manifests) {
    if (!manifest.finalized) continue;
    for (const entry of manifest.finalizedEntries) {
      const current = currentBySlug.get(entry.slug);
      if (!current || current.contentFingerprint !== entry.contentFingerprint) continue;
      const previous = latestRepairEntry.get(entry.slug);
      if (!previous || previous.manifestId < manifest.row.id) {
        latestRepairEntry.set(entry.slug, { manifestId: manifest.row.id, entry });
      }
    }
  }
  report.resolved = [...latestRepairEntry.values()].filter(({ entry }) =>
    entry.graphOutcome === "resolved" && connected.has(entry.slug) && countCurrentGraphLinks(db, entry.slug) > 0
  ).length;
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

/** Stable scalar-only diagnostic shared by Health and fsck. */
export function formatZeroLinkDebtDetail(report: ZeroLinkBackfillReport): string {
  return [
    `total=${report.total}`,
    `actionable=${report.actionable}`,
    `active=${report.active}`,
    `terminal_no_graph_links=${report.terminalNoGraphLinks}`,
    `blocked_source_unavailable=${report.blockedSourceUnavailable}`,
    `source_changed=${report.sourceChanged}`,
    `invalid_terminal=${report.invalidTerminal}`,
    `lost_link=${report.lostLink}`,
    `unverifiable_fingerprint=${report.unverifiableFingerprint}`,
    `failed=${report.failed}`,
    `state_conflicts=${report.stateConflicts}`,
    `queue_integrity_conflicts=${report.queueIntegrityConflicts}`,
    `commit_unknown=${report.commitUnknown}`,
    `resolved=${report.resolved}`,
  ].join(", ");
}

/** Internal queue-control view for durable NER submission; never exposes identities publicly. */
export function inspectZeroLinkRepairControl(
  db: ZeroLinkDb,
  slug: string,
  fingerprint: string,
): {
  queueIntegrityConflicts: number;
  stateConflicts: number;
  finalizedFingerprintOwned: boolean;
  unfinalizedOwnedJobId: number | null;
  unfinalizedOwnedLive: boolean;
} {
  const audit = auditQueue(db);
  const unfinalized = audit.manifests
    .filter((manifest) => !manifest.finalized)
    .flatMap((manifest) => manifest.ownership.map((owner) => ({ manifest, owner })))
    .find(({ owner }) => owner.slug === slug);
  const child = unfinalized
    ? audit.rows.find((row) => row.id === unfinalized.owner.jobId)
    : undefined;
  return {
    queueIntegrityConflicts: audit.queueIntegrityConflicts,
    stateConflicts: audit.globalStateConflictSlugs.size,
    finalizedFingerprintOwned: audit.manifests.some(
      (manifest) => manifest.finalized && manifest.finalizedEntries.some(
        (entry) => entry.slug === slug && entry.contentFingerprint === fingerprint && finalizedEntryOwnsEpoch(entry),
      ),
    ),
    unfinalizedOwnedJobId: unfinalized?.owner.jobId ?? null,
    unfinalizedOwnedLive: Boolean(child && ACTIVE_STATUSES.has(child.status)),
  };
}

export interface NerJobProtection {
  integrityUnknown: boolean;
  protectedJobIds: Set<number>;
}

export function getNerJobProtection(db: ZeroLinkDb): NerJobProtection {
  const audit = auditQueue(db);
  const protectedJobIds = new Set<number>();
  const firstManifestBySlug = new Map<string, number>();
  for (const manifest of audit.manifests) {
    for (const owner of manifest.ownership) {
      protectedJobIds.add(owner.jobId);
      const previous = firstManifestBySlug.get(owner.slug);
      if (previous === undefined || manifest.row.id < previous) firstManifestBySlug.set(owner.slug, manifest.row.id);
    }
  }
  for (const row of audit.rows) {
    if (row.name === "zero-link-backfill-batch") protectedJobIds.add(row.id);
    if (row.name !== "ner-backfill") continue;
    const data = audit.parsedById.get(row.id);
    if (data?.repair) protectedJobIds.add(row.id);
    const firstManifest = data ? firstManifestBySlug.get(data.slug) : undefined;
    if (firstManifest !== undefined && row.id <= firstManifest && !data?.repair) protectedJobIds.add(row.id);
  }
  return { integrityUnknown: audit.queueIntegrityConflicts > 0, protectedJobIds };
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

export function getRepairBatchAttemptIdentity(
  db: ZeroLinkDb,
  batchId: string,
  jobId: number,
): { slug: string; kind: "ner"; sourceFingerprint: string; batchId: string } {
  const audit = auditQueue(db);
  if (audit.queueIntegrityConflicts > 0 || audit.globalStateConflictSlugs.size > 0) throw new Error("BATCH_INTEGRITY_CONFLICT");
  const manifest = audit.manifestByBatchId.get(batchId);
  const owner = manifest?.ownership.find((entry) => entry.jobId === jobId);
  if (!manifest || !owner) throw new Error("BATCH_INTEGRITY_CONFLICT");
  return { slug: owner.slug, kind: "ner", sourceFingerprint: owner.contentFingerprint, batchId };
}

export function prepareRepairBatchJobIds(
  db: ZeroLinkDb,
  batchId: string,
  limit: number,
  staleTtlMs: number,
): number[] {
  db.rawDb.exec("BEGIN IMMEDIATE");
  try {
    const audit = auditQueue(db);
    if (audit.queueIntegrityConflicts > 0 || audit.globalStateConflictSlugs.size > 0) throw new Error("BATCH_INTEGRITY_CONFLICT");
    const manifest = audit.manifestByBatchId.get(batchId);
    if (!manifest) throw new Error("BATCH_NOT_FOUND");
    if (manifest.ownership.length !== limit) throw new Error("BATCH_LIMIT_MISMATCH");
    if (!manifest.finalized) {
      const byId = new Map(audit.rows.map((row) => [row.id, row]));
      for (const owner of manifest.ownership) {
        const row = byId.get(owner.jobId)!;
        if (row.status !== "running" || !isStale(row, Date.now(), staleTtlMs)) continue;
        const data = audit.parsedById.get(row.id)!;
        const lease = data.attemptLease;
        if (!lease) throw new Error("BATCH_INTEGRITY_CONFLICT");
        const raw = parseJsonObject(row.data)!;
        const { attemptLease: _removed, ...withoutLease } = raw;
        if (lease.phase === "claimed") {
          const changed = db.rawDb.prepare(
            `UPDATE jobs SET status='pending', data=?, started_at=NULL, finished_at=NULL
             WHERE id=? AND status='running' AND data=?`,
          ).run(JSON.stringify(withoutLease), row.id, row.data);
          if (changed.changes !== 1) throw new Error("BATCH_INTEGRITY_CONFLICT");
        } else {
          const result = {
            outcome: "commit_unknown",
            kind: "ner",
            ...(data.repair ? { repair: data.repair } : {}),
          };
          const changed = db.rawDb.prepare(
            `UPDATE jobs SET status='done', data=?, result=?, error=NULL, finished_at=datetime('now')
             WHERE id=? AND status='running' AND data=?`,
          ).run(JSON.stringify(withoutLease), JSON.stringify(result), row.id, row.data);
          if (changed.changes !== 1) throw new Error("BATCH_INTEGRITY_CONFLICT");
        }
      }
    }
    db.rawDb.exec("COMMIT");
    return manifest.ownership.map((entry) => entry.jobId);
  } catch (error) {
    try { db.rawDb.exec("ROLLBACK"); } catch { /* closed */ }
    throw error;
  }
}

export function summarizeRepairBatch(db: ZeroLinkDb, batchId: string): RepairBatchStatus {
  const audit = auditQueue(db);
  const matches = audit.manifests.filter((manifest) => manifest.batchId === batchId);
  if (matches.length !== 1 || audit.queueIntegrityConflicts > 0) {
    const manifest = matches.length === 1 ? matches[0] : null;
    const byId = new Map(audit.rows.map((row) => [row.id, row]));
    const degraded: RepairBatchStatus = {
      version: 1, batchId, finalized: false, integrityConflicts: Math.max(1, audit.queueIntegrityConflicts),
      selected: manifest?.ownership.length ?? 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0,
      outcomes: { resolved: 0, terminalNoGraphLinks: 0, blockedSourceUnavailable: 0, sourceChanged: 0, invalidTerminal: 0, commitUnknown: 0 },
    };
    for (const owner of manifest?.ownership ?? []) {
      const row = byId.get(owner.jobId);
      if (row) degraded[row.status]++;
    }
    return degraded;
  }
  const manifest = matches[0];
  if (manifest.finalized) {
    const aggregates = aggregateFinalizedEntries(manifest.finalizedEntries);
    return {
      version: 1,
      batchId,
      finalized: true,
      integrityConflicts: 0,
      selected: manifest.ownership.length,
      pending: 0,
      running: 0,
      done: aggregates.statusCounts.done,
      failed: aggregates.statusCounts.failed,
      cancelled: aggregates.statusCounts.cancelled,
      outcomes: aggregates.outcomes,
    };
  }
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

export function finalizeRepairBatch(db: ZeroLinkDb, batchId: string): RepairBatchStatus {
  db.rawDb.exec("BEGIN IMMEDIATE");
  try {
    const audit = auditQueue(db);
    if (audit.queueIntegrityConflicts > 0) throw new Error("BATCH_INTEGRITY_CONFLICT");
    const manifest = audit.manifestByBatchId.get(batchId);
    if (!manifest) throw new Error("BATCH_NOT_FOUND");
    if (manifest.finalized) {
      db.rawDb.exec("COMMIT");
      return summarizeRepairBatch(db, batchId);
    }
    const byId = new Map(audit.rows.map((row) => [row.id, row]));
    const entries: FinalizedEntry[] = [];
    for (const owner of manifest.ownership) {
      const row = byId.get(owner.jobId);
      if (!row || (row.status !== "done" && row.status !== "failed" && row.status !== "cancelled")) {
        db.rawDb.exec("COMMIT");
        return summarizeRepairBatch(db, batchId);
      }
      const result = readOutcome(row);
      if (result?.outcome === "commit_unknown") {
        db.rawDb.exec("COMMIT");
        return summarizeRepairBatch(db, batchId);
      }
      let graphOutcome: FinalizedEntry["graphOutcome"] = null;
      if (row.status === "done") {
        const raw = result?.graphOutcome;
        graphOutcome = raw === "resolved" || raw === "terminal_no_graph_links" || raw === "blocked_source_unavailable" || raw === "source_changed" || raw === "invalid_terminal"
          ? raw
          : "invalid_terminal";
      }
      entries.push({ ...owner, terminalStatus: row.status, graphOutcome });
    }
    const finalizedData = {
      version: 1,
      repairName: "zero-link-rich-records",
      batchId,
      ownership: manifest.ownership,
      finalizedEntries: entries,
      ledgerDigest: canonicalLedgerDigest(batchId, entries),
    };
    const aggregates = aggregateFinalizedEntries(entries);
    const result = {
      finalized: true,
      version: 1,
      statusCounts: aggregates.statusCounts,
      outcomes: aggregates.outcomes,
      completedAt: new Date().toISOString(),
    };
    const updated = db.rawDb.prepare(
      "UPDATE jobs SET data=?, result=? WHERE id=? AND name='zero-link-backfill-batch' AND data=?",
    ).run(JSON.stringify(finalizedData), JSON.stringify(result), manifest.row.id, manifest.row.data);
    if (updated.changes !== 1) throw new Error("BATCH_INTEGRITY_CONFLICT");
    db.rawDb.exec("COMMIT");
    return summarizeRepairBatch(db, batchId);
  } catch (error) {
    try { db.rawDb.exec("ROLLBACK"); } catch { /* closed */ }
    throw error;
  }
}

export interface CommitUnknownList {
  count: number;
  jobIds: number[];
  integrityConflicts: number;
}

function validOrdinaryCommitUnknownIds(audit: QueueAudit): number[] {
  const ownedIds = new Set(audit.manifests.flatMap((manifest) => manifest.ownership.map((entry) => entry.jobId)));
  const candidates: Array<{ id: number; slug: string; fingerprint: string }> = [];
  for (const row of audit.rows) {
    if (row.name !== "ner-backfill" || row.status !== "done" || ownedIds.has(row.id)) continue;
    const data = audit.parsedById.get(row.id);
    const result = readOutcome(row);
    const sourceKind = data?.sourceFingerprint?.startsWith("page:")
      ? "vault_hash"
      : data?.sourceFingerprint?.startsWith("derived:") ? "raw_chunks" : null;
    if (
      !data || !ordinaryCommitUnknownValid(row, data) ||
      !sourceKind || !validFingerprint(data.sourceFingerprint, sourceKind) ||
      result?.outcome !== "commit_unknown"
    ) continue;
    candidates.push({ id: row.id, slug: data.slug, fingerprint: data.sourceFingerprint });
  }
  const duplicateKeys = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.slug}\0${candidate.fingerprint}`;
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
  }
  return candidates.filter((candidate) => !duplicateKeys.has(`${candidate.slug}\0${candidate.fingerprint}`)).map((candidate) => candidate.id);
}

export function listOrdinaryCommitUnknown(db: ZeroLinkDb): CommitUnknownList {
  const audit = auditQueue(db);
  const jobIds = validOrdinaryCommitUnknownIds(audit);
  return { count: jobIds.length, jobIds, integrityConflicts: audit.queueIntegrityConflicts };
}

export type CommitUnknownDecision = "accept" | "retry" | "release-successor";
export interface CommitUnknownResolution {
  jobId: number;
  decision: CommitUnknownDecision;
  success: boolean;
  successorCount: number;
}

export function resolveOrdinaryCommitUnknown(
  db: ZeroLinkDb,
  jobId: number,
  decision: CommitUnknownDecision,
): CommitUnknownResolution {
  db.rawDb.exec("BEGIN IMMEDIATE");
  try {
    const audit = auditQueue(db);
    const row = audit.rows.find((candidate) => candidate.id === jobId);
    const parsed = row ? audit.parsedById.get(row.id) : undefined;
    const owned = audit.manifests.some((manifest) => manifest.ownership.some((entry) => entry.jobId === jobId));
    if (owned || parsed?.repair) throw new Error("BATCH_ROLLBACK_REQUIRED");
    const validIds = validOrdinaryCommitUnknownIds(audit);
    if (audit.queueIntegrityConflicts > 0 || audit.globalStateConflictSlugs.size > 0 || !row || !parsed || !validIds.includes(jobId)) {
      throw new Error("COMMIT_UNKNOWN_INTEGRITY_CONFLICT");
    }

    const current = deriveZeroLinkSource(db, parsed.slug);
    const currentPage = db.rawDb.prepare("SELECT content_hash FROM pages WHERE slug=?").get(parsed.slug) as { content_hash: string | null } | undefined;
    const live = audit.rows.filter((candidate) => {
      if (candidate.id === jobId || candidate.name !== "ner-backfill" || !ACTIVE_STATUSES.has(candidate.status)) return false;
      return audit.parsedById.get(candidate.id)?.slug === parsed.slug;
    });
    const validSuccessors = live.filter((candidate) => {
      const data = audit.parsedById.get(candidate.id);
      return candidate.status === "pending" && !data?.repair && data?.sourceFingerprint &&
        data.sourceFingerprint !== parsed.sourceFingerprint && data.sourceFingerprint === current.contentFingerprint &&
        ordinaryCurrentIdentityValid(db, data) && data.contentHash === currentPage?.content_hash;
    });
    const successorShapeValid = live.length === validSuccessors.length && validSuccessors.length <= 1;
    let legal = false;
    if (decision === "accept") legal = successorShapeValid && (live.length === 0 || validSuccessors.length === 1);
    else if (decision === "retry") legal = live.length === 0 && current.contentFingerprint === parsed.sourceFingerprint;
    else if (decision === "release-successor") legal = successorShapeValid && validSuccessors.length === 1 && current.contentFingerprint !== parsed.sourceFingerprint && current.contentFingerprint !== null;
    if (!legal) throw new Error("COMMIT_UNKNOWN_STATE_MISMATCH");

    let updated: { changes: number };
    if (decision === "retry") {
      updated = db.rawDb.prepare(
        `UPDATE jobs SET status='pending', result=NULL, error=NULL, attempts=0, started_at=NULL, finished_at=NULL
         WHERE id=? AND status='done' AND result=?`,
      ).run(jobId, row.result);
    } else {
      const result = decision === "accept"
        ? { outcome: "processed", kind: "ner", reason: "COMMIT_UNKNOWN_ACCEPTED" }
        : { outcome: "commit_unknown_released", kind: "ner" };
      updated = db.rawDb.prepare(
        "UPDATE jobs SET result=? WHERE id=? AND status='done' AND result=?",
      ).run(JSON.stringify(result), jobId, row.result);
    }
    if (updated.changes !== 1) throw new Error("COMMIT_UNKNOWN_STATE_MISMATCH");
    db.rawDb.exec("COMMIT");
    return { jobId, decision, success: true, successorCount: validSuccessors.length };
  } catch (error) {
    try { db.rawDb.exec("ROLLBACK"); } catch { /* closed */ }
    throw error;
  }
}
