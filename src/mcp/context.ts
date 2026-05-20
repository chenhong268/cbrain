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
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";

export interface ToolContext {
  db: CBrainDB;
  vaultPath: string;
  dbPath?: string;
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
}

export async function indexPage(pipeline: ContentPipeline, slug: string, body: string): Promise<void> {
  try {
    const { chunks, embedResults } = await pipeline.embed(body);
    pipeline.writeIndexes(slug, chunks, embedResults);
  } catch (err) {
    console.error(`indexPageContent failed for ${slug}:`, err);
  }
}

export function buildContext(deps: { db: CBrainDB; embedding: EmbeddingProvider; lance: LanceDBManager; vaultPath: string; dbPath?: string; llm?: LLMProvider; profileDir?: string }): ToolContext {
  const { db, embedding, lance, vaultPath, dbPath, llm, profileDir } = deps;
  const outputsDir = join(vaultPath, "outputs");
  const logger = new Logger(outputsDir);
  const pages = new PageManager(db, vaultPath, logger);
  const search = new HybridSearch(db, embedding, lance, { llm });
  const nerEngine = llm ? new NerEngine(llm) : undefined;
  const sync = new SyncManager(db, embedding, lance, { nerEngine, pages, logger });
  const ingest = new IngestManager(db, embedding, lance, vaultPath, llm);
  const graph = new GraphManager(db);
  const enrich = new EnrichManager(db, undefined, undefined, vaultPath);
  const versions = new VersionManager(db, pages, vaultPath);
  const jobs = new JobQueue(db);
  const writeback = new WritebackManager(pages, db, outputsDir);
  const pipeline = new ContentPipeline(db, embedding, lance, { pages, nerEngine, logger });
  const insights = new InsightManager(db, embedding, lance);
  const learn = new LearnManager(db);
  const profile = new ProfileManager(profileDir ?? join(vaultPath, ".."));
  profile.load();

  return { db, vaultPath, dbPath, outputsDir, pages, search, sync, ingest, graph, enrich, versions, jobs, writeback, pipeline, embedding, lance, llm, logger, insights, learn, profile };
}
