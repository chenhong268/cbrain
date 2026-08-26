import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getReverseRelation } from "../core/shared.js";
import {
  PageWriteProvenanceConflictError,
  provenanceMatchesRow,
  toConflictFields,
  validateOriginRef,
  type PageCreationProvenanceInput,
  type PageWriteProvenanceRow,
} from "../core/page-write-provenance.js";
import { parseFingerprintedNerJob } from "../core/ingestion/ner-backfill-contract.js";
import {
  runAliasMigrations,
  ensurePagesIndexes,
  runDiscoveryMigrations,
  runLatePageMigrations,
  runMissingIndexMigrations,
  runLinkMigrations,
  runPageMigrations,
  runProvenanceMigrations,
  runRecommendationRecordsMigration,
  runQueryInteractionMigrations,
  runTelemetryMigrations,
  validatePagesIndexes,
} from "./migrations/index.js";

// #386: DB-level origin_ref format enforcement. SQLite GLOB supports [a-z]
// character classes (case-sensitive). UUID = 8-4-4-4-12 hex; ULID = Crockford
// base32 with first char 0-7 (avoids >128-bit overflow). A BEFORE INSERT
// trigger uses these so NO path — including direct SQL — can persist a
// credential-shaped origin_ref. Credential detection at the method layer can
// never be exhaustive; this makes "no credential in SQLite" structural.
const ORIGIN_REF_UUID_GLOB = [8, 4, 4, 4, 12].map((n) => "[0-9a-fA-F]".repeat(n)).join("-");
const ORIGIN_REF_ULID_GLOB = "[0-7]" + "[0-9A-HJKMNP-TV-Z]".repeat(25);

/** Raised when a destructive migration's FK integrity check fails (#209).
 * Carries summarized per-table counts (NO raw row data) so callers can emit an
 * anonymized diagnostic and point the operator at `cbrain repair-fk`. */
export class FKMigrationError extends Error {
  readonly migrationName: string;
  readonly violationsByTable: Record<string, number>;
  readonly total: number;
  constructor(migrationName: string, violationsByTable: Record<string, number>) {
    const total = Object.values(violationsByTable).reduce((a, b) => a + b, 0);
    super(
      `FK integrity check failed in migration "${migrationName}": ${total} violation(s) across ${Object.keys(violationsByTable).length} table(s)`,
    );
    this.name = "FKMigrationError";
    this.migrationName = migrationName;
    this.violationsByTable = violationsByTable;
    this.total = total;
  }
}

export class CBrainReadSnapshotError extends Error {
  constructor() {
    super("Unable to create a stable read snapshot.");
    this.name = "CBrainReadSnapshotError";
  }
}

interface SourceFileIdentity {
  exists: boolean;
  dev?: bigint;
  ino?: bigint;
  size?: bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
}

interface ReadSnapshotSourceState {
  physicalDbPath: string;
  main: SourceFileIdentity;
  wal: SourceFileIdentity;
}

class ReadSnapshotSourceChangedError extends Error {}

function sourceFileIdentity(path: string, required: boolean): SourceFileIdentity {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile()) throw new CBrainReadSnapshotError();
    return {
      exists: true,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
    };
  } catch (error) {
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

function captureReadSnapshotSource(dbPath: string): ReadSnapshotSourceState {
  const physicalDbPath = realpathSync(dbPath);
  return {
    physicalDbPath,
    main: sourceFileIdentity(physicalDbPath, true),
    wal: sourceFileIdentity(`${physicalDbPath}-wal`, false),
  };
}

function sameSourceFile(a: SourceFileIdentity, b: SourceFileIdentity): boolean {
  return a.exists === b.exists
    && a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs;
}

function sameReadSnapshotSource(a: ReadSnapshotSourceState, b: ReadSnapshotSourceState): boolean {
  return a.physicalDbPath === b.physicalDbPath
    && sameSourceFile(a.main, b.main)
    && sameSourceFile(a.wal, b.wal);
}

function recoverAndSerializeReadSnapshot(snapshotPath: string): Uint8Array {
  const recovery = new Database(snapshotPath);
  try {
    // Force WAL playback on the isolated copy, then merge every committed frame
    // into its main file. The live DB directory and live -shm are never opened.
    recovery.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get();
    const checkpoint = recovery.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    if (checkpoint.busy !== 0 || checkpoint.checkpointed < checkpoint.log) {
      throw new CBrainReadSnapshotError();
    }
    const mode = recovery.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string };
    if (mode.journal_mode !== "delete") throw new CBrainReadSnapshotError();
    return recovery.serialize();
  } finally {
    recovery.close();
  }
}

function removeReadSnapshotDirectory(directory: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      if (!existsSync(directory)) return true;
    } catch {
      // Retry once, then let the caller fail closed with a path-free error.
    }
  }
  return false;
}

function createReadSnapshot(
  dbPath: string,
  testHooks: {
    afterCopy?(attempt: number, directory: string, snapshotPath: string): void;
  } = {},
): Database {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let directory: string;
    try {
      directory = mkdtempSync(join(tmpdir(), "cbrain-read-snapshot-"));
    } catch {
      throw new CBrainReadSnapshotError();
    }
    try {
      chmodSync(directory, 0o700);
      const before = captureReadSnapshotSource(dbPath);
      const snapshotPath = join(directory, basename(before.physicalDbPath));
      copyFileSync(before.physicalDbPath, snapshotPath);
      chmodSync(snapshotPath, 0o600);
      if (before.wal.exists) {
        copyFileSync(`${before.physicalDbPath}-wal`, `${snapshotPath}-wal`);
        chmodSync(`${snapshotPath}-wal`, 0o600);
      }
      testHooks.afterCopy?.(attempt, directory, snapshotPath);
      let after: ReadSnapshotSourceState;
      try {
        after = captureReadSnapshotSource(dbPath);
      } catch {
        throw new ReadSnapshotSourceChangedError();
      }
      if (!sameReadSnapshotSource(before, after)) throw new ReadSnapshotSourceChangedError();

      const serialized = recoverAndSerializeReadSnapshot(snapshotPath);
      // No disk snapshot survives constructor return or process.exit. The
      // exposed connection is a native read-only deserialized in-memory DB.
      if (!removeReadSnapshotDirectory(directory)) throw new CBrainReadSnapshotError();
      return Database.deserialize(serialized, { readonly: true });
    } catch (error) {
      removeReadSnapshotDirectory(directory);
      if (error instanceof ReadSnapshotSourceChangedError && attempt + 1 < maxAttempts) continue;
      throw new CBrainReadSnapshotError();
    }
  }
  throw new CBrainReadSnapshotError();
}

/** @internal — deterministic seam for bounded source-change retry tests. */
export function openReadSnapshotWithHookForTest(
  dbPath: string,
  afterCopy: (attempt: number, directory: string, snapshotPath: string) => void,
): void {
  const snapshot = createReadSnapshot(dbPath, { afterCopy });
  snapshot.close();
}

/** @internal — test hook to exercise runDestructiveMigration's FK path. (#209) */
export function runDestructiveMigrationForTest(
  db: CBrainDB,
  name: string,
  completionKey: string,
  body: () => void,
): void {
  (db as unknown as { runDestructiveMigration(o: { name: string; completionKey: string; body: () => void }): void })
    .runDestructiveMigration({ name, completionKey, body });
}

export interface NerAttemptIdentity {
  slug: string;
  kind: "ner";
  sourceFingerprint: string | null;
  batchId: string | null;
  payloadDigest: string;
}

export function buildNerAttemptIdentity(data: Record<string, unknown>): NerAttemptIdentity | null {
  const kind = data.kind === undefined || data.kind === "ner" ? "ner" : null;
  if (!kind || typeof data.slug !== "string" || !data.slug.trim()) return null;
  const frozenFieldsPresent = Object.hasOwn(data, "repair") ||
    Object.hasOwn(data, "sourceFingerprint") || Object.hasOwn(data, "sourceKind");
  const fingerprinted = frozenFieldsPresent ? parseFingerprintedNerJob(data) : null;
  if (frozenFieldsPresent && !fingerprinted) return null;
  const sourceFingerprint = fingerprinted?.sourceFingerprint ?? null;
  const batchId = fingerprinted?.repair?.batchId ?? null;
  const { attemptLease: _lease, ...payload } = data;
  const payloadDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return { slug: data.slug, kind, sourceFingerprint, batchId, payloadDigest };
}

function buildStrictFrozenNerIdentity(data: Record<string, unknown>): NerAttemptIdentity | null {
  const identity = buildNerAttemptIdentity(data);
  const fingerprinted = parseFingerprintedNerJob(data);
  if (!identity?.sourceFingerprint || !fingerprinted) return null;
  const hasPageHash = Object.hasOwn(data, "pageContentHash");
  const hasContentHash = Object.hasOwn(data, "contentHash");
  if (!hasPageHash && !hasContentHash) return null;
  const contentHash = hasPageHash ? data.pageContentHash : data.contentHash;
  if (contentHash !== null && typeof contentHash !== "string") return null;
  if (fingerprinted.sourceKind === "vault_hash" &&
    (typeof contentHash !== "string" || identity.sourceFingerprint !== `page:${contentHash}`)) return null;
  return identity;
}

function sameNerAttemptIdentity(left: NerAttemptIdentity, right: NerAttemptIdentity): boolean {
  return left.slug === right.slug && left.kind === right.kind &&
    left.sourceFingerprint === right.sourceFingerprint && left.batchId === right.batchId &&
    left.payloadDigest === right.payloadDigest;
}

function leaseMatchesNerIdentity(
  data: Record<string, unknown>,
  token: string,
  phase: "claimed" | "committing",
  frozenPayloadDigest: string,
): boolean {
  const identity = buildNerAttemptIdentity(data);
  const lease = typeof data.attemptLease === "object" && data.attemptLease !== null && !Array.isArray(data.attemptLease)
    ? data.attemptLease as Record<string, unknown>
    : null;
  return Boolean(
    identity && lease?.version === 1 && lease.token === token && lease.phase === phase &&
    lease.slug === identity.slug && lease.kind === identity.kind &&
    lease.sourceFingerprint === identity.sourceFingerprint && lease.batchId === identity.batchId &&
    lease.payloadDigest === identity.payloadDigest && identity.payloadDigest === frozenPayloadDigest,
  );
}

const ACTIVE_LINK_SQL = "(trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
const CURRENT_FACT_LINK_SQL = `${ACTIVE_LINK_SQL} AND NOT (relation = 'reports_to' AND trust_state = 'candidate')`;

const ALLOWED_ORDER_COLUMNS = new Set([
  "slug", "title", "type", "created_at", "updated_at", "mention_count", "tier",
]);
const ALLOWED_DIRECTIONS = new Set(["ASC", "DESC"]);

function sanitizeOrderBy(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 2) return fallback;
  if (!ALLOWED_ORDER_COLUMNS.has(parts[0])) return fallback;
  if (parts.length === 2 && !ALLOWED_DIRECTIONS.has(parts[1].toUpperCase())) return fallback;
  return `${parts[0]} ${parts.length === 2 ? parts[1].toUpperCase() : "ASC"}`;
}

// ─── Row types ──────────────────────────────────────────────

export interface PageRow {
  slug: string;
  type: string;
  title: string;
  file_path: string;
  content_hash: string | null;
  ingest_content_hash: string | null;
  tier: number;
  mention_count: number;
  expires_at: string | null;
  confidence_decay: number;
  hotness_score: number;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  id: number;
  from_slug: string;
  to_slug: string;
  relation: string;
  weight: number;
  strength: string;
  context: string | null;
  source_type: string;
  confidence: number;
  created_at: string;
  last_validated_at: string | null;
  effective_weight: number;
  source_page_slug?: string;
  trust_state?: string;
  evidence?: string;
}
export type SemanticEventDate = string;
export interface BoundedTrustedTimelineRow {
  page_slug: string;
  event_date: SemanticEventDate;
  summary: string;
  trust_state: "trusted" | "user_thought";
}

/**
 * Supported semantic timeline dates. The timeline model stores partial dates
 * from extraction, so year, year-month, and full ISO calendar dates are valid.
 * Free text, empty strings, impossible month/day values, and timestamps are not.
 */
