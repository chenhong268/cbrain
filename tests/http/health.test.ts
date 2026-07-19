import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { createHttpServer } from "../../src/http/server.js";
import { buildContext } from "../../src/mcp/context.js";
import type { CBrainDeps } from "../../src/mcp/server.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";

describe("GET /health runtime freshness (#320)", () => {
  let root: string;
  let db: CBrainDB;
  let server: ReturnType<ReturnType<typeof createHttpServer>["start"]>;
  let endpoint: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-health-"));
    const deps: CBrainDeps = {
      db: new CBrainDB(join(root, "brain.sqlite")),
      embedding: new DeterministicEmbeddingProvider(),
      lance: new LanceDBManager(),
      vaultPath: join(root, "vault"),
      dbPath: join(root, "brain.sqlite"),
      runtimePath: join(root, "runtime"),
    };
    db = deps.db;
    server = createHttpServer(buildContext(deps)).start(0);
    endpoint = `http://127.0.0.1:${server.port}/health`;
  });

  afterEach(() => {
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("returns an additive, stable, privacy-safe freshness contract", async () => {
    const beforePages = db.getPageCount();
    const first = await fetch(endpoint).then((response) => response.json());
    await Bun.sleep(5);
    const second = await fetch(endpoint).then((response) => response.json());

    expect(Object.keys(first).sort()).toEqual(["ok", "output_boundary", "started_at", "tools", "version"]);
    expect(first.ok).toBe(true);
    expect(first.output_boundary).toBe("legacy");
    expect(first.tools).toBeGreaterThan(0);
    expect(typeof first.version).toBe("string");
    expect(first.version.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(first.started_at))).toBe(false);
    expect(second.started_at).toBe(first.started_at);
    expect(db.getPageCount()).toBe(beforePages);

    const serialized = JSON.stringify(first).toLowerCase();
    for (const privateTerm of ["pid", "path", "vault", "database", "secret", "profile"]) {
      expect(serialized).not.toContain(privateTerm);
    }
  });

  test("binds the dedicated cohort health response to its deployment and process", async () => {
    server.stop(true);
    const digest = "a".repeat(64);
    const deps: CBrainDeps = {
      db,
      embedding: new DeterministicEmbeddingProvider(),
      lance: new LanceDBManager(),
      vaultPath: join(root, "vault"),
      dbPath: join(root, "brain.sqlite"),
      runtimePath: join(root, "runtime"),
    };
    const ctx = buildContext(deps);
    ctx.rolloutIdentity = { cohortId: "cbrain-structured-pilot-v1", deploymentDigest: digest };
    server = createHttpServer(ctx).start(0);
    endpoint = `http://127.0.0.1:${server.port}/health`;
    const health = await fetch(endpoint).then((response) => response.json());
    expect(health.cohort_id).toBe("cbrain-structured-pilot-v1");
    expect(health.deployment_digest).toBe(digest);
    expect(health.process_id).toBe(process.pid);
  });
});
