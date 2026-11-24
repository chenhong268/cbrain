import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { buildContext } from "../../src/mcp/context.js";
import { attachMcpTools } from "../../src/mcp/server.js";

// #567 Agent tools contract v2: MCP SDK 1.32.2 with Zod 4.6.7.
// Hashes cover complete tools/list entries from an anonymous Agent session.
// The previous v2.0.9 contract remains in the history of this test (#377).
const LEGACY_V2 = {
  cbrain_recall: "d4ebfee7c113161b2e737faf6457d41616bf53aad65f993e55afa92ac8c3acb9",
  deep_recall: "a9fb420623fa2dc38aba8f5b6a89371eb0500aa8c3dc41219fc2b549a93da094",
  find_similar_entities: "1a335324b81ceac6844403405867b67fe312492ff85dbd06e5bae5179d00d79c",
  get_org_tree: "7a59619370214a774240d311284598ec25774bfe836cb17cdd4be7b95d74fc0a",
  get_page: "527ee050b67f769c11b592438f0c8bd8d7b59d3da5be6cbc4402b2973d70a8e1",
  get_pages: "8f44d39959876e465e2c8719ee45cf80e895f3187ee59e9584c227f094603389",
  get_timeline: "dece3bd4f65deca1da3586ae16092034ced8775ac95594d4bc61166f8e1caaf7",
  graph_query: "a1b35191c93ead076e6f833abbde149a89148b93646717d7d28608dbc75c5ae5",
  ingest: "fc5b28e522b6b8266b0f549de136a4e071596a570b6e0a578da05b65f18f4c00",
  ingest_dialogue: "4568bf96030261e5a761dfecfd8c34aa88671e838b89844a7855cab9d12e9360",
  list_pages: "b28fa57c3f603452e72bd50051443bdbcf3c0be1e31cdb50cfec532565587a14",
  merge_entities: "b8e0228898624cc762d221b37e038d70e7d63439b3fd37a4da9c9994cb88bbb8",
  next_actions: "6a970a0e0b87c14a3736295547cb6a2e8e092306ddf5d5a1cfd296ef6a6ef46b",
  profile: "3100360bdd9a68b64e9b720fb3edb1386a6377d0bf8e5312e569cf4e3b9c6843",
  put_page: "1a9b3f38da2749c74a4aa1e878e385785af61f85328cd4b38be537db97bd0bbe",
  read_discoveries: "f61913c61f728a8ed6c6af571878cb9527d9f73059b9a7ad6367fb73d41dc458",
  recall_episode: "46969367d80f40b8c3dc26b3292323629a48631a2afdec07039b365f3dfd6674",
  resolve_slugs: "39b13e341d7a17c641dee9d725299f72184d0ec49a61f355a2293216e43cf31a",
  status: "1361e6f1f45794635f6d0d44f0b57acdba7c27d131872fb1a1cb08c8303aa3d3",
  update_discovery_status: "2973369d8964635014c8c6e1b36ccebc4246bcb248e203d2e5896100030a3480",
} as const;

const STRUCTURED_V2 = {
  ...LEGACY_V2,
  deep_recall: "6a6ca0f29d11ad86d73534e6d201417b56100d6341362c45bf83ebdbf84b6f2d",
  get_timeline: "f94852259b38ce1d3e2e195dccedca5a0d7b7137c91f4737f3cc16091828379a",
  graph_query: "919d7c743cc5db6ebdb4d1ccff2be44685e47a646f3d1547e4537555e13eff3c",
};

async function agentToolHashes(mode: "legacy" | "structured"): Promise<Record<string, string>> {
  const previous = process.env.CBRAIN_OUTPUT_BOUNDARY;
  process.env.CBRAIN_OUTPUT_BOUNDARY = mode;
  const root = mkdtempSync(join(tmpdir(), "cbrain-agent-contract-"));
  mkdirSync(join(root, "vault"), { recursive: true });
  const db = new CBrainDB(join(root, "brain.sqlite"));
  const server = new McpServer({ name: "agent-contract", version: "0.0.0" });
  try {
    attachMcpTools(server, buildContext({
      db,
      embedding: new DeterministicEmbeddingProvider(),
      lance: new LanceDBManager(),
      vaultPath: join(root, "vault"),
      runtimePath: join(root, "runtime"),
      toolProfile: "agent",
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "agent-contract-probe", version: "0.0.0" });
    try {
      await client.connect(clientSide);
      const { tools } = await client.listTools();
      return Object.fromEntries(tools.map((tool) => [
        tool.name,
        createHash("sha256").update(JSON.stringify(tool)).digest("hex"),
      ]));
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CBRAIN_OUTPUT_BOUNDARY;
    else process.env.CBRAIN_OUTPUT_BOUNDARY = previous;
  }
}

describe.serial("daily Agent tools contract v2 (#567)", () => {
  test("legacy tools/list definitions match the v2 baseline", async () => {
    expect(await agentToolHashes("legacy")).toEqual(LEGACY_V2);
  });

  test("structured tools/list definitions match the v2 baseline", async () => {
    expect(await agentToolHashes("structured")).toEqual(STRUCTURED_V2);
  });
});
