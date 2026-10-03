/**
 * #511 Task 3 — narrow, provider-independent topic read snapshot and
 * freshness. Shared by TopicManager.inspectFreshness, the MCP read surfaces,
 * HybridSearch admission and the CLI `show` fallback; it depends ONLY on
 * db/vaultPath/budgets (never the model, ContentPipeline or Lance), so no
 * read path ever instantiates model plumbing or waits for background work.
 *
 * Read freshness = the full Task 1 publication contract (committed manifest,
 * body hash, per-source content+governance fingerprints, committed index
 * hash) PLUS the Task 2 catalog attestation: a read requires a MATCHING
 * attestation — missing and mismatched both fail closed until maintenance
 * reattests (metadata-only, no model). `state` deliberately EXCLUDES the
 * catalog dimension — maintenance eligibility (reattest vs regenerate) keeps
 * using it.
 */
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve, sep } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import { hashContent, isTopicRow } from "../shared.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { parseTopicManifest } from "./manifest.js";
import { readRecordSource, resolveWithinVault, governanceFingerprint } from "./source-reader.js";
import {
  DEFAULT_TOPIC_BUDGETS,
  TopicBudgets,
  TopicFreshnessReport,
  TopicManifest,
  TopicSourceReadError,
} from "./types.js";

export interface TopicReadDeps {
  db: CBrainDB;
  vaultPath: string;
  budgets?: TopicBudgets;
}

/** The verified read itself — the SAME bytes the verification checked. */
export interface TopicReadSnapshot {
  slug: string;
  title: string;
  generatedAt: string;
  sourceSlugs: string[];
  /** Verified raw file bytes (frontmatter included). */
  raw: string;
  /** Verified body (frontmatter-stripped) of the same read. */
  body: string;
}

export interface TopicReadVerification {
  slug: string;
  /** Task 1 freshness semantics WITHOUT the catalog dimension. */
  state: TopicFreshnessReport["state"];
  /** Readable as a current derived page: state fresh AND attested catalog (if any) matches. */
  current: boolean;
  editedByUser: boolean;
  generatedAt: string | null;
  reasons: string[];
  sources: Array<{ slug: string; ok: boolean; reason?: string }>;
  catalogAttested: boolean;
  catalogChanged: boolean;
}

interface TopicReadInspection {
  verification: TopicReadVerification;
  manifest: TopicManifest;
  raw: string;
  body: string;
  title: string;
}

interface InspectionDeps extends TopicReadDeps {
  /** Bytes already read asynchronously through the vault boundary. */
  readRaw?: (relPath: string) => string;
  catalog?: string;
}

