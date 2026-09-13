import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "../ingestion/pipeline.js";
import type { VersionManager } from "../version.js";
import type { LanceDBManager } from "../../storage/lancedb.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { Logger } from "../logger.js";
import { generateSlug } from "../../utils/slug.js";
import { hashContent } from "../shared.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import {
  readRecordSource,
  resolveWithinVault,
  sourceFingerprintMismatch,
} from "./source-reader.js";
import { buildManifest, parseTopicManifest } from "./manifest.js";
import { buildTopicPrompt, parseTopicModelOutput } from "./output.js";
import { renderTopicBody } from "./render.js";
import {
  DEFAULT_TOPIC_BUDGETS,
  TOPIC_PAGE_TYPE,
  TopicBlockReason,
  TopicBudgets,
  TopicCompileRequest,
  TopicCompileResult,
  TopicFreshnessReport,
  TopicIndexFailedError,
  TopicManifest,
  TopicManagerDeps,
  TopicRollbackError,
  TopicSourceCatalogEntry,
  TopicSourceReadError,
  TopicSourceSnapshot,
} from "./types.js";

const MAX_TITLE_CHARS = 120;

/**
 * TopicManager — bounded compiler for source-backed topic pages (#509 Task 1).
 *
 * Compiles an explicit title + source-slug selection into one derived
 * `topic` page under brain/topics/. Validity follows the sources: manifests
 * live in the page frontmatter, sources are re-read from disk (never the
 * PageManager cache) with path-boundary guards, and every model claim must
 * cite an exact excerpt of a selected current source. Model output is
 * untrusted: bounds are hard, fabricated quotes reject the whole output, and
 * claim kinds (observation/user_thought/candidate) stay labels — never trust
 * states.
 *
 * Safety contract:
 * - Embeddings are prepared BEFORE any mutation; source and target
 *   fingerprints are rechecked synchronously immediately before commit.
 * - Manual edits to the topic page block regeneration (never silently
 *   overwritten); version snapshots precede replacement; indexing failure
 *   compensates deterministically around the existing page/index APIs.
 * - Original records are never modified. Refresh may use fewer than three
 *   remaining sources, but zero valid sources blocks generation; sources
 *   that leave the selection are retired in the manifest, never dropped.
 */
export class TopicManager {
  private readonly db: CBrainDB;
  private readonly pages: PageManager;
  private readonly pipeline: ContentPipeline;
  private readonly versions: VersionManager;
  private readonly lance: LanceDBManager;
  private readonly llm: LLMProvider;
  private readonly logger: Logger | null;
  private readonly budgets: TopicBudgets;

  constructor(deps: TopicManagerDeps) {
    this.db = deps.db;
    this.pages = deps.pages;
    this.pipeline = deps.pipeline;
    this.versions = deps.versions;
    this.lance = deps.lance;
    this.llm = deps.llm;
    this.logger = deps.logger ?? null;
    this.budgets = { ...DEFAULT_TOPIC_BUDGETS, ...(deps.budgets ?? {}) };
  }

  /** Canonical slug a topic with this title would occupy (no writes). */
  resolveTopicSlug(title: string): string {
    return generateSlug(title, TOPIC_PAGE_TYPE);
  }

  /**
   * Read-only catalog of eligible original-record sources: every `record`
   * page with its on-disk content hash, tags, provenance and active
   * link/timeline counts. Derived pages (entity/concept/insight/topic) are
   * never listed — generated material cannot be a source.
   */
  listSourceCatalog(): TopicSourceCatalogEntry[] {
    const slugs = this.db.listPageSlugs({ type: "record" });
    const tagsBySlug = this.db.batchGetTagsForSlugs(slugs);
    const timelineBySlug = this.db.batchGetTimelineForSlugs(slugs);

    return slugs.flatMap((slug) => {
      const row = this.db.getPage(slug);
      if (!row || !row.file_path) return [];

      let contentHash = "";
      let bodyChars = 0;
      try {
        const raw = readFileSync(resolveWithinVault(this.pages.vaultPath, row.file_path), "utf-8");
        contentHash = hashContent(raw);
        bodyChars = parseFrontmatter(raw).body.length;
      } catch {
        // Unreadable file: list the row with an empty hash rather than
        // hiding a broken source from the catalog.
      }

      const provenance = this.db.getPageWriteProvenance(slug);
      return [{
        slug,
        title: row.title,
        updatedAt: row.updated_at,
        contentHash,
        bodyChars,
        tags: tagsBySlug.get(slug) ?? [],
        actorClass: provenance?.actor_class ?? null,
        originKind: provenance?.origin_kind ?? null,
        activeLinks: this.db.getOutgoingLinks(slug).length + this.db.getIncomingLinks(slug).length,
        timelineEntries: (timelineBySlug.get(slug) ?? []).length,
      }];
    });
  }

