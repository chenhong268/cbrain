import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CBrainDB } from "../storage/sqlite.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import { buildContext } from "./context.js";
import { registerSearchTools } from "./tools/search.js";
import { registerIngestTools } from "./tools/ingest.js";
import { registerPageTools } from "./tools/pages.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerTagTools } from "./tools/tags.js";
import { registerTimelineTools } from "./tools/timeline.js";
import { registerVersionTools } from "./tools/versions.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerSyncTools } from "./tools/sync.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerRecallTools } from "./tools/recall.js";
import { registerBrainstormTools } from "./tools/brainstorm.js";
import { registerSummarizeTools } from "./tools/summarize.js";
import { registerDiscoveryTools } from "./tools/discoveries.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerExpandTools } from "./tools/expand.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerDossierTools } from "./tools/dossier.js";
import { registerHierarchyTools } from "./tools/hierarchy.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerBatchTools } from "./tools/batch.js";

export interface CBrainDeps {
  db: CBrainDB;
  embedding: EmbeddingProvider;
  lance: LanceDBManager;
  vaultPath: string;
  llm?: LLMProvider;
  profileDir?: string;
}

export function createServer(deps: CBrainDeps): McpServer {
  const server = new McpServer({
    name: "cbrain",
    version: "1.0.0",
  });

  // Unified error wrapper — every tool handler gets try-catch automatically
  const origRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, def: any, handler: (...a: any[]) => Promise<any>) =>
    origRegister(name, def, async (...a: any[]) => {
      try {
        return await handler(...a);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    });

  const ctx = buildContext(deps);

  registerSearchTools(server, ctx);
  registerIngestTools(server, ctx);
  registerPageTools(server, ctx);
  registerGraphTools(server, ctx);
  registerTagTools(server, ctx);
  registerTimelineTools(server, ctx);
  registerVersionTools(server, ctx);
  registerJobTools(server, ctx);
  registerSyncTools(server, ctx);
  registerOpsTools(server, ctx);
  registerRecallTools(server, ctx);
  registerBrainstormTools(server, ctx);
  registerSummarizeTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerInsightTools(server, ctx);
  registerExpandTools(server, ctx);
  registerProfileTools(server, ctx);
  registerDossierTools(server, ctx);
  registerHierarchyTools(server, ctx);
  registerFeedbackTools(server, ctx);
  registerBatchTools(server, ctx);

  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