function inspectTopicRead(deps: InspectionDeps, slug: string): TopicReadInspection | null {
  const { db, vaultPath } = deps;
  const budgets = deps.budgets ?? DEFAULT_TOPIC_BUDGETS;
  const row = db.getPage(slug);
  if (!row || !isTopicRow(row)) return null;

  const fail = (reasons: string[]): TopicReadInspection => ({
    verification: {
      slug,
      state: "invalid",
      current: false,
      editedByUser: false,
      generatedAt: null,
      reasons,
      sources: [],
      catalogAttested: false,
      catalogChanged: false,
    },
    manifest: null as unknown as TopicManifest,
    raw: "",
    body: "",
    title: row.title,
  });

  let raw: string;
  try {
    raw = deps.readRaw ? deps.readRaw(row.file_path!) : readFileSync(resolveWithinVault(vaultPath, row.file_path!), "utf-8");
  } catch {
    return fail(["topic_file_unreadable"]);
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const manifestResult = parseTopicManifest(frontmatter.topic);
  if (manifestResult === null) return fail(["manifest_missing"]);
  if (!manifestResult.ok) return fail(["manifest_invalid"]);
  const manifest = manifestResult.manifest;

  const reasons: string[] = [];
  if (manifest.state !== "committed") reasons.push("publication_pending");
  const editedByUser = hashContent(body) !== manifest.output_hash;
  if (editedByUser) reasons.push("target_edited");
  if (db.getPageContentHash(slug) !== hashContent(raw)) reasons.push("index_pending_or_dirty");

  // Read-side selection sanity: nonempty, distinct, compiler-bounded. Reads do
  // NOT enforce the creation minimum — a legitimate refresh may retain fewer.
  // An invalid list fails BEFORE any source record is resolved (zero source
  // lookups) — a corrupt/oversized selection must never pay for, or partially
  // trust, per-source verification.
  const selected = manifest.sources.map((m) => m.slug);
  const selectionInvalid =
    selected.length === 0
    || new Set(selected).size !== selected.length
    || selected.length > budgets.maxSourcesPerTopic;
  if (selectionInvalid) {
    return {
      verification: {
        slug,
        state: "stale",
        current: false,
        editedByUser,
        generatedAt: manifest.generated_at,
        reasons: [...reasons, "manifest_selection_invalid"],
        sources: [],
        catalogAttested: typeof manifest.catalog === "string",
        catalogChanged: false,
      },
      manifest,
      raw,
      body,
      title: row.title,
    };
  }

  // Request reads reject a stale catalog before touching source files.
  // Maintenance still verifies sources independently for reattestation.
  const catalogAttested = typeof manifest.catalog === "string";
  const catalogChanged = catalogAttested && manifest.catalog !== (deps.catalog ?? computeCatalogFingerprint(db));
  const skipSources = !!deps.readRaw && (!catalogAttested || catalogChanged);
  const sources = skipSources ? [] : manifest.sources.map((m): { slug: string; ok: boolean; reason?: string } => {
    let reason: string | undefined;
    try {
      const snapshot = readRecordSource(db, vaultPath, m.slug, budgets, deps.readRaw);
      if (snapshot.disqualified) reason = `source_governance_rejected:${m.slug}`;
      else if (snapshot.contentHash !== m.content_hash) reason = `source_hash_changed:${m.slug}`;
      else if (snapshot.governanceHash !== m.governance_hash) reason = `source_governance_changed:${m.slug}`;
    } catch (e) {
      if (e instanceof TopicSourceReadError) {
        if (e.code === "not_found") reason = `source_missing:${m.slug}`;
        else if (e.code === "not_record") reason = `source_type_changed:${m.slug}`;
        else reason = `source_unreadable:${m.slug}:${e.code}`;
      } else {
        throw e;
      }
    }
    if (reason) reasons.push(reason);
    return { slug: m.slug, ok: !reason, ...(reason ? { reason } : {}) };
  });

  // Catalog attestation: READS require proof — a MISSING attestation is not a
  // matching proof and fails closed exactly like a mismatch (legacy/seeded
  // pages stay blocked until maintenance reattests, which is metadata-only,
  // no model). `state` keeps Task 1 source-only semantics for maintenance
  // eligibility and never reflects the catalog dimension.
  const freshWithoutCatalog = !skipSources && reasons.length === 0;
  if (!catalogAttested) reasons.push("catalog_missing");
  else if (catalogChanged) reasons.push("catalog_changed");

  const verification: TopicReadVerification = {
    slug,
    state: freshWithoutCatalog ? "fresh" : "stale",
    current: freshWithoutCatalog && catalogAttested && !catalogChanged,
    editedByUser,
    generatedAt: manifest.generated_at,
    reasons,
    sources,
    catalogAttested,
    catalogChanged,
  };
  return { verification, manifest, raw, body, title: row.title };
}

/** Full read verification for a topic row; null when the slug is not a topic. */
export function verifyTopicForRead(deps: TopicReadDeps, slug: string): TopicReadVerification | null {
  return inspectTopicRead(deps, slug)?.verification ?? null;
}

/** Verified snapshot of a CURRENT topic; null when not a topic or not current. */
export function readCurrentTopic(deps: TopicReadDeps, slug: string): TopicReadSnapshot | null {
  const read = inspectTopicRead(deps, slug);
  if (!read || !read.verification.current) return null;
  return {
    slug,
    title: read.title,
    generatedAt: read.manifest.generated_at,
    sourceSlugs: read.manifest.sources.map((m) => m.slug),
    raw: read.raw,
    body: read.body,
  };
}

/** Narrow admission seam handed to search/read surfaces. Constructed from
 *  db+vaultPath only — never model/pipeline state. */
export interface TopicReadAdmission {
  inspectTopic(slug: string): Promise<TopicReadVerification | null>;
  isCurrentTopic(slug: string): Promise<boolean>;
  readCurrentTopic(slug: string): Promise<TopicReadSnapshot | null>;
  /** Share one bounded, verified snapshot across search and hydration only. */
  withRequest<T>(read: () => Promise<T>): Promise<T>;
}

interface ReadRequest {
  revision: string;
  catalog?: string;
  deadline?: number;
  reads: Map<string, Promise<TopicReadInspection | null>>;
}

export function createTopicReadAdmission(deps: TopicReadDeps): TopicReadAdmission {
  const requests = new AsyncLocalStorage<ReadRequest>();
  // Keep stalled filesystem calls from consuming the server's entire IO pool.
  // This tracks in-flight operations only, never caches cross-request bytes.
  const pendingIO = new Set<Promise<string>>();
  const waiters = new Set<() => void>();
  // Includes same-connection writes and commits by other connections. Any DB
  // mutation (including timeline/governance) invalidates request-local proof.
  const revision = () => JSON.stringify(deps.db.rawDb.prepare("SELECT total_changes(), data_version FROM pragma_data_version").get());
  const withRequest = async <T>(read: () => Promise<T>): Promise<T> => {
    if (requests.getStore()) return read();
    return requests.run({ revision: revision(), reads: new Map() }, read);
  };
  const inspect = (slug: string): Promise<TopicReadInspection | null> => withRequest(async () => {
    const scope = requests.getStore()!;
    const currentRevision = revision();
    if (scope.revision !== currentRevision) {
      scope.reads.clear();
      scope.catalog = undefined;
      scope.revision = currentRevision;
    }
    let pending = scope.reads.get(slug);
    if (!pending) {
      pending = load(slug, scope);
      scope.reads.set(slug, pending);
    }
    const result = await pending;
    // Never expose a result verified across a concurrent DB mutation.
    if (revision() !== currentRevision) return null;
    return result;
  });
  const load = async (slug: string, scope: ReadRequest): Promise<TopicReadInspection | null> => {
    const row = deps.db.getPage(slug);
    if (!isTopicRow(row)) return null;
    const bytes = new Map<string, string | Error>();
    const getRaw = (path: string): string => {
      const value = bytes.get(path);
      if (typeof value === "string") return value;
      throw value ?? new Error("topic_read_unavailable");
    };
    // The deadline covers path resolution AND file reads, across all sources
    // and topics in this request. A stalled OS read cannot block the event loop
    // or extend the request; late bytes never become a verified snapshot.
    const read = async (path: string) => {
      scope.deadline ??= Date.now() + 2000;
      const remaining = scope.deadline - Date.now();
      if (remaining <= 0) { bytes.set(path, new Error("topic_read_timeout")); return; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const io = async () => {
          while (pendingIO.size >= 2) {
            await new Promise<void>((resolveSlot, rejectSlot) => {
              const wake = () => { controller.signal.removeEventListener("abort", abort); resolveSlot(); };
              const abort = () => { waiters.delete(wake); rejectSlot(new Error("topic_read_timeout")); };
              waiters.add(wake);
              controller.signal.addEventListener("abort", abort, { once: true });
            });
            controller.signal.throwIfAborted();
          }
          controller.signal.throwIfAborted();
          const operation = (async () => {
            if (!path || path.startsWith("..") || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
              throw new TopicSourceReadError("path_unsafe", path);
            }
            const root = await realpath(deps.vaultPath);
            controller.signal.throwIfAborted();
            const full = await realpath(resolve(deps.vaultPath, path));
            controller.signal.throwIfAborted();
            if (full !== root && !full.startsWith(root + sep)) throw new TopicSourceReadError("path_unsafe", path);
            const info = await stat(full);
            controller.signal.throwIfAborted();
            if (!info.isFile()) throw new Error("topic_file_not_regular");
            // Do not release the slot merely because the caller's timer fired:
            // readFile AbortSignal may reject while an OS syscall still waits.
            return readFile(full, { encoding: "utf-8" });
          })();
          pendingIO.add(operation);
          const release = () => {
            pendingIO.delete(operation);
            for (const wake of waiters) { waiters.delete(wake); wake(); }
          };
          operation.then(release, release);
          return operation;
        };
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("topic_read_timeout")); }, remaining);
        });
        bytes.set(path, await Promise.race([io(), timeout]));
      } catch (error) {
        bytes.set(path, error instanceof Error ? error : new Error("topic_read_unavailable"));
      } finally {
        clearTimeout(timer);
      }
    };
    await read(row!.file_path!);
    const raw = bytes.get(row!.file_path!);
    if (typeof raw === "string") {
      const parsed = parseTopicManifest(parseFrontmatter(raw).frontmatter.topic);
      const budgets = deps.budgets ?? DEFAULT_TOPIC_BUDGETS;
      scope.catalog ??= computeCatalogFingerprint(deps.db);
      if (parsed?.ok && parsed.manifest.catalog === scope.catalog
        && parsed.manifest.sources.length > 0 && parsed.manifest.sources.length <= budgets.maxSourcesPerTopic
        && new Set(parsed.manifest.sources.map((s) => s.slug)).size === parsed.manifest.sources.length) {
        for (const source of parsed.manifest.sources) {
          const path = deps.db.getPageFilePath(source.slug);
          if (path && !bytes.has(path)) await read(path);
        }
      }
    }
    try {
      return inspectTopicRead({ ...deps, readRaw: getRaw, catalog: scope.catalog }, slug);
    } catch {
      return null; // unavailable source bytes cannot admit a derived page
    }
  };
  return {
    withRequest,
    inspectTopic: async (slug) => (await inspect(slug))?.verification ?? null,
    isCurrentTopic: async (slug) => (await inspect(slug))?.verification.current === true,
    readCurrentTopic: async (slug) => {
      const result = await inspect(slug);
      if (!result?.verification.current) return null;
      return { slug, title: result.title, generatedAt: result.manifest.generated_at,
        sourceSlugs: result.manifest.sources.map((s) => s.slug), raw: result.raw, body: result.body };
    },
  };
}

