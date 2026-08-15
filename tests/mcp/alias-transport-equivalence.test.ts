import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { hashContent } from "../../src/core/shared.js";
import { buildContext } from "../../src/mcp/context.js";
import type { CBrainDeps } from "../../src/mcp/server.js";
import { attachMcpTools } from "../../src/mcp/server.js";

type Fixture = { root: string; db: CBrainDB; client: Client; server: McpServer };
type Seed = (root: string, db: CBrainDB) => void;

type AliasCase = {
  alias: string;
  aliasArgs: Record<string, unknown>;
  canonical: string;
  canonicalArgs: Record<string, unknown>;
  seed?: Seed;
};

function mockLance(): LanceDBManager {
  return {
    connect: async () => {},
    addChunks: async () => {},
    addInsightVector: async () => {},
    search: async () => [],
    searchInsights: async () => [{ id: 1 }],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  } as unknown as LanceDBManager;
}

function seedPage(root: string, db: CBrainDB, slug: string, title: string): void {
  const filePath = `${slug}.md`;
  const absolutePath = join(root, "vault", filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `---\ntitle: ${title}\ntype: entity\n---\nAnonymous fixture body.\n`);
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
  ).run(slug, title, filePath, hashContent(readFileSync(absolutePath, "utf-8")));
}

const seedTwoPages: Seed = (root, db) => {
  seedPage(root, db, "entities/a", "Entity A");
  seedPage(root, db, "entities/b", "Entity B");
};

