import { describe, test, expect } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";

// #448: the HTTP watcher must honor the NER configuration already resolved by
// createDeps (ner.enabled + ner.llm_provider). These tests run a REAL
// `serve --http` subprocess against an anonymous temp vault with deterministic
// embedding and a local fake LLM endpoint that counts requests — zero external
// network calls. Anonymous fixtures only (实体A/实体B/主题D), per privacy rules.

const PROJECT_ROOT = process.cwd();
const NOTE_FILE = "topic-d-note.md";
// canonicalSlug() namespaces record-type pages under records/ on first sync
// (the file itself is physically relocated via rename).
const NOTE_SLUG = "records/topic-d-note";

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close(() => reject(new Error("Failed to get port")));
      }
    });
    s.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

/** Deterministic teardown: SIGTERM, bounded wait, SIGKILL fallback. Safe on an
 * already-exited child. Every test calls this in finally BEFORE removing the
 * temp dir / stopping the fake endpoint, so no orphaned serve processes. */
async function killServe(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 10_000);
}

interface FakeLlmRequest {
  path: string;
  auth: string;
  model: string;
}

/** Local fake LLM endpoint: counts /chat/completions requests and returns a
 * valid empty NER extraction so the sync pipeline completes cleanly. */
function startFakeLlm(requests: FakeLlmRequest[]): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body: Record<string, unknown> = await req.json().catch(() => ({}));
      requests.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization") ?? "",
        model: typeof body.model === "string" ? body.model : "",
      });
      return Response.json({
        choices: [{
          message: { content: JSON.stringify({ entities: [], events: [], facts: [] }) },
          finish_reason: "stop",
        }],
      });
    },
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("fake LLM endpoint: no port assigned");
  }
  return { port: server.port, stop: () => server.stop(true) };
}

function writeNote(vaultPath: string, body: string): void {
  writeFileSync(
    join(vaultPath, NOTE_FILE),
    `---\nslug: topic-d-note\ntype: record\ntitle: 主题D笔记\n---\n\n${body}\n`,
  );
}

interface NerConfig {
  enabled?: boolean;
  llm_provider?: string;
  llm_api_key?: string;
  llm_base_url?: string;
  ingest_mode?: "sync" | "defer" | "off";
}

interface TestEnv {
  testDir: string;
  vaultPath: string;
  dbPath: string;
  configPath: string;
  pidFile: string;
  watcherLockFile: string;
}

/** Random temp dir per run — never a fixed shared path. */
function setupTestDir(tag: string, ner: NerConfig): TestEnv {
  const testDir = mkdtempSync(join(tmpdir(), `cbrain-448-${tag}-`));
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "brain.sqlite");
  const lancePath = join(testDir, "lancedb");
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(lancePath, { recursive: true });
  const configPath = join(testDir, "cbrain.json");
  writeFileSync(configPath, JSON.stringify({
    vaultPath,
    dbPath,
    lancePath,
    embedding: { provider: "deterministic" },
    ner,
  }));
  return {
    testDir, vaultPath, dbPath, configPath,
    pidFile: join(testDir, "cbrain-http.pid"),
    watcherLockFile: join(testDir, ".watcher.lock"),
  };
}

function spawnServe(env: TestEnv, port: number): ChildProcess {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CBRAIN_CONFIG: env.configPath,
    // hermetic: block any host ZHIPU_API_KEY from leaking into the child
    ZHIPU_API_KEY: "",
  };
  delete childEnv.CBRAIN_INGEST_NER_MODE; // config file drives ingest_mode here
  return spawn("bun", [
    join(PROJECT_ROOT, "src/cli/index.ts"),
    "serve", "--http", "--port", String(port),
  ], { cwd: env.testDir, stdio: "pipe", env: childEnv });
}

interface PageRow {
  content_hash: string | null;
  file_path: string | null;
}

/** Read-only peek while serve owns the DB (WAL). Returns null on miss OR on a
 * transient busy/lock error so poll loops can retry. */