// ─── DB record catalog fingerprint (#510 Task 2, moved here for #511) ─────
// Conservative MEMBERSHIP signal computed from DB metadata only — no
// directory scan per query. Read freshness compares the attested fingerprint
// against this value; maintenance re-derives it for reattestation. Same
// count/max(updated_at) is deliberately NOT enough: slug/file_path/
// content_hash plus the tags, active link rows and provenance that affect
// source membership are all hashed, in a stable canonical form.

export function computeCatalogFingerprint(db: CBrainDB): string {
  const records = db.rawDb.prepare(
    `SELECT p.slug, p.file_path, p.content_hash
     FROM pages p WHERE p.type = 'record' ORDER BY p.slug`
  ).all() as Array<{ slug: string; file_path: string; content_hash: string | null }>;

  const tags = db.rawDb.prepare(
    `SELECT t.page_slug, t.tag FROM tags t
     JOIN pages p ON p.slug = t.page_slug AND p.type = 'record'
     ORDER BY t.page_slug, t.tag`
  ).all() as Array<{ page_slug: string; tag: string }>;

  // Active links touching any record (endpoint OR provenance origin).
  // Uncorrelated membership sets avoid scanning all records for each link;
  // retain identical rows/order so existing persisted attestations still match.
  const links = db.rawDb.prepare(
    `SELECT l.id, l.from_slug, l.to_slug, l.relation, l.trust_state, l.source_page_slug
     FROM links l
     WHERE (
       l.from_slug IN (SELECT slug FROM pages WHERE type = 'record')
       OR l.to_slug IN (SELECT slug FROM pages WHERE type = 'record')
       OR l.source_page_slug IN (SELECT slug FROM pages WHERE type = 'record')
     )
     AND (l.trust_state IS NULL OR l.trust_state NOT IN ('rejected','superseded'))
     ORDER BY l.id`
  ).all() as Array<{ id: number; from_slug: string; to_slug: string; relation: string; trust_state: string | null; source_page_slug: string | null }>;

  const provenance = db.rawDb.prepare(
    `SELECT pwp.page_slug, pwp.write_mode, pwp.actor_class, pwp.creation_reason, pwp.origin_kind, pwp.origin_ref
     FROM page_write_provenance pwp
     JOIN pages p ON p.slug = pwp.page_slug AND p.type = 'record'
     ORDER BY pwp.page_slug`
  ).all() as Array<{ page_slug: string; write_mode: string; actor_class: string; creation_reason: string; origin_kind: string | null; origin_ref: string | null }>;

  return governanceFingerprint({
    records,
    tags,
    links,
    provenance,
  });
}