const CASES: AliasCase[] = [
  { alias: "get_tags", aliasArgs: { slug: "entities/a" }, canonical: "tag", canonicalArgs: { action: "list", slug: "entities/a" }, seed: (root, db) => { seedPage(root, db, "entities/a", "Entity A"); db.addTag("entities/a", "seed-tag"); } },
  { alias: "add_tag", aliasArgs: { slug: "entities/a", tag: "new-tag" }, canonical: "tag", canonicalArgs: { action: "add", slug: "entities/a", tag: "new-tag" }, seed: (root, db) => seedPage(root, db, "entities/a", "Entity A") },
  { alias: "remove_tag", aliasArgs: { slug: "entities/a", tag: "remove-tag" }, canonical: "tag", canonicalArgs: { action: "remove", slug: "entities/a", tag: "remove-tag" }, seed: (root, db) => { seedPage(root, db, "entities/a", "Entity A"); db.addTag("entities/a", "remove-tag"); } },
  { alias: "add_alias", aliasArgs: { slug: "entities/a", alias: "Entity Alias" }, canonical: "alias", canonicalArgs: { action: "add", slug: "entities/a", alias: "Entity Alias" }, seed: (root, db) => seedPage(root, db, "entities/a", "Entity A") },
  { alias: "remove_alias", aliasArgs: { slug: "entities/a", alias: "Old Alias" }, canonical: "alias", canonicalArgs: { action: "remove", slug: "entities/a", alias: "Old Alias" }, seed: (root, db) => { seedPage(root, db, "entities/a", "Entity A"); db.addAlias("entities/a", "Old Alias"); } },
  { alias: "get_links", aliasArgs: { slug: "entities/a" }, canonical: "link", canonicalArgs: { action: "list", slug: "entities/a" }, seed: (root, db) => { seedTwoPages(root, db); db.insertLink("entities/a", "entities/b", "mentions"); } },
  { alias: "add_link", aliasArgs: { from: "entities/a", to: "entities/b", relation: "mentions" }, canonical: "link", canonicalArgs: { action: "add", from: "entities/a", to: "entities/b", relation: "mentions" }, seed: seedTwoPages },
  { alias: "remove_link", aliasArgs: { from: "entities/a", to: "entities/b", relation: "mentions" }, canonical: "link", canonicalArgs: { action: "remove", from: "entities/a", to: "entities/b", relation: "mentions" }, seed: (root, db) => { seedTwoPages(root, db); db.insertLink("entities/a", "entities/b", "mentions"); } },
  { alias: "job_submit", aliasArgs: { name: "anonymous-task", data: { value: 1 }, priority: 2 }, canonical: "job", canonicalArgs: { action: "submit", name: "anonymous-task", data: { value: 1 }, priority: 2 } },
  { alias: "job_list", aliasArgs: { status: "done" }, canonical: "job", canonicalArgs: { action: "list", status: "done" }, seed: (_root, db) => { db.rawDb.prepare("INSERT INTO jobs (name, status, priority, created_at) VALUES (?, ?, ?, ?)").run("anonymous-list", "done", 1, "2026-01-01 00:00:00"); } },
  { alias: "job_status", aliasArgs: { id: 1 }, canonical: "job", canonicalArgs: { action: "status", id: 1 }, seed: (_root, db) => { db.rawDb.prepare("INSERT INTO jobs (name, status, priority, created_at) VALUES (?, ?, ?, ?)").run("anonymous-status", "pending", 1, "2026-01-01 00:00:00"); } },
  { alias: "job_cancel", aliasArgs: { id: 1 }, canonical: "job", canonicalArgs: { action: "cancel", id: 1 }, seed: (_root, db) => { db.rawDb.prepare("INSERT INTO jobs (name, status, priority, created_at) VALUES (?, ?, ?, ?)").run("anonymous-cancel", "pending", 1, "2026-01-01 00:00:00"); } },
  { alias: "job_retry", aliasArgs: { id: 1 }, canonical: "job", canonicalArgs: { action: "retry", id: 1 }, seed: (_root, db) => { db.rawDb.prepare("INSERT INTO jobs (name, status, priority, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("anonymous-retry", "failed", 1, 1, 3, "2026-01-01 00:00:00"); } },
  { alias: "batch_delete_pages", aliasArgs: { slugs: ["entities/a"] }, canonical: "batch", canonicalArgs: { action: "delete_pages", slugs: ["entities/a"] }, seed: (root, db) => seedPage(root, db, "entities/a", "Entity A") },
  { alias: "batch_add_links", aliasArgs: { links: [{ from: "entities/a", to: "entities/b", relation: "mentions" }] }, canonical: "batch", canonicalArgs: { action: "add_links", links: [{ from: "entities/a", to: "entities/b", relation: "mentions" }] }, seed: seedTwoPages },
  { alias: "batch_merge_pages", aliasArgs: { pairs: [{ source: "entities/a", target: "entities/b" }] }, canonical: "batch", canonicalArgs: { action: "merge_pages", pairs: [{ source: "entities/a", target: "entities/b" }] }, seed: seedTwoPages },
  { alias: "get_profile", aliasArgs: {}, canonical: "profile", canonicalArgs: { action: "get" } },
  { alias: "update_profile", aliasArgs: { entries: [{ id: "anonymous-pref", type: "preference", category: "general", scope: "open", content: "Anonymous preference", source: "explicit" }] }, canonical: "profile", canonicalArgs: { action: "update", entries: [{ id: "anonymous-pref", type: "preference", category: "general", scope: "open", content: "Anonymous preference", source: "explicit" }] } },
  { alias: "remove_profile", aliasArgs: { ids: ["remove-me"] }, canonical: "profile", canonicalArgs: { action: "remove", ids: ["remove-me"] }, seed: (root) => { writeFileSync(join(root, "profile", "profile.yaml"), "version: 1\nuser:\n  id: anonymous\nentries:\n  - id: remove-me\n    type: preference\n    category: general\n    scope: open\n    content: Anonymous entry\n    source: explicit\n    updated_at: 2026-01-01\n"); } },
  { alias: "reload_profile", aliasArgs: {}, canonical: "profile", canonicalArgs: { action: "reload" } },
  { alias: "list_insights", aliasArgs: { limit: 5 }, canonical: "insight", canonicalArgs: { action: "list", limit: 5 }, seed: (_root, db) => { db.createInsight({ content: "Anonymous insight", type: "bridge", confidence: 0.8, sourceEntities: ["entities/a"], sourceType: "manual" }); } },
  { alias: "get_insight", aliasArgs: { id: 1 }, canonical: "insight", canonicalArgs: { action: "get", id: 1 }, seed: (_root, db) => { db.createInsight({ content: "Anonymous insight", type: "bridge", confidence: 0.8, sourceEntities: ["entities/a"], sourceType: "manual" }); } },
  { alias: "archive_insight", aliasArgs: { id: 1 }, canonical: "insight", canonicalArgs: { action: "archive", id: 1 }, seed: (_root, db) => { db.createInsight({ content: "Anonymous insight", type: "bridge", confidence: 0.8, sourceEntities: ["entities/a"], sourceType: "manual" }); } },
  { alias: "dismiss_insight", aliasArgs: { id: 1 }, canonical: "insight", canonicalArgs: { action: "dismiss", id: 1 }, seed: (_root, db) => { db.createInsight({ content: "Anonymous insight", type: "bridge", confidence: 0.8, sourceEntities: ["entities/a"], sourceType: "manual" }); } },
  { alias: "query_insights", aliasArgs: { query: "anonymous", limit: 5 }, canonical: "insight", canonicalArgs: { action: "query", query: "anonymous", limit: 5 }, seed: (_root, db) => { db.createInsight({ content: "Anonymous insight", type: "bridge", confidence: 0.8, sourceEntities: ["entities/a"], sourceType: "manual" }); } },
  { alias: "promote_discovery", aliasArgs: { discoveryId: 1, type: "bridge" }, canonical: "insight", canonicalArgs: { action: "promote_discovery", discoveryId: 1, type: "bridge" }, seed: (_root, db) => { const { id } = db.upsertDiscovery("bridge", ["entities/a", "entities/b"], 0.8, { distance: 2 }, undefined, "medium"); db.updateDiscoverySuggestion(id, "Anonymous discovery suggestion"); } },
];

async function openFixture(seed?: Seed): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "cbrain-alias-transport-"));
  mkdirSync(join(root, "vault"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  mkdirSync(join(root, "profile"), { recursive: true });
  const db = new CBrainDB(join(root, "brain.sqlite"));
  seed?.(root, db);
  const deps: CBrainDeps = {
    db,
    embedding: new DeterministicEmbeddingProvider(),
    lance: mockLance(),
    vaultPath: join(root, "vault"),
    runtimePath: join(root, "runtime"),
    profileDir: join(root, "profile"),
  };
  const server = new McpServer({ name: "alias-transport-equivalence", version: "0.0.0" });
  attachMcpTools(server, buildContext(deps));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "alias-transport-probe", version: "0.0.0" });
  await client.connect(clientSide);
  return { root, db, server, client };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.client.close();
  await fixture.server.close();
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

const TIME_FIELDS = new Set(["created_at", "updated_at", "detected_at", "last_detected_at", "started_at", "finished_at", "expires_at"]);
// Separate fixtures receive distinct wall-clock instants. Page hashes include the
// generated frontmatter timestamp, so compare semantic state after normalizing
// that timestamp, while separately proving every stored hash matches its file.
const TIME_DERIVED_FIELDS = new Set(["content_hash"]);

function normalizeTransportText(text: string): string {
  try {
    return JSON.stringify(normalize(JSON.parse(text)));
  } catch {
    return text;
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !TIME_FIELDS.has(key) && !TIME_DERIVED_FIELDS.has(key))
      .map(([key, item]) => [
        key,
        key === "text" && typeof item === "string" ? normalizeTransportText(item) : normalize(item),
      ]));
  }
  return value;
}

