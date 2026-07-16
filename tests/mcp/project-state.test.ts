import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { writeProjectState } from "../../src/core/project-state.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { isToolAllowedForProfile } from "../../src/mcp/tool-profiles.js";

const tmp = "/tmp/cbrain-test-project-state-mcp";

function embedding(): EmbeddingProvider {
  return {
    dimensions: 8,
    embed: async () => ({ embedding: new Array(8).fill(0), tokenCount: 1 }),
    embedBatch: async (texts: string[]) => texts.map(() => ({ embedding: new Array(8).fill(0), tokenCount: 1 })),
  };
}

function lance() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function tools(server: unknown): Record<string, { handler: (input: unknown) => Promise<unknown> }> {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

function deps(runtimePath: string): CBrainDeps {
  const dbPath = join(tmp, "brain.sqlite");
  return {
    db: new CBrainDB(dbPath),
    embedding: embedding(),
    lance: lance() as any,
    vaultPath: join(tmp, "vault"),
    dbPath,
    runtimePath,
    toolProfile: "full",
  };
}

async function callReadProjectState(runtimePath: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const d = deps(runtimePath);
  try {
    const server = createServer(d);
    const result = await tools(server).read_project_state.handler(input) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text);
  } finally {
    d.db.close();
  }
}

describe("read_project_state MCP tool (#266)", () => {
  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "vault"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing state returns compact empty envelope", async () => {
    const result = await callReadProjectState(join(tmp, "runtime"));

    expect((result.summary as { status: string }).status).toBe("empty");
    expect(String(result.display)).toContain("暂无项目状态");
  });

  test("reads state from runtime and keeps display under requested budget", async () => {
    const runtimePath = join(tmp, "runtime");
    writeProjectState(runtimePath, {
      active_work: ["#1 处理主题A"],
      decisions: ["保持 CBrain 只提供状态，不注入 prompt"],
      blockers: ["等待主题B"],
    });

    const result = await callReadProjectState(runtimePath, { max_chars: 500 });

    expect((result.summary as { status: string }).status).toBe("ok");
    expect(String(result.display)).toContain("当前工作");
    expect(String(result.display).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(result)).not.toContain("/tmp/cbrain-test");
  });

  test("include_raw is explicit", async () => {
    const runtimePath = join(tmp, "runtime");
    writeProjectState(runtimePath, { active_work: ["任务A"], decisions: [], blockers: [] });

    const compact = await callReadProjectState(runtimePath);
    const raw = await callReadProjectState(runtimePath, { include_raw: true });

    expect(compact.raw).toBeUndefined();
    expect(raw.raw).toBeDefined();
  });

  // #309: read_project_state moved out of agent (project metadata; next_actions is the
  // attention entry daily Agents need). Stays reachable via maintenance + full.
  test("agent excludes project state but includes governed profile, not its update alias (#309/#335)", () => {
    expect(isToolAllowedForProfile("read_project_state", "agent")).toBe(false);
    expect(isToolAllowedForProfile("read_project_state", "maintenance")).toBe(true);
    expect(isToolAllowedForProfile("read_project_state", "full")).toBe(true);
    expect(isToolAllowedForProfile("profile", "agent")).toBe(true);
    expect(isToolAllowedForProfile("update_profile", "agent")).toBe(false);
  });
});
