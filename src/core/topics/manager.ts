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
import { computeCatalogFingerprint, verifyTopicForRead } from "./read.js";
import { buildManifest, parseTopicManifest, withManifestCatalog, withManifestState } from "./manifest.js";
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

/** Pre-mutation index snapshot for provider-independent rollback. L1 rows
 *  are intentionally not captured: nonempty pipeline writes preserve them. */
interface IndexSnapshot {
  raw: string;
  chunks: Array<{ chunkIndex: number; content: string }>;
  vectors: RawVectorRow[];
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
   *
   * #511: delegates to the shared provider-independent read verification
   * (src/core/topics/read.ts) so maintenance and every read surface agree on
   * ONE set of verification facts. `state` deliberately keeps Task 1
   * semantics — the catalog attestation mismatch is reported separately
   * (catalogAttested/catalogChanged) so a sole catalog change stays eligible
   * for the metadata-only reattestation instead of LLM regeneration.
   */
  inspectFreshness(topicSlug: string): TopicFreshnessReport | null {
    const v = verifyTopicForRead(
      { db: this.db, vaultPath: this.pages.vaultPath, budgets: this.budgets },
      topicSlug,
    );
    if (!v) return null;
    return {
      slug: v.slug,
      state: v.state,
      generatedAt: v.generatedAt,
      editedByUser: v.editedByUser,
      // Catalog attestation is NOT a per-source staleness reason: it rides in
      // the dedicated fields so Task 1 reason semantics stay byte-stable.
      reasons: v.reasons.filter((r) => r !== "catalog_missing" && r !== "catalog_changed"),
      sources: v.sources,
      ...(v.catalogAttested ? { catalogAttested: true } : {}),
      ...(v.catalogChanged ? { catalogChanged: true } : {}),
    };
  }

  /**
   * #510 Task 2: read an existing topic page's manifest. Returns null when
   * the slug is not a topic page (or its file is unreadable); `manifest` is
   * null when present but unusable (unmanaged / corrupt). Maintenance uses
   * this for seed identity and catalog attestation without touching the
   * private raw-reader.
   */
  readTopicManifest(topicSlug: string): { manifest: TopicManifest; raw: string } | { manifest: null; raw: null } | null {
    const read = this.readTopicPageRaw(topicSlug);
    if (!read) return null;
    const parsed = parseTopicManifest(read.manifest);
    if (!parsed || !parsed.ok) return { manifest: null, raw: null };
    return { manifest: parsed.manifest, raw: read.raw };
  }

