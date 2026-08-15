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

// SHA-256 of each complete tools/list entry (name, description, input/output
// schema and annotations) captured from immutable v2.0.9 commit 4a2d12a.
// The two mode-specific entries have output-boundary differences; all others
// must remain byte-identical across legacy and structured modes.
const LEGACY_V209 = {
  cbrain_recall: "e8c488eb1fa094531ded5a5e76c48776699057c306da8d8250cf69e77dedb48f",
  deep_recall: "d1b4807d879d1e22d59cbe47488344bf2342f488b489c9120d00ebc6a3324445",
  find_similar_entities: "9cbc6e72bd559cc989b4cc503f47cfbc411263e05cbb548803178a05cc0c0538",
  get_org_tree: "07b8f1d5696469c5ce13a9c74d8eba47b629372aca56e1f68e739320c57e0dda",
  get_page: "2f35417b12b7c3a71197f7e03bf76c10f13111df13f78f3bc7e7e7cf15e33865",
  get_pages: "0c03da983aa07ce481441cbb5b8316e9f2d9de8750dd8af9b7a5b602d9a99331",
  get_timeline: "8cf58bbc8220e7856494a0c35b88738f5eb8c05d32429b7ab283183bbcb7972f",
  graph_query: "4d76bd489cf5868e7ab05d20a8ad862c535199597e610eee463df0f6d8066e0a",
  ingest: "5c71ba0f697fb19ec01de5d0a2183637a57105cbf0c0fecf189fca96970993ee",
  ingest_dialogue: "551cd2155e1c398b43101094e1860364a39c5edf83b79ed33af64926513f81bb",
  list_pages: "75aa42d783f204adefc9469ad8aaeb519f2c54a53514f6dde250c9637f4d11e3",
  merge_entities: "4f5103e4c4b06d3b88be1b045f00a9a67646346010ccbb9faca8875907c092c2",
  next_actions: "e77806bf235b4835f11ec8e410d0bb1654d6e0ccad13c4e3e2252a87dfc0b3c6",
  profile: "6f3688e307b07b8ee48c357b1eb402441f3c1f703b14472129d2767596d30199",
  put_page: "8fe87d0e5b019bf8ddf5158d01da080aeb7824b966cf91066a24c55253ed7607",
  read_discoveries: "1569e6ff3ed2c5dbfbcbc4972a17a9336a856d075b765e03300e7294ebc94760",
  recall_episode: "d8f639422d1e53ea1470a9c931ab98f25879b09782f5076d8a9029f4a2d6e4c1",
  resolve_slugs: "9240d2ab7d7a2f06b0f24272a425d079db7501fb3b436775d42236e0bb3bfebd",
  status: "1361e6f1f45794635f6d0d44f0b57acdba7c27d131872fb1a1cb08c8303aa3d3",
  update_discovery_status: "e58c7e7835cdaf4d19b64225d89d3953663228e321e96cbbd7e6cb0de3df7310",
} as const;

const STRUCTURED_V209 = {
  ...LEGACY_V209,
  deep_recall: "2cae80589b34954c73b497efb1a075d5a5c63a12c884228f2e0f21faaee0ed29",
  get_timeline: "1b15574b75712d3cd10464c3cf8f14418de05d923bcdd5af62b635071be07975",
  graph_query: "69a9773a5aa48fcd5a94accc18afd9557d6a5d4d1e1ad544a162060146571369",
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

describe.serial("daily Agent contract stays frozen at v2.0.9 (#377)", () => {
  test("legacy tools/list definitions match the immutable release baseline", async () => {
    expect(await agentToolHashes("legacy")).toEqual(LEGACY_V209);
  });

  test("structured tools/list definitions match the immutable release baseline", async () => {
    expect(await agentToolHashes("structured")).toEqual(STRUCTURED_V209);
  });
});
