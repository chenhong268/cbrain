import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB, type LinkRow } from "../../storage/sqlite.js";
import { PageManager } from "../page.js";
import { generateSlug, slugToFilePath, looksLikePath } from "../../utils/slug.js";
import { normalizePageType, normalizeAndHashBody, type PageType } from "../shared.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import type { EmbeddingProvider } from "../../embedding/provider.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { NerEngine, isNerTimeoutError } from "./ner.js";
import type { LLMProvider } from "../../llm/provider.js";
import { ContentPipeline, type NerPipelineResult } from "./pipeline.js";
import { filterExtractedEntities, type ExtractedEntity } from "./ner.js";
import { classifyContentType, hasSemanticContent } from "./content-classifier.js";
import { classifyPersonalTag } from "./personal-tag-classifier.js";
import type { DeferredNerSubmitter } from "./ner-backfill.js";
import {
  resolveNerAction,
  submitDeferredNerForWritePath,
  type NerAction,
  type NerMode,
} from "./ner-write-path.js";
import { extractEntityFacts } from "./entity-facts.js";
import { forIngest, type RecordWriterContext } from "../page-write-provenance.js";

export interface IngestManagerOptions {
  /** #252: default NER mode for this manager (config/env resolved upstream). Default "sync". */
  nerMode?: NerMode;
  /** #252: required when nerMode resolves to "defer"; else throws. */
  deferredNerSubmitter?: DeferredNerSubmitter;
}

/**
 * Thrown when an ingest operation fails AND the subsequent rollback
 * could not fully restore the system to a consistent state.
 * Callers (Hermes) must treat this as requiring manual reindex.
 */
export class IngestRollbackError extends Error {
  readonly originalError: Error;
  readonly rollbackErrors: Error[];

  constructor(originalError: Error, rollbackErrors: Error[]) {
    const rollbackDetails = rollbackErrors.map(e => e.message).join("; ");
    super(
      `INGEST_ROLLBACK_INCOMPLETE: original=${originalError.message}; rollback failures=[${rollbackDetails}]; reindex required`,
    );
    this.name = "IngestRollbackError";
    this.originalError = originalError;
    this.rollbackErrors = rollbackErrors;
  }
}

/** Snapshot of page state before mutation — used for rollback on downstream failure. */
interface PageSnapshot {
  body: string;
  tags: string[];
  mentionLinks: LinkRow[];
  ingestHash: string | null;
}

function takeSnapshot(slug: string, db: CBrainDB, pages: PageManager): PageSnapshot | null {
  const page = pages.getBySlug(slug);
  if (!page) return null;
  const links = db.getOutgoingLinks(slug, true)
    .filter(l => l.relation === "提及");
  const ingestHash = db.getPageIngestHash(slug);
  return { body: page.body, tags: [...(page.frontmatter.tags ?? [])], mentionLinks: links, ingestHash };
}

/** 仅用于 person 快捷路由的保守门控：明显组织/团队标签（包含匹配，覆盖中英文）。
 *  标签可能在候选名前（组织A）或后（区域组织），故用包含而非后缀匹配。
 *  窄范围——只用明显组织词，不引入模糊判断。 */
const ORG_LABEL = /(?:组织|机构|协会|研究院|团队|小组|部门|中心|委员会|项目组|公司|集团|\b(?:team|department|committee|company|group|organization|division|unit)\b)/i;
/** 仅用于 person 快捷路由的保守门控：明显英文职位标签。
 *  窄范围——只用 unambiguously 职位、不会作为人名出现的词；
 *  避开 head/lead/chief 等可能误伤姓名的词。 */
const ENGLISH_JOB_TITLE = /\b(?:manager|director|engineer|developer|designer|analyst|specialist|coordinator|administrator|consultant|representative|intern|officer|president|executive|architect|chairman)\b/i;

export interface IngestInput {
  content: string;
  type?: "markdown" | "text";
  title?: string;
  tags?: string[];
  pageType?: "record" | "insight";
  skipNer?: boolean;
  allowDuplicate?: boolean;
  /** #252: per-call override for this manager's default nerMode. */
  nerMode?: NerMode;
  /**
   * #386: who is performing this ingest. INTERNAL — set by the adapter layer
   * (MCP→agent, CLI→operator), never by an MCP caller. Mapped to record-page
   * creation provenance when a record page is created.
   */
  writer?: RecordWriterContext;
}