export function isSupportedSemanticEventDate(value: string | null | undefined): value is SemanticEventDate {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (year < 1) return false;
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (isLeapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= daysInMonth;
}


export interface ProvenanceInput {
  source_page_slug?: string;
  evidence?: string;
}

export interface UpsertPageData {
  slug: string;
  type: string;
  title: string;
  filePath: string;
  contentHash?: string;
}

export interface InsightRow {
  id: number;
  content: string;
  type: string;
  confidence: number;
  source_entities: string | null;
  source_type: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  seen: number;
}

export interface CreateInsightInput {
  content: string;
  type: "synthesis" | "pattern" | "anomaly" | "bridge";
  confidence?: number;
  sourceEntities?: string[];
  sourceType: "reflect" | "discovery" | "manual";
  expiresAt?: string | null;
}

export type CandidateType = "theme_convergence" | "supported_connection" | "judgment_shift" | "preference_observation" | "other";
export type CandidateStatus = "pending" | "accepted" | "rejected" | "deferred" | "disabled" | "superseded";
export type FeedbackAction = "accept" | "reject" | "defer" | "disable" | "superseded" | "reactivate";

export interface CandidateRow {
  id: number;
  title: string;
  summary: string | null;
  candidate_type: CandidateType;
  status: CandidateStatus;
  evidence_json: string | null;
  scores_json: string | null;
  source_slugs_json: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface CandidateFeedbackRow {
  id: number;
  candidate_id: number;
  action: FeedbackAction;
  note: string | null;
  created_at: string;
}

export class CBrainDB {
  private db: Database;

  /** Expose raw Database for bounded stores that share the same connection. */
  get rawDb(): Database {
    return this.db;
  }

  /** Flush WAL to main database file for crash-safe file-level backup. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /**
   * Open (and normally migrate) the brain DB.
   *
   * opts.skipMigrate: open WITHOUT running migrations. Used by `cbrain repair-fk`
   * (#209) so the repair command can open a DB whose migrations are currently
   * FK-failing — serve refuses to start on such a DB, but repair-fk must still
   * be able to open it and clean orphan rows. This is a repair-only escape
   * hatch: it does not initialize new schema. Callers must only use methods that
   * can operate against the already-existing DB shape.
   * opts.readSnapshot: capture a bounded stable copy of the existing main DB
   * plus its WAL (when present), recover that copy in an isolated temp
   * directory, then expose only a native read-only connection to the recovered
   * snapshot. The live main/WAL/SHM files are never opened through SQLite.
   */
  constructor(dbPath: string, opts: { skipMigrate?: boolean; readSnapshot?: boolean } = {}) {
    if (opts.readSnapshot) {
      if (opts.skipMigrate === false) {
        throw new Error("read snapshot CBrainDB requires skipMigrate (omit it or set true)");
      }
      this.db = createReadSnapshot(dbPath);
      return;
    }
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    // busy_timeout 尽早设：让后续普通语句（migrate 写、读 schema 等）在 SQLITE_BUSY
    // 时自动重试。注意 `PRAGMA journal_mode = WAL` 的 EXCLUSIVE 获取不被 busy_handler
    // 保护，所以下方「已 WAL 就跳过这条 PRAGMA」才是 flaky 的根治。#307
    this.db.exec("PRAGMA busy_timeout = 5000");
    // 只在非 WAL 时切换：对已 WAL 的 DB 再执行 `PRAGMA journal_mode = WAL` 即使是
    // no-op，SQLite 仍会尝试获取 EXCLUSIVE 锁来「切换」，而 busy_handler 不保护该
    // PRAGMA，遇 checkpoint 窗口立即抛 "database is locked"（fsck CLI reopen WAL
    // DB 时偶发，#307）。读 journal_mode 是纯元数据读，不抢 EXCLUSIVE，安全。
    const modeRow = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    if (modeRow?.journal_mode !== "wal") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA cache_size = -64000");
    this.db.exec("PRAGMA mmap_size = 268435456");
    this.db.exec("PRAGMA synchronous = NORMAL");
    if (opts.skipMigrate) return;
    try {
      this.migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_slug TEXT NOT NULL,
        to_slug TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'mentions',
        weight REAL DEFAULT 1.0,
        strength TEXT DEFAULT 'medium' CHECK(strength IN ('strong','medium','weak')),
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (from_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        FOREIGN KEY (to_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(from_slug, to_slug, relation)
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, tag)
      );

      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        event_date TEXT,
        source TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS ingest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        action TEXT NOT NULL,
        page_slug TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
      CREATE INDEX IF NOT EXISTS idx_pages_tier ON pages(tier);
      CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_slug);
      CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_slug);
      CREATE INDEX IF NOT EXISTS idx_links_relation ON links(relation);
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
      CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline(event_date);
      CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_slug);

      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        frontmatter TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, version)
      );

      CREATE INDEX IF NOT EXISTS idx_versions_page ON versions(page_slug);

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        data TEXT,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS discoveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        entities TEXT NOT NULL,
        score REAL NOT NULL,
        detail TEXT,
        detected_at TEXT NOT NULL,
        dream_run TEXT,
        seen INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);

      CREATE TABLE IF NOT EXISTS insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('synthesis','pattern','anomaly','bridge')),
        confidence REAL DEFAULT 0.5,
        source_entities TEXT,
        source_type TEXT NOT NULL CHECK(source_type IN ('reflect','discovery','manual')),
        status TEXT DEFAULT 'active' CHECK(status IN ('active','archived','dismissed')),
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        seen INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(type);
      CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status);
      CREATE INDEX IF NOT EXISTS idx_insights_source_type ON insights(source_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(page_slug, content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        alias TEXT NOT NULL,
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, alias)
      );

      CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
      CREATE INDEX IF NOT EXISTS idx_aliases_page ON aliases(page_slug);

      CREATE TABLE IF NOT EXISTS mention_snapshots (
        slug TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        mention_count INTEGER NOT NULL,
        PRIMARY KEY (slug, snapshot_date),
        FOREIGN KEY (slug) REFERENCES pages(slug) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS compounding_review_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        summary TEXT,
        candidate_type TEXT NOT NULL CHECK(candidate_type IN ('theme_convergence','supported_connection','judgment_shift','preference_observation','other')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','deferred','disabled','superseded')),
        evidence_json TEXT,
        scores_json TEXT,
        source_slugs_json TEXT,
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS compounding_review_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('accept','reject','defer','disable','superseded','reactivate')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (candidate_id) REFERENCES compounding_review_candidates(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_crc_status ON compounding_review_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_crc_last_seen ON compounding_review_candidates(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_crf_candidate ON compounding_review_feedback(candidate_id);

      -- #386: page_write_provenance table (append-only record-page creation
      -- provenance). The TABLE is safe in the base block: its FK->pages is handled
      -- by PRAGMA foreign_keys=OFF during pages rebuilds. Only its TRIGGERS
      -- reference pages() in their bodies and must be absent during a pages
      -- rebuild — they are dropped before and recreated after the rebuilding
      -- migrations below. The table and its rows are NEVER dropped by migrate().
      CREATE TABLE IF NOT EXISTS page_write_provenance (
        page_slug TEXT PRIMARY KEY,
        write_mode TEXT NOT NULL CHECK(write_mode IN ('ingest','put_page','external_direct_write','unknown_write_path')),
        actor_class TEXT NOT NULL CHECK(actor_class IN ('operator','agent','system','unknown_writer')),
        creation_reason TEXT NOT NULL CHECK(creation_reason IN ('explicit_ingest','explicit_page_create','vault_file_discovered','unattributed_internal_create')),
        origin_kind TEXT CHECK(origin_kind IS NULL OR origin_kind IN ('session','job')),
        origin_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_page_write_provenance_actor ON page_write_provenance(actor_class);
    `);

    // #386: the two migrations below rebuild pages (DROP+RENAME pages). The
    // page_write_provenance triggers reference pages() in their bodies and must
    // be absent during each rebuild; runWithProvenanceTriggersSuspended drops
    // them, runs the rebuild, and ALWAYS recreates them in finally (fail-closed:
    // a mid-migration failure can never leave the DB without its
    // immutability/privacy/delete-protection triggers). The pwp TABLE is never
    // dropped, so rows from any prior build survive.
    this.runWithProvenanceTriggersSuspended(() => this.migratePagesConstraint());
    runPageMigrations(this.db);
    runLinkMigrations(this.db);
    runDiscoveryMigrations(this.db, CBrainDB.discoveryDedupKey);
    runTelemetryMigrations(this.db);
    this.migrateRawToRecords();
    runQueryInteractionMigrations(this.db);
    runAliasMigrations(this.db);
    this.migrateChunksSummaryLevel();
    this.runWithProvenanceTriggersSuspended(() => this.migrateOntologyTypes());
    runMissingIndexMigrations(this.db);
    runProvenanceMigrations(this.db);
    runLatePageMigrations(this.db);
    this.repairDirtyData();
    runRecommendationRecordsMigration(this.db);
  }

  /**
   * #386: (re)create the four page_write_provenance protection triggers. Called
   * on a fresh DB (via the wrappers' finally) and after every pages rebuild.
   * Idempotent (IF NOT EXISTS). The triggers reference pages() in their bodies.
   */
  private ensurePageWriteProvenanceTriggers(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS page_write_provenance_immutable
      BEFORE UPDATE OF write_mode, actor_class, creation_reason, origin_kind, origin_ref, created_at
      ON page_write_provenance
      BEGIN
        SELECT RAISE(ABORT, 'page_write_provenance is immutable: attribution fields cannot be updated (only page_slug may move)');
      END;

      CREATE TRIGGER IF NOT EXISTS page_write_provenance_no_direct_delete
      BEFORE DELETE ON page_write_provenance
      BEGIN
        SELECT CASE WHEN EXISTS (SELECT 1 FROM pages WHERE slug = OLD.page_slug)
          THEN RAISE(ABORT, 'page_write_provenance is immutable: direct DELETE refused (removed only when the page is deleted)')
        END;
      END;

      CREATE TRIGGER IF NOT EXISTS page_write_provenance_no_transfer
      BEFORE UPDATE OF page_slug ON page_write_provenance
      BEGIN
        SELECT CASE WHEN EXISTS (SELECT 1 FROM pages WHERE slug = OLD.page_slug)
          THEN RAISE(ABORT, 'page_write_provenance.page_slug may only move via page rename (movePage); direct transfer to another page is refused')
        END;
      END;

      CREATE TRIGGER IF NOT EXISTS page_write_provenance_origin_format
      BEFORE INSERT ON page_write_provenance
      BEGIN
        SELECT CASE
          WHEN NOT ((NEW.origin_kind IS NULL) = (NEW.origin_ref IS NULL))
            THEN RAISE(ABORT, 'page_write_provenance: origin_kind and origin_ref must both be null or both present')
          WHEN NEW.origin_ref IS NOT NULL
             AND NEW.origin_ref NOT GLOB '${ORIGIN_REF_UUID_GLOB}'
             AND NEW.origin_ref NOT GLOB '${ORIGIN_REF_ULID_GLOB}'
            THEN RAISE(ABORT, 'page_write_provenance.origin_ref must be a UUID or ULID (no credentials/paths)')
          ELSE NULL
        END;
      END;
    `);
  }

  /**
   * #386: run a pages-rebuilding migration with the page_write_provenance
   * triggers temporarily removed. The triggers reference pages() in their bodies
   * and must be absent while pages is DROP+RENAME'd (else SQLite recompiles a
   * trigger while pages is gone -> 'no such table: pages'). The triggers are
   * ALWAYS restored in finally — even if fn throws — so a mid-migration failure
   * can never leave the DB without its immutability/privacy/delete-protection
   * guarantees (fail-closed). The window is narrowed to just the rebuild, not
   * the whole migration chain. (fn's failure rolls its rebuild tx back first, so
   * pages exists again before triggers are recreated.)
   */
  private runWithProvenanceTriggersSuspended(fn: () => void): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS page_write_provenance_immutable;
      DROP TRIGGER IF EXISTS page_write_provenance_no_direct_delete;
      DROP TRIGGER IF EXISTS page_write_provenance_no_transfer;
      DROP TRIGGER IF EXISTS page_write_provenance_origin_format;
    `);
    try {
      fn();
    } finally {
      this.ensurePageWriteProvenanceTriggers();
    }
  }

  private migratePagesConstraint(): void {
    // Capture baseline before migration
    const preCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number }).cnt;

    this.runDestructiveMigration({
      name: "migratePagesConstraint",
      completionKey: "migration_v4_pages_constraint",
      body: () => {
        const check = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string } | undefined;
        // Already has the correct constraint (v4) or no constraint at all (v6+) — skip
        if (check?.sql?.includes("'insight'") && !check.sql.includes("'source'") && !check.sql.includes("'event'") && !check.sql.includes("'raw'")) return;
        if (check?.sql && !check.sql.includes("CHECK(type IN")) return;

        // Convert legacy event and raw pages to record before migration
        this.db.prepare("UPDATE pages SET type = 'record' WHERE type = 'event'").run();
        this.db.prepare("UPDATE pages SET type = 'record' WHERE type = 'raw'").run();

        this.cleanupTempTable("pages_new", "pages");

        this.db.exec(`
          CREATE TABLE pages_new (
            slug TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'insight')),
            title TEXT NOT NULL,
            file_path TEXT NOT NULL,
            content_hash TEXT,
            tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
            mention_count INTEGER DEFAULT 0,
            expires_at TEXT,
            confidence_decay REAL DEFAULT 1.0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO pages_new SELECT slug, type, title, file_path, content_hash, tier, mention_count, expires_at, confidence_decay, created_at, updated_at FROM pages;
          DROP TABLE pages;
          ALTER TABLE pages_new RENAME TO pages;
        `);

        ensurePagesIndexes(this.db);
      },
      validate: () => {
        // pages table must exist, pages_new must not
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pages', 'pages_new')").all() as Array<{ name: string }>;
        const tableNames = new Set(tables.map(t => t.name));
        if (!tableNames.has("pages")) throw new Error("pages table missing after rebuild");
        if (tableNames.has("pages_new")) throw new Error("pages_new residual after rebuild");

        // Required columns must exist
        const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
        const colNames = new Set(cols.map(c => c.name));
        for (const required of ["slug", "type", "title", "file_path", "created_at"]) {
          if (!colNames.has(required)) throw new Error(`pages missing required column: ${required}`);
        }

        // Row count must match baseline
        const postCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number }).cnt;
        if (postCount !== preCount) throw new Error(`pages row count mismatch: expected ${preCount}, got ${postCount}`);

        // Verify indexes that exist at v4 stage (activity_weight column not added yet,
        // so full validatePagesIndexes() would fail — ontology validate handles the rest)
        const idxRows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_pages_type', 'idx_pages_tier')").all() as Array<{ name: string }>;
        const idxNames = new Set(idxRows.map(i => i.name));
        if (!idxNames.has("idx_pages_type")) throw new Error("idx_pages_type missing after rebuild");
        if (!idxNames.has("idx_pages_tier")) throw new Error("idx_pages_tier missing after rebuild");
      },
    });
  }

  /**
   * v5 migration: raw→record type merge + path unification.
   * - Converts raw/* slugs to records/*
   * - Converts brain/records/* slugs to records/*
   * - Updates links, chunks, tags, timeline, versions tables accordingly
   */
  private migrateRawToRecords(): void {
    this.runDestructiveMigration({
      name: "migrateRawToRecords",
      completionKey: "migration_v5_raw_to_records",
      body: () => {
        // 1. Update raw/* slugs → records/* in pages
        this.db.prepare("UPDATE pages SET slug = REPLACE(slug, 'raw/', 'records/'), file_path = REPLACE(file_path, 'raw/', 'records/') WHERE slug LIKE 'raw/%'").run();

        // 2. Update brain/records/* slugs → records/* in pages
        this.db.prepare("UPDATE pages SET slug = REPLACE(slug, 'brain/records/', 'records/'), file_path = REPLACE(file_path, 'brain/records/', 'records/') WHERE slug LIKE 'brain/records/%'").run();

        // 3. Update links table (from_slug and to_slug)
        this.db.prepare("UPDATE links SET from_slug = REPLACE(from_slug, 'raw/', 'records/') WHERE from_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE links SET to_slug = REPLACE(to_slug, 'raw/', 'records/') WHERE to_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE links SET from_slug = REPLACE(from_slug, 'brain/records/', 'records/') WHERE from_slug LIKE 'brain/records/%'").run();
        this.db.prepare("UPDATE links SET to_slug = REPLACE(to_slug, 'brain/records/', 'records/') WHERE to_slug LIKE 'brain/records/%'").run();

        // 4. Update chunks table
        this.db.prepare("UPDATE chunks SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE chunks SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

        // 5. Update chunks_fts virtual table (no FK; must be migrated explicitly)
        this.db.prepare("UPDATE chunks_fts SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE chunks_fts SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

        // 6. Update tags table
        this.db.prepare("UPDATE tags SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE tags SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

        // 7. Update timeline table
        this.db.prepare("UPDATE timeline SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE timeline SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

        // 8. Update versions table
        this.db.prepare("UPDATE versions SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE versions SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

        // 9. Update ingest_log table
        this.db.prepare("UPDATE ingest_log SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
        this.db.prepare("UPDATE ingest_log SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();
      },
      validate: () => {
        // Exhaustive check: every table/column that the body updates must have no
        // raw/* or brain/records/* residuals.  Fixed table+column list — no external input.
        const checks: ReadonlyArray<{ table: string; column: string }> = [
          { table: "pages", column: "slug" },
          { table: "links", column: "from_slug" },
          { table: "links", column: "to_slug" },
          { table: "chunks", column: "page_slug" },
          { table: "chunks_fts", column: "page_slug" },
          { table: "tags", column: "page_slug" },
          { table: "timeline", column: "page_slug" },
          { table: "versions", column: "page_slug" },
          { table: "ingest_log", column: "page_slug" },
        ];
        for (const { table, column } of checks) {
          for (const prefix of ["raw/%", "brain/records/%"]) {
            const row = this.db.prepare(
              `SELECT COUNT(*) as cnt FROM ${table} WHERE ${column} LIKE ?`
            ).get(prefix) as { cnt: number };
            if (row.cnt > 0) {
              throw new Error(`${row.cnt} ${prefix} ref(s) remain in ${table}.${column}`);
            }
          }
        }
      },
    });
  }

  private stmtCache = new Map<string, ReturnType<typeof this.db.prepare>>();

  private prepare(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string) {
    return this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Run a destructive migration atomically: all-or-nothing within a transaction.
   * Handles FK state save/restore, completion marker, and FK integrity check.
   * FK toggle happens OUTSIDE the transaction (SQLite constraint).
   *
   * Flow: body() → FK check → validate() → marker write.
   * validate() runs inside the same transaction; if it throws, everything rolls back.
   */
  private runDestructiveMigration(opts: {
    name: string;
    completionKey: string;
    body: () => void;
    validate?: () => void;
  }): void {
    const done = this.db.prepare("SELECT value FROM config WHERE key = ?").get(opts.completionKey) as { value: string } | undefined;
    if (done?.value === "1") return;

    const fkWasOn = (this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
    try {
      this.db.exec("PRAGMA foreign_keys = OFF");
      this.db.transaction(() => {
        opts.body();
        const violations = this.db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
        if (violations.length > 0) {
          // #209: summarized by-table counts (anonymized), not raw rowid dumps.
          const byTable: Record<string, number> = {};
          for (const v of violations) byTable[v.table] = (byTable[v.table] ?? 0) + 1;
          throw new FKMigrationError(opts.name, byTable);
        }
        if (opts.validate) opts.validate();
        this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')").run(opts.completionKey);
      })();
    } catch (e) {
      // FKMigrationError already carries the anonymized summary — rethrow as-is.
      if (e instanceof FKMigrationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${opts.name}: ${msg}`);
    } finally {
      if (fkWasOn) this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  /** Summarize FK violations by table — anonymized (no slugs/titles/paths). (#209) */
  checkFkViolations(): { byTable: Record<string, number>; total: number } {
    const rows = this.db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>;
    const byTable: Record<string, number> = {};
    for (const r of rows) byTable[r.table] = (byTable[r.table] ?? 0) + 1;
    return { byTable, total: rows.length };
  }

  /** Derived tables whose rows reference pages(slug) — repair whitelist (#209).
   *  `chunks_new` is a migration temp table and is intentionally excluded. */
  private static readonly DERIVED_FK_TABLES = new Set([
    "aliases", "chunks", "links", "mention_snapshots", "page_write_provenance", "tags", "timeline", "versions",
  ]);

  /** Delete orphan rows in derived tables (rows whose FK parent page is gone).
   * Atomic; FK-checked before & after; touches only whitelisted derived tables
   * (never pages, never markdown). (#209) */
  repairOrphanedDerivedRows(): { repairedByTable: Record<string, number>; remaining: number } {
    const before = this.checkFkViolations();
    // Read violations OUTSIDE the transaction (PRAGMA behavior is reliable here,
    // matching checkFkViolations); DELETE inside for atomicity.
    const violations = this.db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number }>;
    const byTable = new Map<string, number[]>();
    for (const r of violations) {
      if (!CBrainDB.DERIVED_FK_TABLES.has(r.table)) continue; // defensive whitelist
      if (!byTable.has(r.table)) byTable.set(r.table, []);
      byTable.get(r.table)!.push(r.rowid);
    }
    // transaction(fn) returns a wrapped fn — must invoke it. Atomicity: all orphan
    // deletes commit together or none. (#209)
    this.db.transaction(() => {
      for (const [table, rowids] of byTable) {
        const stmt = this.db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`);
        for (const rowid of rowids) stmt.run(rowid);
      }
    })();
    const after = this.checkFkViolations();
    const repairedByTable: Record<string, number> = {};
    for (const [t, beforeCount] of Object.entries(before.byTable)) {
      const removed = beforeCount - (after.byTable[t] ?? 0);
      if (removed > 0) repairedByTable[t] = removed;
    }
    return { repairedByTable, remaining: after.total };
  }

  /** Drop a leftover _new temp table from a failed prior migration.
   *  Safe: only drops if BOTH temp and production tables exist. */
  private cleanupTempTable(tempName: string, productionName: string): void {
    const rows = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)"
    ).all(tempName, productionName) as Array<{ name: string }>;
    const names = new Set(rows.map(r => r.name));
    if (names.has(tempName) && names.has(productionName)) {
      this.db.exec(`DROP TABLE ${tempName}`);
    }
  }

  // ─── Tag operations ──────────────────────────────────────────

  getTags(pageSlug: string): string[] {
    const rows = this.prepare(
      "SELECT tag FROM tags WHERE page_slug = $slug ORDER BY tag"
    ).all({ $slug: pageSlug }) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  addTag(pageSlug: string, tag: string): boolean {
    try {
      this.prepare(
        "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)"
      ).run({ $slug: pageSlug, $tag: tag });
      return true;
    } catch (e) {
      console.error(`[db] addTag 失败: ${pageSlug}/${tag}`, e);
      return false;
    }
  }

  removeTag(pageSlug: string, tag: string): boolean {
    const result = this.prepare(
      "DELETE FROM tags WHERE page_slug = $slug AND tag = $tag"
    ).run({ $slug: pageSlug, $tag: tag });
    return result.changes > 0;
  }

  // ─── Timeline operations ─────────────────────────────────────

  getTimeline(pageSlug: string, includeInactive = false): Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string; trust_state?: string; source_page_slug?: string; evidence?: string }> {
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    return this.prepare(
      `SELECT id, event_date, source, summary, created_at, trust_state, source_page_slug, evidence FROM timeline WHERE page_slug = $slug${activeFilter} ORDER BY event_date DESC, id DESC`
    ).all({ $slug: pageSlug }) as any[];
  }

  addTimelineEntry(pageSlug: string, summary: string, eventDate?: string, source?: string, provenance?: ProvenanceInput): number {
    const result = this.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, source_page_slug, trust_state, evidence) VALUES ($slug, $summary, $date, $source, $sps, $ts, $ev)"
    ).run({ $slug: pageSlug, $summary: summary, $date: eventDate ?? null, $source: source ?? null, $sps: provenance?.source_page_slug ?? null, $ts: "candidate", $ev: provenance?.evidence ?? null });
    return Number(result.lastInsertRowid);
  }

  searchTimeline(keyword?: string, dateFrom?: string, limit = 10): Array<{ page_slug: string; event_date: string | null; source: string | null; summary: string }> {
    let sql = "SELECT page_slug, event_date, source, summary FROM timeline WHERE (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    const params: Record<string, string | number> = { $limit: limit };
    if (keyword) {
      sql += " AND summary LIKE $keyword";
      params.$keyword = `%${keyword}%`;
    }
    if (dateFrom) {
      sql += " AND event_date >= $dateFrom";
      params.$dateFrom = dateFrom;
    }
    sql += " ORDER BY event_date DESC, id DESC LIMIT $limit";
    return this.prepare(sql).all(params) as any[];
  }

  // ─── Chunk operations ────────────────────────────────────────

  getChunksByPage(pageSlug: string, opts?: { summaryLevel?: number; limit?: number }): Array<{ id: number; chunk_index: number; content: string; created_at: string }> {
    const limitClause = opts?.limit != null ? " LIMIT $limit" : "";
    const bind = (extra: Record<string, unknown>) => ({ $slug: pageSlug, ...(opts?.limit != null ? { $limit: opts.limit } : {}), ...extra });
    if (opts?.summaryLevel != null) {
      return this.prepare(
        `SELECT id, chunk_index, content, created_at FROM chunks WHERE page_slug = $slug AND summary_level = $level ORDER BY chunk_index${limitClause}`
      ).all(bind({ $level: opts.summaryLevel })) as any[];
    }
    return this.prepare(
      `SELECT id, chunk_index, content, created_at FROM chunks WHERE page_slug = $slug ORDER BY chunk_index${limitClause}`
    ).all(bind({})) as any[];
  }

  // ─── Ingest log ──────────────────────────────────────────────

  getIngestLog(limit: number = 50): Array<{ id: number; source_type: string; action: string; page_slug: string | null; details: string | null; created_at: string }> {
    return this.prepare(
      "SELECT id, source_type, action, page_slug, details, created_at FROM ingest_log ORDER BY id DESC LIMIT $limit"
    ).all({ $limit: limit }) as any[];
  }

  // ─── Config operations ───────────────────────────────────────

  getConfig(key: string): string | null {
    const row = this.prepare(
      "SELECT value FROM config WHERE key = $key"
    ).get({ $key: key }) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)"
    ).run({ $key: key, $value: value });
  }

  compareAndSetConfig(key: string, expected: string | null, value: string | null): boolean {
    if (expected === null) {
      if (value === null) return this.getConfig(key) === null;
      return this.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ($key, $value)")
        .run({ $key: key, $value: value }).changes === 1;
    }
    const result = value === null
      ? this.prepare("DELETE FROM config WHERE key = $key AND value = $expected").run({ $key: key, $expected: expected })
      : this.prepare("UPDATE config SET value = $value WHERE key = $key AND value = $expected").run({ $key: key, $expected: expected, $value: value });
    return result.changes === 1;
  }

  // ─── Slug resolution ─────────────────────────────────────────

  resolveSlugs(queries: string[]): Array<{ query: string; slug: string | null; title: string | null }> {
    if (queries.length === 0) return [];

    const result = new Map<string, { slug: string; title: string }>();
    const remaining = new Set(queries);

    // Pass 1: Exact slug match (batch)
    const ph = queries.map(() => "?").join(",");
    const slugRows = this.prepare(
      `SELECT slug, title FROM pages WHERE slug IN (${ph})`
    ).all(...queries) as Array<{ slug: string; title: string }>;
    for (const row of slugRows) {
      if (remaining.has(row.slug)) {
        result.set(row.slug, row);
        remaining.delete(row.slug);
      }
    }

    // Pass 2: Exact title match (batch)
    if (remaining.size > 0) {
      const left = [...remaining];
      const ph2 = left.map(() => "?").join(",");
      const titleRows = this.prepare(
        `SELECT slug, title FROM pages WHERE title IN (${ph2})`
      ).all(...left) as Array<{ slug: string; title: string }>;
      for (const row of titleRows) {
        if (remaining.has(row.title)) {
          result.set(row.title, row);
          remaining.delete(row.title);
        }
      }
    }

    // Pass 3: Exact alias match (batch) — consult the aliases table so names
    // added via add_alias resolve consistently. Prefer entity/concept over
    // record/source when the same alias is attached to pages of mixed types.
    if (remaining.size > 0) {
      const left = [...remaining];
      const ph3 = left.map(() => "?").join(",");
      const aliasRows = this.prepare(
        `SELECT a.alias AS q, p.slug, p.title
         FROM aliases a JOIN pages p ON p.slug = a.page_slug
         WHERE a.alias IN (${ph3})
         ORDER BY
           CASE WHEN p.type = 'entity' OR p.type LIKE 'entity/%' THEN 0
                WHEN p.type = 'concept' OR p.type LIKE 'concept/%' THEN 1
                ELSE 2
           END,
           a.id`,
      ).all(...left) as Array<{ q: string; slug: string; title: string }>;
      for (const row of aliasRows) {
        // First row per query wins (already type-prefixed by ORDER BY); ignore the rest.
        if (remaining.has(row.q)) {
          result.set(row.q, { slug: row.slug, title: row.title });
          remaining.delete(row.q);
        }
      }
    }

    // Pass 4: Fuzzy LIKE for remaining (prefer entity/concept types over record/source by type)
    if (remaining.size > 0) {
      for (const query of remaining) {
        const fuzzy = this.prepare(
          `SELECT slug, title FROM pages WHERE title LIKE $q
           ORDER BY
             CASE WHEN type = 'entity' OR type LIKE 'entity/%' THEN 0
                  WHEN type = 'concept' OR type LIKE 'concept/%' THEN 1
                  ELSE 2
             END,
             CASE WHEN slug LIKE 'entity/%' OR slug LIKE 'brain/entities/%' THEN 0
                  WHEN slug LIKE 'concept/%' OR slug LIKE 'brain/concepts/%' THEN 1
                  ELSE 2
             END
           LIMIT 1`
        ).get({ $q: `%${query}%` }) as { slug: string; title: string } | undefined;
        if (fuzzy) result.set(query, fuzzy);
      }
    }

    return queries.map(query => {
      const found = result.get(query);
      return { query, slug: found?.slug ?? null, title: found?.title ?? null };
    });
  }

  /**
   * Resolve a subject extracted from a closed-grammar identity question.
   * Exact title and alias collisions fail closed. The only fuzzy form is a
   * unique record-title prefix; other page types never qualify by prefix.
   */
  resolveIdentitySubject(subject: string): { slug: string; title: string } | null {
    const isIdentityPage = (type: string): boolean => (
      type === "record" || type === "entity" || type.startsWith("entity/")
    );

    const exactTitles = this.getPagesByExactTitle(subject);
    if (exactTitles.length > 1) return null;
    if (exactTitles.length === 1) {
      const match = exactTitles[0]!;
      return isIdentityPage(match.type) ? { slug: match.slug, title: match.title } : null;
    }

    const exactAliases = this.getPagesByAlias(subject);
    if (exactAliases.length > 1) return null;
    if (exactAliases.length === 1) {
      const match = exactAliases[0]!;
      return isIdentityPage(match.type) ? { slug: match.slug, title: match.title } : null;
    }

    const escaped = subject.replace(/[!%_]/gu, (character) => `!${character}`);
    const prefixes = this.prepare(
      `SELECT slug, title FROM pages
       WHERE type = 'record' AND title LIKE $pattern ESCAPE '!'
       ORDER BY length(title), slug
       LIMIT 2`,
    ).all({ $pattern: `${escaped}%` }) as Array<{ slug: string; title: string }>;
    return prefixes.length === 1 ? prefixes[0]! : null;
  }

  // ─── Version operations ──────────────────────────────────────

  getVersionCount(pageSlug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM versions WHERE page_slug = $slug"
    ).get({ $slug: pageSlug }) as { cnt: number };
    return row.cnt;
  }

  createVersion(pageSlug: string, content: string, frontmatter?: string): number {
    const nextVer = this.getVersionCount(pageSlug) + 1;
    this.prepare(
      "INSERT INTO versions (page_slug, version, content, frontmatter) VALUES ($slug, $ver, $content, $fm)"
    ).run({ $slug: pageSlug, $ver: nextVer, $content: content, $fm: frontmatter ?? null });
    return nextVer;
  }

  getVersions(pageSlug: string): Array<{ id: number; version: number; created_at: string }> {
    return this.prepare(
      "SELECT id, version, created_at FROM versions WHERE page_slug = $slug ORDER BY version DESC"
    ).all({ $slug: pageSlug }) as any[];
  }

  getVersion(pageSlug: string, version: number): { content: string; frontmatter: string | null; version: number; created_at: string } | null {
    return this.prepare(
      "SELECT content, frontmatter, version, created_at FROM versions WHERE page_slug = $slug AND version = $ver"
    ).get({ $slug: pageSlug, $ver: version }) as any ?? null;
  }

  ftsInsert(pageSlug: string, content: string): void {
    this.prepare(
      "INSERT INTO chunks_fts(page_slug, content) VALUES ($slug, $content)"
    ).run({ $slug: pageSlug, $content: content });
  }

  ftsDeleteByPage(pageSlug: string): void {
    this.prepare(
      "DELETE FROM chunks_fts WHERE page_slug = $slug"
    ).run({ $slug: pageSlug });
  }

  /** Read all FTS content rows for a page (used by sync rollback verification). */
  getFtsContentsByPage(pageSlug: string): string[] {
    const rows = this.prepare(
      "SELECT content FROM chunks_fts WHERE page_slug = $slug"
    ).all({ $slug: pageSlug }) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  cleanupStaleFtsRows(): number {
    const row = this.prepare(
      `SELECT COUNT(DISTINCT page_slug) AS cnt FROM chunks_fts
       WHERE page_slug NOT IN (SELECT DISTINCT page_slug FROM chunks)`
    ).get() as { cnt: number };
    this.prepare(
      `DELETE FROM chunks_fts
       WHERE page_slug NOT IN (SELECT DISTINCT page_slug FROM chunks)`
    ).run();
    return row.cnt;
  }

  /**
   * Full-text search over chunks_fts (trigram tokenizer).
   *
   * @param _meta Optional out-parameter: set `fts_fallback=true` when
   *   MATCH throws a parser/runtime error and the method degrades to a
   *   parameterized LIKE query. Callers can read this to surface
   *   `fts_parser_fallback` in diagnostics without changing the return type.
   */
  ftsSearch(query: string, limit: number = 10, _meta?: { fts_fallback?: boolean }): Array<{ page_slug: string; content: string; rank: number }> {
    // Short queries (<3 chars) fall back to LIKE with TF-weighted rank.
    // rank = tf / (1 + tf): more occurrences → higher rank → higher score.
    if (query.length < 3) {
      const pattern = `%${query}%`;
      return this.prepare(`
        SELECT page_slug, content,
          CAST(tf AS REAL) / (1.0 + CAST(tf AS REAL)) AS rank
        FROM (
          SELECT page_slug, content,
            (LENGTH(content) - LENGTH(REPLACE(content, $query, ''))) * 1.0 / LENGTH($query) AS tf
          FROM chunks
          WHERE content LIKE $pattern
        )
        GROUP BY page_slug
        ORDER BY rank DESC
        LIMIT $limit
      `).all({ $query: query, $pattern: pattern, $limit: limit }) as Array<{ page_slug: string; content: string; rank: number }>;
    }
    const ftsQuery = this.buildTrigramQuery(query);
    try {
      const rows = this.prepare(
        "SELECT page_slug, content, rank FROM chunks_fts WHERE chunks_fts MATCH $query ORDER BY rank LIMIT $limit"
      ).all({ $query: ftsQuery, $limit: limit }) as Array<{ page_slug: string; content: string; rank: number }>;
      // Normal zero-match is fine — do NOT trigger fallback.
      return rows;
    } catch (e) {
      // FTS5 parser/runtime error — run deterministic LIKE fallback.
      // Log only metadata, never the full query or content.
      const isSyntax = String(e).includes("syntax error");
      console.warn("[ftsSearch] MATCH failed, running LIKE fallback", {
        category: isSyntax ? "fts5_syntax" : "fts5_runtime",
        queryLength: query.length,
      });
      if (_meta) _meta.fts_fallback = true;
      return this.ftsLikeFallback(query, limit);
    }
  }

  /**
   * Deterministic LIKE-based fallback when FTS5 MATCH fails.
   * Extracts clean word fragments from the query, ORs them via LIKE
   * against the `chunks` table, with TF-weighted ranking.
   */
  private ftsLikeFallback(query: string, limit: number): Array<{ page_slug: string; content: string; rank: number }> {
    // Extract word fragments: split on non-word chars, keep >= 2 chars
    const fragments = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter((f) => f.length >= 2)
      .slice(0, 5); // cap at 5 to keep query bounded

    if (fragments.length === 0) {
      // No usable fragments — return empty rather than throw
      return [];
    }

    // Build parameterized OR-LIKE against chunks table
    const conditions = fragments.map((_, i) => `content LIKE $p${i}`).join(" OR ");
    const params: Record<string, string | number> = { $limit: limit };
    for (let i = 0; i < fragments.length; i++) {
      params[`$p${i}`] = `%${fragments[i]}%`;
    }
    // Also pass fragments for TF weighting
    for (let i = 0; i < fragments.length; i++) {
      params[`$f${i}`] = fragments[i];
    }

    // Sum TF across all matching fragments, weight by 1/(1+tf)
    const tfTerms = fragments.map((_, i) =>
      `(LENGTH(content) - LENGTH(REPLACE(content, $f${i}, ''))) * 1.0 / LENGTH($f${i})`
    );
    const tfExpr = tfTerms.join(" + ");

    return this.prepare(`
      SELECT page_slug, content,
        CAST(tf AS REAL) / (1.0 + CAST(tf AS REAL)) AS rank
      FROM (
        SELECT page_slug, content, (${tfExpr}) AS tf
        FROM chunks
        WHERE ${conditions}
      )
      GROUP BY page_slug
      ORDER BY rank DESC
      LIMIT $limit
    `).all(params) as Array<{ page_slug: string; content: string; rank: number }>;
  }

  private buildTrigramQuery(query: string): string {
    // For short queries (3-6 chars), wrap in double quotes to avoid FTS5 syntax errors
    // from reserved words (AND, OR, NOT) or special chars (-, ")
    if (query.length <= 6) {
      return `"${query.replace(/"/g, '""')}"`;
    }
    // For longer queries, extract overlapping trigrams and OR them.
    // Each trigram is individually double-quoted as an FTS5 phrase so that
    // punctuation (-, /, (, )) and reserved words (AND, OR, NOT) inside the
    // 3-char slice are treated as literals, not FTS5 operators.
    const seen = new Set<string>();
    const parts: string[] = [];
    for (let i = 0; i <= query.length - 3; i++) {
      const tri = query.slice(i, i + 3);
      if (seen.has(tri)) continue;
      seen.add(tri);
      // Double internal quotes per FTS5 phrase escaping rules.
      parts.push(`"${tri.replace(/"/g, '""')}"`);
    }
    // Guard: if no trigrams survived, return a safe empty-match phrase.
    if (parts.length === 0) return '""';
    return parts.join(" OR ");
  }

  // ─── Job operations ────────────────────────────────────────────

  submitJob(name: string, data?: unknown, priority: number = 0): number {
    const result = this.prepare(
      "INSERT INTO jobs (name, data, priority) VALUES ($name, $data, $priority)"
    ).run({ $name: name, $data: data ? JSON.stringify(data) : null, $priority: priority });
    return Number(result.lastInsertRowid);
  }

  claimJob(): { id: number; name: string; data: string | null; attempts: number } | null {
    const row = this.prepare(
      "SELECT id, name, data, attempts FROM jobs WHERE status = 'pending' ORDER BY priority DESC, id ASC LIMIT 1"
    ).get() as { id: number; name: string; data: string | null; attempts: number } | undefined;
    if (!row) return null;

    this.prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = datetime('now') WHERE id = $id"
    ).run({ $id: row.id });
    return row;
  }

  /** Claim the highest-priority pending job whose name is in the allowlist. */
  claimJobForNames(names: string[]): { id: number; name: string; data: string | null; attempts: number } | null {
    if (names.length === 0) return null;
    const placeholders = names.map(() => "?").join(",");
    const row = this.rawDb.prepare(
      `SELECT id, name, data, attempts FROM jobs WHERE status = 'pending' AND name IN (${placeholders}) ORDER BY priority DESC, id ASC LIMIT 1`
    ).get(...names) as { id: number; name: string; data: string | null; attempts: number } | undefined;
    if (!row) return null;

    this.rawDb.prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = datetime('now') WHERE id = ?"
    ).run(row.id);
    return row;
  }

  /** #252/#321: active backfill jobs for one slug + enrichment kind. */
  findActiveNerJobs(
    slug: string,
    staleTtlMs: number,
    kind: "ner" | "entity_facts" = "ner",
  ): Array<{ id: number; status: string }> {
    const ttlSec = Math.floor(staleTtlMs / 1000);
    return this.rawDb.prepare(
      `SELECT id, status FROM jobs
       WHERE name = 'ner-backfill'
         AND json_extract(data, '$.slug') = ?
         AND CASE WHEN json_extract(data, '$.kind') = 'entity_facts'
                  THEN 'entity_facts' ELSE 'ner' END = ?
         AND (status = 'pending'
              OR (status = 'running' AND started_at IS NOT NULL
                  AND julianday('now') - julianday(started_at) < ?))`
    ).all(slug, kind, ttlSec / 86400) as Array<{ id: number; status: string }>;
  }

  /** #252: claim a specific pending job by id. Returns null if no longer pending. */
  claimJobById(id: number): { id: number; name: string; data: string | null; attempts: number } | null {
    const row = this.rawDb.prepare(
      "SELECT id, name, data, attempts FROM jobs WHERE id = ? AND status = 'pending'"
    ).get(id) as { id: number; name: string; data: string | null; attempts: number } | undefined;
    if (!row) return null;
    this.rawDb.prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = datetime('now') WHERE id = ?"
    ).run(id);
    return row;
  }

  /** #342: scoped atomic claim for ordinary/repair NER only. Entity facts stay on the legacy path. */
  claimNerJobByIdWithLease(
    id: number,
    expectedIdentity?: NerAttemptIdentity,
    authorize?: (db: { rawDb: Database }, jobId: number) => "legacy" | "ordinary" | "repair" | null,
  ): { id: number; name: string; data: string; attempts: number; leaseToken: string; payloadDigest: string } | null {
    this.rawDb.exec("BEGIN IMMEDIATE");
    try {
      const row = this.rawDb.prepare(
        "SELECT id, name, data, attempts FROM jobs WHERE id = ? AND name = 'ner-backfill' AND status = 'pending'",
      ).get(id) as { id: number; name: string; data: string | null; attempts: number } | undefined;
      if (!row?.data) { this.rawDb.exec("COMMIT"); return null; }
      let data: Record<string, unknown>;
      try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { this.rawDb.exec("COMMIT"); return null; }
      const claimMode = authorize?.(this, id);
      if (!claimMode) { this.rawDb.exec("COMMIT"); return null; }
      const identity = claimMode === "legacy" ? buildNerAttemptIdentity(data) : buildStrictFrozenNerIdentity(data);
      if (!identity || (expectedIdentity && !sameNerAttemptIdentity(identity, expectedIdentity))) {
        this.rawDb.exec("COMMIT");
        return null;
      }
      const terminalRows = this.rawDb.prepare(
        "SELECT data, result FROM jobs WHERE name='ner-backfill' AND status='done' AND id<>?",
      ).all(id) as Array<{ data: string | null; result: string | null }>;
      for (const terminal of terminalRows) {
        let terminalResult: Record<string, unknown> | null = null;
        try { terminalResult = terminal.result ? JSON.parse(terminal.result) as Record<string, unknown> : null; } catch { /* not commit-unknown evidence */ }
        if (terminalResult?.outcome !== "commit_unknown") continue;
        let terminalData: Record<string, unknown> | null = null;
        try { terminalData = terminal.data ? JSON.parse(terminal.data) as Record<string, unknown> : null; } catch { /* fail closed below */ }
        const terminalIdentity = terminalData ? buildStrictFrozenNerIdentity(terminalData) : null;
        const repair = terminalData && typeof terminalData.repair === "object" && terminalData.repair !== null
          ? terminalData.repair
          : null;
        const expectedResultKeys = repair ? ["kind", "outcome", "repair"] : ["kind", "outcome"];
        const resultValid = terminalResult.kind === "ner" &&
          JSON.stringify(Object.keys(terminalResult).sort()) === JSON.stringify(expectedResultKeys) &&
          (!repair || JSON.stringify(terminalResult.repair) === JSON.stringify(repair));
        if (!terminalIdentity || !resultValid || terminalIdentity.slug === identity.slug) {
          this.rawDb.exec("COMMIT");
          return null;
        }
      }
      const leaseToken = randomUUID();
      const nextData = JSON.stringify({
        ...data,
        attemptLease: { version: 1, token: leaseToken, phase: "claimed", ...identity },
      });
      const updated = this.rawDb.prepare(
        `UPDATE jobs
         SET status='running', attempts=attempts + 1, started_at=datetime('now'), data=?
         WHERE id=? AND name='ner-backfill' AND status='pending' AND data=?`,
      ).run(nextData, id, row.data);
      if (updated.changes !== 1) { this.rawDb.exec("COMMIT"); return null; }
      this.rawDb.exec("COMMIT");
      return { id: row.id, name: row.name, data: nextData, attempts: row.attempts, leaseToken, payloadDigest: identity.payloadDigest };
    } catch (error) {
      try { this.rawDb.exec("ROLLBACK"); } catch { /* closed */ }
      throw error;
    }
  }

  /** #342: write-authority linearization point for a claimed NER attempt. */
  moveNerLeaseToCommitting(id: number, leaseToken: string, frozenPayloadDigest: string): boolean {
    const row = this.rawDb.prepare(
      "SELECT data FROM jobs WHERE id=? AND name='ner-backfill' AND status='running'",
    ).get(id) as { data: string | null } | undefined;
    if (!row?.data) return false;
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { return false; }
    if (!leaseMatchesNerIdentity(data, leaseToken, "claimed", frozenPayloadDigest)) return false;
    const nextData = JSON.stringify({
      ...data,
      attemptLease: { ...(data.attemptLease as Record<string, unknown>), phase: "committing" },
    });
    const updated = this.rawDb.prepare(
      "UPDATE jobs SET data=? WHERE id=? AND name='ner-backfill' AND status='running' AND data=?",
    ).run(nextData, id, row.data);
    return updated.changes === 1;
  }

  validateNerJobLease(id: number, leaseToken: string, phase: "claimed" | "committing", frozenPayloadDigest: string): boolean {
    const row = this.rawDb.prepare(
      "SELECT data FROM jobs WHERE id=? AND name='ner-backfill' AND status='running'",
    ).get(id) as { data: string | null } | undefined;
    if (!row?.data) return false;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      return leaseMatchesNerIdentity(data, leaseToken, phase, frozenPayloadDigest);
    } catch {
      return false;
    }
  }

  /** #342: terminal completion guarded by the exact token and phase; removes the private lease. */
  completeNerJobWithLease(
    id: number,
    leaseToken: string,
    phase: "claimed" | "committing",
    frozenPayloadDigest: string,
    result?: unknown,
  ): boolean {
    const row = this.rawDb.prepare(
      "SELECT data FROM jobs WHERE id=? AND name='ner-backfill' AND status='running'",
    ).get(id) as { data: string | null } | undefined;
    if (!row?.data) return false;
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { return false; }
    if (!leaseMatchesNerIdentity(data, leaseToken, phase, frozenPayloadDigest)) return false;
    const { attemptLease: _removed, ...withoutLease } = data;
    const updated = this.rawDb.prepare(
      `UPDATE jobs
       SET status='done', data=?, result=?, error=NULL, finished_at=datetime('now')
       WHERE id=? AND name='ner-backfill' AND status='running' AND data=?`,
    ).run(JSON.stringify(withoutLease), result === undefined ? null : JSON.stringify(result), id, row.data);
    return updated.changes === 1;
  }

  /** #342: retry/terminal failure guarded by the claimed lease. */
  failNerJobWithLease(id: number, leaseToken: string, frozenPayloadDigest: string, errorCode: string): boolean {
    const row = this.rawDb.prepare(
      "SELECT data, attempts, max_attempts FROM jobs WHERE id=? AND name='ner-backfill' AND status='running'",
    ).get(id) as { data: string | null; attempts: number; max_attempts: number } | undefined;
    if (!row?.data) return false;
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { return false; }
    if (!leaseMatchesNerIdentity(data, leaseToken, "claimed", frozenPayloadDigest)) return false;
    const { attemptLease: _removed, ...withoutLease } = data;
    const status = row.attempts >= row.max_attempts ? "failed" : "pending";
    const updated = this.rawDb.prepare(
      `UPDATE jobs
       SET status=?, data=?, error=?, started_at=CASE WHEN ?='pending' THEN NULL ELSE started_at END,
           finished_at=CASE WHEN ?='failed' THEN datetime('now') ELSE NULL END
       WHERE id=? AND name='ner-backfill' AND status='running' AND data=?`,
    ).run(status, JSON.stringify(withoutLease), errorCode, status, status, id, row.data);
    return updated.changes === 1;
  }

  /** #252: reset stale 'running' jobs (older than ttl) back to 'pending'. Returns count reset. */
  resetStaleJobsForNames(names: string[], staleTtlMs: number): number {
    if (names.length === 0) return 0;
    const ttlSec = Math.floor(staleTtlMs / 1000);
    const placeholders = names.map(() => "?").join(",");
    const r = this.rawDb.prepare(
      `UPDATE jobs SET status = 'pending', started_at = NULL, finished_at = NULL
       WHERE status = 'running' AND started_at IS NOT NULL
         AND julianday('now') - julianday(started_at) >= ?
         AND name IN (${placeholders})`
    ).run(ttlSec / 86400, ...names);
    return Number(r.changes);
  }

  /** #252: snapshot pending job ids for names, ordered by priority desc then id asc, limited. */
  snapshotEligibleJobIds(names: string[], limit: number): number[] {
    if (names.length === 0 || limit <= 0) return [];
    const placeholders = names.map(() => "?").join(",");
    const rows = this.rawDb.prepare(
      `SELECT id FROM jobs WHERE status = 'pending' AND name IN (${placeholders})
       ORDER BY priority DESC, id ASC LIMIT ?`
    ).all(...names, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  completeJob(id: number, result?: unknown): void {
    // Merge with existing progress data (from updateJobProgress calls)
    let finalResult = result;
    try {
      const row = this.prepare("SELECT result FROM jobs WHERE id = $id").get({ $id: id }) as { result: string | null } | undefined;
      if (row?.result && result && typeof result === "object") {
        const existing = JSON.parse(row.result) as Record<string, unknown>;
        const incoming = result as Record<string, unknown>;
        finalResult = { ...existing, ...incoming };
      }
    } catch { /* if merge fails, just use raw result */ }
    this.prepare(
      "UPDATE jobs SET status = 'done', result = $result, finished_at = datetime('now') WHERE id = $id"
    ).run({ $id: id, $result: finalResult ? JSON.stringify(finalResult) : null });
  }

  /** Update job result field progressively (for stage-level progress). Atomic via transaction. */
  updateJobProgress(id: number, stage: string, detail: unknown): void {
    this.rawDb.transaction(() => {
      const row = this.prepare("SELECT result FROM jobs WHERE id = $id").get({ $id: id }) as { result: string | null } | undefined;
      const existing = row?.result ? JSON.parse(row.result) as Record<string, unknown> : {};
      const updated = { ...existing, current_stage: stage, [stage]: detail };
      this.prepare("UPDATE jobs SET result = $result WHERE id = $id").run({ $id: id, $result: JSON.stringify(updated) });
    })();
  }

  failJob(id: number, error: string): void {
    const job = this.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = $id").get({ $id: id }) as { attempts: number; max_attempts: number } | undefined;
    const status = job && job.attempts >= job.max_attempts ? "failed" : "pending";
    this.prepare(
      "UPDATE jobs SET status = $status, error = $error, finished_at = CASE WHEN $status = 'failed' THEN datetime('now') ELSE NULL END WHERE id = $id"
    ).run({ $id: id, $status: status, $error: error });
  }

  listJobs(status?: string): Array<{
    id: number; name: string; status: string; priority: number;
    data: string | null; result: string | null; error: string | null;
    attempts: number; max_attempts: number;
    created_at: string; started_at: string | null; finished_at: string | null;
  }> {
    if (status) {
      return this.prepare(
        "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs WHERE status = $status ORDER BY id DESC"
      ).all({ $status: status }) as any[];
    }
    return this.prepare(
      "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs ORDER BY id DESC LIMIT 100"
    ).all() as any[];
  }

  getJob(id: number): {
    id: number; name: string; status: string; priority: number;
    data: string | null; result: string | null; error: string | null;
    attempts: number; max_attempts: number;
    created_at: string; started_at: string | null; finished_at: string | null;
  } | null {
    return this.prepare(
      "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs WHERE id = $id"
    ).get({ $id: id }) as any ?? null;
  }

  cancelJob(id: number): boolean {
    const r = this.prepare(
      "UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = $id AND status IN ('pending', 'running')"
    ).run({ $id: id });
    return r.changes > 0;
  }

  retryJob(id: number): boolean {
    const r = this.prepare(
      "UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = $id AND status = 'failed'"
    ).run({ $id: id });
    return r.changes > 0;
  }

  // ─── Page operations ──────────────────────────────────────────

  getPage(slug: string): PageRow | null {
    return this.prepare(
      "SELECT * FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as PageRow | null;
  }

  getPageByTitle(title: string): { slug: string; type: string; title: string } | null {
    return this.prepare(
      "SELECT slug, type, title FROM pages WHERE title = $title LIMIT 1"
    ).get({ $title: title }) as { slug: string; type: string; title: string } | null;
  }

  /** Exact title lookup for governed resolvers; preserves every collision. */
  getPagesByExactTitle(title: string): Array<{ slug: string; type: string; title: string }> {
    return this.prepare(
      "SELECT slug, type, title FROM pages WHERE title = $title ORDER BY slug",
    ).all({ $title: title }) as Array<{ slug: string; type: string; title: string }>;
  }

  getPageByTitleExcluding(title: string, excludeSlug: string): { slug: string; type: string; title: string } | null {
    return this.prepare(
      "SELECT slug, type, title FROM pages WHERE title = $title AND slug != $slug LIMIT 1"
    ).get({ $title: title, $slug: excludeSlug }) as { slug: string; type: string; title: string } | null;
  }

  getPageTitle(slug: string): string | null {
    const row = this.prepare(
      "SELECT title FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { title: string } | undefined;
    return row?.title ?? null;
  }

  getPageTitleAndType(slug: string): { title: string; type: string } | null {
    return this.prepare(
      "SELECT title, type FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { title: string; type: string } | null;
  }

  getPageFilePath(slug: string): string | null {
    const row = this.prepare(
      "SELECT file_path FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  getPageContentHash(slug: string): string | null {
    const row = this.prepare(
      "SELECT content_hash FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { content_hash: string | null } | undefined;
    return row?.content_hash ?? null;
  }

  /** Find a durable-source page (record or insight) by its ingest content hash. */
  findDurableSourceByIngestHash(hash: string): { slug: string; title: string } | null {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE ingest_content_hash = $hash AND type IN ('record', 'insight') LIMIT 1"
    ).get({ $hash: hash }) as { slug: string; title: string } | null;
  }

  /** Get the ingest content hash for a specific page. */
  getPageIngestHash(slug: string): string | null {
    const row = this.prepare(
      "SELECT ingest_content_hash FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { ingest_content_hash: string | null } | undefined;
    return row?.ingest_content_hash ?? null;
  }

  /** Update the ingest content hash for a page after successful commit. */
  updateIngestHash(slug: string, hash: string): void {
    this.prepare(
      "UPDATE pages SET ingest_content_hash = $hash WHERE slug = $slug"
    ).run({ $slug: slug, $hash: hash });
  }

  /** Clear the ingest content hash — call when body changes outside ingest. */
  clearIngestHash(slug: string): void {
    this.prepare(
      "UPDATE pages SET ingest_content_hash = NULL WHERE slug = $slug"
    ).run({ $slug: slug });
  }

  getPageTierAndMentions(slug: string): { tier: number; mention_count: number; activity_weight: number } | null {
    return this.prepare(
      "SELECT tier, mention_count, COALESCE(activity_weight, 0) AS activity_weight FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { tier: number; mention_count: number; activity_weight: number } | null;
  }

  insertPage(data: { slug: string; type: string; title: string; filePath: string; contentHash: string; tier?: number; expiresAt?: string | null; confidenceDecay?: number }): void {
    const autoExpires = data.type.startsWith("entity/") && !data.expiresAt
      ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
      : data.expiresAt ?? null;
    this.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, expires_at, confidence_decay, created_at, updated_at) VALUES ($slug, $type, $title, $path, $hash, $tier, $expires, $decay, datetime('now'), datetime('now'))"
    ).run({
      $slug: data.slug,
      $type: data.type,
      $title: data.title,
      $path: data.filePath,
      $hash: data.contentHash,
      $tier: data.tier ?? 3,
      $expires: autoExpires,
      $decay: data.confidenceDecay ?? 1.0,
    });
  }

  upsertPage(data: UpsertPageData): void {
    const isEntity = data.type.startsWith("entity/");
    const expiresAt = isEntity ? `datetime('now', '+90 days')` : null;
    this.prepare(`
      INSERT INTO pages (slug, type, title, file_path, content_hash, tier, expires_at, created_at, updated_at)
      VALUES ($slug, $type, $title, $path, $hash, 3, ${expiresAt ? expiresAt : 'NULL'}, datetime('now'), datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        ${data.contentHash !== undefined ? 'content_hash = excluded.content_hash,' : ''}
        updated_at = datetime('now')
    `).run({
      $slug: data.slug,
      $type: data.type,
      $title: data.title,
      $path: data.filePath,
      $hash: data.contentHash ?? null,
    });
  }

  /**
   * #386: Record append-only creation provenance for a page.
   *
   * Semantics (NOT INSERT OR IGNORE — that hides real errors):
   * - No existing row → INSERT. CHECK/FK/constraint failures propagate normally.
   * - Existing row with IDENTICAL attribution → idempotent retry, return false.
   * - Existing row with DIFFERENT attribution → throw PageWriteProvenanceConflictError
   *   (append-only: a page's writer can never be re-attributed).
   * Also validates origin_ref is an opaque ID (rejects paths/credentials) at the
   * write boundary.
   */
  recordPageWriteProvenance(slug: string, input: PageCreationProvenanceInput): boolean {
    if (input.origin) validateOriginRef(input.origin.ref);
    const existing = this.getPageWriteProvenance(slug);
    if (existing) {
      if (provenanceMatchesRow(existing, input)) return false;
      throw new PageWriteProvenanceConflictError(slug, existing, toConflictFields(input));
    }
    this.prepare(
      "INSERT INTO page_write_provenance (page_slug, write_mode, actor_class, creation_reason, origin_kind, origin_ref) VALUES ($slug, $mode, $actor, $reason, $originKind, $originRef)"
    ).run({
      $slug: slug,
      $mode: input.writeMode,
      $actor: input.actorClass,
      $reason: input.creationReason,
      $originKind: input.origin?.kind ?? null,
      $originRef: input.origin?.ref ?? null,
    });
    return true;
  }

  /** #386: Read a page's creation provenance, or null when untracked (honest absence). */
  getPageWriteProvenance(slug: string): PageWriteProvenanceRow | null {
    const row = this.prepare(
      "SELECT page_slug, write_mode, actor_class, creation_reason, origin_kind, origin_ref, created_at FROM page_write_provenance WHERE page_slug = $slug"
    ).get({ $slug: slug });
    return (row ?? null) as PageWriteProvenanceRow | null;
  }

  /**
   * #386: record pages with no creation-provenance row, newest first. Used by
   * the `cbrain writer-audit` CLI. Absence is honest (pre-tracking / untracked),
   * never a fabrication target.
   */
  listRecordPagesWithoutWriteProvenance(limit = 200): Array<{ slug: string; title: string; created_at: string }> {
    return this.prepare(
      `SELECT p.slug, p.title, p.created_at
       FROM pages p
       LEFT JOIN page_write_provenance pwp ON pwp.page_slug = p.slug
       WHERE p.type = 'record' AND pwp.page_slug IS NULL
       ORDER BY p.created_at DESC
       LIMIT $limit`
    ).all({ $limit: limit }) as Array<{ slug: string; title: string; created_at: string }>;
  }

  /** #386: total count of record pages with no provenance row (no LIMIT) — lets
   *  writer-audit report truncation when the page set exceeds --limit. */
  countRecordPagesWithoutWriteProvenance(): number {
    const row = this.prepare(
      `SELECT COUNT(*) AS cnt
       FROM pages p
       LEFT JOIN page_write_provenance pwp ON pwp.page_slug = p.slug
       WHERE p.type = 'record' AND pwp.page_slug IS NULL`
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * #386: list + total in ONE read-only transaction so writer-audit's count,
   * total, and truncated reflect the same snapshot. Without this, a concurrent
   * writer (watcher/serve) between two autocommit queries could make count >
   * total or a wrong truncated flag.
   */
  listAndCountRecordPagesWithoutWriteProvenance(
    limit = 200,
  ): { missing: Array<{ slug: string; title: string; created_at: string }>; total: number } {
    return this.runInTransaction(() => ({
      missing: this.listRecordPagesWithoutWriteProvenance(limit),
      total: this.countRecordPagesWithoutWriteProvenance(),
    }));
  }

  updatePageHash(slug: string, hash: string): void {
    this.prepare(
      "UPDATE pages SET content_hash = $hash, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug, $hash: hash });
  }

  updatePageFilePath(slug: string, filePath: string): void {
    this.prepare("UPDATE pages SET file_path = $path, updated_at = datetime('now') WHERE slug = $slug")
      .run({ $slug: slug, $path: filePath });
  }

  updatePageTier(slug: string, tier: number): void {
    this.prepare(
      "UPDATE pages SET tier = $tier, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug, $tier: tier });
  }

  incrementMentionCount(slug: string): void {
    this.prepare(
      "UPDATE pages SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug });
  }

  deletePage(slug: string): boolean {
    const r = this.prepare("DELETE FROM pages WHERE slug = $slug").run({ $slug: slug });
    return r.changes > 0;
  }

  deletePageCascaded(slug: string): void {
    // chunks_fts (virtual table) and ingest_log have no FK → delete explicitly.
    // links, tags, timeline, chunks are cleaned by ON DELETE CASCADE on pages DELETE.
    // Wrapped in one transaction so a failure mid-cascade leaves no partial delete (#187).
    this.db.transaction(() => {
      this.prepare("DELETE FROM chunks_fts WHERE page_slug = $slug").run({ $slug: slug });
      this.prepare("DELETE FROM ingest_log WHERE page_slug = $slug").run({ $slug: slug });
      this.prepare("DELETE FROM pages WHERE slug = $slug").run({ $slug: slug });
    })();
  }

  rewireLinks(oldSlug: string, newSlug: string): void {
    // Delete old-slug links that would collide with existing new-slug links after UPDATE
    this.prepare(`
      DELETE FROM links WHERE from_slug = $old AND EXISTS (
        SELECT 1 FROM links l2 WHERE l2.from_slug = $new AND l2.to_slug = links.to_slug AND l2.relation = links.relation
      )
    `).run({ $old: oldSlug, $new: newSlug });
    this.prepare(`
      DELETE FROM links WHERE to_slug = $old AND EXISTS (
        SELECT 1 FROM links l2 WHERE l2.to_slug = $new AND l2.from_slug = links.from_slug AND l2.relation = links.relation
      )
    `).run({ $old: oldSlug, $new: newSlug });
    this.prepare("UPDATE links SET from_slug = $new WHERE from_slug = $old").run({ $old: oldSlug, $new: newSlug });
    this.prepare("UPDATE links SET to_slug = $new WHERE to_slug = $old").run({ $old: oldSlug, $new: newSlug });
    this.prepare("UPDATE links SET context = REPLACE(context, $old, $new) WHERE context LIKE '%' || $old || '%'")
      .run({ $old: oldSlug, $new: newSlug });
  }

  // ─── Page list/query operations ──────────────────────────────

  listPages(opts?: { type?: string; types?: string[]; typePrefix?: string; limit?: number; offset?: number; orderBy?: string }): PageRow[] {
    let sql = "SELECT * FROM pages WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.typePrefix) {
      sql += " AND type LIKE $typePrefix";
      params.$typePrefix = `${opts.typePrefix}%`;
    } else if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    if (opts?.types && opts.types.length > 0) {
      const placeholders = opts.types.map((_, i) => `$t${i}`).join(",");
      opts.types.forEach((t, i) => { params[`$t${i}`] = t; });
      sql += ` AND type IN (${placeholders})`;
    }
    sql += ` ORDER BY ${sanitizeOrderBy(opts?.orderBy, "title ASC")}`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }
    return this.prepare(sql).all(params) as PageRow[];
  }

  listPageSlugs(opts?: { type?: string; limit?: number; offset?: number; orderBy?: string }): string[] {
    let sql = "SELECT slug FROM pages WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    sql += ` ORDER BY ${sanitizeOrderBy(opts?.orderBy, "slug ASC")}`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }
    const rows = this.prepare(sql).all(params) as Array<{ slug: string }>;
    return rows.map(r => r.slug);
  }

  getPageCount(): number {
    const row = this.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number };
    return row.cnt;
  }

  getPageCountByType(type: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM pages WHERE type = $type"
    ).get({ $type: type }) as { cnt: number };
    return row.cnt;
  }

  getPageCountByTypes(types: string[]): number {
    if (types.length === 0) return 0;
    const placeholders = types.map((_, i) => `$t${i}`).join(",");
    const params: Record<string, string> = {};
    types.forEach((t, i) => { params[`$t${i}`] = t; });
    const row = this.prepare(
      `SELECT COUNT(*) as cnt FROM pages WHERE type IN (${placeholders})`
    ).get(params) as { cnt: number };
    return row.cnt;
  }

  getPageCountByTypePrefix(prefix: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM pages WHERE type LIKE $prefix"
    ).get({ $prefix: `${prefix}%` }) as { cnt: number };
    return row.cnt;
  }

  getPageTypeCounts(): Array<{ type: string; cnt: number }> {
    return this.prepare(
      "SELECT type, COUNT(*) as cnt FROM pages GROUP BY type ORDER BY cnt DESC"
    ).all() as Array<{ type: string; cnt: number }>;
  }

  getEntities(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE type LIKE 'entity/%' ORDER BY slug"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getEntityConceptPages(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT slug, title, type FROM pages WHERE type LIKE 'entity/%' OR type LIKE 'concept/%' ORDER BY title"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getAutoExtractedPages(): Array<{ slug: string; title: string; file_path: string }> {
    return this.prepare(
      "SELECT slug, title, file_path FROM pages WHERE slug IN (SELECT page_slug FROM tags WHERE tag = 'auto-extracted')"
    ).all() as Array<{ slug: string; title: string; file_path: string }>;
  }

  /** Bulk alias loader: rows of (page_slug, alias). Caller groups + normalizes. (#246) */
  getAliasesBySlugBulk(): Array<{ page_slug: string; alias: string }> {
    return this.prepare("SELECT page_slug, alias FROM aliases").all() as Array<{ page_slug: string; alias: string }>;
  }

  /**
   * Bulk entity/concept quality signals for similar-entity detection (#246).
   * pages has no summary column; completeness comes from chunks.
   */
  getEntityConceptQuality(): Array<{
    slug: string; mention_count: number; alias_count: number; tag_count: number; body_chars: number; chunk_count: number;
  }> {
    return this.prepare(`
      SELECT p.slug,
             p.mention_count AS mention_count,
             COALESCE(a.c, 0) AS alias_count,
             COALESCE(t.c, 0) AS tag_count,
             COALESCE(c.body_chars, 0) AS body_chars,
             COALESCE(c.chunk_count, 0) AS chunk_count
      FROM pages p
      LEFT JOIN (SELECT page_slug, COUNT(*) c FROM aliases GROUP BY page_slug) a ON a.page_slug = p.slug
      LEFT JOIN (SELECT page_slug, COUNT(*) c FROM tags GROUP BY page_slug) t ON t.page_slug = p.slug
      LEFT JOIN (
        SELECT page_slug, SUM(length(content)) body_chars, COUNT(*) chunk_count
        FROM chunks
        WHERE page_slug IN (SELECT slug FROM pages WHERE type LIKE 'entity/%' OR type LIKE 'concept/%')
        GROUP BY page_slug
      ) c ON c.page_slug = p.slug
      WHERE p.type LIKE 'entity/%' OR p.type LIKE 'concept/%'
    `).all() as Array<{ slug: string; mention_count: number; alias_count: number; tag_count: number; body_chars: number; chunk_count: number }>;
  }

  findEmptyShells(): Array<{ slug: string; type: string; title: string; file_path: string }> {
    return this.prepare(`
      SELECT p.slug, p.type, p.title, p.file_path
      FROM pages p
      WHERE p.type != 'record'
        AND p.mention_count = 0
        AND NOT EXISTS (SELECT 1 FROM links WHERE (from_slug = p.slug OR to_slug = p.slug) AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded')))
        AND NOT EXISTS (SELECT 1 FROM aliases WHERE page_slug = p.slug)
        AND NOT EXISTS (SELECT 1 FROM tags WHERE page_slug = p.slug)
      ORDER BY p.type, p.title
    `).all() as Array<{ slug: string; type: string; title: string; file_path: string }>;
  }

  getAllPageSlugsWithPaths(): Array<{ slug: string; file_path: string }> {
    return this.prepare(
      "SELECT slug, file_path FROM pages"
    ).all() as Array<{ slug: string; file_path: string }>;
  }

  getPagesBySlugs(slugs: string[]): PageRow[] {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    return this.prepare(
      `SELECT * FROM pages WHERE slug IN (${placeholders})`
    ).all(params) as PageRow[];
  }

  getPagesBySlugsOrdered(slugs: string[]): Array<{ slug: string }> {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    return this.prepare(
      `SELECT slug FROM pages WHERE slug IN (${placeholders}) ORDER BY (COALESCE(activity_weight, 0) + LOG(COALESCE(mention_count, 0) + 1)) DESC`
    ).all(params) as Array<{ slug: string }>;
  }

  getPagesWithoutChunks(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p LEFT JOIN chunks c ON p.slug = c.page_slug WHERE c.id IS NULL AND p.type = 'record'"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getPagesWithMissingTitle(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE title IS NULL OR title = '' OR title = slug"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getPagesWithEmptyType(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE type IS NULL OR type = ''"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getBareStubs(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p LEFT JOIN links l ON (l.from_slug = p.slug OR l.to_slug = p.slug) AND (l.trust_state IS NULL OR l.trust_state NOT IN ('rejected','superseded')) WHERE (p.type LIKE 'entity/%' OR p.type LIKE 'concept/%') AND p.mention_count <= 1 GROUP BY p.slug HAVING COUNT(l.id) <= 1"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getIslandPages(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p LEFT JOIN links l ON (l.from_slug = p.slug OR l.to_slug = p.slug) AND (l.trust_state IS NULL OR l.trust_state NOT IN ('rejected','superseded')) WHERE (p.type LIKE 'entity/%' OR p.type LIKE 'concept/%') GROUP BY p.slug HAVING COUNT(l.id) = 0"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getStaleHighValuePages(days: number = 30): Array<{ slug: string; title: string; type: string; updated_at: string }> {
    return this.prepare(
      "SELECT slug, title, type, updated_at FROM pages WHERE tier <= 2 AND updated_at < datetime('now', '-' || $days || ' days') ORDER BY updated_at ASC"
    ).all({ $days: days }) as Array<{ slug: string; title: string; type: string; updated_at: string }>;
  }

  getPopularThinPages(threshold: number = 3): Array<{ slug: string; title: string; mention_count: number; type: string }> {
    return this.prepare(
      "SELECT slug, title, mention_count, type FROM pages WHERE mention_count >= $threshold AND (type LIKE 'entity/%' OR type LIKE 'concept/%') AND (SELECT COUNT(*) FROM chunks WHERE page_slug = pages.slug) <= 1 ORDER BY mention_count DESC"
    ).all({ $threshold: threshold }) as Array<{ slug: string; title: string; mention_count: number; type: string }>;
  }

  getPagesWithLinkCount(types: string[], orderBy?: string): Array<{ slug: string; title: string; type: string; link_count: number }> {
    const placeholders = types.map((_, i) => `$t${i}`).join(",");
    const params: Record<string, string> = {};
    types.forEach((t, i) => { params[`$t${i}`] = t; });
    const order = sanitizeOrderBy(orderBy, "title ASC");
    return this.prepare(
      `SELECT p.slug, p.title, p.type, COUNT(l.id) as link_count FROM pages p LEFT JOIN links l ON (l.from_slug = p.slug OR l.to_slug = p.slug) AND ${CURRENT_FACT_LINK_SQL} WHERE p.type IN (${placeholders}) GROUP BY p.slug ORDER BY ${order}`
    ).all(params) as Array<{ slug: string; title: string; type: string; link_count: number }>;
  }

  getPagesWithLinkCountByPrefix(prefix: string, orderBy?: string): Array<{ slug: string; title: string; type: string; link_count: number }> {
    const order = sanitizeOrderBy(orderBy, "title ASC");
    return this.prepare(
      `SELECT p.slug, p.title, p.type, COUNT(l.id) as link_count FROM pages p LEFT JOIN links l ON (l.from_slug = p.slug OR l.to_slug = p.slug) AND ${CURRENT_FACT_LINK_SQL} WHERE p.type LIKE $prefix GROUP BY p.slug ORDER BY ${order}`
    ).all({ $prefix: `${prefix}%` }) as Array<{ slug: string; title: string; type: string; link_count: number }>;
  }

  getAvgMentionCount(): number {
    const row = this.prepare("SELECT AVG(mention_count) as avg FROM pages").get() as { avg: number | null };
    return row.avg ?? 0;
  }

  getRecentUpdatedPages(days: number = 7, limit: number = 10): PageRow[] {
    return this.prepare(
      "SELECT * FROM pages WHERE updated_at >= datetime('now', $days) ORDER BY updated_at DESC LIMIT $limit"
    ).all({ $days: `-${days} days`, $limit: limit }) as PageRow[];
  }

  getEntityConceptPagesUpdatedSince(since: string): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT slug, title, type FROM pages WHERE updated_at > $since AND (type LIKE 'entity/%' OR type LIKE 'concept/%') ORDER BY updated_at DESC"
    ).all({ $since: since }) as Array<{ slug: string; title: string; type: string }>;
  }

  getTopMentionedEntities(limit: number = 10): PageRow[] {
    return this.prepare(
      "SELECT * FROM pages WHERE type LIKE 'entity/%' ORDER BY mention_count DESC LIMIT $limit"
    ).all({ $limit: limit }) as PageRow[];
  }

  getHighMentionEntities(minMentions: number): Array<{ slug: string; title: string; mention_count: number }> {
    return this.prepare(
      "SELECT slug, title, mention_count FROM pages WHERE type LIKE 'entity/%' AND mention_count >= $min ORDER BY mention_count DESC"
    ).all({ $min: minMentions }) as Array<{ slug: string; title: string; mention_count: number }>;
  }

  getHighConnectivityEntities(minNeighbors: number): Array<{ slug: string; title: string }> {
    return this.prepare(
      `SELECT p.slug, p.title FROM pages p
       WHERE p.type LIKE 'entity/%'
       AND (
         (SELECT COUNT(DISTINCT to_slug) FROM links WHERE from_slug = p.slug AND ${CURRENT_FACT_LINK_SQL}) +
         (SELECT COUNT(DISTINCT from_slug) FROM links WHERE to_slug = p.slug AND ${CURRENT_FACT_LINK_SQL})
       ) >= $min
       ORDER BY p.mention_count DESC`
    ).all({ $min: minNeighbors }) as Array<{ slug: string; title: string }>;
  }

  // ─── Brief & Cross-ref queries ────────────────────────────────

  countNewPagesSince(hours: number): { entities: number; concepts: number } {
    const rows = this.prepare(
      "SELECT type, COUNT(*) as c FROM pages WHERE (type LIKE 'entity/%' OR type LIKE 'concept/%') AND created_at > datetime('now', '-' || $h || ' hours') GROUP BY type"
    ).all({ $h: hours }) as Array<{ type: string; c: number }>;
    const result = { entities: 0, concepts: 0 };
    for (const row of rows) {
      if (row.type.startsWith("entity/")) result.entities += row.c;
      else if (row.type.startsWith("concept/")) result.concepts += row.c;
    }
    return result;
  }

  getRecentUpdatesBySlugs(slugs: string[], days: number): Array<{ slug: string; title: string; type: string; updated_at: string }> {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map(() => "?").join(",");
    return this.prepare(
      `SELECT slug, title, type, updated_at FROM pages
       WHERE slug IN (${placeholders})
       AND updated_at > datetime('now', '-${days} days')
       ORDER BY updated_at DESC
       LIMIT 10`
    ).all(...slugs) as Array<{ slug: string; title: string; type: string; updated_at: string }>;
  }

  getExpiredPages(now: string): Array<{ slug: string; title: string; expires_at: string }> {
    return this.prepare(
      "SELECT slug, title, expires_at FROM pages WHERE expires_at IS NOT NULL AND expires_at < $now"
    ).all({ $now: now }) as Array<{ slug: string; title: string; expires_at: string }>;
  }

  getLowConfidenceDecayPages(threshold: number): Array<{ slug: string; title: string; confidence_decay: number }> {
    return this.prepare(
      "SELECT slug, title, confidence_decay FROM pages WHERE confidence_decay < $t"
    ).all({ $t: threshold }) as Array<{ slug: string; title: string; confidence_decay: number }>;
  }

  cleanDanglingLinks(): number {
    const r = this.prepare(
      "DELETE FROM links WHERE from_slug NOT IN (SELECT slug FROM pages) OR to_slug NOT IN (SELECT slug FROM pages)"
    ).run();
    return r.changes;
  }

  getLinksContextForSlugs(slugs: string[]): string[] {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT DISTINCT context FROM links WHERE context IS NOT NULL AND context != ''
         AND (from_slug IN (${placeholders}) OR to_slug IN (${placeholders}))`
    ).all(...slugs, ...slugs) as Array<{ context: string }>;
    return rows.map(r => r.context);
  }

  // ─── Link operations ──────────────────────────────────────────

  insertLink(from: string, to: string, relation: string, context?: string | null, weight?: number, strength?: string, sourceType?: string, confidence?: number, _skipReverse?: boolean, provenance?: ProvenanceInput): void {
    const clampedWeight = Math.min(1.0, Math.max(0.0, weight ?? 1.0));
    const trustState = sourceType && ["wikilink", "manual"].includes(sourceType) ? "trusted" : "candidate";
    this.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context, weight, strength, source_type, confidence, source_page_slug, trust_state, evidence) VALUES ($from, $to, $rel, $ctx, $w, $s, $st, $c, $sps, $ts, $ev)"
    ).run({ $from: from, $to: to, $rel: relation, $ctx: context ?? null, $w: clampedWeight, $s: strength ?? 'medium', $st: sourceType ?? 'unknown', $c: confidence ?? 0.5, $sps: provenance?.source_page_slug ?? null, $ts: trustState, $ev: provenance?.evidence ?? null });

    if (!_skipReverse) {
      const reverse = getReverseRelation(relation);
      if (reverse) {
        this.insertLink(to, from, reverse, context, weight, strength, sourceType, confidence, true, provenance);
      }
    }
  }

  deleteLink(from: string, to: string, relation: string): boolean {
    const r = this.prepare(
      "DELETE FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel"
    ).run({ $from: from, $to: to, $rel: relation });
    const reverse = getReverseRelation(relation);
    if (reverse) {
      this.prepare(
        "DELETE FROM links WHERE from_slug = $to AND to_slug = $from AND relation = $rel"
      ).run({ $to: to, $from: from, $rel: reverse });
    }
    return r.changes > 0;
  }

  deleteLinksBySlug(slug: string): void {
    this.prepare(
      "DELETE FROM links WHERE from_slug = $slug OR to_slug = $slug"
    ).run({ $slug: slug });
  }

  deleteLinksByRelation(slug: string, relation: string): void {
    this.prepare(
      "DELETE FROM links WHERE from_slug = $slug AND relation = $rel"
    ).run({ $slug: slug, $rel: relation });
  }

  /** Remove only mention edges owned by the Markdown wikilink projector. */
  deleteWikilinkMentions(fromSlug: string): void {
    this.prepare(
      "DELETE FROM links WHERE from_slug = $slug AND relation = '提及' AND source_type = 'wikilink'"
    ).run({ $slug: fromSlug });
  }

  /**
   * Persist explicit wikilink evidence without downgrading a manually curated
   * edge that already occupies the unique (from, to, relation) key.
   */
  upsertWikilinkMention(fromSlug: string, toSlug: string): void {
    this.prepare(
      `INSERT INTO links
        (from_slug, to_slug, relation, context, weight, strength, source_type,
         confidence, source_page_slug, trust_state, evidence)
       VALUES ($from, $to, '提及', NULL, 0.3, 'weak', 'wikilink', 0.9, $from, 'trusted', NULL)
       ON CONFLICT(from_slug, to_slug, relation) DO UPDATE SET
         context = CASE WHEN links.source_type = 'manual' THEN links.context ELSE excluded.context END,
         weight = CASE WHEN links.source_type = 'manual' THEN links.weight ELSE excluded.weight END,
         strength = CASE WHEN links.source_type = 'manual' THEN links.strength ELSE excluded.strength END,
         source_type = CASE WHEN links.source_type = 'manual' THEN links.source_type ELSE excluded.source_type END,
         confidence = CASE WHEN links.source_type = 'manual' THEN links.confidence ELSE excluded.confidence END,
         source_page_slug = CASE WHEN links.source_type = 'manual' THEN links.source_page_slug ELSE excluded.source_page_slug END,
         trust_state = CASE WHEN links.source_type = 'manual' THEN links.trust_state ELSE excluded.trust_state END,
         evidence = CASE WHEN links.source_type = 'manual' THEN links.evidence ELSE excluded.evidence END`
    ).run({ $from: fromSlug, $to: toSlug });
  }

  /** Restore an exact outgoing mention snapshot during ingest compensation. */
  restoreOutgoingMentionLinks(fromSlug: string, links: readonly LinkRow[]): void {
    const insert = this.prepare(
      `INSERT INTO links
        (id, from_slug, to_slug, relation, context, weight, strength,
         source_type, confidence, created_at, source_page_slug, trust_state,
         evidence, last_validated_at, effective_weight)
       VALUES
        ($id, $from, $to, '提及', $context, $weight, $strength,
         $sourceType, $confidence, $createdAt, $sourcePageSlug, $trustState,
         $evidence, $lastValidatedAt, $effectiveWeight)`
    );

    this.deleteLinksByRelation(fromSlug, "提及");
    for (const link of links) {
      if (link.from_slug !== fromSlug || link.relation !== "提及") {
        throw new Error("Invalid mention-link snapshot");
      }
      insert.run({
        $id: link.id,
        $from: link.from_slug,
        $to: link.to_slug,
        $context: link.context,
        $weight: link.weight,
        $strength: link.strength,
        $sourceType: link.source_type,
        $confidence: link.confidence,
        $createdAt: link.created_at,
        $sourcePageSlug: link.source_page_slug ?? null,
        $trustState: link.trust_state ?? null,
        $evidence: link.evidence ?? null,
        $lastValidatedAt: link.last_validated_at,
        $effectiveWeight: link.effective_weight,
      });
    }
  }

  // ─── Volatile relation lifecycle (Phase 1: reports_to) ───────────
  // reports_to has no reverse relation (it is a structured_field, not in
  // relation_types), so these helpers are forward-only — no symmetric
  // reverse handling like deleteLink. Superseded rows are preserved so the
  // old manager edge stays auditable; active reads already exclude
  // 'superseded' via the shared filter.

  /** Active (non-superseded, non-rejected) reports_to edges from `fromSlug`. */
  getActiveReportsToLinks(fromSlug: string): LinkRow[] {
    return this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence, last_validated_at, effective_weight
       FROM links WHERE from_slug = $slug AND relation = 'reports_to'
       AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))`
    ).all({ $slug: fromSlug }) as LinkRow[];
  }

  /**
   * Mark every active reports_to edge from `fromSlug` as superseded.
   * Preserves rows + evidence (no hard delete). Pass `exceptToSlug` to spare
   * the edge that is about to be (re)activated. Returns forward count.
   */
  supersedeReportsTo(fromSlug: string, exceptToSlug?: string): number {
    const r = this.prepare(
      `UPDATE links SET trust_state = 'superseded'
       WHERE from_slug = $slug AND relation = 'reports_to'
       AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))
       AND ($except IS NULL OR to_slug <> $except)`
    ).run({ $slug: fromSlug, $except: exceptToSlug ?? null });
    return r.changes;
  }

  /**
   * Insert a reports_to edge as active+trusted, or REACTIVATE an existing
   * (superseded/candidate/rejected) edge. Deterministic reports_to paths
   * (frontmatter sync, setHierarchy) are authoritative → trust_state='trusted'.
   * Avoids the INSERT OR IGNORE trap where a superseded row would silently
   * block reactivation on revert. Existing evidence is preserved unless
   * overridden via `provenance`.
   */
  upsertActiveReportsTo(
    from: string,
    to: string,
    sourceType = "agent",
    confidence = 0.95,
    provenance?: ProvenanceInput,
  ): void {
    const existing = this.prepare(
      "SELECT id, source_page_slug, evidence FROM links WHERE from_slug = $from AND to_slug = $to AND relation = 'reports_to'"
    ).get({ $from: from, $to: to }) as
      | { id: number; source_page_slug: string | null; evidence: string | null }
      | undefined;

    if (existing) {
      this.prepare(
        `UPDATE links SET trust_state = 'trusted', source_type = $st, confidence = $c,
            weight = 1.0, strength = 'strong',
            source_page_slug = $sps, evidence = $ev,
            effective_weight = 1.0 * $c,
            last_validated_at = datetime('now')
         WHERE id = $id`
      ).run({
        $st: sourceType,
        $c: confidence,
        $sps: provenance?.source_page_slug ?? existing.source_page_slug,
        $ev: provenance?.evidence ?? existing.evidence,
        $id: existing.id,
      });
      return;
    }

    this.prepare(
      `INSERT INTO links (from_slug, to_slug, relation, context, weight, strength, source_type, confidence, source_page_slug, trust_state, evidence, effective_weight, last_validated_at)
       VALUES ($from, $to, 'reports_to', NULL, 1.0, 'strong', $st, $c, $sps, 'trusted', $ev, 1.0 * $c, datetime('now'))`
    ).run({
      $from: from,
      $to: to,
      $st: sourceType,
      $c: confidence,
      $sps: provenance?.source_page_slug ?? null,
      $ev: provenance?.evidence ?? null,
    });
  }

  /**
   * Upsert a deterministic organization employment fact as one forward-only
   * trusted edge. The organization projector owns validation, and employment
   * has no reverse relation or supersession semantics.
   */
  upsertTrustedOrganizationEmployment(
    from: string,
    to: string,
    sourceType: "manual" | "agent",
    confidence = 0.95,
    provenance?: ProvenanceInput,
  ): void {
    const existing = this.prepare(
      "SELECT id, source_page_slug, evidence FROM links WHERE from_slug = $from AND to_slug = $to AND relation = '任职'",
    ).get({ $from: from, $to: to }) as
      | { id: number; source_page_slug: string | null; evidence: string | null }
      | undefined;

    if (existing) {
      this.prepare(
        `UPDATE links SET trust_state = 'trusted', source_type = $st, confidence = $c,
            weight = 1.0, strength = 'strong',
            source_page_slug = $sps, evidence = $ev,
            effective_weight = 1.0 * $c,
            last_validated_at = datetime('now')
         WHERE id = $id`,
      ).run({
        $st: sourceType,
        $c: confidence,
        $sps: provenance?.source_page_slug ?? existing.source_page_slug,
        $ev: provenance?.evidence ?? existing.evidence,
        $id: existing.id,
      });
      return;
    }

    this.prepare(
      `INSERT INTO links
        (from_slug, to_slug, relation, context, weight, strength, source_type,
         confidence, source_page_slug, trust_state, evidence, effective_weight,
         last_validated_at)
       VALUES ($from, $to, '任职', NULL, 1.0, 'strong', $st, $c, $sps,
         'trusted', $ev, 1.0 * $c, datetime('now'))`,
    ).run({
      $from: from,
      $to: to,
      $st: sourceType,
      $c: confidence,
      $sps: provenance?.source_page_slug ?? null,
      $ev: provenance?.evidence ?? null,
    });
  }

  /**
   * Current (authoritative) reports_to edges for `slug` in a direction.
   * trust_state IS NULL or IN ('trusted','user_thought') — EXCLUDES candidate
   * (unverified), rejected, superseded. This is the "current fact" semantic for
   * volatile relations (#233 Phase 1 HIGH 1): a weak/NER candidate edge is
   * evidence, not a current manager/subordinate. candidate remains visible via
   * includeInactive=true / debug / raw / evidence paths (getOutgoingLinks).
   */
  getCurrentReportsToLinks(slug: string, direction: "outgoing" | "incoming"): LinkRow[] {
    const col = direction === "outgoing" ? "from_slug" : "to_slug";
    return this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence, last_validated_at, effective_weight
       FROM links WHERE ${col} = $slug AND relation = 'reports_to'
       AND (trust_state IS NULL OR trust_state IN ('trusted','user_thought'))`
    ).all({ $slug: slug }) as LinkRow[];
  }

  getOutgoingLinks(slug: string, includeInactive = false): LinkRow[] {
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    return this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence FROM links WHERE from_slug = $slug${activeFilter}`
    ).all({ $slug: slug }) as LinkRow[];
  }

  getIncomingLinks(slug: string, includeInactive = false): LinkRow[] {
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    return this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence FROM links WHERE to_slug = $slug${activeFilter}`
    ).all({ $slug: slug }) as LinkRow[];
  }

  /**
   * #385: bounded trusted-link fetch for the personal current-state guard.
   * Returns at most `limit` outgoing+incoming links with trust_state
   * explicitly 'trusted' or 'user_thought' (NOT null/legacy — the guard
   * requires explicit provenance for personal current-state authority).
   * Pushes LIMIT into SQL with deterministic ORDER BY so high-degree subjects
   * always get a stable, auditable subset (P2#5: no LIMIT without ORDER BY).
   */
  getBoundedTrustedLinks(slug: string, limit: number): LinkRow[] {
    const trustedFilter = " AND trust_state IN ('trusted','user_thought')";
    const cols = "id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence, last_validated_at, effective_weight";
    const rows = this.prepare(
      `SELECT ${cols} FROM links WHERE (from_slug = $slug OR to_slug = $slug)${trustedFilter} ORDER BY effective_weight DESC, id ASC LIMIT $limit`
    ).all({ $slug: slug, $limit: limit }) as LinkRow[];
    return rows;
  }

  /**
   * #385: bounded timeline fetch for the personal current-state guard.
   * Reads the subject and trusted one-hop neighbors only.
   *
   * Explicit provenance and supported semantic dates are required. SQL
   * filters the supported shapes before LIMIT, so malformed legacy rows
   * cannot consume the bounded result budget.
   */
  getBoundedTrustedTimelineForSlugs(slugs: string[], limit: number): BoundedTrustedTimelineRow[] {
    if (slugs.length === 0 || limit <= 0) return [];
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT page_slug, event_date, summary, trust_state FROM timeline
       WHERE page_slug IN (${placeholders})
       AND event_date IS NOT NULL
       AND trim(event_date) <> ''
       AND substr(trim(event_date), 1, 4) <> '0000'
       AND trust_state IN ('trusted','user_thought')
       AND (
         trim(event_date) GLOB '[0-9][0-9][0-9][0-9]'
         OR trim(event_date) GLOB '[0-9][0-9][0-9][0-9]-0[1-9]'
         OR trim(event_date) GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'
         OR (
           trim(event_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           AND date(trim(event_date)) = trim(event_date)
         )
       )
       ORDER BY event_date DESC, id DESC LIMIT ?`
    ).all(...slugs, limit) as Array<{
      page_slug: string;
      event_date: string | null;
      summary: string;
      trust_state?: string | null;
    }>;
    return rows
      .filter((row): row is BoundedTrustedTimelineRow =>
        isSupportedSemanticEventDate(row.event_date) &&
        (row.trust_state === "trusted" || row.trust_state === "user_thought")
      )
      .slice(0, limit);
  }

  getOutgoingSlugs(slug: string, includeInactive = false): string[] {
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    const rows = this.prepare(
      `SELECT to_slug FROM links WHERE from_slug = $slug${activeFilter}`
    ).all({ $slug: slug }) as Array<{ to_slug: string }>;
    return rows.map(r => r.to_slug);
  }

  getIncomingSlugs(slug: string, includeInactive = false): string[] {
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    const rows = this.prepare(
      `SELECT from_slug FROM links WHERE to_slug = $slug${activeFilter}`
    ).all({ $slug: slug }) as Array<{ from_slug: string }>;
    return rows.map(r => r.from_slug);
  }

  getLinkedSlugs(slug: string, direction: "from" | "to", relation?: string, includeInactive = false): string[] {
    const col = direction === "from" ? "to_slug" : "from_slug";
    const where = direction === "from" ? "from_slug" : "to_slug";
    let sql = `SELECT ${col} as slug FROM links WHERE ${where} = $slug`;
    const params: Record<string, string> = { $slug: slug };
    if (relation) {
      sql += " AND relation = $rel";
      params.$rel = relation;
    }
    if (!includeInactive) {
      sql += " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    }
    const rows = this.prepare(sql).all(params) as Array<{ slug: string }>;
    return rows.map(r => r.slug);
  }

  /** Return all distinct slugs that have links to/from the given slug (both directions). */
  getLinkNeighborSlugs(slug: string): string[] {
    const rows = this.prepare(
      `SELECT DISTINCT from_slug AS slug FROM links WHERE to_slug = $slug` +
      ` UNION ` +
      `SELECT DISTINCT to_slug AS slug FROM links WHERE from_slug = $slug`
    ).all({ $slug: slug }) as Array<{ slug: string }>;
    return rows.map(r => r.slug);
  }

  getAllLinks(includeInactive = false): Array<{ from_slug: string; to_slug: string; relation: string; weight: number; trust_state?: string | null }> {
    const activeFilter = includeInactive ? "" : " WHERE (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    return this.prepare(
      `SELECT from_slug, to_slug, relation, weight, trust_state FROM links${activeFilter}`
    ).all() as Array<{ from_slug: string; to_slug: string; relation: string; weight: number; trust_state?: string | null }>;
  }

  batchGetLinksForSlugs(slugs: string[], includeInactive = false): Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }> {
    const result = new Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, { outgoing: [], incoming: [] });
    const placeholders = slugs.map(() => "?").join(",");
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    const outgoing = this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence FROM links WHERE from_slug IN (${placeholders})${activeFilter}`
    ).all(...slugs) as LinkRow[];
    const incoming = this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at, source_page_slug, trust_state, evidence FROM links WHERE to_slug IN (${placeholders})${activeFilter}`
    ).all(...slugs) as LinkRow[];
    for (const l of outgoing) result.get(l.from_slug)!.outgoing.push(l);
    for (const l of incoming) result.get(l.to_slug)!.incoming.push(l);
    return result;
  }

  /**
   * #311 — active link degree (endpoint count) per slug, for proactive-connection
   * hub filtering. Counts link rows where the slug is `from_slug` OR `to_slug` and
   * the edge is active (`trust_state` NULL or not rejected/superseded) — same
   * definition as `batchGetLinksForSlugs(includeInactive=false)`. Missing slugs → 0.
   * One query over the bounded batch scope; mirrors the positional-IN pattern of
   * `batchGetLinksForSlugs`.
   */
  batchGetLinkDegrees(slugs: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (slugs.length === 0) return out;
    for (const s of slugs) out.set(s, 0);
    const placeholders = slugs.map(() => "?").join(",");
    const activeFilter = " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    // #311 adversarial fix — exclude self-loops (from_slug = to_slug): a single self-loop
    // row would otherwise be counted by both halves of the UNION ALL (+2), inflating degree
    // and misclassifying a boundary-degree neighbor as a hub. Matches buildLocalAdjacency's
    // `a === b` drop.
    const noSelfLoop = " AND from_slug != to_slug";
    const rows = this.prepare(
      `SELECT slug, COUNT(*) AS deg FROM (
         SELECT from_slug AS slug FROM links WHERE from_slug IN (${placeholders})${activeFilter}${noSelfLoop}
         UNION ALL
         SELECT to_slug AS slug FROM links WHERE to_slug IN (${placeholders})${activeFilter}${noSelfLoop}
       ) GROUP BY slug`,
    ).all(...slugs, ...slugs) as Array<{ slug: string; deg: number }>;
    for (const r of rows) out.set(r.slug, r.deg);
    return out;
  }

  batchGetTimelineForSlugs(slugs: string[], includeInactive = false): Map<string, Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string; trust_state?: string; source_page_slug?: string; evidence?: string }>> {
    const result = new Map<string, Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string; trust_state?: string; source_page_slug?: string; evidence?: string }>>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, []);
    const placeholders = slugs.map(() => "?").join(",");
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    const rows = this.prepare(
      `SELECT page_slug, id, event_date, source, summary, created_at, trust_state, source_page_slug, evidence FROM timeline WHERE page_slug IN (${placeholders})${activeFilter} ORDER BY event_date DESC, id DESC`
    ).all(...slugs) as Array<{ page_slug: string; id: number; event_date: string | null; source: string | null; summary: string; created_at: string; trust_state?: string; source_page_slug?: string; evidence?: string }>;
    for (const r of rows) result.get(r.page_slug)!.push(r);
    return result;
  }

  batchGetTagsForSlugs(slugs: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, []);
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT page_slug, tag FROM tags WHERE page_slug IN (${placeholders}) ORDER BY tag`
    ).all(...slugs) as Array<{ page_slug: string; tag: string }>;
    for (const r of rows) result.get(r.page_slug)!.push(r.tag);
    return result;
  }

  getPageTitlesAndTypes(slugs: string[]): Map<string, { title: string; type: string }> {
    const result = new Map<string, { title: string; type: string }>();
    if (slugs.length === 0) return result;
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT slug, title, type FROM pages WHERE slug IN (${placeholders})`
    ).all(...slugs) as Array<{ slug: string; title: string; type: string }>;
    for (const r of rows) result.set(r.slug, { title: r.title, type: r.type });
    return result;
  }

  getLinksForSlugs(slugs: string[], includeInactive = false): Map<string, { outgoing: string[]; incoming: string[] }> {
    const result = new Map<string, { outgoing: string[]; incoming: string[] }>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, { outgoing: [], incoming: [] });
    const placeholders = slugs.map(() => "?").join(",");
    const activeFilter = includeInactive ? "" : ` AND ${CURRENT_FACT_LINK_SQL}`;
    const outRows = this.prepare(
      `SELECT from_slug, to_slug FROM links WHERE from_slug IN (${placeholders})${activeFilter}`
    ).all(...slugs) as Array<{ from_slug: string; to_slug: string }>;
    const inRows = this.prepare(
      `SELECT to_slug, from_slug FROM links WHERE to_slug IN (${placeholders})${activeFilter}`
    ).all(...slugs) as Array<{ to_slug: string; from_slug: string }>;
    for (const r of outRows) result.get(r.from_slug)!.outgoing.push(r.to_slug);
    for (const r of inRows) result.get(r.to_slug)!.incoming.push(r.from_slug);
    return result;
  }

  /** Find distinct page_slugs whose chunks_fts content matches any LIKE pattern. */
  findSlugsByText(patterns: string[]): string[] {
    if (patterns.length === 0) return [];
    const clauses = patterns.map(() => "content LIKE ?").join(" OR ");
    const params = patterns.map(p => `%${p}%`);
    const rows = this.prepare(
      `SELECT DISTINCT page_slug FROM chunks_fts WHERE ${clauses}`
    ).all(...params) as Array<{ page_slug: string }>;
    return rows.map(r => r.page_slug);
  }

  getLinkCount(): number {
    const row = this.prepare("SELECT COUNT(*) as cnt FROM links WHERE (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))").get() as { cnt: number };
    return row.cnt;
  }

  getLinkCountBySlug(slug: string): number {
    const row = this.prepare(
      `SELECT COUNT(*) as cnt FROM links WHERE (from_slug = $slug OR to_slug = $slug) AND ${CURRENT_FACT_LINK_SQL}`
    ).get({ $slug: slug }) as { cnt: number };
    return row.cnt;
  }

  linkExists(from: string, to: string, relation: string): boolean {
    // #233 R2: exclude rejected/superseded — a superseded evidence row must NOT
    // satisfy an existence check, otherwise generic dedup guards (dialogue) and
    // INSERT OR IGNORE would silently block re-creation after supersede.
    const row = this.prepare(
      "SELECT 1 FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))"
    ).get({ $from: from, $to: to, $rel: relation });
    return row != null;
  }

  // ─── Chunk write operations ──────────────────────────────────

  deleteChunksByPage(slug: string): void {
    this.prepare("DELETE FROM chunks WHERE page_slug = $slug AND summary_level = 0").run({ $slug: slug });
  }

  insertChunk(slug: string, index: number, content: string): void {
    this.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES ($slug, $idx, $content, 0)"
    ).run({ $slug: slug, $idx: index, $content: content });
  }

  insertChunkWithLevel(slug: string, index: number, content: string, summaryLevel: number, contentHash: string | null): void {
    this.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level, content_hash) VALUES ($slug, $idx, $content, $level, $hash)"
    ).run({ $slug: slug, $idx: index, $content: content, $level: summaryLevel, $hash: contentHash });
  }

  getL1Summary(slug: string): { id: number; content: string; content_hash: string | null } | null {
    return this.prepare(
      "SELECT id, content, content_hash FROM chunks WHERE page_slug = $slug AND summary_level = 1"
    ).get({ $slug: slug }) as { id: number; content: string; content_hash: string | null } | null;
  }

  deleteL1Summary(slug: string): void {
    this.prepare("DELETE FROM chunks WHERE page_slug = $slug AND summary_level = 1").run({ $slug: slug });
  }

  /** A page is "sealed" when it owns an L1 summary chunk (summary_level = 1). */
  isSealedPage(pageSlug: string): boolean {
    const row = this.prepare(
      "SELECT 1 FROM chunks WHERE page_slug = $slug AND summary_level = 1 LIMIT 1"
    ).get({ $slug: pageSlug });
    return Boolean(row);
  }

  /**
   * Bounded raw-chunk lookup for a single page. Deterministic OR-LIKE over ONLY
   * that page's summary_level = 0 chunks — no global FTS scan, no LLM. Terms are
   * pre-extracted and RANKED BY PRIORITY by the caller (see
   * HybridSearch.pickStrongestRawHit): highest-signal term first. LIKE wildcards
   * (%, _, \) are escaped to match literally; terms < 2 chars are dropped.
   *
   * match_rank is computed in SQL (CASE: index of the first matching term) so
   * the strongest-signal chunk is promoted BEFORE LIMIT — a high-signal chunk
   * at chunk_index 4 is not lost to a chunk_index-ordered LIMIT cutoff (#169).
   * Returns up to `maxChunks` raw chunks ordered by (match_rank, chunk_index).
   */
  getRawChunkHitsForPage(
    pageSlug: string,
    terms: string[],
    maxChunks: number = 3
  ): Array<{ chunk_index: number; content: string }> {
    const escaped = terms
      .slice(0, 16)
      .filter((t) => t.trim().length >= 2)
      .map((t) => t.replace(/[%_\\]/g, "\\$&"));
    if (escaped.length === 0) return [];
    const patterns = escaped.map((e) => `%${e}%`);
    const caseClauses = escaped
      .map((_, i) => `WHEN content LIKE ? ESCAPE '\\' THEN ${i}`)
      .join(" ");
    const whereClauses = escaped.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
    return this.rawDb
      .prepare(
        `SELECT chunk_index, content,
           CASE ${caseClauses} ELSE ${escaped.length} END AS match_rank
         FROM chunks
         WHERE page_slug = ? AND summary_level = 0 AND (${whereClauses})
         ORDER BY match_rank ASC, chunk_index ASC
         LIMIT ?`
      )
      .all(...patterns, pageSlug, ...patterns, maxChunks) as Array<{
      chunk_index: number;
      content: string;
    }>;
  }

  getPagesNeedingSeal(): string[] {
    const rows = this.prepare(
      `SELECT DISTINCT c1.page_slug FROM chunks c1
       WHERE c1.summary_level = 0
       AND NOT EXISTS (
         SELECT 1 FROM chunks c2 WHERE c2.page_slug = c1.page_slug AND c2.summary_level = 1
       )`
    ).all() as Array<{ page_slug: string }>;
    return rows.map(r => r.page_slug);
  }

  getPagesWithChangedChunks(): string[] {
    const l1Rows = this.prepare(
      "SELECT page_slug, content_hash FROM chunks WHERE summary_level = 1 AND content_hash IS NOT NULL"
    ).all() as Array<{ page_slug: string; content_hash: string }>;
    const changed: string[] = [];
    for (const row of l1Rows) {
      const currentHash = this.getRawChunkContentHash(row.page_slug);
      if (currentHash !== row.content_hash) changed.push(row.page_slug);
    }
    return changed;
  }

  getRawChunkContentHash(slug: string): string {
    const rows = this.prepare(
      "SELECT content FROM chunks WHERE page_slug = $slug AND summary_level = 0 ORDER BY chunk_index"
    ).all({ $slug: slug }) as Array<{ content: string }>;
    const combined = rows.map(r => r.content).join("\n");
    return Bun.hash(combined).toString();
  }

  getChunkCount(): number {
    const row = this.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    return row.cnt;
  }

  getChunkCountByPage(slug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM chunks WHERE page_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };
    return row.cnt;
  }

  // ─── Ingest log write ──────────────────────────────────────

  addIngestLog(sourceType: string, action: string, slug?: string | null, details?: string | null): void {
    this.prepare(
      "INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($src, $action, $slug, $details)"
    ).run({ $src: sourceType, $action: action, $slug: slug ?? null, $details: details ?? null });
  }

  getRecentNerErrorCount(): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM ingest_log WHERE details LIKE '%nerError%' AND created_at > datetime('now', '-24 hours')"
    ).get() as { cnt: number };
    return row.cnt;
  }

  getRecentVerifierCounts(hours = 24): {
    ner: { warning: number; error: number };
    discovery: { warning: number; error: number };
    byCode: Record<string, number>;
  } {
    const rows = this.prepare(
      "SELECT action, details FROM ingest_log WHERE source_type = $src AND created_at > datetime('now', '-' || $hours || ' hours')"
    ).all({ $src: "verifier", $hours: hours }) as Array<{ action: string; details: string | null }>;

    const out = {
      ner: { warning: 0, error: 0 },
      discovery: { warning: 0, error: 0 },
      byCode: {} as Record<string, number>,
    };

    for (const row of rows) {
      let summary: { counts?: { warning?: number; error?: number }; reasonCounts?: Record<string, unknown> };
      try {
        summary = row.details ? JSON.parse(row.details) : {};
      } catch {
        continue;
      }
      const bucket =
        row.action === "ner_shadow_verifier" ? out.ner :
        row.action === "discovery_shadow_verifier" ? out.discovery : null;
      if (!bucket) continue;
      bucket.warning += summary.counts?.warning ?? 0;
      bucket.error += summary.counts?.error ?? 0;
      if (summary.reasonCounts) {
        for (const [code, n] of Object.entries(summary.reasonCounts)) {
          if (typeof n === "number") out.byCode[code] = (out.byCode[code] ?? 0) + n;
        }
      }
    }
    return out;
  }

  // ─── Timeline write operations ──────────────────────────────

  deleteTimelineByPage(slug: string): void {
    this.prepare("DELETE FROM timeline WHERE page_slug = $slug").run({ $slug: slug });
  }

  getTimelineCountByPage(slug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM timeline WHERE page_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };
    return row.cnt;
  }

  rewireTimeline(oldSlug: string, newSlug: string): void {
    this.prepare(
      "UPDATE timeline SET page_slug = $new WHERE page_slug = $old"
    ).run({ $old: oldSlug, $new: newSlug });
  }

  getAllTimelineRaw(): Array<{ id: number; page_slug: string; event_date: string | null; summary: string }> {
    return this.prepare("SELECT id, page_slug, event_date, summary FROM timeline").all() as Array<{ id: number; page_slug: string; event_date: string | null; summary: string }>;
  }

  deleteTimelineByIds(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$id${i}`).join(",");
    const params: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) params[`$id${i}`] = ids[i];
    this.prepare(`DELETE FROM timeline WHERE id IN (${placeholders})`).run(params);
  }

  updateTimelineDate(id: number, newDate: string): void {
    this.prepare("UPDATE timeline SET event_date = $date WHERE id = $id").run({ $id: id, $date: newDate });
  }

  getDuplicateTimelineIds(): number[] {
    const rows = this.prepare(`
      SELECT id FROM timeline WHERE id NOT IN (
        SELECT MIN(id) FROM timeline GROUP BY page_slug, COALESCE(event_date, ''), summary
      )
    `).all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  // ─── Tag bulk operations ─────────────────────────────────────

  deleteTagsByPage(slug: string): void {
    this.prepare("DELETE FROM tags WHERE page_slug = $slug").run({ $slug: slug });
  }

  addTags(slug: string, tags: string[]): void {
    const stmt = this.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)");
    for (const tag of tags) {
      stmt.run({ $slug: slug, $tag: tag });
    }
  }

  replaceTags(slug: string, tags: string[]): void {
    this.deleteTagsByPage(slug);
    this.addTags(slug, tags);
  }

  // ─── Config operations ───────────────────────────────────────

  getAllConfig(): Array<{ key: string; value: string }> {
    return this.prepare("SELECT key, value FROM config ORDER BY key").all() as Array<{ key: string; value: string }>;
  }

  deleteConfig(key: string): void {
    this.prepare("DELETE FROM config WHERE key = $key").run({ $key: key });
  }

  // ─── Entity lookup ─────────────────────────────────────────────

  getEntitySlugByTitle(name: string): string | null {
    const row = this.prepare(
      "SELECT slug FROM pages WHERE title = $name AND (type LIKE 'entity/%' OR type LIKE 'concept/%')"
    ).get({ $name: name }) as { slug: string } | null;
    return row?.slug ?? null;
  }

  getEntitySlugByTitleLower(name: string): string | null {
    const row = this.prepare(
      "SELECT slug FROM pages WHERE LOWER(title) = LOWER($name) AND (type LIKE 'entity/%' OR type LIKE 'concept/%')"
    ).get({ $name: name }) as { slug: string } | null;
    return row?.slug ?? null;
  }

  getEntityType(slug: string): string | null {
    const row = this.prepare(
      "SELECT type FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { type: string } | null;
    return row?.type ?? null;
  }

  updateType(slug: string, newType: string): void {
    this.prepare(
      "UPDATE pages SET type = $type, updated_at = CURRENT_TIMESTAMP WHERE slug = $slug"
    ).run({ $slug: slug, $type: newType });
  }

  /** Atomically update both type and content_hash for same-slug moves. */
  updateTypeAndHash(slug: string, newType: string, contentHash: string | null): void {
    this.db.transaction(() => {
      this.prepare(
        "UPDATE pages SET type = $type, content_hash = $hash, updated_at = CURRENT_TIMESTAMP WHERE slug = $slug"
      ).run({ $slug: slug, $type: newType, $hash: contentHash });
    })();
  }

  /**
   * Run a callback inside a single SQLite transaction. All CBrainDB methods
   * called within `fn` participate (same connection) — either all commit or all
   * roll back. Use this to make multi-statement durable writes atomic (e.g.
   * insertPage + tags + provenance) instead of compensating deletes, which can
   * themselves fail and leak a half-written row. #386.
   */
  runInTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  movePage(oldSlug: string, newSlug: string, newType: string, newFilePath: string, contentHash?: string | null): void {
    // Pre-validation (outside transaction — fast fail on obvious errors)
    if (oldSlug === newSlug) {
      throw new Error(`movePage: oldSlug and newSlug must differ (got "${oldSlug}")`);
    }
    const existing = this.getPage(oldSlug);
    if (!existing) {
      throw new Error(`movePage: source page not found: "${oldSlug}"`);
    }
    const target = this.getPage(newSlug);
    if (target) {
      throw new Error(`movePage: target page already exists: "${newSlug}"`);
    }

    const hash = contentHash !== undefined ? contentHash : existing.content_hash;

    const tx = this.db.transaction(() => {
      // Defer FK checks until commit — lets us UPDATE pages.slug (PK) before
      // child rows are updated. Unlike PRAGMA foreign_keys=OFF, this actually
      // works inside a transaction.
      this.db.exec("PRAGMA defer_foreign_keys = ON");

      // 1. pages (primary key + type + file_path + content_hash in ONE update)
      this.prepare(
        "UPDATE pages SET slug = $new, type = $type, file_path = $fp, content_hash = $hash, updated_at = CURRENT_TIMESTAMP WHERE slug = $old"
      ).run({ $old: oldSlug, $new: newSlug, $type: newType, $fp: newFilePath, $hash: hash });

      // 2-4. links: from_slug, to_slug (FK), source_page_slug (no FK)
      this.prepare("UPDATE links SET from_slug = $new WHERE from_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });
      this.prepare("UPDATE links SET to_slug = $new WHERE to_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });
      this.prepare("UPDATE links SET source_page_slug = $new WHERE source_page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });
      this.prepare("UPDATE links SET context = REPLACE(context, $old, $new) WHERE context LIKE '%' || $old || '%'")
        .run({ $old: oldSlug, $new: newSlug });

      // 5. tags
      this.prepare("UPDATE tags SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 6. chunks
      this.prepare("UPDATE chunks SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 7. versions
      this.prepare("UPDATE versions SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 8. aliases
      this.prepare("UPDATE aliases SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 9-10. timeline: page_slug (FK), source_page_slug (no FK)
      this.prepare("UPDATE timeline SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });
      this.prepare("UPDATE timeline SET source_page_slug = $new WHERE source_page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 11. mention_snapshots (FK, composite PK with snapshot_date)
      this.prepare("UPDATE mention_snapshots SET slug = $new WHERE slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 12. chunks_fts (virtual table, no FK)
      this.prepare("UPDATE chunks_fts SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 13. ingest_log (no FK)
      this.prepare("UPDATE ingest_log SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 14. query_feedback (no FK on slug column)
      this.prepare("UPDATE query_feedback SET slug = $new WHERE slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // 15. compounding_review_candidates.source_slugs_json (JSON array)
      const jsonRows = this.prepare(
        "SELECT id, source_slugs_json FROM compounding_review_candidates WHERE source_slugs_json LIKE '%' || $old || '%'"
      ).all({ $old: oldSlug }) as Array<{ id: number; source_slugs_json: string }>;
      for (const row of jsonRows) {
        try {
          const slugs: string[] = JSON.parse(row.source_slugs_json);
          const updated = slugs.map(s => s === oldSlug ? newSlug : s);
          this.prepare(
            "UPDATE compounding_review_candidates SET source_slugs_json = $json WHERE id = $id"
          ).run({ $json: JSON.stringify(updated), $id: row.id });
        } catch {
          // Malformed JSON — skip; non-critical data
        }
      }

      // 16. page_write_provenance (FK -> pages.slug, PK = page_slug; #386). Without
      // this, renaming a tracked record page fails the integrity gate below
      // (the FK has no ON UPDATE CASCADE).
      this.prepare("UPDATE page_write_provenance SET page_slug = $new WHERE page_slug = $old")
        .run({ $old: oldSlug, $new: newSlug });

      // Integrity gate: reject commit if any FK violation remains
      const violations = this.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
      if (violations.length > 0) {
        throw new Error(
          `movePage: foreign key check failed with ${violations.length} violation(s): ` +
          violations.map(v => `${v.table}[${v.rowid}] -> ${v.parent}`).join(", ")
        );
      }
    });
    tx();
  }

  getAllEntityTitles(): string[] {
    const rows = this.prepare(
      "SELECT title FROM pages WHERE type LIKE 'entity/%' OR type LIKE 'concept/%'"
    ).all() as Array<{ title: string }>;
    return rows.map(r => r.title);
  }

  getAllEntitiesInfo(type?: string): Array<{ slug: string; title: string; type: string; mention_count: number }> {
    const sql = type
      ? "SELECT slug, title, type, mention_count FROM pages WHERE type = $type ORDER BY mention_count DESC"
      : "SELECT slug, title, type, mention_count FROM pages WHERE type LIKE 'entity/%' OR type LIKE 'concept/%' ORDER BY mention_count DESC";
    return this.prepare(sql).all(type ? { $type: type } : {}) as Array<{ slug: string; title: string; type: string; mention_count: number }>;
  }

  findCrossTypeDuplicates(): Array<{ title: string; slug_a: string; type_a: string; slug_b: string; type_b: string }> {
    return this.prepare(`
      SELECT p1.title, p1.slug AS slug_a, p1.type AS type_a, p2.slug AS slug_b, p2.type AS type_b
      FROM pages p1
      JOIN pages p2 ON LOWER(REPLACE(REPLACE(REPLACE(p1.title,' ',''),'-',''),'.','')) = LOWER(REPLACE(REPLACE(REPLACE(p2.title,' ',''),'-',''),'.',''))
                   AND p1.rowid < p2.rowid
      WHERE p1.type != p2.type
      ORDER BY p1.title
    `).all() as Array<{ title: string; slug_a: string; type_a: string; slug_b: string; type_b: string }>;
  }

  addAlias(pageSlug: string, alias: string): void {
    this.prepare(
      "INSERT OR IGNORE INTO aliases (page_slug, alias) VALUES ($slug, $alias)"
    ).run({ $slug: pageSlug, $alias: alias });
  }

  addAliasWithSource(pageSlug: string, alias: string, source: string): void {
    this.prepare(
      "INSERT OR IGNORE INTO aliases (page_slug, alias, source) VALUES ($slug, $alias, $source)"
    ).run({ $slug: pageSlug, $alias: alias, $source: source });
  }

  removeAlias(pageSlug: string, alias: string): void {
    this.prepare(
      "DELETE FROM aliases WHERE page_slug = $slug AND alias = $alias"
    ).run({ $slug: pageSlug, $alias: alias });
  }

  getSlugByAlias(alias: string): string | null {
    const row = this.prepare(
      "SELECT page_slug FROM aliases WHERE alias = $alias"
    ).get({ $alias: alias }) as { page_slug: string } | null;
    return row?.page_slug ?? null;
  }

  /** Exact alias lookup for governed resolvers; never chooses an arbitrary owner. */
  getPagesByAlias(alias: string): Array<{ slug: string; type: string; title: string }> {
    return this.prepare(
      `SELECT p.slug, p.type, p.title
       FROM aliases a JOIN pages p ON p.slug = a.page_slug
       WHERE a.alias = $alias
       ORDER BY p.slug`,
    ).all({ $alias: alias }) as Array<{ slug: string; type: string; title: string }>;
  }

  listAliases(pageSlug: string): string[] {
    const rows = this.prepare(
      "SELECT alias FROM aliases WHERE page_slug = $slug ORDER BY id"
    ).all({ $slug: pageSlug }) as Array<{ alias: string }>;
    return rows.map(r => r.alias);
  }

  // ─── Discoveries ──────────────────────────────────────────────

  static discoveryDedupKey(type: string, entities: string[]): string {
    const sorted = [...new Set(entities)].sort();
    return `${type}|${JSON.stringify(sorted)}`;
  }

  upsertDiscovery(type: string, entities: string[], score: number, detail?: Record<string, unknown>, dreamRun?: string, actionable?: string, autoApplicable?: boolean, metadata?: Record<string, unknown>): { id: number; inserted: boolean; occurrenceCount: number } {
    const dedupKey = CBrainDB.discoveryDedupKey(type, entities);
    const sortedEntities = [...new Set(entities)].sort();
    const entitiesJson = JSON.stringify(sortedEntities);
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    // Atomic: try insert first; on conflict, update recurrence
    const insertResult = this.prepare(
      "INSERT INTO discoveries (type, entities, score, detail, detected_at, last_detected_at, dream_run, actionable, auto_applicable, metadata, dedup_key, occurrence_count) VALUES ($type, $entities, $score, $detail, datetime('now'), datetime('now'), $run, $actionable, $auto, $metadata, $key, 1) ON CONFLICT(dedup_key) DO NOTHING"
    ).run({
      $type: type,
      $entities: entitiesJson,
      $score: score,
      $detail: detail ? JSON.stringify(detail) : null,
      $run: dreamRun ?? null,
      $actionable: actionable ?? "low",
      $auto: autoApplicable ? 1 : 0,
      $metadata: metaJson,
      $key: dedupKey,
    });

    if (insertResult.changes > 0) {
      return { id: Number(insertResult.lastInsertRowid), inserted: true, occurrenceCount: 1 };
    }

    // Conflict — recurrence update: only touch recurrence fields, never user decisions
    this.prepare(
      "UPDATE discoveries SET score = $score, metadata = $metadata, last_detected_at = datetime('now'), occurrence_count = occurrence_count + 1 WHERE dedup_key = $key"
    ).run({ $score: score, $metadata: metaJson, $key: dedupKey });

    const row = this.prepare(
      "SELECT id, occurrence_count FROM discoveries WHERE dedup_key = $key"
    ).get({ $key: dedupKey }) as { id: number; occurrence_count: number };

    return { id: row.id, inserted: false, occurrenceCount: row.occurrence_count };
  }

  getUnseenDiscoveries(limit: number = 20): Array<{ id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; dream_run: string | null; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number; metadata: string | null }> {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, dream_run, actionable, suggestion, proposed_actions, auto_applicable, metadata FROM discoveries WHERE seen = 0 AND status = 'pending' ORDER BY CASE actionable WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, score DESC, id DESC LIMIT $limit"
    ).all({ $limit: limit }) as any[];
  }

  markDiscoverySeen(id: number): void {
    this.prepare("UPDATE discoveries SET seen = 1 WHERE id = $id").run({ $id: id });
  }

  cleanupOldDiscoveries(days: number = 90): number {
    const r = this.prepare(
      "DELETE FROM discoveries WHERE seen = 0 AND detected_at < datetime('now', '-' || $days || ' days')"
    ).run({ $days: days });
    return r.changes;
  }

  clearPendingDiscoveries(): number {
    const r = this.prepare("DELETE FROM discoveries WHERE seen = 0 AND status = 'pending'").run();
    return r.changes;
  }

  updateDiscoveryStatus(id: number, status: "pending" | "seen" | "resolved" | "dismissed"): void {
    // Any non-pending status means the user has acted on this discovery → seen=1.
    // This protects it from cleanupOldDiscoveries (which keys off seen=0) so a
    // dismissed/resolved row is not deleted and later resurrected by recurrence
    // as a fresh pending row. pending resets seen=0 (awaiting attention). (#172)
    const seen = status === "pending" ? 0 : 1;
    this.prepare("UPDATE discoveries SET status = $status, seen = $seen WHERE id = $id").run({ $id: id, $status: status, $seen: seen });
  }

  // ─── Mention Snapshots ─────────────────────────────────────────

  upsertMentionSnapshot(slug: string, date: string, count: number): void {
    this.prepare(
      "INSERT OR REPLACE INTO mention_snapshots (slug, snapshot_date, mention_count) VALUES ($slug, $date, $count)"
    ).run({ $slug: slug, $date: date, $count: count });
  }

  getMentionSnapshots(slug: string, days: number): Array<{ snapshot_date: string; mention_count: number }> {
    return this.prepare(
      "SELECT snapshot_date, mention_count FROM mention_snapshots WHERE slug = $slug AND snapshot_date >= date('now', '-' || $days || ' days') ORDER BY snapshot_date ASC"
    ).all({ $slug: slug, $days: days }) as any[];
  }

  cleanMentionSnapshots(olderThanDays: number): number {
    const r = this.prepare(
      "DELETE FROM mention_snapshots WHERE snapshot_date < date('now', '-' || $days || ' days')"
    ).run({ $days: olderThanDays });
    return r.changes;
  }

  updateDiscoverySuggestion(id: number, suggestion: string): void {
    this.prepare("UPDATE discoveries SET suggestion = $suggestion WHERE id = $id").run({ $id: id, $suggestion: suggestion });
  }

  updateDiscoveryActions(id: number, actions: { type: string; target: string; reason: string }[]): void {
    this.prepare("UPDATE discoveries SET proposed_actions = $actions WHERE id = $id").run({ $id: id, $actions: JSON.stringify(actions) });
  }

  getDiscoveriesByActionable(actionable: string, limit: number = 20): Array<{ id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number; metadata: string | null }> {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, actionable, suggestion, proposed_actions, auto_applicable, metadata FROM discoveries WHERE actionable = $actionable AND seen = 0 AND status = 'pending' ORDER BY score DESC, id DESC LIMIT $limit"
    ).all({ $actionable: actionable, $limit: limit }) as any[];
  }

  getDiscoveriesByType(type: string, limit: number = 20): Array<{ id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number; metadata: string | null }> {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, actionable, suggestion, proposed_actions, auto_applicable, metadata FROM discoveries WHERE type = $type AND seen = 0 AND status = 'pending' ORDER BY CASE actionable WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, score DESC, id DESC LIMIT $limit"
    ).all({ $type: type, $limit: limit }) as any[];
  }

  /**
   * #311 — lifecycle index for a discovery type: ALL rows (any status) with the
   * fields the proactive-connection producer needs to (a) skip exact dismissed/
   * resolved dedup_keys, (b) match evidence-identical equivalent candidates, and
   * (c) read pre-upsert occurrence_count for novelty/recurrence scoring. One query
   * backs cooldown + scoring. No schema change — reuses the existing discoveries
   * lifecycle (`status` + `dedup_key` from `runDiscoveryMigrations`).
   */
  getDiscoveryLifecycleIndex(type: string, limit: number = 500): Array<{ id: number; dedup_key: string; entities: string; metadata: string | null; last_detected_at: string | null; occurrence_count: number; status: string }> {
    return this.prepare(
      "SELECT id, dedup_key, entities, metadata, last_detected_at, occurrence_count, status FROM discoveries WHERE type = $type ORDER BY last_detected_at DESC, id DESC LIMIT $limit",
    ).all({ $type: type, $limit: limit }) as any[];
  }

  countDiscoveriesByActionable(): Record<string, number> {
    const rows = this.prepare(
      "SELECT actionable, COUNT(*) as cnt FROM discoveries WHERE seen = 0 AND status = 'pending' GROUP BY actionable"
    ).all() as Array<{ actionable: string; cnt: number }>;
    const result: Record<string, number> = { high: 0, medium: 0, low: 0 };
    for (const row of rows) result[row.actionable] = row.cnt;
    return result;
  }

  // ─── Insights ──────────────────────────────────────────────────

  createInsight(data: CreateInsightInput): number {
    const r = this.prepare(
      "INSERT INTO insights (content, type, confidence, source_entities, source_type, expires_at) VALUES ($content, $type, $confidence, $entities, $sourceType, $expiresAt)"
    ).run({
      $content: data.content,
      $type: data.type,
      $confidence: data.confidence ?? 0.5,
      $entities: data.sourceEntities ? JSON.stringify(data.sourceEntities) : null,
      $sourceType: data.sourceType,
      $expiresAt: data.expiresAt ?? null,
    });
    return Number(r.lastInsertRowid);
  }

  getInsight(id: number): InsightRow | null {
    return this.prepare(
      "SELECT * FROM insights WHERE id = $id"
    ).get({ $id: id }) as InsightRow | null;
  }

  listInsights(opts?: { type?: string; status?: string; sourceType?: string; limit?: number; offset?: number }): InsightRow[] {
    let sql = "SELECT * FROM insights WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    if (opts?.status) {
      sql += " AND status = $status";
      params.$status = opts.status;
    } else {
      sql += " AND status = 'active'";
    }
    if (opts?.sourceType) {
      sql += " AND source_type = $sourceType";
      params.$sourceType = opts.sourceType;
    }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }
    return this.prepare(sql).all(params) as InsightRow[];
  }

  getInsightsBySourceEntities(slugs: string[], limit: number = 10): InsightRow[] {
    if (slugs.length === 0) return [];
    const conditions = slugs.map((_, i) => `source_entities LIKE $s${i}`).join(" OR ");
    const params: Record<string, string | number> = { $limit: limit };
    slugs.forEach((s, i) => { params[`$s${i}`] = `%"${s}"%`; });
    return this.prepare(
      `SELECT * FROM insights WHERE status = 'active' AND (${conditions}) ORDER BY created_at DESC LIMIT $limit`
    ).all(params) as InsightRow[];
  }

  updateInsightStatus(id: number, status: "active" | "archived" | "dismissed"): boolean {
    const r = this.prepare(
      "UPDATE insights SET status = $status WHERE id = $id"
    ).run({ $id: id, $status: status });
    return r.changes > 0;
  }

  markInsightSeen(id: number): void {
    this.prepare("UPDATE insights SET seen = 1 WHERE id = $id").run({ $id: id });
  }

  countInsights(status?: string): number {
    if (status) {
      const row = this.prepare(
        "SELECT COUNT(*) as cnt FROM insights WHERE status = $status"
      ).get({ $status: status }) as { cnt: number };
      return row.cnt;
    }
    const row = this.prepare("SELECT COUNT(*) as cnt FROM insights").get() as { cnt: number };
    return row.cnt;
  }

  archiveExpiredInsights(): number {
    const r = this.prepare(
      "UPDATE insights SET status = 'archived' WHERE expires_at IS NOT NULL AND expires_at < datetime('now') AND status = 'active'"
    ).run();
    return r.changes;
  }

  getDiscoveryById(id: number): { id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number; status: string; metadata: string | null; seen: number; occurrence_count: number; last_detected_at: string | null; dedup_key: string | null } | null {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, actionable, suggestion, proposed_actions, auto_applicable, status, metadata, seen, occurrence_count, last_detected_at, dedup_key FROM discoveries WHERE id = $id"
    ).get({ $id: id }) as any ?? null;
  }

  logSearch(query: string, strategy: string, latencyMs: number, hitCount: number, degraded: boolean, details?: Record<string, unknown>): void {
    this.prepare(
      "INSERT INTO search_log (query, strategy, latency_ms, hit_count, degraded, details_json) VALUES ($query, $strategy, $latency, $hits, $degraded, $details)"
    ).run({ $query: query, $strategy: strategy, $latency: latencyMs, $hits: hitCount, $degraded: degraded ? 1 : 0, $details: details ? JSON.stringify(details) : null });
  }

  getSearchLog(limit: number = 50): Array<{ id: number; query: string; strategy: string; latency_ms: number; hit_count: number; degraded: number; details_json: string | null; created_at: string }> {
    return this.prepare(
      "SELECT id, query, strategy, latency_ms, hit_count, degraded, details_json, created_at FROM search_log ORDER BY id DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ id: number; query: string; strategy: string; latency_ms: number; hit_count: number; degraded: number; details_json: string | null; created_at: string }>;
  }

  getSearchQualityStats(days: number = 7): {
    totalSearches: number;
    degradedCount: number;
    degradedRate: number;
    latencyWarningCount: number;
    latencyWarningRate: number;
    avgLatencyMs: number;
    topReasonCodes: Array<{ code: string; count: number }>;
    topLatencyWarningCodes: Array<{ code: string; count: number }>;
    emptyResultCount: number;
    hierarchyMismatchCount: number;
    periodDays: number;
  } {
    const rows = this.prepare(
      "SELECT degraded, hit_count, latency_ms, details_json FROM search_log WHERE created_at >= datetime('now', '-' || $days || ' days')"
    ).all({ $days: days }) as Array<{ degraded: number; hit_count: number; latency_ms: number; details_json: string | null }>;

    const totalSearches = rows.length;
    if (totalSearches === 0) {
      return {
        totalSearches: 0,
        degradedCount: 0,
        degradedRate: 0,
        latencyWarningCount: 0,
        latencyWarningRate: 0,
        avgLatencyMs: 0,
        topReasonCodes: [],
        topLatencyWarningCodes: [],
        emptyResultCount: 0,
        hierarchyMismatchCount: 0,
        periodDays: days,
      };
    }

    const avgLatencyMs = Math.round(rows.reduce((s, r) => s + r.latency_ms, 0) / totalSearches);
    const emptyResultCount = rows.filter(r => r.hit_count === 0).length;

    // Aggregate reason codes from details_json
    const degradedReasonCodes = new Set([
      "vector_timeout",
      "vector_error",
      "fts_empty",
      "low_score",
      "budget_exhausted",
      "fallback_used",
      "reasoning_parse_failed",
    ]);
    const warningReasonCodes = new Set(["latency_budget_exceeded", "fts_parser_fallback"]);
    const informationalReasonCodes = new Set(["rerank_insufficient", "routing_mismatch_hierarchy"]);
    const knownReasonCodes = new Set([
      ...degradedReasonCodes,
      ...warningReasonCodes,
      ...informationalReasonCodes,
    ]);
    const degradedCodeCounts = new Map<string, number>();
    const warningCodeCounts = new Map<string, number>();
    let hierarchyMismatchCount = 0;
    let degradedCount = 0;
    let latencyWarningCount = 0;
    for (const row of rows) {
      let codes: string[] = [];
      try {
        if (row.details_json) {
          const details = JSON.parse(row.details_json);
          codes = Array.isArray(details.reason_codes)
            ? details.reason_codes.filter((code: unknown): code is string => typeof code === "string" && knownReasonCodes.has(code))
            : [];
        }
      } catch {
        codes = [];
      }

      if (codes.includes("routing_mismatch_hierarchy")) hierarchyMismatchCount++;

      const hasParserFallback = codes.includes("fts_parser_fallback");
      const parserFallbackDegraded = hasParserFallback && row.hit_count === 0;
      const hasDegradedReason = codes.some(code => degradedReasonCodes.has(code)) || parserFallbackDegraded;
      const hasWarningReason = codes.some(code => warningReasonCodes.has(code));
      const legacyDegradedWithoutReasons = row.degraded === 1 && codes.length === 0;
      const isRetrievalDegraded = hasDegradedReason || legacyDegradedWithoutReasons;
      const isLatencyWarning = row.latency_ms > 2000 || hasWarningReason;

      if (isRetrievalDegraded) degradedCount++;
      if (isLatencyWarning) latencyWarningCount++;

      for (const code of codes) {
        if (degradedReasonCodes.has(code)) {
          degradedCodeCounts.set(code, (degradedCodeCounts.get(code) ?? 0) + 1);
        } else if (code === "fts_parser_fallback" && parserFallbackDegraded) {
          degradedCodeCounts.set(code, (degradedCodeCounts.get(code) ?? 0) + 1);
        } else if (warningReasonCodes.has(code)) {
          warningCodeCounts.set(code, (warningCodeCounts.get(code) ?? 0) + 1);
        }
      }
    }

    const topReasonCodes = [...degradedCodeCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const topLatencyWarningCodes = [...warningCodeCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalSearches,
      degradedCount,
      degradedRate: degradedCount / totalSearches,
      latencyWarningCount,
      latencyWarningRate: latencyWarningCount / totalSearches,
      avgLatencyMs,
      topReasonCodes,
      topLatencyWarningCodes,
      emptyResultCount,
      hierarchyMismatchCount,
      periodDays: days,
    };
  }

  // ─── NER quality observability (#167 Phase 1, observe-only) ────

  logNerQuality(input: {
    extractedEntities: number;
    extractedConcepts: number;
    filteredTotal: number;
    filterReasons: Record<string, number>;
    resolvedExisting: number;
    aliasAdded: number;
    stubCreated: number;
    duplicateCandidate: number;
    relationsTotal: number;
    relationsWritten: number;
  }): void {
    const skipped = Math.max(0, input.relationsTotal - input.relationsWritten);
    this.prepare(
      `INSERT INTO ner_quality_log
       (extracted_entities, extracted_concepts, filtered_total, filter_reasons_json,
        resolved_existing, alias_added, stub_created, duplicate_candidate,
        relations_total, relations_written, relations_skipped)
       VALUES ($ee, $ec, $ft, $fr, $re, $aa, $sc, $dc, $rt, $rw, $rs)`
    ).run({
      $ee: input.extractedEntities,
      $ec: input.extractedConcepts,
      $ft: input.filteredTotal,
      $fr: JSON.stringify(input.filterReasons),
      $re: input.resolvedExisting,
      $aa: input.aliasAdded,
      $sc: input.stubCreated,
      $dc: input.duplicateCandidate,
      $rt: input.relationsTotal,
      $rw: input.relationsWritten,
      $rs: skipped,
    });
  }

  getNerQualityStats(days: number = 7): {
    runs: number;
    extractedEntities: number;
    extractedConcepts: number;
    filteredTotal: number;
    filteredRate: number;
    resolvedExisting: number;
    aliasAdded: number;
    stubCreated: number;
    duplicateCandidate: number;
    duplicateRate: number;
    stubRate: number;
    relationsTotal: number;
    relationsSkipped: number;
    relationSkipRate: number;
    topFilterReasons: Array<{ reason: string; count: number }>;
    periodDays: number;
  } {
    const rows = this.prepare(
      "SELECT extracted_entities, extracted_concepts, filtered_total, filter_reasons_json, resolved_existing, alias_added, stub_created, duplicate_candidate, relations_total, relations_written, relations_skipped FROM ner_quality_log WHERE created_at >= datetime('now', '-' || $days || ' days')"
    ).all({ $days: days }) as Array<{
      extracted_entities: number; extracted_concepts: number; filtered_total: number;
      filter_reasons_json: string | null; resolved_existing: number; alias_added: number;
      stub_created: number; duplicate_candidate: number; relations_total: number;
      relations_written: number; relations_skipped: number;
    }>;

    const runs = rows.length;
    if (runs === 0) {
      return {
        runs: 0, extractedEntities: 0, extractedConcepts: 0, filteredTotal: 0,
        filteredRate: 0, resolvedExisting: 0, aliasAdded: 0, stubCreated: 0,
        duplicateCandidate: 0, duplicateRate: 0, stubRate: 0,
        relationsTotal: 0, relationsSkipped: 0, relationSkipRate: 0,
        topFilterReasons: [], periodDays: days,
      };
    }

    const sum = (sel: (r: typeof rows[number]) => number) => rows.reduce((s, r) => s + sel(r), 0);
    const extractedEntities = sum((r) => r.extracted_entities);
    const extractedConcepts = sum((r) => r.extracted_concepts);
    const filteredTotal = sum((r) => r.filtered_total);
    const resolvedExisting = sum((r) => r.resolved_existing);
    const aliasAdded = sum((r) => r.alias_added);
    const stubCreated = sum((r) => r.stub_created);
    const duplicateCandidate = sum((r) => r.duplicate_candidate);
    const relationsTotal = sum((r) => r.relations_total);
    const relationsSkipped = sum((r) => r.relations_skipped);

    const kept = extractedEntities + extractedConcepts;
    const outcomes = resolvedExisting + aliasAdded + stubCreated + duplicateCandidate;

    const reasonCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.filter_reasons_json) continue;
      try {
        const parsed = JSON.parse(row.filter_reasons_json) as Record<string, number>;
        for (const [reason, count] of Object.entries(parsed)) {
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + count);
        }
      } catch { /* malformed json, skip */ }
    }
    const topFilterReasons = [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      runs,
      extractedEntities,
      extractedConcepts,
      filteredTotal,
      filteredRate: kept + filteredTotal > 0 ? filteredTotal / (kept + filteredTotal) : 0,
      resolvedExisting,
      aliasAdded,
      stubCreated,
      duplicateCandidate,
      duplicateRate: outcomes > 0 ? duplicateCandidate / outcomes : 0,
      stubRate: outcomes > 0 ? stubCreated / outcomes : 0,
      relationsTotal,
      relationsSkipped,
      relationSkipRate: relationsTotal > 0 ? relationsSkipped / relationsTotal : 0,
      topFilterReasons,
      periodDays: days,
    };
  }

  // ─── Search trace ─────────────────────────────────────────────

  startSearchTraceSession(input: import("../core/retrieval/search-trace.js").StartSearchTraceSessionInput): number {
    const result = this.prepare(
      "INSERT INTO search_trace_sessions (query, mode, intent) VALUES ($query, $mode, $intent)"
    ).run({ $query: input.query, $mode: input.mode, $intent: input.intent ?? null });
    return Number(result.lastInsertRowid);
  }

  finishSearchTraceSession(id: number, patch: import("../core/retrieval/search-trace.js").FinishSearchTraceSessionInput): void {
    this.prepare(
      `UPDATE search_trace_sessions
       SET ended_at = datetime('now'),
           latency_ms = $latencyMs,
           status = COALESCE($status, status),
           llm_calls = COALESCE($llmCalls, llm_calls),
           total_steps = COALESCE($totalSteps, total_steps),
           summary_json = COALESCE($summary, summary_json)
       WHERE id = $id`
    ).run({
      $id: id,
      $latencyMs: patch.latencyMs ?? null,
      $status: patch.status ?? null,
      $llmCalls: patch.llmCalls ?? null,
      $totalSteps: patch.totalSteps ?? null,
      $summary: patch.summaryJson ? JSON.stringify(patch.summaryJson) : null,
    });
  }

  addSearchTraceStep(input: import("../core/retrieval/search-trace.js").AddSearchTraceStepInput): void {
    this.prepare(
      "INSERT INTO search_trace_steps (session_id, step_index, kind, input_json, output_summary, latency_ms, error) VALUES ($sessionId, $stepIndex, $kind, $inputJson, $outputSummary, $latencyMs, $error)"
    ).run({
      $sessionId: input.sessionId,
      $stepIndex: input.stepIndex,
      $kind: input.kind,
      $inputJson: input.inputJson ? JSON.stringify(input.inputJson) : null,
      $outputSummary: input.outputSummary ?? null,
      $latencyMs: input.latencyMs ?? null,
      $error: input.error ?? null,
    });
  }

  getRecentSearchTraceSessions(limit: number = 20): Array<import("../core/retrieval/search-trace.js").SearchTraceSessionRow> {
    const rows = this.prepare(
      "SELECT id, query, mode, intent, started_at, ended_at, latency_ms, status, llm_calls, total_steps, summary_json FROM search_trace_sessions ORDER BY id DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ id: number; query: string; mode: string; intent: string | null; started_at: string; ended_at: string | null; latency_ms: number | null; status: string; llm_calls: number; total_steps: number; summary_json: string | null }>;
    return rows.map(row => ({
      ...row,
      summary_json: row.summary_json ? JSON.parse(row.summary_json) : null,
    }));
  }

  getSearchTraceSteps(sessionId: number): Array<import("../core/retrieval/search-trace.js").SearchTraceStepRow> {
    const rows = this.prepare(
      "SELECT id, session_id, step_index, kind, input_json, output_summary, latency_ms, error, created_at FROM search_trace_steps WHERE session_id = $sessionId ORDER BY step_index ASC"
    ).all({ $sessionId: sessionId }) as Array<{ id: number; session_id: number; step_index: number; kind: string; input_json: string | null; output_summary: string | null; latency_ms: number | null; error: string | null; created_at: string }>;
    return rows.map(row => ({
      ...row,
      input_json: row.input_json ? JSON.parse(row.input_json) : null,
    }));
  }

  logQuery(tool: string, query: string, resultSlugs: string[], latencyMs: number, sessionId?: string): void {
    this.prepare(
      "INSERT INTO query_log (tool, query, result_slugs, result_count, latency_ms, session_id) VALUES ($tool, $query, $slugs, $count, $latency, $session)"
    ).run({
      $tool: tool, $query: query, $slugs: JSON.stringify(resultSlugs),
      $count: resultSlugs.length, $latency: latencyMs, $session: sessionId ?? null,
    });
  }

  getQueryStatsSince(since: string): Array<{ slug: string; query_count: number; avg_position: number; tools: string; last_seen: string }> {
    return this.db.prepare(`
      WITH exploded AS (
        SELECT ql.tool, ql.created_at, j.value AS slug
        FROM query_log ql, json_each(ql.result_slugs) AS j
        WHERE ql.created_at >= $since
      )
      SELECT slug,
             COUNT(*) AS query_count,
             1.0 AS avg_position,
             GROUP_CONCAT(DISTINCT tool) AS tools,
             MAX(created_at) AS last_seen
      FROM exploded
      GROUP BY slug
      ORDER BY query_count DESC
    `).all({ $since: since }) as Array<{ slug: string; query_count: number; avg_position: number; tools: string; last_seen: string }>;
  }

  cleanOldQueryLogs(olderThanDays: number): number {
    this.prepare(
      "DELETE FROM query_feedback WHERE query_id IN (SELECT id FROM query_log WHERE created_at < datetime('now', '-' || $days || ' days'))"
    ).run({ $days: olderThanDays });
    const r = this.prepare(
      "DELETE FROM query_log WHERE created_at < datetime('now', '-' || $days || ' days')"
    ).run({ $days: olderThanDays });
    return r.changes;
  }

  getSessionCoOccurrences(sessionId: string): Array<{ slug_a: string; slug_b: string; count: number }> {
    const rows = this.db.prepare(`
      WITH session_slugs AS (
        SELECT j.value AS slug
        FROM query_log ql, json_each(ql.result_slugs) AS j
        WHERE ql.session_id = $session
      ),
      slug_pairs AS (
        SELECT a.slug AS slug_a, b.slug AS slug_b
        FROM session_slugs a, session_slugs b
        WHERE a.slug < b.slug
      )
      SELECT slug_a, slug_b, COUNT(*) AS count
      FROM slug_pairs
      GROUP BY slug_a, slug_b
    `).all({ $session: sessionId }) as Array<{ slug_a: string; slug_b: string; count: number }>;
    return rows;
  }

  getDistinctSessionsSince(since: string): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT session_id FROM query_log WHERE session_id IS NOT NULL AND created_at >= $since"
    ).all({ $since: since }) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  batchUpdateActivityWeights(weights: Map<string, { weight: number; lastQueriedAt: string }>): number {
    if (weights.size === 0) return 0;
    const stmt = this.prepare(
      "UPDATE pages SET activity_weight = $w, last_queried_at = $t WHERE slug = $slug"
    );
    let updated = 0;
    for (const [slug, data] of weights) {
      const r = stmt.run({ $w: data.weight, $t: data.lastQueriedAt, $slug: slug });
      if (r.changes > 0) updated++;
    }
    return updated;
  }

  getActivityWeights(slugs: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    const rows = this.prepare(
      `SELECT slug, activity_weight FROM pages WHERE slug IN (${placeholders}) AND activity_weight > 0`
    ).all(params) as Array<{ slug: string; activity_weight: number }>;
    for (const row of rows) result.set(row.slug, row.activity_weight);
    return result;
  }

  bumpActivityWeight(slug: string, delta: number): void {
    this.prepare(
      "UPDATE pages SET activity_weight = COALESCE(activity_weight, 0) + $delta, last_queried_at = datetime('now') WHERE slug = $slug"
    ).run({ $delta: delta, $slug: slug });
  }

  getTopActivityEntities(limit: number = 10): Array<{ slug: string; title: string; activity_weight: number }> {
    return this.prepare(
      "SELECT slug, title, activity_weight FROM pages WHERE activity_weight > 0 ORDER BY activity_weight DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ slug: string; title: string; activity_weight: number }>;
  }

  updateHotnessScore(slug: string, score: number): void {
    this.prepare(
      "UPDATE pages SET hotness_score = $score WHERE slug = $slug"
    ).run({ $score: score, $slug: slug });
  }

  getLinkCountForSlug(slug: string): number {
    const row = this.prepare(
      `SELECT count(*) as cnt FROM links WHERE (from_slug = $slug OR to_slug = $slug) AND ${CURRENT_FACT_LINK_SQL}`
    ).get({ $slug: slug }) as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  batchGetLinkCounts(slugs: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;

    // Single scan of links table, count per slug
    const rows = this.prepare(
      `SELECT from_slug, to_slug FROM links WHERE ${CURRENT_FACT_LINK_SQL}`
    ).all() as Array<{ from_slug: string; to_slug: string }>;

    const slugSet = new Set(slugs);
    const counts = new Map<string, number>();

    for (const { from_slug, to_slug } of rows) {
      if (slugSet.has(from_slug)) {
        counts.set(from_slug, (counts.get(from_slug) ?? 0) + 1);
      }
      // Self-link (A→A) already counted via from_slug; skip to avoid double-count
      if (slugSet.has(to_slug) && to_slug !== from_slug) {
        counts.set(to_slug, (counts.get(to_slug) ?? 0) + 1);
      }
    }

    // Build result: requested slugs → count (0 if absent)
    for (const slug of slugs) {
      if (!result.has(slug)) {
        result.set(slug, counts.get(slug) ?? 0);
      }
    }

    return result;
  }

  getHotnessStats(): { mentionP95: number; linkP95: number; activityP95: number } {
    const p95 = (col: string, table: string) => {
      const row = this.prepare(
        `SELECT ${col} as val FROM ${table} WHERE ${col} > 0 ORDER BY ${col} DESC LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.05 AS INTEGER) FROM ${table} WHERE ${col} > 0)`
      ).get() as { val: number } | null;
      return row?.val ?? 1;
    };
    const linkRow = this.prepare(
      "SELECT MAX(cnt) as cnt FROM (SELECT count(*) as cnt FROM (SELECT from_slug as slug FROM links WHERE (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded')) UNION ALL SELECT to_slug as slug FROM links WHERE (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))) GROUP BY slug)"
    ).get() as { cnt: number } | null;
    return {
      mentionP95: p95("mention_count", "pages"),
      linkP95: linkRow?.cnt ?? 1,
      activityP95: p95("activity_weight", "pages"),
    };
  }

  getHotnessWeights(slugs: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    const rows = this.prepare(
      `SELECT slug, hotness_score FROM pages WHERE slug IN (${placeholders}) AND hotness_score > 0`
    ).all(params) as Array<{ slug: string; hotness_score: number }>;
    for (const row of rows) result.set(row.slug, row.hotness_score);
    return result;
  }

  getTopHotnessEntities(limit: number = 10): Array<{ slug: string; title: string; hotness_score: number }> {
    return this.prepare(
      "SELECT slug, title, hotness_score FROM pages WHERE hotness_score > 0 ORDER BY hotness_score DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ slug: string; title: string; hotness_score: number }>;
  }

  boostLinkWeight(slugA: string, slugB: string, boost: number): void {
    this.prepare(
      "UPDATE links SET weight = MIN(weight + $boost, 10.0) WHERE (from_slug = $a AND to_slug = $b) OR (from_slug = $b AND to_slug = $a)"
    ).run({ $a: slugA, $b: slugB, $boost: boost });
  }

  applyLinkDecay(): number {
    const result = this.prepare(`
      UPDATE links SET
        effective_weight = CASE
          WHEN source_type IN ('manual', 'wikilink') THEN weight * confidence
          ELSE weight * confidence * POW(0.95, (julianday('now') - julianday(last_validated_at)) / 30.0)
        END
      WHERE last_validated_at < datetime('now', '-7 days')
    `).run();
    return result.changes;
  }

  validateLinksForSlugs(slugs: string[]): void {
    if (slugs.length === 0) return;
    const placeholders = slugs.map(() => "?").join(",");
    this.prepare(
      `UPDATE links SET last_validated_at = datetime('now') WHERE from_slug IN (${placeholders}) OR to_slug IN (${placeholders})`
    ).run(...slugs, ...slugs);
  }

  boostLinkConfidence(from: string, to: string, relation: string, delta: number): void {
    this.prepare(
      "UPDATE links SET confidence = MIN(1.0, confidence + $delta), last_validated_at = datetime('now') WHERE from_slug = $from AND to_slug = $to AND relation = $rel"
    ).run({ $from: from, $to: to, $rel: relation, $delta: delta });
  }

  private migrateChunksSummaryLevel(): void {
    // Capture baseline before migration
    const preCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;

    this.runDestructiveMigration({
      name: "migrateChunksSummaryLevel",
      completionKey: "migration_v4_chunks_summary_level",
      body: () => {
        const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
        const names = new Set(cols.map(c => c.name));
        if (names.has("summary_level")) return;

        this.cleanupTempTable("chunks_new", "chunks");

        this.db.exec(`
          CREATE TABLE chunks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page_slug TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            summary_level INTEGER NOT NULL DEFAULT 0,
            content_hash TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
            UNIQUE(page_slug, summary_level, chunk_index)
          );
          INSERT INTO chunks_new (id, page_slug, chunk_index, content, summary_level, content_hash, created_at)
            SELECT id, page_slug, chunk_index, content, 0, NULL, created_at FROM chunks;
          DROP TABLE chunks;
          ALTER TABLE chunks_new RENAME TO chunks;
        `);
      },
      validate: () => {
        // chunks table must exist, chunks_new must not
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chunks', 'chunks_new')").all() as Array<{ name: string }>;
        const tableNames = new Set(tables.map(t => t.name));
        if (!tableNames.has("chunks")) throw new Error("chunks table missing after rebuild");
        if (tableNames.has("chunks_new")) throw new Error("chunks_new residual after rebuild");

        // Required columns must exist
        const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
        const colNames = new Set(cols.map(c => c.name));
        if (!colNames.has("summary_level")) throw new Error("chunks missing summary_level column");
        if (!colNames.has("content_hash")) throw new Error("chunks missing content_hash column");

        // Row count must match baseline
        const postCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;
        if (postCount !== preCount) throw new Error(`chunks row count mismatch: expected ${preCount}, got ${postCount}`);

        // UNIQUE constraint must be (page_slug, summary_level, chunk_index)
        const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks'").get() as { sql: string } | undefined;
        if (!schema?.sql) throw new Error("chunks schema not found");
        if (!schema.sql.includes("UNIQUE(page_slug, summary_level, chunk_index)")) {
          throw new Error("chunks UNIQUE constraint is not (page_slug, summary_level, chunk_index)");
        }
      },
    });
  }

  /**
   * v6 migration: Remove type CHECK constraint from pages table to support
   * ontology type paths (e.g., entity/person, concept/concept).
   * Migrates existing flat types to path-based types.
   */
  private migrateOntologyTypes(): void {
    // Capture baseline before migration
    const preCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number }).cnt;

    this.runDestructiveMigration({
      name: "migrateOntologyTypes",
      completionKey: "migration_v6_ontology_types",
      body: () => {
        this.cleanupTempTable("pages_new", "pages");

        this.db.exec(`
          CREATE TABLE pages_new (
            slug TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL,
            content_hash TEXT,
            tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
            mention_count INTEGER DEFAULT 0,
            expires_at TEXT,
            confidence_decay REAL DEFAULT 1.0,
            activity_weight REAL DEFAULT 0.0,
            last_queried_at TEXT,
            hotness_score REAL NOT NULL DEFAULT 0.0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO pages_new SELECT slug, type, title, file_path, content_hash, tier, mention_count, expires_at, confidence_decay, COALESCE(activity_weight, 0.0), last_queried_at, COALESCE(hotness_score, 0.0), created_at, updated_at FROM pages;
          DROP TABLE pages;
          ALTER TABLE pages_new RENAME TO pages;
        `);

        // Migrate old flat types → new type paths
        this.db.prepare("UPDATE pages SET type = 'entity/person' WHERE type = 'entity' AND slug LIKE 'brain/entities/%'").run();
        this.db.prepare("UPDATE pages SET type = 'concept/concept' WHERE type = 'concept' AND slug LIKE 'brain/concepts/%'").run();

        // Rebuild all indexes (pages rebuild drops everything)
        ensurePagesIndexes(this.db);
      },
      validate: () => {
        // pages table must exist, pages_new must not
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pages', 'pages_new')").all() as Array<{ name: string }>;
        const tableNames = new Set(tables.map(t => t.name));
        if (!tableNames.has("pages")) throw new Error("pages table missing after rebuild");
        if (tableNames.has("pages_new")) throw new Error("pages_new residual after rebuild");

        // Required columns must exist
        const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
        const colNames = new Set(cols.map(c => c.name));
        for (const required of ["slug", "type", "title", "file_path", "activity_weight", "hotness_score"]) {
          if (!colNames.has(required)) throw new Error(`pages missing required column: ${required}`);
        }

        // No CHECK(type IN) constraint — removed by v6
        const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string } | undefined;
        if (schema?.sql?.includes("CHECK(type IN")) throw new Error("pages still has CHECK(type IN) constraint");

        // Row count must match baseline
        const postCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number }).cnt;
        if (postCount !== preCount) throw new Error(`pages row count mismatch: expected ${preCount}, got ${postCount}`);

        validatePagesIndexes(this.db);

        // No flat entity/concept types should remain under brain/ paths
        const flatEntity = this.db.prepare("SELECT COUNT(*) as cnt FROM pages WHERE type = 'entity' AND slug LIKE 'brain/entities/%'").get() as { cnt: number };
        if (flatEntity.cnt > 0) throw new Error(`${flatEntity.cnt} flat 'entity' type(s) remain under brain/entities/`);
        const flatConcept = this.db.prepare("SELECT COUNT(*) as cnt FROM pages WHERE type = 'concept' AND slug LIKE 'brain/concepts/%'").get() as { cnt: number };
        if (flatConcept.cnt > 0) throw new Error(`${flatConcept.cnt} flat 'concept' type(s) remain under brain/concepts/`);
      },
    });
  }

  private repairDirtyData(): void {
    const done = this.db.prepare("SELECT value FROM config WHERE key = 'repair_v1_dirty_data'").get() as { value: string } | undefined;
    if (done?.value === "1") return;

    // Clamp links.weight to [0, 1]
    this.db.prepare("UPDATE links SET weight = 1.0 WHERE weight > 1.0").run();
    this.db.prepare("UPDATE links SET weight = 0.0 WHERE weight < 0.0").run();

    // Delete orphaned records in child tables where page doesn't exist
    this.db.prepare("DELETE FROM timeline WHERE page_slug NOT IN (SELECT slug FROM pages)").run();
    this.db.prepare("DELETE FROM chunks WHERE page_slug NOT IN (SELECT slug FROM pages)").run();
    this.db.prepare("DELETE FROM tags WHERE page_slug NOT IN (SELECT slug FROM pages)").run();

    this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('repair_v1_dirty_data', '1')").run();
  }

  insertFeedback(queryId: number | null, slug: string, signal: "relevant" | "irrelevant" | "corrected" | "expanded", note?: string): void {
    this.prepare(
      "INSERT INTO query_feedback (query_id, slug, signal, note) VALUES ($qid, $slug, $signal, $note)"
    ).run({ $qid: queryId ?? null, $slug: slug, $signal: signal, $note: note ?? null });
  }

  getFeedbackSince(since: string): Array<{ slug: string; signal: string; cnt: number }> {
    return this.db.prepare(`
      SELECT slug, signal, COUNT(*) AS cnt
      FROM query_feedback
      WHERE created_at >= $since
      GROUP BY slug, signal
    `).all({ $since: since }) as Array<{ slug: string; signal: string; cnt: number }>;
  }

  // ─── Proactive hints support ──────────────────────────────────

  getRecentEventsInNetwork(
    slugs: string[],
    days: number,
    limit: number
  ): Array<{ slug: string; title: string; event_date: string | null; summary: string }> {
    if (slugs.length === 0) return [];
    const ph = slugs.map(() => "?").join(",");
    const activeLinkFilter = " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";

    const neighborRows = this.prepare(
      `SELECT DISTINCT to_slug AS neighbor FROM links WHERE from_slug IN (${ph})${activeLinkFilter}
       UNION
       SELECT DISTINCT from_slug AS neighbor FROM links WHERE to_slug IN (${ph})${activeLinkFilter}`
    ).all(...slugs, ...slugs) as Array<{ neighbor: string }>;
    const neighbors = neighborRows.map(r => r.neighbor).filter(n => !slugs.includes(n));
    if (neighbors.length === 0) return [];

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const ph2 = neighbors.map(() => "?").join(",");
    const activeTlFilter = " AND (t.trust_state IS NULL OR t.trust_state NOT IN ('rejected','superseded'))";
    const rows = this.prepare(
      `SELECT t.page_slug AS slug, p.title, t.event_date, t.summary
       FROM timeline t JOIN pages p ON p.slug = t.page_slug
       WHERE t.page_slug IN (${ph2}) AND t.event_date >= ?${activeTlFilter}
       ORDER BY t.event_date DESC LIMIT ?`
    ).all(...neighbors, cutoff, limit) as Array<{ slug: string; title: string; event_date: string | null; summary: string }>;
    return rows;
  }

  getExpiringSlugsInSet(
    slugs: string[],
    withinDays: number
  ): Array<{ slug: string; title: string; expires_at: string }> {
    if (slugs.length === 0) return [];
    const ph = slugs.map(() => "?").join(",");
    const cutoff = new Date(Date.now() + withinDays * 86_400_000).toISOString().slice(0, 10);
    return this.prepare(
      `SELECT slug, title, expires_at FROM pages
       WHERE slug IN (${ph}) AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at ASC`
    ).all(...slugs, cutoff) as Array<{ slug: string; title: string; expires_at: string }>;
  }

  // ─── Relation audit helpers ─────────────────────────────────

  getRelationDistribution(): Array<{ relation: string; count: number }> {
    return this.db.query(
      `SELECT relation, COUNT(*) as count FROM links GROUP BY relation ORDER BY count DESC`
    ).all() as Array<{ relation: string; count: number }>;
  }

  getAllLinksByRelation(relation: string, includeInactive = false): LinkRow[] {
    const activeFilter = includeInactive ? "" : " AND (trust_state IS NULL OR trust_state NOT IN ('rejected','superseded'))";
    return this.db.query(
      `SELECT * FROM links WHERE relation = ?${activeFilter}`
    ).all(relation) as LinkRow[];
  }

  updateLinkRelation(id: number, newRelation: string): void {
    this.db.query(
      `UPDATE links SET relation = ? WHERE id = ?`
    ).run(newRelation, id);
  }

  deleteLinkById(id: number): void {
    const link = this.db.query(`SELECT from_slug, to_slug, relation FROM links WHERE id = ?`).get(id) as { from_slug: string; to_slug: string; relation: string } | null;
    this.db.query(`DELETE FROM links WHERE id = ?`).run(id);
    if (link) {
      const reverse = getReverseRelation(link.relation);
      if (reverse) {
        this.prepare(
          "DELETE FROM links WHERE from_slug = $to AND to_slug = $from AND relation = $rel"
        ).run({ $to: link.to_slug, $from: link.from_slug, $rel: reverse });
      }
    }
  }

  // ─── Compounding Review Candidates ──────────────────────────────

  upsertCandidate(
    title: string,
    candidateType: CandidateType,
    contentHash: string,
    opts?: {
      summary?: string;
      evidenceJson?: string;
      scoresJson?: string;
      sourceSlugsJson?: string;
    },
  ): { id: number; isNew: boolean } {
    const existing = this.prepare(
      "SELECT id, status FROM compounding_review_candidates WHERE content_hash = $hash"
    ).get({ $hash: contentHash }) as { id: number; status: CandidateStatus } | undefined;

    if (existing) {
      if (existing.status === "pending" || existing.status === "deferred") {
        this.prepare(
          "UPDATE compounding_review_candidates SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = $id"
        ).run({ $id: existing.id });
      }
      return { id: existing.id, isNew: false };
    }

    const r = this.prepare(
      `INSERT INTO compounding_review_candidates (title, summary, candidate_type, evidence_json, scores_json, source_slugs_json, content_hash)
       VALUES ($title, $summary, $type, $evidence, $scores, $slugs, $hash)`
    ).run({
      $title: title,
      $summary: opts?.summary ?? null,
      $type: candidateType,
      $evidence: opts?.evidenceJson ?? null,
      $scores: opts?.scoresJson ?? null,
      $slugs: opts?.sourceSlugsJson ?? null,
      $hash: contentHash,
    });
    return { id: Number(r.lastInsertRowid), isNew: true };
  }

  getCandidate(id: number): CandidateRow | null {
    return this.prepare(
      "SELECT * FROM compounding_review_candidates WHERE id = $id"
    ).get({ $id: id }) as CandidateRow | null;
  }

  listCandidates(opts?: {
    status?: CandidateStatus;
    includeDeferred?: boolean;
    limit?: number;
    offset?: number;
  }): CandidateRow[] {
    let sql = "SELECT * FROM compounding_review_candidates WHERE 1=1";
    const params: Record<string, string | number> = {};

    if (opts?.status) {
      sql += " AND status = $status";
      params.$status = opts.status;
    } else if (opts?.includeDeferred) {
      sql += " AND status IN ('pending', 'deferred')";
    } else {
      sql += " AND status = 'pending'";
    }

    sql += " ORDER BY last_seen_at DESC";

    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }

    return this.prepare(sql).all(params) as CandidateRow[];
  }

  updateCandidateStatus(id: number, status: CandidateStatus): boolean {
    const r = this.prepare(
      "UPDATE compounding_review_candidates SET status = $status, updated_at = datetime('now') WHERE id = $id"
    ).run({ $status: status, $id: id });
    return r.changes > 0;
  }

  insertReviewFeedback(candidateId: number, action: FeedbackAction, note?: string): number {
    const r = this.prepare(
      "INSERT INTO compounding_review_feedback (candidate_id, action, note) VALUES ($cid, $action, $note)"
    ).run({ $cid: candidateId, $action: action, $note: note ?? null });
    return Number(r.lastInsertRowid);
  }

  getReviewFeedback(candidateId: number): CandidateFeedbackRow[] {
    return this.prepare(
      "SELECT * FROM compounding_review_feedback WHERE candidate_id = $cid ORDER BY created_at DESC"
    ).all({ $cid: candidateId }) as CandidateFeedbackRow[];
  }

  countReviewCandidates(status?: CandidateStatus): number {
    if (status) {
      const row = this.prepare(
        "SELECT COUNT(*) as cnt FROM compounding_review_candidates WHERE status = $status"
      ).get({ $status: status }) as { cnt: number };
      return row.cnt;
    }
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM compounding_review_candidates WHERE status = 'pending'"
    ).get() as { cnt: number };
    return row.cnt;
  }

  // ── Brain snapshot methods (wake-up diff) ────────────────────────

  createSnapshotAtomic(
    id: string,
    createdAt: string,
    pageCount: number,
    linkCount: number,
    items: Array<{ slug: string; title: string; contentHash: string | null; tier: number; mentionCount: number; linkCount: number; updatedAt: string | null; pageType: string; confidenceDecay: number }>,
  ): void {
    const headerStmt = this.prepare(
      "INSERT INTO brain_snapshots (id, created_at, kind, page_count, link_count) VALUES ($id, $ca, 'wakeup_diff', $pc, $lc)"
    );
    const itemStmt = this.prepare(
      "INSERT INTO brain_snapshot_items (snapshot_id, slug, title, content_hash, tier, mention_count, link_count, updated_at, page_type, confidence_decay) VALUES ($sid, $slug, $title, $ch, $tier, $mc, $lc, $ua, $pt, $cd)"
    );
    const tx = this.db.transaction((rows: typeof items) => {
      headerStmt.run({ $id: id, $ca: createdAt, $pc: pageCount, $lc: linkCount });
      for (const r of rows) {
        itemStmt.run({ $sid: id, $slug: r.slug, $title: r.title, $ch: r.contentHash, $tier: r.tier, $mc: r.mentionCount, $lc: r.linkCount, $ua: r.updatedAt, $pt: r.pageType, $cd: r.confidenceDecay });
      }
    });
    tx(items);
  }

  getLatestSnapshot(): { id: string; created_at: string; page_count: number; link_count: number } | null {
    return this.prepare(
      "SELECT id, created_at, page_count, link_count FROM brain_snapshots WHERE kind = 'wakeup_diff' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get() as { id: string; created_at: string; page_count: number; link_count: number } | null;
  }

  getSnapshotItems(snapshotId: string): Array<{ slug: string; title: string; content_hash: string | null; tier: number; mention_count: number; link_count: number; updated_at: string | null; page_type: string; confidence_decay: number }> {
    return this.prepare(
      "SELECT slug, title, content_hash, tier, mention_count, link_count, updated_at, page_type, confidence_decay FROM brain_snapshot_items WHERE snapshot_id = $sid"
    ).all({ $sid: snapshotId }) as Array<{ slug: string; title: string; content_hash: string | null; tier: number; mention_count: number; link_count: number; updated_at: string | null; page_type: string; confidence_decay: number }>;
  }

  deleteSnapshot(id: string): void {
    this.prepare("DELETE FROM brain_snapshot_items WHERE snapshot_id = $id").run({ $id: id });
    this.prepare("DELETE FROM brain_snapshots WHERE id = $id").run({ $id: id });
  }

  getSnapshotIds(): string[] {
    const rows = this.prepare(
      "SELECT id FROM brain_snapshots WHERE kind = 'wakeup_diff' ORDER BY created_at DESC, id DESC"
    ).all() as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  close(): void {
    this.db.close();
  }
}
