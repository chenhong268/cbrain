import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "../ingestion/pipeline.js";
import type { VersionManager } from "../version.js";
import type { LanceDBManager, RawVectorRow } from "../../storage/lancedb.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { Logger } from "../logger.js";
import { generateSlug } from "../../utils/slug.js";
import { hashContent } from "../shared.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { readRecordSource, resolveWithinVault, sourceFingerprintMismatch } from "./source-reader.js";
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

/** Pre-mutation index snapshot for provider-independent rollback. */
interface IndexSnapshot {
  raw: string;
  chunks: Array<{ chunkIndex: number; content: string }>;
  vectors: RawVectorRow[];
  l1: RawVectorRow[];
}

/**
 * TopicManager — bounded compiler for source-backed topic pages (#509 Task 1).
 *
 * Compiles an explicit title + source-slug selection into one derived
 * `topic` page under brain/topics/. Validity follows the sources: manifests
 * live in the page frontmatter, sources are re-read from disk (never the
 * PageManager cache) with path-boundary guards, and every model claim —
 * overview included — must cite an exact excerpt of a selected current
 * source. Model output is untrusted: bounds are hard, fabricated quotes
 * reject the whole output, and claim kinds stay labels, never trust states.
 *
 * Safety contract:
 * - Durable commit invariant: the topic page is written with a NULL
 *   content_hash (dirty) and only becomes "fresh" after indexing completed
 *   AND the committed DB content hash matches the exact bytes we wrote.
 *   Manifest/body presence alone is never proof of completion.
 * - Embeddings are prepared BEFORE mutation; source and target fingerprints
 *   are rechecked synchronously immediately before commit AND again after
 *   the index await. A concurrent user edit of the target is preserved
 *   byte-for-byte (never overwritten or removed); cancellation or a source
 *   change after indexing un-publishes via CAS-guarded compensation.
 * - Compensation is deterministic and provider-independent: old page bytes,
 *   chunks and vectors are snapshotted before mutation and restored without
 *   calling the embedding provider. Restore only happens when the target
 *   still holds our exact written bytes; a failed restore leaves an explicit
 *   dirty state and surfaces TopicRollbackError.
 * - Manual edits to the topic page block regeneration (never silently
 *   overwritten); version snapshots precede replacement. Original records
 *   are never modified. Refresh may use fewer than three remaining sources,
 *   but zero valid sources blocks generation; disqualified (rejected/
 *   superseded) sources are dropped and retired in the manifest — kept for
 *   recovery, never silently discarded.
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
   * page that passes the fail-closed eligibility check (DB type, fresh disk
   * frontmatter type, non-derived vault path, no disqualifying governance
   * row) with its on-disk content hash, tags, provenance and active
   * link/timeline counts. Derived pages (entity/concept/insight/topic) and
   * pages whose disk state contradicts the DB are never listed.
   */
  listSourceCatalog(): TopicSourceCatalogEntry[] {
    const slugs = this.db.listPageSlugs({ type: "record" });

    return slugs.flatMap((slug) => {
      let snapshot: TopicSourceSnapshot;
      try {
        snapshot = readRecordSource(this.db, this.pages.vaultPath, slug, this.budgets);
      } catch {
        // Ineligible or unreadable: a catalog entry claims eligibility, so
        // fail closed and omit rather than list a broken/derived source.
        return [];
      }
      if (snapshot.disqualified) return [];
      return [{
        slug,
        title: snapshot.title,
        updatedAt: this.db.getPage(slug)?.updated_at ?? "",
        contentHash: snapshot.contentHash,
        bodyChars: snapshot.body.length,
        tags: snapshot.governance.tags,
        actorClass: snapshot.governance.provenance?.actorClass ?? null,
        originKind: snapshot.governance.provenance?.originKind ?? null,
        activeLinks: snapshot.governance.links.filter((l) => l.active).length,
        timelineEntries: snapshot.governance.timeline.length,
      }];
    });
  }

  /**
   * Freshness inspection of an existing topic page. Pure disk/DB state —
   * works after restart, no in-memory invalidation. A topic is fresh ONLY
   * when: its body matches the manifest output hash, every source still
   * passes eligibility with identical content AND governance fingerprints,
   * and the committed DB content hash proves indexing completed for the
   * current bytes (dirty/null hash ⇒ index_pending_or_dirty). Returns null
   * when the slug is not a topic page.
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

    const committedHash = this.db.getPageContentHash(topicSlug);
    if (committedHash === null || committedHash !== hashContent(read.raw)) {
      reasons.push("index_pending_or_dirty");
    }

    const sources = manifest.sources.map((m): { slug: string; ok: boolean; reason?: string } => {
      let reason: string | undefined;
      try {
        const snapshot = readRecordSource(this.db, this.pages.vaultPath, m.slug, this.budgets);
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

    // A disqualifying (rejected/superseded) governance row makes the whole
    // source unusable: its raw body could restate a user correction.
    const usable = snapshots.filter((s) => !s.disqualified);
    const disqualifiedSlugs = snapshots.filter((s) => s.disqualified).map((s) => s.slug);

    if (!isExistingTopic) {
      if (invalid.length > 0) {
        const first = invalid[0];
        return this.blocked(
          first.code === "not_found" ? "source_not_found" : "source_not_record",
          `${first.slug}:${first.code}`,
        );
      }
      if (disqualifiedSlugs.length > 0) {
        return this.blocked("source_governance_rejected", disqualifiedSlugs.join(","), slug);
      }
      if (usable.length < this.budgets.minNewTopicSources) {
        return this.blocked("too_few_sources", `${usable.length} < ${this.budgets.minNewTopicSources}`);
      }
    } else {
      for (const entry of invalid) dropped.push(entry.slug);
      dropped.push(...disqualifiedSlugs);
      if (usable.length === 0) {
        return this.blocked("zero_valid_sources", dropped.join(","), slug);
      }
    }

    // Unchanged no-op: identical FULL selection, fingerprints, an unedited
    // target AND a committed content hash proving indexes are complete —
    // a dirty topic falls through to a full refresh instead of skipping
    // index repair.
    if (
      isExistingTopic
      && previousManifest
      && dropped.length === 0
      && this.selectionMatches(usable, previousManifest)
      && this.db.getPageContentHash(slug) === hashContent(existingRaw!)
    ) {
      return { status: "unchanged", slug };
    }

    const totalMaterialChars = usable.reduce(
      (n, s) => n + s.body.length + s.usableFacts.reduce((m, f) => m + f.text.length, 0),
      0,
    );
    if (totalMaterialChars > this.budgets.maxTotalMaterialChars) {
      return this.blocked("material_over_budget", `${totalMaterialChars} > ${this.budgets.maxTotalMaterialChars}`);
    }

    // ── Model work (nothing mutated yet) ────────────────────────────
    this.throwIfCancelled(request);
    const rawOutput = await this.llm.chat(
      buildTopicPrompt(title, usable),
      request.signal ? { signal: request.signal } : undefined,
    );
    this.throwIfCancelled(request);

    const parsed = parseTopicModelOutput(rawOutput, usable, this.budgets);
    if (!parsed.ok) {
      return this.blocked("output_invalid", parsed.reason, slug);
    }

    // ── Prepare output + embeddings BEFORE mutation ─────────────────
    const sourceSlugs = usable.map((s) => s.slug);
    const body = renderTopicBody(parsed.output, sourceSlugs);
    const generatedAt = new Date().toISOString();
    const manifest = buildManifest({
      title,
      generatedAt,
      outputHash: hashContent(body),
      snapshots: usable,
      previous: previousManifest,
    });
    const { chunks, embedResults } = await this.pipeline.embed(body);
    this.throwIfCancelled(request);

    // Snapshot pre-mutation index state for provider-independent rollback.
    let indexSnapshot: IndexSnapshot | null = null;
    if (isExistingTopic) {
      indexSnapshot = {
        raw: existingRaw!,
        chunks: this.db.getChunksByPage(slug).map((c) => ({ chunkIndex: c.chunk_index, content: c.content })),
        vectors: await this.lance.readRawVectorRows(slug),
        l1: await this.lance.readL1VectorRows(slug),
      };
    }

    // ── Synchronous recheck, then commit (no awaits before the page write) ──
    if (this.sourcesChanged(usable)) {
      return this.blocked("source_changed_during_compile", undefined, slug);
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

    // Durable not-fresh mark: only a verified index commit (content-hash
    // set back to the exact bytes we wrote) may make this page fresh again.
    // PageManager.create seeds a content hash at creation — null it so the
    // initial hash can never masquerade as index-completion proof.
    this.db.updatePageHash(slug, null);
    const absPath = resolveWithinVault(this.pages.vaultPath, this.db.getPageFilePath(slug)!);
    const writtenRaw = readFileSync(absPath, "utf-8");

    try {
      await this.pipeline.writeIndexes(slug, chunks, embedResults);
    } catch (indexError) {
      await this.compensateIndexFailure(slug, created, writtenRaw, indexSnapshot, indexError);
      throw new TopicIndexFailedError(indexError);
    }

    // ── Post-index revalidation — publication boundary ───────────────
    // Order matters: a concurrent user edit is checked FIRST and is always
    // preserved (no compensation may touch their bytes).
    const current = this.readTopicPageRaw(slug);
    if (!current || current.raw !== writtenRaw) {
      this.db.updatePageHash(slug, null);
      return this.blocked("target_changed_during_compile", "concurrent edit during indexing", slug);
    }
    try {
      this.throwIfCancelled(request);
    } catch (cancelError) {
      await this.compensateIndexFailure(slug, created, writtenRaw, indexSnapshot, cancelError);
      throw cancelError;
    }
    if (this.sourcesChanged(usable)) {
      await this.compensateIndexFailure(slug, created, writtenRaw, indexSnapshot, new Error("source changed during indexing"));
      return this.blocked("source_changed_during_compile", "source changed during indexing", slug);
    }
    if (this.db.getPageContentHash(slug) !== hashContent(writtenRaw)) {
      const proofError = new Error(`TOPIC_COMPLETION_PROOF_MISSING: ${slug}`);
      await this.compensateIndexFailure(slug, created, writtenRaw, indexSnapshot, proofError);
      throw new TopicIndexFailedError(proofError);
    }

    this.logger?.info("topic", "主题页已编译", { slug, sources: usable.length, created });
    return created
      ? { status: "created", slug, sources: usable.length, chunks: chunks.length }
      : { status: "refreshed", slug, sources: usable.length, chunks: chunks.length, droppedSources: dropped };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private blocked(reason: TopicBlockReason, detail?: string, slug?: string): TopicCompileResult {
    return { status: "blocked", ...(slug ? { slug } : {}), reason, ...(detail ? { detail } : {}) };
  }

  private throwIfCancelled(request: TopicCompileRequest): void {
    request.checkCancelled?.();
    request.signal?.throwIfAborted();
  }

  private sourcesChanged(snapshots: TopicSourceSnapshot[]): boolean {
    return snapshots.some((s) =>
      sourceFingerprintMismatch(
        this.db,
        this.pages.vaultPath,
        s.slug,
        { contentHash: s.contentHash, governanceHash: s.governanceHash },
        this.budgets,
      ) !== null,
    );
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
   * CAS-guarded, provider-independent compensation for a failed/unpublished
   * index commit — scoped to this one page around the existing page/index
   * APIs (no generic transaction framework). Restoration happens ONLY when
   * the target still holds our exact written bytes: a concurrent user edit
   * is preserved byte-for-byte and the page is left dirty (cannot read as
   * fresh). The restore replays the pre-mutation snapshot (old raw bytes,
   * chunks, vectors) and never calls the embedding provider. Any restore
   * failure leaves an explicit dirty state and surfaces TopicRollbackError.
   */
  private async compensateIndexFailure(
    slug: string,
    created: boolean,
    writtenRaw: string,
    indexSnapshot: IndexSnapshot | null,
    originalError: unknown,
  ): Promise<void> {
    const current = this.readTopicPageRaw(slug);
    if (created && !current) return; // already removed
    if (!current || current.raw !== writtenRaw) {
      // Target no longer ours (concurrent edit / another writer): preserve
      // their bytes, keep the page determinately not-fresh.
      this.db.updatePageHash(slug, null);
      return;
    }

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
    } else if (indexSnapshot) {
      // Exact-byte restore of the previous page (frontmatter extras, tags
      // and version history untouched), then replay the old indexes from
      // the snapshot — no embedding provider involved.
      try {
        writeFileSync(resolveWithinVault(this.pages.vaultPath, this.db.getPageFilePath(slug)!), indexSnapshot.raw);
        this.db.transaction(() => {
          this.db.deleteChunksByPage(slug);
          this.db.ftsDeleteByPage(slug);
          for (const chunk of indexSnapshot!.chunks) {
            this.db.insertChunk(slug, chunk.chunkIndex, chunk.content);
          }
          this.db.ftsInsert(
            slug,
            [...indexSnapshot!.chunks]
              .sort((a, b) => a.chunkIndex - b.chunkIndex)
              .map((c) => c.content)
              .join("\n\n"),
          );
        });
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
      try {
        await this.lance.deleteRawChunksByPageSlug(slug);
        await this.lance.deleteL1VectorByPageSlug(slug);
        const rows = [...indexSnapshot.vectors, ...indexSnapshot.l1].map((r) => ({
          pageSlug: slug,
          chunkIndex: r.chunkIndex,
          content: r.content,
          vector: r.vector,
        }));
        if (rows.length > 0) await this.lance.addChunks(rows);
        const restored = await this.lance.readRawVectorRows(slug);
        if (restored.length !== indexSnapshot.vectors.length) {
          throw new Error(`TOPIC_RESTORE_VERIFY_FAILED: ${restored.length} != ${indexSnapshot.vectors.length}`);
        }
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
      if (errors.length === 0) {
        // Restored snapshot is complete by construction; mark it clean so
        // freshness reflects reality again.
        try {
          this.db.updatePageHash(slug, hashContent(indexSnapshot.raw));
        } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
      }
    }
    if (errors.length > 0) {
      // Explicit invalid state: never leave a half-restored page readable
      // as current.
      try { this.db.updatePageHash(slug, null); } catch { /* best effort; rollback error below carries it */ }
      throw new TopicRollbackError(originalError, errors);
    }
  }
}