export type IngestOutcome = "created" | "updated" | "duplicate";

export interface IngestResult {
  slug: string;
  created: boolean;
  linksExtracted: number;
  ner?: NerPipelineResult | null;
  nerSkipped?: "timeout" | "error";
  /** #252: true when NER was deferred to a background job. */
  nerPending?: boolean;
  outcome: IngestOutcome;
  duplicateOf?: { slug: string; title: string };
}

export class IngestManager {
  private db: CBrainDB;
  private pages: PageManager;
  private lance: LanceDBManager;
  private nerEngine: NerEngine | null;
  private llmProvider: LLMProvider | undefined;
  private pipeline: ContentPipeline;
  private readonly defaultNerMode: NerMode;
  private readonly deferredNerSubmitter?: DeferredNerSubmitter;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    vaultPath: string,
    llmProvider?: LLMProvider,
    nerEngine?: NerEngine,
    opts?: IngestManagerOptions,
  ) {
    this.db = db;
    this.lance = lance;
    this.pages = new PageManager(db, vaultPath, undefined, lance);
    this.nerEngine = nerEngine ?? (llmProvider ? new NerEngine(llmProvider) : null);
    this.llmProvider = llmProvider;
    this.pipeline = new ContentPipeline(db, embedding, lance, {
      pages: this.pages,
      nerEngine: this.nerEngine ?? undefined,
    });
    this.defaultNerMode = opts?.nerMode ?? "sync";
    this.deferredNerSubmitter = opts?.deferredNerSubmitter;
    if (this.defaultNerMode === "defer" && !this.deferredNerSubmitter) {
      throw new Error("IngestManager: nerMode='defer' requires a deferredNerSubmitter");
    }
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const nerAction = resolveNerAction(input.skipNer, input.nerMode ?? this.defaultNerMode, this.deferredNerSubmitter);
    const type = input.type ?? classifyContentType(input.content);
    if (type === "markdown") {
      return this.ingestMarkdown(input.content, input, nerAction);
    }
    return this.ingestText(input, nerAction);
  }

  private async ingestMarkdown(
    content: string,
    input: IngestInput,
    nerAction: NerAction,
  ): Promise<IngestResult> {
    const parsed = parseFrontmatter(content);

    // (#198) Explicit caller/CLI title takes precedence over a stale frontmatter
    // title, so `ingest @file --title X` derives slug/title/file_path from X.
    const declaredTitle = input.title ?? parsed.frontmatter.title;
    const bodyTitle = parsed.body.split("\n").find(line => hasSemanticContent(line))?.trim().slice(0, 50);
    const title = hasSemanticContent(String(declaredTitle ?? "")) ? String(declaredTitle).trim() : bodyTitle;
    if (!title) {
      throw new Error("VALIDATION_ERROR: markdown has no semantic title or body content");
    }
    // (#190) Refuse path-like titles so a path can never become a page title or slug.
    if (looksLikePath(title)) {
      throw new Error("VALIDATION_ERROR: title looks like a filesystem path; refusing to ingest");
    }
    const type = normalizePageType(parsed.frontmatter.type ?? input.pageType ?? "record");
    const declaredSlug = typeof parsed.frontmatter.slug === "string" && parsed.frontmatter.slug ? parsed.frontmatter.slug : undefined;
    const slug = declaredSlug ?? generateSlug(title, type);

    // (#190) Idempotent no-op when this exact frontmatter slug already exists
    // (unless --allow-duplicate forces a re-index). Durable-source hash dedup only
    // covers record/insight, so entity/concept markdown needs this slug-level gate.
    if (declaredSlug && !input.allowDuplicate) {
      const existing = this.db.getPage(slug);
      if (existing) {
        return { slug, created: false, linksExtracted: 0, outcome: "duplicate", duplicateOf: { slug: existing.slug, title: existing.title } };
      }
      // (#190) Conservative: same entity/person title under a different slug → no-op
      // duplicate rather than creating a second person page.
      if (type === "entity/person") {
        const byTitle = this.db.getPageByTitle(title);
        if (byTitle && byTitle.type === "entity/person" && byTitle.slug !== slug) {
          return { slug: byTitle.slug, created: false, linksExtracted: 0, outcome: "duplicate", duplicateOf: { slug: byTitle.slug, title: byTitle.title } };
        }
      }
    }

    const body = parsed.body;
    const baseTags = parsed.frontmatter.tags ?? input.tags ?? [];
    // #236: classify against the stripped body + title; union personal into effective tags.
    const effectiveTags = classifyPersonalTag({ title, content: body, tags: baseTags })
      ? [...new Set([...baseTags, "personal"])]
      : baseTags;

    return this.ingestCore(slug, title, type, body, effectiveTags, nerAction, input.allowDuplicate, input.writer);
  }

  private async ingestText(input: IngestInput, nerAction: NerAction): Promise<IngestResult> {
    // Reject pure-punctuation / empty content before any file/DB write
    if (!hasSemanticContent(input.title ?? '') && !hasSemanticContent(input.content)) {
      throw new Error("VALIDATION_ERROR: content has no semantic content — provide a title or content with letters/numbers");
    }

    const rawTitle = input.title ?? input.content.split("\n").find(l => hasSemanticContent(l))?.trim().slice(0, 50) ?? "Untitled";
    // (#190) Refuse path-like titles (e.g. a path passed instead of @path) before slug generation.
    if (looksLikePath(rawTitle)) {
      throw new Error("VALIDATION_ERROR: title looks like a filesystem path; refusing to ingest");
    }
    const routedPersonTitle = this.inferPersonRelationshipTitle(input.content, input.title);
    const existingPersonSlug = this.findExistingPersonSlug(input.title ?? routedPersonTitle ?? rawTitle);

    // #236: classify personal memory before durable write. One effectiveTags value
    // covers BOTH branches (ingestEntityAppend + ingestCore) of the text path.
    const classifierTitle = input.title ?? routedPersonTitle ?? rawTitle;
    const baseTags = input.tags ?? [];
    const effectiveTags = classifyPersonalTag({ title: classifierTitle, content: input.content, tags: baseTags })
      ? [...new Set([...baseTags, "personal"])]
      : baseTags;

    if (existingPersonSlug) {
      return this.ingestEntityAppend(existingPersonSlug, input.content, effectiveTags, nerAction);
    }

    const title = routedPersonTitle ?? rawTitle;
    const type = normalizePageType(routedPersonTitle ? "entity/person" : input.pageType ?? "record");
    const slug = generateSlug(title, type);
    const body = input.content;

    return this.ingestCore(slug, title, type, body, effectiveTags, nerAction, input.allowDuplicate, input.writer);
  }

  private findExistingPersonSlug(title: string | undefined): string | null {
    if (!title) return null;
    const row = this.db.getPageByTitle(title.trim());
    if (!row || row.type !== "entity/person") return null;
    return row.slug;
  }

  private submitNerRecovery(input: {
    slug: string;
    pageType: string;
    contentHash?: string;
  }): boolean {
    if (!this.deferredNerSubmitter) return false;
    try {
      return submitDeferredNerForWritePath(this.deferredNerSubmitter, input);
    } catch {
      return false;
    }
  }

  private inferPersonRelationshipTitle(content: string, explicitTitle?: string): string | null {
    if (explicitTitle) return null;
    const firstLine = content.split("\n").find(l => l.trim())?.trim() ?? "";
    const match = firstLine.match(/^([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·.\s-]{1,20})[，,：:]\s*(.+)$/u);
    if (!match) return null;

    const name = match[1].trim();
    const description = match[2];
    if (!/[\p{Script=Han}A-Za-z]/u.test(name)) return null;
    if (!/(同事|同学|同门|朋友|学弟|学长|学姐|学妹|上级|下属|同僚|前任|现任|汇报|认识|合作|负责|任职|worked with|reports to|colleague|friend)/iu.test(description)) {
      return null;
    }

    // 保守门控：不确定就降级 record，绝不在图谱里误建 person。
    // 误漏一次自动路由只是少一次快捷操作（无害）；误建 person 会持续污染图谱（有害）。
    if (!this.passesPersonCandidateFilter(name, description)) return null;

    return name;
  }

  /** Person 快捷路由专属的保守门控。
   *  Gate-0: 同名已有页面直接以 DB 类型为准短路——person 放行走 append，其他类型降级，
   *          绝不覆盖/改型/合并已有实体。已确认 person 优先于任何启发式。
   *  Gate-1: 复用 NER 的 filterExtractedEntities（含既有 job-title / generic-term 过滤，不复制职位正则）。
   *  Gate-2: 仅本路由用：拒绝明显组织/团队标签 + 英文职位标签。
   *  任一失败返回 false → 调用方降级 record，保留完整内容走正常 NER。
   *  注：同名 person 不在此拦截——交回 findExistingPersonSlug 走 append，保持现有行为。 */
  private passesPersonCandidateFilter(name: string, description: string): boolean {
    const existing = this.db.getPageByTitle(name);
    if (existing) return existing.type === "entity/person";

    const candidate: ExtractedEntity = {
      name,
      type: "person",
      relevance: "high",
      context: description,
    };
    const { kept } = filterExtractedEntities([candidate]);
    if (!kept.some(e => e.name === name)) return false;

    if (ORG_LABEL.test(name)) return false;
    if (ENGLISH_JOB_TITLE.test(name)) return false;

    return true;
  }

  private async ingestEntityAppend(slug: string, body: string, tags: string[], nerAction: NerAction): Promise<IngestResult> {
    const before = this.pages.getBySlug(slug);
    if (!before) {
      throw new Error(`Cannot append to missing entity page: ${slug}`);
    }
    const snapshot = takeSnapshot(slug, this.db, this.pages);

    try {
      const page = this.pages.patch(slug, {
        body_append: body,
        tags_merge: tags,
      });
      if (!page) {
        throw new Error(`Cannot append to missing entity page: ${slug}`);
      }

      // Write indexes FIRST — main failure point before touching links/mention_count
      const { chunks, embedResults } = await this.pipeline.embed(page.body);
      await this.pipeline.writeIndexes(slug, chunks, embedResults);
      this.pipeline.writeIngestLog(slug, "api", { appended: true, chunks: chunks.length });

      // Now safe to modify links and mention_count
      const { count: linksExtracted, mentionedSlugs } = this.pipeline.replaceWikilinks(slug, page.body);

      let nerResult: NerPipelineResult | null = null;
      let nerSkipped: "timeout" | "error" | undefined;
      let nerPending = false;
      if (nerAction === "sync" && body.trim()) {
        try {
          nerResult = await this.pipeline.processNer(slug, body, before.type, true, undefined, mentionedSlugs);
        } catch (e) {
          nerSkipped = isNerTimeoutError(e) ? "timeout" : "error";
          nerPending = this.submitNerRecovery({ slug, pageType: before.type });
          this.pipeline.writeIngestLog(slug, "api", {
            nerError: nerSkipped === "timeout" ? "NER_TIMEOUT" : "NER_PROVIDER_ERROR",
            nerSkipped,
            nerRecoveryQueued: nerPending,
            appended: true,
          });
        }
      } else if (nerAction === "defer" && body.trim()) {
        // submitter guaranteed non-null by resolveNerAction fail-fast (defer ⇒ submitter wired)
        nerPending = submitDeferredNerForWritePath(this.deferredNerSubmitter!, { slug, pageType: before.type });
      }

      const nerResolvedSlugs = nerResult?.resolvedSlugs ?? [];
      const nerRelationSlugs = nerResult?.relationSlugs ?? [];
      this.recordSyncWarnings(
        slug,
        this.pages.syncAffectedSlugs([slug, ...mentionedSlugs, ...nerResolvedSlugs, ...nerRelationSlugs]),
      );

      return { slug, created: false, linksExtracted, ner: nerResult, nerSkipped, ...(nerPending ? { nerPending: true } : {}), outcome: "updated" as const };
    } catch (indexError) {
      if (snapshot) {
        await this.restoreSnapshot(slug, snapshot, indexError);
      }
      throw indexError;
    }
  }

  private async ingestCore(
    slug: string, title: string, type: PageType, body: string, tags: string[], nerAction: NerAction,
    allowDuplicate?: boolean, writer?: RecordWriterContext
  ): Promise<IngestResult> {
    // --- Dedup gate for durable source types (record / insight) ---
    let bodyHash: string | undefined;
    let overrideAudit: { matchedSlug: string; matchedHash: string } | null = null;
    const isDurableSource = type === "record" || type === "insight";

    if (isDurableSource) {
      bodyHash = normalizeAndHashBody(body);

      // Cross-slug: same body already exists under a different slug?
      const match = this.db.findDurableSourceByIngestHash(bodyHash);
      if (match && match.slug !== slug && !allowDuplicate) {
        return {
          slug,
          created: false,
          linksExtracted: 0,
          outcome: "duplicate",
          duplicateOf: { slug: match.slug, title: match.title },
        };
      }

      // Same-slug same-body: re-ingest is a no-op
      const existingHash = this.db.getPageIngestHash(slug);
      if (existingHash === bodyHash && !allowDuplicate) {
        const titleRow = this.db.getPageTitleAndType(slug);
        return {
          slug,
          created: false,
          linksExtracted: 0,
          outcome: "duplicate",
          duplicateOf: { slug, title: titleRow?.title ?? title },
        };
      }

      // Override audit: saved for post-commit logging (after all writes succeed)
      if (allowDuplicate && (match || existingHash === bodyHash)) {
        overrideAudit = { matchedSlug: match?.slug ?? slug, matchedHash: bodyHash };
      }
    }

    // --- Existing pipeline ---
    const { chunks, embedResults } = await this.pipeline.embed(body);

    const existedBefore = !!this.pages.getBySlug(slug);
    const snapshot = existedBefore ? takeSnapshot(slug, this.db, this.pages) : null;
    let createdThisAttempt = false;

    try {
      if (existedBefore) {
        this.pages.update(slug, { body, tags });
      } else {
        this.pages.create({ title, type, body, tags, slug, ...(writer ? { provenance: forIngest(writer) } : {}) });
        createdThisAttempt = true;
      }

      // Write indexes FIRST — the main failure point (LanceDB) must fail
      // before we touch links/mention_count in processWikilinks.
      await this.pipeline.writeIndexes(slug, chunks, embedResults);
      this.pipeline.writeIngestLog(slug, "api", { chunks: chunks.length });

      // Now safe to modify links and mention_count
      const { count: linksExtracted, mentionedSlugs } = this.pipeline.replaceWikilinks(slug, body);

      let nerResult: NerPipelineResult | null = null;
      let nerSkipped: "timeout" | "error" | undefined;
      let nerPending = false;
      const nerEligibleType = !type.startsWith("entity/") && !type.startsWith("concept/") && !type.startsWith("insight/");
      if (nerAction === "sync" && nerEligibleType) {
        try {
          nerResult = await this.pipeline.processNer(slug, body, type, true, undefined, mentionedSlugs);
        } catch (e) {
          nerSkipped = isNerTimeoutError(e) ? "timeout" : "error";
          nerPending = this.submitNerRecovery({
            slug,
            contentHash: bodyHash ?? undefined,
            pageType: type,
          });
          this.pipeline.writeIngestLog(slug, "api", {
            nerError: nerSkipped === "timeout" ? "NER_TIMEOUT" : "NER_PROVIDER_ERROR",
            nerSkipped,
            nerRecoveryQueued: nerPending,
          });
        }
      } else if (nerAction === "defer" && nerEligibleType) {
        // submitter guaranteed non-null by resolveNerAction fail-fast (defer ⇒ submitter wired)
        nerPending = submitDeferredNerForWritePath(this.deferredNerSubmitter!, { slug, contentHash: bodyHash ?? undefined, pageType: type });
      }

      // Entity facts share the same mode contract as regular NER: sync preserves
      // the existing behavior; defer records a durable job and never awaits LLM.
      if (type.startsWith("entity/") && body.trim()) {
        if (nerAction === "sync" && this.llmProvider) {
          try {
            await extractEntityFacts({ pages: this.pages, llm: this.llmProvider, slug, title, type, body });
          } catch {
            // Non-critical — skip silently
          }
        } else if (nerAction === "defer") {
          nerPending = submitDeferredNerForWritePath(this.deferredNerSubmitter!, {
            slug,
            pageType: type,
            kind: "entity_facts",
          });
        }
      }

      // Sync Known Relations for the ingested page and all mentioned/resolved entities
      const nerResolvedSlugs = nerResult?.resolvedSlugs ?? [];
      const nerRelationSlugs = nerResult?.relationSlugs ?? [];
      this.recordSyncWarnings(
        slug,
        this.pages.syncAffectedSlugs([slug, ...mentionedSlugs, ...nerResolvedSlugs, ...nerRelationSlugs]),
      );

      // Post-commit: store ingest hash for durable source types
      if (bodyHash) {
        this.db.updateIngestHash(slug, bodyHash);
      }

      // Post-commit: log override audit only after all writes succeed
      if (overrideAudit) {
        this.pipeline.writeIngestLog(slug, "api", { duplicateOverride: true, matchedSlug: overrideAudit.matchedSlug, matchedHash: overrideAudit.matchedHash });
      }

      return {
        slug,
        created: !existedBefore,
        linksExtracted,
        ner: nerResult,
        nerSkipped,
        ...(nerPending ? { nerPending: true } : {}),
        outcome: existedBefore ? "updated" : "created",
      };
    } catch (indexError) {
      if (createdThisAttempt) {
        // New page: narrow cleanup — vault file + DB cascade + LanceDB
        // cleanupNewPage throws IngestRollbackError if cleanup fails
        await this.cleanupNewPage(slug, indexError);
      } else if (snapshot) {
        // Existing page: restore to pre-update state + re-index old content
        // restoreSnapshot throws IngestRollbackError if restore fails
        await this.restoreSnapshot(slug, snapshot, indexError);
      }
      throw indexError;
    }
  }

  /** Narrow cleanup for a newly-created page that failed during indexing.
   *  Only removes this page's file, DB rows, and LanceDB vectors —
   *  does NOT touch other vault files (no dead-link rewrite).
   *  Throws IngestRollbackError if any cleanup step fails. */
  private async cleanupNewPage(slug: string, originalError: unknown): Promise<void> {
    const original = originalError instanceof Error ? originalError : new Error(String(originalError));
    const errors: Error[] = [];

    const filePath = this.db.getPageFilePath(slug) ?? slugToFilePath(slug);
    try {
      unlinkSync(join(this.pages.vaultPath, filePath));
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (!("code" in error) || error.code !== "ENOENT") errors.push(error);
    }
    try { this.db.deletePageCascaded(slug); } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    try { await this.lance.deleteByPageSlug(slug); } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }

    if (errors.length > 0) {
      this.recordRollbackFailure(slug, original, errors);
      throw new IngestRollbackError(original, errors);
    }
  }

  /** Restore a page to its pre-mutation state after downstream failure.
   *  Re-embeds and re-indexes the old content to keep all stores consistent.
   *  Throws IngestRollbackError if any restore step fails. */
  private async restoreSnapshot(slug: string, snapshot: PageSnapshot, originalError: unknown): Promise<void> {
    const original = originalError instanceof Error ? originalError : new Error(String(originalError));
    const errors: Error[] = [];

    // 1. Restore body and tags
    try {
      this.pages.update(slug, { body: snapshot.body, tags: snapshot.tags });
    } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }

    // 2. Restore mention links
    try {
      this.db.transaction(() => {
        this.db.restoreOutgoingMentionLinks(slug, snapshot.mentionLinks);
      });
    } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }

    // 3. Re-embed and re-index the OLD content to restore LanceDB + SQLite chunks
    try {
      const { chunks, embedResults } = await this.pipeline.embed(snapshot.body);
      await this.pipeline.writeIndexes(slug, chunks, embedResults);
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }

    // 4. Restore original ingest hash (update() cleared it since body changed)
    if (snapshot.ingestHash !== null) {
      try {
        this.db.updateIngestHash(slug, snapshot.ingestHash);
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    }

    if (errors.length > 0) {
      this.recordRollbackFailure(slug, original, errors);
      throw new IngestRollbackError(original, errors);
    }
  }

  private recordRollbackFailure(slug: string, original: Error, errors: Error[]): void {
    try {
      this.pipeline.writeIngestLog(slug, "api", {
        rollbackIncomplete: true,
        rollbackErrors: errors.map(error => error.message),
        originalError: original.message,
        reindexRequired: true,
      });
    } catch (auditError) {
      errors.push(auditError instanceof Error ? auditError : new Error(String(auditError)));
    }
  }

  private recordSyncWarnings(slug: string, warnings: Array<{ slug: string; error: string }>): void {
    if (warnings.length === 0) return;
    try {
      this.pipeline.writeIngestLog(slug, "api", {
        syncWarnings: warnings,
        repairRecommended: true,
      });
    } catch {
      // Derived markdown sync must not turn a committed ingest into a rollback.
    }
  }
}
