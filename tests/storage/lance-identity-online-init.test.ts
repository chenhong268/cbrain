/**
 * #545 R1: the normal initialization boundary must resolve the local model
 * digest, so a same-name model update is refused where a user actually enters
 * (createDeps → connect → write), not only at an explicit rebuild.
 *
 * These are entry tests: nothing here calls the identity helpers directly.
 * Every assertion goes through createDeps() or through the manager it builds,
 * with a mocked model server standing in for a local anonymous Ollama.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeps, type CBrainConfig } from "../../src/cli/context.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { readIndexIdentity, type VectorIndexIdentity } from "../../src/storage/lance-identity.js";
import { OLLAMA_DEFAULT_MODEL, resolveOllamaModelDigest } from "../../src/embedding/ollama.js";

const MODEL = OLLAMA_DEFAULT_MODEL;
const DIMS = 1024;
/** A port nothing listens on: used only as a base URL, the fetch mock answers. */
const UNREACHABLE = "http://127.0.0.1:1";

let root: string;
let originalFetch: typeof globalThis.fetch;
let tagsCalls = 0;
let tagsResponse: { status: number; digest?: string } = { status: 200, digest: "digest-current" };

function identity(overrides: Partial<VectorIndexIdentity> = {}): VectorIndexIdentity {
  return { provider: "ollama", model: MODEL, dimensions: DIMS, documentEncoding: 1, ...overrides };
}

function vector(index: number, dimensions: number = DIMS): Float32Array {
  const vec = new Float32Array(dimensions);
  vec[index % dimensions] = 1;
  return vec;
}

function chunk(pageSlug: string, chunkIndex: number, index: number) {
  return { pageSlug, chunkIndex, content: `${pageSlug}#${chunkIndex}`, vector: vector(index) };
}

function lanceDir(name: string): string {
  return join(root, name);
}

function config(baseUrl: string = UNREACHABLE): CBrainConfig {
  return {
    vaultPath: join(root, "vault"),
    dbPath: join(root, "test.sqlite"),
    lancePath: lanceDir("lance-shared"),
    runtimePath: join(root, "runtime"),
    embedding: { provider: "ollama", baseUrl, model: MODEL },
  };
}