  /**
   * #510 Task 2: metadata-only catalog reattestation. When the DB record
   * catalog changed but this topic's chosen inputs did not (selection and
   * per-source content/governance fingerprints identical, body unedited,
   * publication committed, index completion proven), rewrite ONLY the
   * manifest's catalog field and re-commit the content hash — no model, no
   * reindex (the indexed body is untouched), same synchronous no-await
   * discipline as the compile's final publication flip.
   */
  reattestCatalog(
    topicSlug: string,
    catalogFingerprint: string,
  ): { status: "unchanged" | "reattested" | "ineligible"; reason?: string } | null {
    const read = this.readTopicManifest(topicSlug);
    if (!read || !read.manifest) return null;
    const manifest = read.manifest;
    const raw = read.raw;
    const ineligible = (reason: string): { status: "ineligible"; reason: string } => ({ status: "ineligible", reason });

    if (manifest.catalog === catalogFingerprint) return { status: "unchanged" };
    if (manifest.state !== "committed") return ineligible("publication_pending");
    if (hashContent(parseFrontmatter(raw).body) !== manifest.output_hash) return ineligible("target_edited");
    if (this.db.getPageContentHash(topicSlug) !== hashContent(raw)) return ineligible("index_pending_or_dirty");
    for (const m of manifest.sources) {
      if (
        sourceFingerprintMismatch(
          this.db,
          this.pages.vaultPath,
          m.slug,
          { contentHash: m.content_hash, governanceHash: m.governance_hash },
          this.budgets,
        ) !== null
      ) {
        return ineligible(`source_changed:${m.slug}`);
      }
    }

    const absPath = this.db.getPageFilePath(topicSlug);
    if (!absPath) return ineligible("no_file_path");
    try {
      const finalRaw = withManifestCatalog(raw, catalogFingerprint);
      writeFileSync(resolveWithinVault(this.pages.vaultPath, absPath), finalRaw);
      this.db.updatePageHash(topicSlug, hashContent(finalRaw));
    } catch (e) {
      this.logger?.error("topic", "主题页 catalog 重证明失败", { slug: topicSlug, error: String(e) });
      return ineligible("reattest_write_failed");
    }
    return { status: "reattested" };
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

    // #511: reads require a catalog attestation, so a NEW topic always gets
    // one — an explicit fingerprint (Task 2 maintenance) wins, otherwise the
    // current record catalog is captured at compile start. This is a read
    // PROOF, never a validation relaxation: a legacy page without an
    // attestation stays read-blocked until maintenance reattests it.
    const catalogFingerprint = request.catalogFingerprint ?? computeCatalogFingerprint(this.db);

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
    // target, a COMMITTED publication state and a committed content hash
    // proving indexes are complete — a pending or dirty topic falls through
    // to a full refresh instead of skipping publication/index repair.
    if (
      isExistingTopic
      && previousManifest
      && dropped.length === 0
      && previousManifest.state === "committed"
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
    const body = renderTopicBody(parsed.output, usable.map((s) => ({ slug: s.slug, filePath: s.filePath })));
    const generatedAt = new Date().toISOString();
    const manifest = buildManifest({
      title,
      generatedAt,
      outputHash: hashContent(body),
      snapshots: usable,
      previous: previousManifest,
      ...(request.seed ? { seed: request.seed } : {}),
      catalogFingerprint,
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
      };
    }

    // Cancellation landing inside the snapshot awaits must precede the
    // synchronous recheck and every mutation below (version snapshot
    // included) — a cancelled job never writes the old page.
    this.throwIfCancelled(request);

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

    // ── Final publication flip — fully synchronous, LAST ────────────
    // Distinguish "index complete" (pipeline clean hash, visible the moment
    // writeIndexes resolves) from "compile passed its final publication
    // checks": the manifest state flips to committed only here, so no
    // microtask window between the two can read the topic as fresh. Only
    // the frontmatter changes — the body stays exactly the indexed bytes,
    // so indexed body consistency is retained. The content hash is
    // re-committed for the final bytes; if that DB write fails the page
    // stays determinately not-fresh (hash mismatch) until the next
    // refresh — no compensation touches an indexed, verified page.
    try {
      const finalRaw = withManifestState(current.raw, "committed");
      writeFileSync(absPath, finalRaw);
      this.db.updatePageHash(slug, hashContent(finalRaw));
    } catch (finalizeError) {
      this.logger?.error("topic", "主题页发布标记写入失败", { slug, error: String(finalizeError) });
      throw new Error(`TOPIC_FINALIZE_INCOMPLETE: ${slug}`);
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
   * fresh).
   *
   * There is exactly ONE index path: the pre-mutation snapshot is replayed
   * through the SAME serialized ContentPipeline.writeIndexes queue as every
   * other writer, with the snapshot's own vectors as prepared embedResults —
   * the embedding provider is never called for rollback, no parallel
   * SQLite/FTS/Lance restore exists, and L1 rows ride the existing pipeline
   * contract (nonempty writes preserve them). The pipeline's content-hash
   * gate decides cleanliness, so the old snapshot hash is never marked
   * clean after another writer took ownership. Vector cleanup for a failed
   * NEW page also goes through the queue (empty-chunk write) BEFORE the
   * synchronous page/DB removal, so an unqueued delete can never race a
   * same-slug re-creation; ownership is re-checked after the await and a
   * taken-over page is preserved and reported incomplete.
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

    const failIncomplete = (reason: string): TopicRollbackError => {
      // Explicit invalid state: never leave a half-restored page readable
      // as current.
      try { this.db.updatePageHash(slug, null); } catch { /* best effort; the error carries it */ }
      return new TopicRollbackError(originalError, [new Error(reason)]);
    };

    if (created) {
      // 1. Clear our failed vectors through the serialized queue (empty
      //    chunks = the pipeline's own empty-index semantics).
      try {
        await this.pipeline.writeIndexes(slug, [], []);
      } catch (e) {
        throw failIncomplete(`TOPIC_CLEANUP_INDEX_FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
      // 2. Ownership re-check AFTER the await: if a concurrent writer took
      //    the page over, preserve their page/bytes and report incomplete —
      //    never delete a new owner's page or DB row.
      const now = this.readTopicPageRaw(slug);
      if (!now || now.raw !== writtenRaw) {
        throw failIncomplete("TOPIC_CLEANUP_TAKEN_OVER: page preserved, left dirty");
      }
      const filePath = this.db.getPageFilePath(slug) ?? `${slug}.md`;
      try {
        unlinkSync(join(this.pages.vaultPath, filePath));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw failIncomplete(`TOPIC_CLEANUP_UNLINK_FAILED: ${error.message}`);
        }
      }
      try {
        this.db.deletePageCascaded(slug);
      } catch (e) {
        throw failIncomplete(`TOPIC_CLEANUP_DB_FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (!indexSnapshot) return;

    // The entry CAS still owns these bytes. Recover Markdown even if the
    // old index snapshot is incomplete; failed index recovery stays dirty.
    try {
      writeFileSync(resolveWithinVault(this.pages.vaultPath, this.db.getPageFilePath(slug)!), indexSnapshot.raw);
    } catch (e) {
      throw failIncomplete(`TOPIC_RESTORE_FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Snapshot correspondence must be provable BEFORE index replay: chunks
    // and vectors have to pair 1:1 by chunkIndex + content, otherwise the
    // restore cannot be trusted — leave the bytes dirty and report
    // incomplete.
    const orderedChunks = [...indexSnapshot.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const provable = orderedChunks.length === indexSnapshot.vectors.length
      && orderedChunks.every(
        (c, i) => indexSnapshot.vectors[i].chunkIndex === c.chunkIndex
          && indexSnapshot.vectors[i].content === c.content,
      );
    if (!provable) {
      throw failIncomplete("TOPIC_SNAPSHOT_MISMATCH: snapshot chunks/vectors do not correspond");
    }

    // Restore our owned old bytes synchronously, then immediately enqueue
    // the ONE serialized index path with the snapshot's chunks and its own
    // vectors as prepared embedResults (tokenCount 0 — no provider call).
    // commitIndexedFileHash decides the final hash from the actual file
    // bytes, so a concurrent user write landing in the queue after ours
    // still wins, and our restored hash only commits when the file still
    // holds the restored bytes.
    try {
      await this.pipeline.writeIndexes(
        slug,
        orderedChunks.map((c) => ({ index: c.chunkIndex, content: c.content })),
        indexSnapshot.vectors.map((v) => ({ embedding: Array.from(v.vector), tokenCount: 0 })),
      );
    } catch (e) {
      throw failIncomplete(`TOPIC_RESTORE_FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
