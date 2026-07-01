import { join } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { HybridSearch } from "../core/search.js";
import { SyncManager } from "../core/sync.js";
import { IngestManager } from "../core/ingest.js";
import { GraphManager } from "../core/graph.js";
import { EnrichManager } from "../core/enrich.js";
import { WritebackManager } from "../core/writeback.js";
import { NerEngine } from "../core/ner.js";
import { PageManager } from "../core/page.js";
import { ContentPipeline } from "../core/pipeline.js";
import { VersionManager } from "../core/version.js";
import { JobQueue } from "../core/jobs.js";
import { Logger } from "../core/logger.js";
import { InsightManager } from "../core/insight.js";
import { LearnManager } from "../core/learn.js";
import { ProfileManager } from "../profile/manager.js";
import { ProvenanceManager } from "../core/provenance.js";
import { SqliteProvenanceStore } from "../storage/provenance-store.js";
import { CompoundingReviewManager } from "../core/compounding-review.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import type { FileWatcher } from "../core/watcher.js";
import { resolveIngestNerMode } from "../cli/context.js";
import type { ToolProfile } from "./tool-profiles.js";
import { JobQueueNerSubmitter } from "../core/ner-backfill.js";

export interface ToolContext {
  db: CBrainDB;
  vaultPath: string;
  dbPath?: string;
  profileDir?: string;
  outputsDir: string;
  pages: PageManager;
  search: HybridSearch;
  sync: SyncManager;
  ingest: IngestManager;
  graph: GraphManager;
  enrich: EnrichManager;
  versions: VersionManager;
  jobs: JobQueue;
  writeback: WritebackManager;
  pipeline: ContentPipeline;
  embedding: EmbeddingProvider;
  lance: LanceDBManager;
  llm?: LLMProvider;
  logger: Logger;
  insights: InsightManager;
  learn: LearnManager;
  profile: ProfileManager;
  provenance: ProvenanceManager;
  compoundingReview: CompoundingReviewManager;
  watcher?: FileWatcher;
  /** #251: MCP tool surface profile — gates which tools attachMcpTools exposes. */
  toolProfile: ToolProfile;
}

export interface IndexResult {
  ok: boolean;
}

export async function indexPage(pipeline: ContentPipeline, slug: string, body: string, logger?: Logger): Promise<IndexResult> {
  try {
    const { chunks, embedResults } = await pipeline.embed(body);
    await pipeline.writeIndexes(slug, chunks, embedResults);
    return { ok: true };
  } catch (err) {
    logger?.error("indexPage", `indexing failed for ${slug}`, { error: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }
}

export function buildContext(deps: { db: CBrainDB; embedding: EmbeddingProvider; lance: LanceDBManager; vaultPath: string; dbPath?: string; llm?: LLMProvider; profileDir?: string; runtimePath: string; watcher?: FileWatcher; nerIngestMode?: "sync" | "defer" | "off"; toolProfile?: ToolProfile }): ToolContext {
  const { db, embedding, lance, vaultPath, dbPath, llm, profileDir, watcher } = deps;
  const outputsDir = deps.runtimePath;
  const logger = new Logger(outputsDir);
  const pages = new PageManager(db, vaultPath, logger, lance);
  const graph = new GraphManager(db);
  const search = new HybridSearch(db, embedding, lance, { llm, logger, graph });
  const nerEngine = llm ? new NerEngine(llm, logger) : undefined;
  const sync = new SyncManager(db, embedding, lance, { nerEngine, pages, logger });
  const jobs = new JobQueue(db, logger);
  // #252: re-resolve defensively — createDeps already put the config-resolved mode in deps.nerIngestMode,
  // but env should still win if buildContext is called without going through createDeps.
  const nerMode = resolveIngestNerMode(process.env.CBRAIN_INGEST_NER_MODE, deps.nerIngestMode);
  const ingest = new IngestManager(db, embedding, lance, vaultPath, llm, undefined, {
    nerMode,
    deferredNerSubmitter: new JobQueueNerSubmitter(db),
  });
  const enrich = new EnrichManager(db, undefined, undefined, vaultPath, pages);
  const versions = new VersionManager(db, pages, vaultPath, logger);
  const writeback = new WritebackManager(pages, db, outputsDir);
  const pipeline = new ContentPipeline(db, embedding, lance, { pages, nerEngine, logger });
  const insights = new InsightManager(db, embedding, lance, logger);
  const learn = new LearnManager(db);
  const profile = new ProfileManager(profileDir ?? join(vaultPath, ".."));
  const provStore = new SqliteProvenanceStore(db.rawDb);
  const provenance = new ProvenanceManager(provStore);
  const compoundingReview = new CompoundingReviewManager(db);
  profile.load();

  return { db, vaultPath, dbPath, profileDir, outputsDir, pages, search, sync, ingest, graph, enrich, versions, jobs, writeback, pipeline, embedding, lance, llm, logger, insights, learn, profile, provenance, compoundingReview, watcher, toolProfile: deps.toolProfile ?? "full" };
}