  /**
   * Freshness inspection of an existing topic page. Pure disk/DB state —
   * works after restart, no in-memory invalidation. Returns null when the
   * slug is not a topic page.
   */
  inspectFreshness(topicSlug: string): TopicFreshnessReport | null {
    const row = this.db.getPage(topicSlug);
    if (!row || row.type !== TOPIC_PAGE_TYPE) return null;

    const invalid: TopicFreshnessReport = {
      slug: topicSlug,
      state: "invalid",
      generatedAt: null,
      editedByUser: false,
      reasons: [],
      sources: [],
    };

    const read = this.readTopicPageRaw(topicSlug);
    if (!read) return { ...invalid, reasons: ["topic_file_unreadable"] };

    const manifestResult = parseTopicManifest(read.manifest);
    if (manifestResult === null) return { ...invalid, reasons: ["manifest_missing"] };
    if (!manifestResult.ok) return { ...invalid, reasons: ["manifest_invalid"] };
    const manifest = manifestResult.manifest;

    const reasons: string[] = [];
    const editedByUser = hashContent(read.body) !== manifest.output_hash;
    if (editedByUser) reasons.push("target_edited");

    const sources = manifest.sources.map((m): { slug: string; ok: boolean; reason?: string } => {
      const current = this.db.getPage(m.slug);
      let reason: string | undefined;
      if (!current) reason = `source_missing:${m.slug}`;
      else if (current.type !== "record") reason = `source_type_changed:${m.slug}`;
      else {
        const mismatch = sourceFingerprintMismatch(
          this.db,
          this.pages.vaultPath,
          m.slug,
          { contentHash: m.content_hash, governanceHash: m.governance_hash },
          this.budgets,
        );
        if (mismatch === "content") reason = `source_hash_changed:${m.slug}`;
        else if (mismatch === "governance") reason = `source_governance_changed:${m.slug}`;
        else if (mismatch) reason = `source_unreadable:${m.slug}:${mismatch}`;
      }
      if (reason) reasons.push(reason);
      return { slug: m.slug, ok: !reason, ...(reason ? { reason } : {}) };
    });

    return {
      slug: topicSlug,
      state: reasons.length === 0 ? "fresh" : "stale",
      generatedAt: manifest.generated_at,
      editedByUser,
      reasons,
      sources,
    };
  }