function readPageRow(dbPath: string): PageRow | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.query("SELECT content_hash, file_path FROM pages WHERE slug = ?").get(NOTE_SLUG) as PageRow | undefined) ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readNerBackfillJobs(dbPath: string): Array<{ data: string }> {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query("SELECT data FROM jobs WHERE name = 'ner-backfill'").all() as Array<{ data: string }>;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Poll until the watcher's first scan has indexed the note (row present). */
async function waitForFirstScan(dbPath: string, timeoutMs = 20_000): Promise<PageRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = readPageRow(dbPath);
    if (row !== null) return row;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Poll until the page's content hash advances (the change scan committed).
 * The watcher polls the vault every 30s, so the deadline must cover a full
 * cycle. Returns true if the hash changed within the deadline. */
async function waitForRescan(dbPath: string, firstHash: string | null, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = readPageRow(dbPath);
    if (row !== null && row.content_hash !== null && row.content_hash !== firstHash) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Poll until a ner-backfill job row lands (defer mode positive control). */
async function waitForNerJobs(dbPath: string, timeoutMs = 15_000): Promise<Array<{ data: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = readNerBackfillJobs(dbPath);
    if (jobs.length > 0) return jobs;
    await new Promise((r) => setTimeout(r, 300));
  }
  return [];
}

/** SIGTERM shutdown hygiene (AC #4): exit 0, locks released, port rebindable. */
async function expectCleanShutdown(child: ChildProcess, env: TestEnv, port: number): Promise<void> {
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
  child.kill("SIGTERM");
  const exitCode = await waitForExit(child);
  if (existsSync(env.pidFile)) {
    const pid = parseInt(readFileSync(env.pidFile, "utf-8").trim(), 10);
    if (pid === child.pid) throw new Error("pid lock not released");
  }
  if (existsSync(env.watcherLockFile)) {
    const owner = JSON.parse(readFileSync(env.watcherLockFile, "utf-8")) as { pid: number };
    if (owner.pid === child.pid) throw new Error("watcher lock not released");
  }
  const rebound = await new Promise<boolean>((resolve) => {
    try {
      const s = Bun.serve({ port, hostname: "127.0.0.1", fetch() { return new Response("ok"); } });
      s.stop(true);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
  if (!rebound) throw new Error("port not rebindable after shutdown");
  if (exitCode !== 0) throw new Error(`unclean exit code ${exitCode}; stderr:\n${stderr}`);
}

describe("watcher NER config (issue #448)", () => {
  test("ner.enabled=false with key present: first scan AND file change make zero LLM requests; clean shutdown", async () => {
    const requests: FakeLlmRequest[] = [];
    const fakeLlm = startFakeLlm(requests);
    const env = setupTestDir("disabled", {
      enabled: false,
      llm_api_key: "test-ner-key-448",
      llm_base_url: `http://127.0.0.1:${fakeLlm.port}`,
    });
    let child: ChildProcess | undefined;
    try {
      writeNote(env.vaultPath, "关于主题D的记录，提及实体A与实体B。");
      const port = await getAvailablePort();
      child = spawnServe(env, port);
      let stderr = "";
      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

      expect(await waitForHealth(port)).toBe(true);

      // wait for the first scan to complete (page indexed) before changing anything
      const first = await waitForFirstScan(env.dbPath);
      expect(first).not.toBeNull();

      // First sync physically relocated the root note to its canonical path
      // (records/). Modify THAT file — writing back at the root would create a
      // same-title duplicate, not a change.
      expect(first!.file_path).not.toBeNull();
      const canonicalFile = join(env.vaultPath, first!.file_path!);
      expect(existsSync(canonicalFile)).toBe(true);
      writeFileSync(canonicalFile, `---\nslug: topic-d-note\ntype: record\ntitle: 主题D笔记\n---\n\n关于主题D的更新记录，提及实体C。\n`);

      // the change is picked up by the next poll cycle (POLL_MS=30s)
      expect(await waitForRescan(env.dbPath, first!.content_hash)).toBe(true);

      // AC #1: zero LLM requests across first scan AND file change
      expect(requests.length).toBe(0);

      // startup log must report the watcher NER as disabled despite the key existing
      expect(stderr).toMatch(/Watcher NER: DISABLED/);

      await expectCleanShutdown(child, env, port);
    } finally {
      if (child) await killServe(child);
      fakeLlm.stop();
      rmSync(env.testDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("enabled=true honors llm_provider: watcher NER requests use the selected provider (deepseek), matching createDeps", async () => {
    const requests: FakeLlmRequest[] = [];
    const fakeLlm = startFakeLlm(requests);
    // No llm_model set: the provider DEFAULT model in the request body is the
    // discriminator — zhipu (glm-4-flash) vs deepseek (deepseek-v4-flash).
    const env = setupTestDir("provider", {
      enabled: true,
      llm_provider: "deepseek",
      llm_api_key: "test-ner-key-448",
      llm_base_url: `http://127.0.0.1:${fakeLlm.port}`,
    });
    let child: ChildProcess | undefined;
    try {
      writeNote(env.vaultPath, "关于主题D的记录，提及实体A与实体B。");
      const port = await getAvailablePort();
      child = spawnServe(env, port);
      let stderr = "";
      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

      expect(await waitForHealth(port)).toBe(true);
      expect(stderr).toMatch(/Watcher NER: enabled/);

      // first scan runs NER in sync mode → poll until the fake endpoint is hit
      const deadline = Date.now() + 20_000;
      while (requests.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }

      // AC #2: same provider resolution as createDeps (deepseek, not zhipu)
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].path).toBe("/chat/completions");
      expect(requests[0].auth).toBe("Bearer test-ner-key-448");
      expect(requests[0].model).toBe("deepseek-v4-flash");

      await expectCleanShutdown(child, env, port);
    } finally {
      if (child) await killServe(child);
      fakeLlm.stop();
      rmSync(env.testDir, { recursive: true, force: true });
    }
  }, 45_000);

  test("ingest_mode=defer: watcher queues a ner-backfill job and makes zero direct LLM requests", async () => {
    const requests: FakeLlmRequest[] = [];
    const fakeLlm = startFakeLlm(requests);
    const env = setupTestDir("defer", {
      enabled: true,
      llm_api_key: "test-ner-key-448",
      llm_base_url: `http://127.0.0.1:${fakeLlm.port}`,
      ingest_mode: "defer",
    });
    let child: ChildProcess | undefined;
    try {
      writeNote(env.vaultPath, "关于主题D的记录，提及实体A与实体B。");
      const port = await getAvailablePort();
      child = spawnServe(env, port);

      expect(await waitForHealth(port)).toBe(true);

      // first scan indexes the page and queues the deferred NER job
      expect(await waitForFirstScan(env.dbPath)).not.toBeNull();
      const jobs = await waitForNerJobs(env.dbPath);
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs.some((j) => j.data.includes("topic-d-note"))).toBe(true);

      // defer semantics: no synchronous LLM extraction during sync
      expect(requests.length).toBe(0);

      await expectCleanShutdown(child, env, port);
    } finally {
      if (child) await killServe(child);
      fakeLlm.stop();
      rmSync(env.testDir, { recursive: true, force: true });
    }
  }, 45_000);

  test("ingest_mode=off: no NER requests, no ner-backfill jobs; page still syncs", async () => {
    const requests: FakeLlmRequest[] = [];
    const fakeLlm = startFakeLlm(requests);
    const env = setupTestDir("off", {
      enabled: true,
      llm_api_key: "test-ner-key-448",
      llm_base_url: `http://127.0.0.1:${fakeLlm.port}`,
      ingest_mode: "off",
    });
    let child: ChildProcess | undefined;
    try {
      writeNote(env.vaultPath, "关于主题D的记录，提及实体A与实体B。");
      const port = await getAvailablePort();
      child = spawnServe(env, port);

      expect(await waitForHealth(port)).toBe(true);

      // positive control: the first scan still indexes the page
      expect(await waitForFirstScan(env.dbPath)).not.toBeNull();
      // off semantics: neither synchronous extraction nor deferred jobs
      await new Promise((r) => setTimeout(r, 2_000));
      expect(requests.length).toBe(0);
      expect(readNerBackfillJobs(env.dbPath).length).toBe(0);

      await expectCleanShutdown(child, env, port);
    } finally {
      if (child) await killServe(child);
      fakeLlm.stop();
      rmSync(env.testDir, { recursive: true, force: true });
    }
  }, 45_000);
});