function installFakeModelServer(): void {
  tagsCalls = 0;
  tagsResponse = { status: 200, digest: "digest-current" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/tags")) {
      tagsCalls += 1;
      if (tagsResponse.status >= 400) return new Response("unavailable", { status: tagsResponse.status });
      const models = tagsResponse.digest ? [{ name: MODEL, digest: tagsResponse.digest }] : [];
      return Response.json({ models });
    }
    if (url.endsWith("/api/embed")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const count = Math.max(1, body.input?.length ?? 1);
      const embeddings = Array.from({ length: count }, (_v, i) => Array.from(vector(i + 1)));
      return Response.json({ embeddings, prompt_eval_count: 1 });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("#545 R1 — model digest at the initialization boundary", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-r1-"));
    originalFetch = globalThis.fetch;
    installFakeModelServer();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  });

  test("resolveOllamaModelDigest reports the digest of the configured model", async () => {
    expect(await resolveOllamaModelDigest(UNREACHABLE, MODEL)).toBe("digest-current");
    expect(tagsCalls).toBe(1);
  });

  test("resolveOllamaModelDigest returns undefined for a missing model, an HTTP error and a dead server", async () => {
    tagsResponse = { status: 200 };
    expect(await resolveOllamaModelDigest(UNREACHABLE, MODEL)).toBeUndefined();

    tagsResponse = { status: 500 };
    expect(await resolveOllamaModelDigest(UNREACHABLE, MODEL)).toBeUndefined();

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    expect(await resolveOllamaModelDigest(UNREACHABLE, MODEL)).toBeUndefined();
  });

  test("a new index created through createDeps records the digest the model server reports", async () => {
    const lancePath = lanceDir("lance-new");
    const deps = createDeps(config(), true);
    try {
      await deps.lance.connect(lancePath);
      await deps.lance.addChunks([chunk("entities/a", 0, 1)]);
    } finally {
      await deps.lance.close();
      deps.db.close();
    }

    expect(readIndexIdentity(lancePath)).toMatchObject({
      provider: "ollama",
      model: MODEL,
      dimensions: DIMS,
      modelDigest: "digest-current",
    });
    // Resolved once at the boundary, from the model list only.
    expect(tagsCalls).toBe(1);
  });

  test("the normal entry point refuses a same-name model digest update", async () => {
    const lancePath = lanceDir("lance-drift");
    const first = new LanceDBManager({ identity: identity({ modelDigest: "digest-old" }) });
    await first.connect(lancePath);
    await first.addChunks([chunk("entities/a", 0, 1)]);
    await first.close();
    expect(readIndexIdentity(lancePath)?.modelDigest).toBe("digest-old");

    const deps = createDeps(config(), true);
    try {
      await expect(deps.lance.connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_MISMATCH/);
      expect(tagsCalls).toBe(1);
      // The refused instance must not be able to extend the index either.
      await expect(deps.lance.addChunks([chunk("entities/new", 0, 2)])).rejects.toThrow(/not connected/);
      await expect(deps.lance.search(Array.from(vector(1)), 5)).rejects.toThrow(/not connected/);
      await expect(deps.lance.warmup()).rejects.toThrow(/not connected/);
    } finally {
      await deps.lance.close();
      deps.db.close();
    }

    expect(readIndexIdentity(lancePath)?.modelDigest).toBe("digest-old");
    const check = new LanceDBManager({ identity: identity({ modelDigest: "digest-old" }) });
    await check.connect(lancePath);
    expect(await check.getIndexedPageSlugs()).toEqual(["entities/a"]);
    await check.close();
  });

  test("an unreadable digest refuses the online handle and creates nothing", async () => {
    const lancePath = lanceDir("lance-offline");
    const first = new LanceDBManager({ identity: identity({ modelDigest: "digest-current" }) });
    await first.connect(lancePath);
    await first.addChunks([chunk("entities/a", 0, 1)]);
    await first.close();

    tagsResponse = { status: 500 };
    const deps = createDeps(config(), true);
    try {
      // #545 F2: a model that cannot be confirmed gets no handle at all — not
      // even a read, and no table creation or identity backfill.
      await expect(deps.lance.connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_DIGEST_UNAVAILABLE/);
      // A refused connect leaves no usable handle behind (#545 R3).
      await expect(deps.lance.addChunks([chunk("entities/new", 0, 2)])).rejects.toThrow(/not connected/);
      await expect(deps.lance.search(Array.from(vector(1)), 5)).rejects.toThrow(/not connected/);
      await expect(deps.lance.warmup()).rejects.toThrow(/not connected/);
    } finally {
      await deps.lance.close();
      deps.db.close();
    }

    expect(readIndexIdentity(lancePath)?.modelDigest).toBe("digest-current");
    const check = new LanceDBManager({ identity: identity({ modelDigest: "digest-current" }) });
    await check.connect(lancePath);
    expect(await check.getIndexedPageSlugs()).toEqual(["entities/a"]);
    await check.close();
  });

  test("every connect resolves the digest again, so a swap between sessions is caught", async () => {
    const lancePath = lanceDir("lance-reconnect");
    const deps = createDeps(config(), true);
    try {
      await deps.lance.connect(lancePath);
      await deps.lance.addChunks([chunk("entities/a", 0, 1)]);
      expect(tagsCalls).toBe(1);
      await deps.lance.close();

      // #545 F3: the resolved digest must not survive a close/connect cycle.
      tagsResponse = { status: 200, digest: "digest-swapped" };
      await expect(deps.lance.connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_MISMATCH/);
      expect(tagsCalls).toBe(2);
      await expect(deps.lance.addChunks([chunk("entities/b", 0, 2)])).rejects.toThrow(/not connected/);

      // Recovery: once the confirmed model is back, reconnect works again.
      tagsResponse = { status: 200, digest: "digest-current" };
      await deps.lance.connect(lancePath);
      expect(await deps.lance.getIndexedPageSlugs()).toEqual(["entities/a"]);
      expect(tagsCalls).toBe(3);
    } finally {
      await deps.lance.close();
      deps.db.close();
    }

    expect(readIndexIdentity(lancePath)?.modelDigest).toBe("digest-current");
  });

  test("a provider without a digest endpoint never talks to the model management API", async () => {
    const lancePath = lanceDir("lance-deterministic");
    const deps = createDeps({
      vaultPath: join(root, "vault"),
      dbPath: join(root, "det.sqlite"),
      lancePath,
      runtimePath: join(root, "runtime"),
      embedding: { provider: "deterministic" },
    }, true);
    try {
      await deps.lance.connect(lancePath);
      await deps.lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: vector(1, 2048) }]);
      expect((await deps.lance.getIndexedPageSlugs())).toEqual(["entities/a"]);
      await expect(deps.lance.addChunks([{ pageSlug: "entities/b", chunkIndex: 0, content: "beta", vector: vector(2, 1024) }]))
        .rejects.toThrow(/VECTOR_DIMENSION_MISMATCH/);
    } finally {
      await deps.lance.close();
      deps.db.close();
    }

    expect(tagsCalls).toBe(0);
    expect(readIndexIdentity(lancePath)?.modelDigest).toBeUndefined();
  });
});
