import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

// #544 D1: `cbrain doctor` must probe the provider the config actually selects.
// Each test runs the real CLI against an anonymous temp brain and a LOCAL fake
// Ollama endpoint. No external network, no real knowledge base, no production
// database — the temp brain is created and deleted inside the test.

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const CLI = join(PROJECT_DIR, "src/cli/index.ts");
const DIMS = 1024;

interface FakeOllama {
  port: number;
  stop: () => void;
}

/** Local fake Ollama `/api/embed`. `status !== 200` makes it fail the request. */
function startFakeOllama(status = 200): FakeOllama {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "boom" }), { status });
      }
      const body = (await req.json().catch(() => ({}))) as { input?: string[] };
      const count = body.input?.length ?? 1;
      return Response.json({
        embeddings: Array.from({ length: count }, () => new Array(DIMS).fill(0.02)),
        prompt_eval_count: count,
      });
    },
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("fake Ollama endpoint: no port assigned");
  }
  return { port: server.port, stop: () => void server.stop(true) };
}

/** A port that is bound and then released, so nothing is listening on it. */
function closedPort(): Promise<number> {
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

function writeBrain(dir: string, embedding: Record<string, unknown>): string {
  mkdirSync(join(dir, "vault"), { recursive: true });
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "lancedb"), { recursive: true });
  const dbPath = join(dir, "brain.sqlite");
  new CBrainDB(dbPath).close();
  const configPath = join(dir, "cbrain.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vaultPath: join(dir, "vault"),
      dbPath,
      lancePath: join(dir, "lancedb"),
      runtimePath: join(dir, "runtime"),
      embedding,
      // Keep the LLM/NER probe out of scope for these tests.
      ner: { enabled: false },
    }),
  );
  return configPath;
}

interface DoctorRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async spawn, deliberately: these tests serve the fake Ollama endpoint from
 * THIS process, so a synchronous spawn would block the event loop and the child
 * would hang waiting for a reply this process can no longer send. */
function runDoctor(dir: string, configPath: string): Promise<DoctorRun> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, "doctor"], {
      cwd: dir,
      env: {
        ...process.env,
        CBRAIN_CONFIG: configPath,
        // Hermetic: no host cloud credential may leak into the child.
        ZHIPU_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// A real CLI start plus, on the failure paths, four classified attempts with
// exponential backoff. Bun's 5s default is too tight for that.
const RUN_TIMEOUT_MS = 20_000;

describe("cbrain doctor selects the configured embedding provider (#544)", () => {
  const testDir = "/tmp/cbrain-test-doctor-embedding";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("a local Ollama brain passes without any cloud credential", async () => {
    const fake = startFakeOllama();
    try {
      const configPath = writeBrain(testDir, {
        provider: "ollama",
        baseUrl: `http://127.0.0.1:${fake.port}`,
        model: "qwen3-embedding:0.6b",
      });

      const run = await runDoctor(testDir, configPath);

      expect(run.stdout).toContain("Embed:   ollama qwen3-embedding:0.6b (1024d) ✓");
      expect(run.stdout).toContain("All checks passed ✓");
      expect(run.stderr).not.toContain("ZHIPU_API_KEY not configured");
      expect(run.status).toBe(0);
    } finally {
      fake.stop();
    }
  }, RUN_TIMEOUT_MS);

  test("a failing local Ollama is reported as an embed failure, not a key problem", async () => {
    const port = await closedPort();
    const configPath = writeBrain(testDir, {
      provider: "ollama",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "qwen3-embedding:0.6b",
    });

    const run = await runDoctor(testDir, configPath);

    expect(run.stderr).toContain("Embed:   FAIL");
    expect(run.stderr).not.toContain("ZHIPU_API_KEY not configured");
    expect(run.status).toBe(1);
  }, RUN_TIMEOUT_MS);

  test("a 5xx from the local server is also reported as an embed failure", async () => {
    const fake = startFakeOllama(500);
    try {
      const configPath = writeBrain(testDir, {
        provider: "ollama",
        baseUrl: `http://127.0.0.1:${fake.port}`,
      });

      const run = await runDoctor(testDir, configPath);

      expect(run.stderr).toContain("Embed:   FAIL");
      expect(run.stderr).toContain("500");
      expect(run.status).toBe(1);
    } finally {
      fake.stop();
    }
  }, RUN_TIMEOUT_MS);

  test("an unknown provider fails without probing the local server", async () => {
    const fake = startFakeOllama();
    try {
      const configPath = writeBrain(testDir, {
        provider: "not-a-provider",
        baseUrl: `http://127.0.0.1:${fake.port}`,
      });

      const run = await runDoctor(testDir, configPath);

      expect(run.stderr).toContain('unknown embedding.provider "not-a-provider"');
      expect(run.stdout).not.toContain("1024d");
      expect(run.status).toBe(1);
    } finally {
      fake.stop();
    }
  }, RUN_TIMEOUT_MS);

  test("the cloud path still requires its key (unchanged contract)", async () => {
    const configPath = writeBrain(testDir, { provider: "zhipu" });

    const run = await runDoctor(testDir, configPath);

    expect(run.stderr).toContain("ZHIPU_API_KEY not configured");
    expect(run.status).toBe(1);
  }, RUN_TIMEOUT_MS);
});