  /**
   * Compile (create or refresh) one topic page from an explicit title and
   * source-slug selection. See the class doc for the safety contract.
   */
  async compile(request: TopicCompileRequest): Promise<TopicCompileResult> {
    const title = (request.title ?? "").trim();
    if (!title || title.length > MAX_TITLE_CHARS) {
      return this.blocked("invalid_title", `title length ${title.length}`);
    }

    const requested = request.sourceSlugs ?? [];
    if (!Array.isArray(requested) || requested.length === 0) {
      return this.blocked("too_few_sources", "no sources requested");
    }
    const distinct = [...new Set(requested)];
    if (distinct.length > this.budgets.maxSourcesPerTopic) {
      return this.blocked("too_many_sources", `${distinct.length} > ${this.budgets.maxSourcesPerTopic}`);
    }

    const slug = this.resolveTopicSlug(title);
    const existingRow = this.db.getPage(slug);
    const isExistingTopic = Boolean(existingRow && existingRow.type === TOPIC_PAGE_TYPE);
    if (existingRow && !isExistingTopic) {
      return this.blocked("title_conflict", `slug occupied by type ${existingRow.type}`, slug);
    }
    if (this.db.getPagesByExactTitle(title).some((p) => p.slug !== slug)) {
      return this.blocked("title_conflict", "another page holds this exact title", slug);
    }

    let previousManifest: TopicManifest | null = null;
    let existingRaw: string | null = null;
    let existingBody: string | null = null;
    if (isExistingTopic) {
      const read = this.readTopicPageRaw(slug);
      const manifestResult = read ? parseTopicManifest(read.manifest) : null;
      if (!read || !manifestResult || !manifestResult.ok) {
        return this.blocked("target_edited", "existing topic page has no usable manifest", slug);
      }
      previousManifest = manifestResult.manifest;
      if (hashContent(read.body) !== previousManifest.output_hash) {
        return this.blocked("target_edited", "topic body changed since last generation", slug);
      }
      existingRaw = read.raw;
      existingBody = read.body;
    }

    // Snapshot every requested source fresh from disk.
    const snapshots: TopicSourceSnapshot[] = [];
    const dropped: string[] = [];
    const invalid: Array<{ slug: string; code: TopicSourceReadError["code"] }> = [];
    for (const sourceSlug of distinct) {
      try {
        snapshots.push(readRecordSource(this.db, this.pages.vaultPath, sourceSlug, this.budgets));
      } catch (e) {
        if (e instanceof TopicSourceReadError) {
          invalid.push({ slug: sourceSlug, code: e.code });
          continue;
        }
        throw e;
      }
    }

    if (!isExistingTopic) {
      if (invalid.length > 0) {
        const first = invalid[0];
        return this.blocked(
          first.code === "not_found" ? "source_not_found" : "source_not_record",
          `${first.slug}:${first.code}`,
        );
      }
      if (snapshots.length < this.budgets.minNewTopicSources) {
        return this.blocked("too_few_sources", `${snapshots.length} < ${this.budgets.minNewTopicSources}`);
      }
    } else {
      for (const entry of invalid) dropped.push(entry.slug);
      if (snapshots.length === 0) {
        return this.blocked("zero_valid_sources", dropped.join(","), slug);
      }
    }

    // Unchanged no-op: identical selection, fingerprints and unedited target.
    if (isExistingTopic && previousManifest && this.selectionMatches(snapshots, previousManifest)) {
      return { status: "unchanged", slug };
    }

    const totalMaterialChars = snapshots.reduce(
      (n, s) => n + s.body.length + s.usableFacts.reduce((m, f) => m + f.text.length, 0),
      0,
    );
    if (totalMaterialChars > this.budgets.maxTotalMaterialChars) {
      return this.blocked("material_over_budget", `${totalMaterialChars} > ${this.budgets.maxTotalMaterialChars}`);
    }

    // ── Model work (nothing mutated yet) ────────────────────────────
    this.throwIfCancelled(request);
    const rawOutput = await this.llm.chat(
      buildTopicPrompt(title, snapshots),
      request.signal ? { signal: request.signal } : undefined,
    );
    this.throwIfCancelled(request);

    const parsed = parseTopicModelOutput(rawOutput, snapshots, this.budgets);
    if (!parsed.ok) {
      return this.blocked("output_invalid", parsed.reason, slug);
    }

    // ── Prepare output + embeddings BEFORE mutation ─────────────────
    const sourceSlugs = snapshots.map((s) => s.slug);
    const body = renderTopicBody(parsed.output, sourceSlugs);
    const generatedAt = new Date().toISOString();
    const manifest = buildManifest({
      title,
      generatedAt,
      outputHash: hashContent(body),
      snapshots,
      previous: previousManifest,
    });
    const { chunks, embedResults } = await this.pipeline.embed(body);
    this.throwIfCancelled(request);

    // ── Synchronous recheck, then commit (no awaits before the page write) ──
    for (const snapshot of snapshots) {
      const mismatch = sourceFingerprintMismatch(
        this.db,
        this.pages.vaultPath,
        snapshot.slug,
        { contentHash: snapshot.contentHash, governanceHash: snapshot.governanceHash },
        this.budgets,
      );
      if (mismatch) {
        return this.blocked("source_changed_during_compile", `${snapshot.slug}:${mismatch}`, slug);
      }
    }
    if (this.targetChangedSince(isExistingTopic, slug, existingRaw)) {
      return this.blocked("target_changed_during_compile", undefined, slug);
    }

    const created = !isExistingTopic;
    if (isExistingTopic) {
      if (this.versions.createVersion(slug) === null) {
        throw new Error(`TOPIC_VERSION_SNAPSHOT_FAILED: ${slug}`);
      }
      this.pages.update(slug, { body, extra: { topic: manifest, title } });
    } else {
      this.pages.create({
        title,
        type: TOPIC_PAGE_TYPE,
        body,
        slug,
        tags: ["topic", "auto-generated"],
        extra: { topic: manifest },
      });
    }

    try {
      await this.pipeline.writeIndexes(slug, chunks, embedResults);
    } catch (indexError) {
      await this.compensate(slug, created, existingBody, previousManifest, indexError);
      throw new TopicIndexFailedError(indexError);
    }

    this.logger?.info("topic", "主题页已编译", { slug, sources: snapshots.length, created });
    return created
      ? { status: "created", slug, sources: snapshots.length, chunks: chunks.length }
      : { status: "refreshed", slug, sources: snapshots.length, chunks: chunks.length, droppedSources: dropped };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private blocked(reason: TopicBlockReason, detail?: string, slug?: string): TopicCompileResult {
    return { status: "blocked", ...(slug ? { slug } : {}), reason, ...(detail ? { detail } : {}) };
  }

  private throwIfCancelled(request: TopicCompileRequest): void {
    request.checkCancelled?.();
    request.signal?.throwIfAborted();
  }

  private selectionMatches(snapshots: TopicSourceSnapshot[], manifest: TopicManifest): boolean {
    if (snapshots.length !== manifest.sources.length) return false;
    return snapshots.every((s) => {
      const m = manifest.sources.find((x) => x.slug === s.slug);
      return Boolean(m) && m!.content_hash === s.contentHash && m!.governance_hash === s.governanceHash;
    });
  }

  private targetChangedSince(isExistingTopic: boolean, slug: string, existingRaw: string | null): boolean {
    if (isExistingTopic) {
      const read = this.readTopicPageRaw(slug);
      return !read || read.raw !== existingRaw;
    }
    return Boolean(this.db.getPage(slug)) || existsSync(join(this.pages.vaultPath, `${slug}.md`));
  }

  private readTopicPageRaw(slug: string): { raw: string; body: string; manifest: unknown } | null {
    const row = this.db.getPage(slug);
    if (!row || row.type !== TOPIC_PAGE_TYPE || !row.file_path) return null;
    try {
      const raw = readFileSync(resolveWithinVault(this.pages.vaultPath, row.file_path), "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      return { raw, body, manifest: frontmatter.topic };
    } catch {
      return null;
    }
  }

  /**
   * Deterministic compensation for a failed index write, scoped to this one
   * page around the existing page/index APIs (no generic transaction
   * framework): a new page is fully removed; a replaced page gets its old
   * body/manifest back and its old indexes rebuilt. A compensation failure
   * surfaces as TopicRollbackError (manual repair required).
   */
  private async compensate(
    slug: string,
    created: boolean,
    oldBody: string | null,
    oldManifest: TopicManifest | null,
    originalError: unknown,
  ): Promise<void> {
    const errors: Error[] = [];
    if (created) {
      const filePath = this.db.getPageFilePath(slug) ?? `${slug}.md`;
      try {
        unlinkSync(join(this.pages.vaultPath, filePath));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
      }
      try {
        this.db.deletePageCascaded(slug);
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
      try {
        await this.lance.deleteByPageSlug(slug);
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    } else {
      try {
        this.pages.update(slug, { body: oldBody!, extra: { topic: oldManifest } });
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
      try {
        const { chunks, embedResults } = await this.pipeline.embed(oldBody!);
        await this.pipeline.writeIndexes(slug, chunks, embedResults);
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    }
    if (errors.length > 0) {
      throw new TopicRollbackError(originalError, errors);
    }
  }
}
