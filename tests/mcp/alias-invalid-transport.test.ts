import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { buildContext } from "../../src/mcp/context.js";
import type { CBrainDeps } from "../../src/mcp/server.js";
import { attachMcpTools } from "../../src/mcp/server.js";

let root = "";

type AliasCase = {
  alias: string;
  aliasArgs: Record<string, unknown>;
  canonical: string;
  canonicalArgs: Record<string, unknown>;
};

// Every request below is intentionally incomplete. It exercises the real MCP
// schema/handler boundary and must leave the anonymous fixture unchanged.
const CASES: AliasCase[] = [
  { alias: "get_tags", aliasArgs: {}, canonical: "tag", canonicalArgs: { action: "list" } },
  { alias: "add_tag", aliasArgs: {}, canonical: "tag", canonicalArgs: { action: "add" } },
  { alias: "remove_tag", aliasArgs: {}, canonical: "tag", canonicalArgs: { action: "remove" } },
  { alias: "add_alias", aliasArgs: {}, canonical: "alias", canonicalArgs: { action: "add" } },
  { alias: "remove_alias", aliasArgs: {}, canonical: "alias", canonicalArgs: { action: "remove" } },
  { alias: "get_links", aliasArgs: {}, canonical: "link", canonicalArgs: { action: "list" } },
  { alias: "add_link", aliasArgs: {}, canonical: "link", canonicalArgs: { action: "add" } },
  { alias: "remove_link", aliasArgs: {}, canonical: "link", canonicalArgs: { action: "remove" } },
  { alias: "job_submit", aliasArgs: {}, canonical: "job", canonicalArgs: { action: "submit" } },
  { alias: "job_list", aliasArgs: { status: 42 }, canonical: "job", canonicalArgs: { action: "list", status: 42 } },
  { alias: "job_status", aliasArgs: {}, canonical: "job", canonicalArgs: { action: "status" } },
  { alias: "job_cancel", aliasArgs: {}, canonical: "job", canonicalArgs: { action: "cancel" } },
  { alias: "job_retry", aliasArgs: {}, canonical: "job", canonicalArgs: { action: "retry" } },
  { alias: "batch_delete_pages", aliasArgs: {}, canonical: "batch", canonicalArgs: { action: "delete_pages" } },
  { alias: "batch_add_links", aliasArgs: {}, canonical: "batch", canonicalArgs: { action: "add_links" } },
  { alias: "batch_merge_pages", aliasArgs: {}, canonical: "batch", canonicalArgs: { action: "merge_pages" } },
  { alias: "get_profile", aliasArgs: { scope: 42 }, canonical: "profile", canonicalArgs: { action: "get", scope: 42 } },
  { alias: "update_profile", aliasArgs: {}, canonical: "profile", canonicalArgs: { action: "update" } },
  { alias: "remove_profile", aliasArgs: {}, canonical: "profile", canonicalArgs: { action: "remove" } },
  { alias: "list_insights", aliasArgs: { limit: "bad" }, canonical: "insight", canonicalArgs: { action: "list", limit: "bad" } },
  { alias: "get_insight", aliasArgs: {}, canonical: "insight", canonicalArgs: { action: "get" } },
  { alias: "archive_insight", aliasArgs: {}, canonical: "insight", canonicalArgs: { action: "archive" } },
  { alias: "dismiss_insight", aliasArgs: {}, canonical: "insight", canonicalArgs: { action: "dismiss" } },
  { alias: "query_insights", aliasArgs: {}, canonical: "insight", canonicalArgs: { action: "query" } },
  { alias: "promote_discovery", aliasArgs: {}, canonical: "insight", canonicalArgs: { action: "promote_discovery" } },
];

function makeDeps(): CBrainDeps {
  const dbPath = join(root, "brain.sqlite");
  return {
    db: new CBrainDB(dbPath),
    dbPath,
    embedding: new DeterministicEmbeddingProvider(),
    lance: new LanceDBManager(),
    vaultPath: join(root, "vault"),
    runtimePath: join(root, "runtime"),
    profileDir: join(root, "profile"),
  };
}

function stateSnapshot(db: CBrainDB): Record<string, number> {
  const tables = ["pages", "links", "tags", "aliases", "insights", "discoveries", "jobs"];
  return Object.fromEntries(tables.map((table) => [
    table,
    (db.rawDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]));
}

function durableFilesSnapshot(root: string): Array<{ path: string; bytes: string }> {
  // Validation failures deliberately create a sanitized runtime audit entry.
  // The durable user state that must remain unchanged is the vault and profile.
  const roots = ["vault", "profile"];
  const files: Array<{ path: string; bytes: string }> = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        files.push({ path: relative(root, child), bytes: readFileSync(child, "utf-8") });
      }
    }
  };
  for (const name of roots) visit(join(root, name));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function attempt(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (error) {
    return error;
  }
}

function isFailure(result: unknown): boolean {
  if (result instanceof Error) return true;
  return typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;
}

describe.serial("candidate aliases fail closed over the real MCP transport (#377)", () => {
  let db: CBrainDB;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cbrain-alias-invalid-transport-"));
    mkdirSync(join(root, "vault"), { recursive: true });
    mkdirSync(join(root, "runtime"), { recursive: true });
    const deps = makeDeps();
    db = deps.db;
    server = new McpServer({ name: "alias-invalid-transport", version: "0.0.0" });
    attachMcpTools(server, buildContext(deps));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "alias-invalid-probe", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    db.close();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("all candidate aliases and their canonical actions remain registered", async () => {
    const listed = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const candidate of CASES) {
      expect(listed).toContain(candidate.alias);
      expect(listed).toContain(candidate.canonical);
    }
  });

  test("every incomplete alias and canonical request fails without changing stored state", async () => {
    for (const candidate of CASES) {
      for (const [name, args] of [
        [candidate.alias, candidate.aliasArgs],
        [candidate.canonical, candidate.canonicalArgs],
      ] as const) {
        const before = stateSnapshot(db);
        const filesBefore = durableFilesSnapshot(root);
        const result = await attempt(client, name, args);
        expect(isFailure(result), `${name} must reject incomplete input`).toBe(true);
        expect(stateSnapshot(db), `${name} must not write on failure`).toEqual(before);
        expect(durableFilesSnapshot(root), `${name} must not change durable files on failure`)
          .toEqual(filesBefore);
      }
    }
  });

  test("profile reload aliases are equivalent valid no-write operations", async () => {
    const before = stateSnapshot(db);
    const filesBefore = durableFilesSnapshot(root);
    const aliasResult = await attempt(client, "reload_profile", {});
    const canonicalResult = await attempt(client, "profile", { action: "reload" });

    expect(isFailure(aliasResult)).toBe(false);
    expect(canonicalResult).toEqual(aliasResult);
    expect(stateSnapshot(db)).toEqual(before);
    expect(durableFilesSnapshot(root)).toEqual(filesBefore);
  });
});