function durableSnapshot(root: string, db: CBrainDB): unknown {
  const pageRows = db.rawDb.prepare("SELECT slug, file_path, content_hash FROM pages").all() as Array<{
    slug: string;
    file_path: string;
    content_hash: string;
  }>;
  for (const page of pageRows) {
    const path = join(root, "vault", page.file_path);
    expect(page.content_hash, `${page.slug} hash must match its vault file`)
      .toBe(hashContent(readFileSync(path, "utf-8")));
  }
  const rows = Object.fromEntries(["pages", "links", "tags", "aliases", "insights", "discoveries", "jobs"].map((table) => [
    table,
    (db.rawDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>)
      .map(normalize)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
  const files: Array<{ path: string; bytes: string }> = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile()) {
        files.push({
          path: relative(root, child),
          bytes: readFileSync(child, "utf-8").replace(/^updated_at:.*$/gm, "updated_at: <generated-date>"),
        });
      }
    }
  };
  visit(join(root, "vault"));
  visit(join(root, "profile"));
  return normalize({ rows, files: files.sort((a, b) => a.path.localeCompare(b.path)) });
}

async function invoke(candidate: AliasCase, name: string, args: Record<string, unknown>) {
  const fixture = await openFixture(candidate.seed);
  try {
    const result = await fixture.client.callTool({ name, arguments: args });
    return { result: normalize(result), durable: durableSnapshot(fixture.root, fixture.db) };
  } finally {
    await closeFixture(fixture);
  }
}

describe.serial("candidate aliases remain equivalent over real MCP transport (#377)", () => {
  test("ignores generated time fields inside transport JSON text", () => {
    const left = {
      content: [{ type: "text", text: JSON.stringify({ raw: [{ created_at: "2026-01-01 00:00:00", slug: "entities/a" }] }) }],
    };
    const right = {
      content: [{ type: "text", text: JSON.stringify({ raw: [{ created_at: "2026-01-01 00:00:01", slug: "entities/a" }] }) }],
    };

    expect(normalize(left)).toEqual(normalize(right));
  });

  test("every valid alias matches its canonical action result and durable state", async () => {
    for (const candidate of CASES) {
      const legacy = await invoke(candidate, candidate.alias, candidate.aliasArgs);
      const canonical = await invoke(candidate, candidate.canonical, candidate.canonicalArgs);
      expect(legacy.result, `${candidate.alias} result`).toEqual(canonical.result);
      expect(legacy.durable, `${candidate.alias} durable state`).toEqual(canonical.durable);
    }
  });
});
