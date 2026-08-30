import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createNetServer } from "node:net";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createHttpServer, type Server } from "node:http";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "../..");
const WRAPPER = join(PROJECT_DIR, "bin", "cbrain-maintenance.sh");
const PATROL = join(PROJECT_DIR, "bin", "daily-patrol.sh");
const execFileAsync = promisify(execFile);
/** Bind to port 0, release it, return the now-free (dead) port. */
function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
    s.on("error", reject);
  });
}

function runWrapper(url: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [WRAPPER, "dream"], {
      env: { ...process.env, CBRAIN_MCP_URL: url },
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? "").toString(),
      stderr: (err.stderr ?? "").toString(),
    };
  }
}

/** One recorded /mcp POST: enough to prove session reuse and which tools the
 *  patrol actually invokes — no mock framework, just an array. */
interface FakeRuntimeCall {
  method: string;
  tool: string | null;
  session: string | null;
}

/** Minimal fake CBrain runtime: /health + /mcp (initialize, tools/list,
 *  tools/call status). The status payload is injected so each patrol scenario
 *  controls the lastFullHealth snapshot the script must render. healthDown
 *  makes /health fail while /mcp stays usable (runtime-probe axis vs MCP
 *  axis). Every /mcp POST is recorded (method, tool, session header). */
function startFakeRuntime(opts: {
  statusText: string;
  healthDown?: boolean;
}): Promise<{ server: Server; port: number; calls: FakeRuntimeCall[] }> {
  const { promise, resolve } = Promise.withResolvers<{ server: Server; port: number; calls: FakeRuntimeCall[] }>();
  const calls: FakeRuntimeCall[] = [];
  const server = createHttpServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/health") {
      if (opts.healthDown) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("unhealthy");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }
      return;
    }
    if (req.method === "DELETE" && url === "/mcp") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "POST" && url === "/mcp") {
      let body = "";
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        const rawSession = req.headers["mcp-session-id"];
        calls.push({
          method: msg.method,
          tool: msg.params?.name ?? null,
          session: Array.isArray(rawSession) ? rawSession[0] ?? null : rawSession ?? null,
        });
        const json = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
        };
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "patrol-test-session" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: msg.id ?? null,
            result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake", version: "0" } },
          }));
          return;
        }
        if (msg.method === "tools/list") {
          json({ tools: [{ name: "status" }, { name: "query" }] });
          return;
        }
        if (msg.method === "tools/call" && msg.params?.name === "status") {
          json({ content: [{ type: "text", text: opts.statusText }] });
          return;
        }
        json({});
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    resolve({ server, port, calls });
  });
  return promise;
}

/** Fake repo root satisfying the patrol preflight (package.json + src/cli/index.ts)
 *  without touching the real checkout or an operator vault. */
function makeFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-patrol-repo-"));
  mkdirSync(join(dir, "src", "cli"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fake-cbrain", version: "0.0.0",
    scripts: { "gate:v2-preflight": "exit 0" },
  }));
  // The stub records every spawn's argv (cwd-independent via import.meta.url)
  // so tests can behaviorally prove daily never invokes CLI health/doctor/full
  // suite — only perf-diagnose (#208).
  writeFileSync(
    join(dir, "src", "cli", "index.ts"),
    'import { appendFileSync } from "node:fs";\n'
      + 'appendFileSync(new URL("../../argv.log", import.meta.url), JSON.stringify(process.argv.slice(2)) + "\\n");\n'
      + 'console.log(JSON.stringify({ ok: true }));\n',
  );
  return dir;
}

/** Async on purpose: the fake runtime serves HTTP from THIS process, so the
 *  event loop must stay alive while the patrol runs (execFileSync would
 *  deadlock the fake server and hang every curl). */
async function runPatrol(port: number, repoDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout } = await execFileAsync("bash", [PATROL], {
      env: {
        ...process.env,
        CBRAIN_PORT: String(port),
        CBRAIN_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        CBRAIN_REPO_DIR: repoDir,
        REPO_GATE_TIMEOUT_S: "15",
      },
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? "").toString(),
      stderr: (err.stderr ?? "").toString(),
    };
  }
}

function statusPayload(lastFullHealth: Record<string, unknown>): string {
  return JSON.stringify({
    totalPages: 1, totalLinks: 0, totalChunks: 0, recentNerErrors: 0, topHotnessEntities: [],
    vaultPath: "/anon/vault", watcher: null, quarantineCount: 0,
    quarantine: [{ slug: "entities/anon-private-slug", failCount: 1, lastError: "x", quarantinedAt: "2026-01-01" }],
    bulkPending: { paused: false, pendingCount: 0, threshold: 50, observedChanged: 0, internallyAcknowledged: 0, actionablePending: 0, missingOrStale: 0 },
    lastFullHealth,
  });
}

describe("bin/cbrain-maintenance.sh — single-writer wrapper (#212, #234)", () => {
  test("shell syntax is clean (bash -n)", () => {
    const code = execFileSync("bash", ["-n", WRAPPER], { encoding: "utf-8" });
    expect(code).toBe("");
  });

  test("daily-patrol.sh shell syntax is clean (bash -n)", () => {
    const code = execFileSync("bash", ["-n", PATROL], { encoding: "utf-8" });
    expect(code).toBe("");
  });

  test("fails fast (exit 1) when the service is unavailable — bails at health, never spawns a writer", async () => {
    const port = await deadPort();
    const { code, stderr } = runWrapper(`http://127.0.0.1:${port}/mcp`);
    expect(code).toBe(1);
    // The wrapper distinguishes service-down from protocol failure: a dead port
    // trips the /health probe first and reports "未运行", so it never reaches
    // MCP initialize or tools/call. The wrapper is curl-only by construction
    // (it never execs a CBrain process), so it cannot spawn a competing writer.
    expect(stderr).toContain("未运行");
  });

  test("wrapper is curl-only — never invokes a CBrain CLI process", () => {
    const src = readFileSync(WRAPPER, "utf-8");
    // No non-comment line execs `cbrain ...` (the only runtime interaction is curl).
    const offenders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => /^\s*[a-z]*\s*cbrain\s+(compact|dream|enrich|dedup|discover|sync)\b/.test(l));
    expect(offenders).toEqual([]);
  });

  test("declares X-CBrain-Tool-Profile: maintenance on every MCP request (#260)", () => {
    const src = readFileSync(WRAPPER, "utf-8");
    // Three MCP curl calls: initialize, notifications/initialized, tools/call.
    // Each must carry the profile header so the per-session runtime assigns maintenance.
    const profileHeaders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("X-CBrain-Tool-Profile: maintenance"));
    // initialize + notifications/initialized + tools/call = 3
    expect(profileHeaders.length).toBe(3);
  });
});

describe("bin/daily-patrol.sh — two status axes (#441)", () => {
  const HOUR = 60 * 60 * 1000;
  let repoDir: string;

  beforeAll(() => {
    repoDir = makeFakeRepo();
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  async function withFakeRuntime(
    lastFullHealth: Record<string, unknown>,
    fn: (port: number, calls: FakeRuntimeCall[]) => Promise<void>,
    opts: { healthDown?: boolean } = {},
  ) {
    const { server, port, calls } = await startFakeRuntime({ statusText: statusPayload(lastFullHealth), ...opts });
    try {
      await fn(port, calls);
    } finally {
      server.close();
    }
  }

  test("runtime ok + last full health=fail → exit 0, both axes shown separately", async () => {
    const checkedAt = new Date(Date.now() - HOUR).toISOString();
    await withFakeRuntime({
      availability: "available", checkedAt, overallStatus: "fail", totalIssueCount: 3210, freshness: "fresh",
    }, async (port) => {
      const { code, stdout } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      expect(stdout).toContain("运行健康：正常");
      expect(stdout).toContain(`最近完整知识体检：失败（检查时间 ${checkedAt}，共 3210 条信号）`);
      expect(stdout).toContain("注：知识体检失败不等于服务或检索不可用。");
      // No merged "all healthy" claim
      expect(stdout).not.toContain("系统全部健康");
    });
  });

  test("runtime ok + last full health=pass → two separate passing lines, no blanket label", async () => {
    const checkedAt = new Date(Date.now() - HOUR).toISOString();
    await withFakeRuntime({
      availability: "available", checkedAt, overallStatus: "pass", totalIssueCount: 0, freshness: "fresh",
    }, async (port) => {
      const { code, stdout } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      expect(stdout).toContain("运行健康：正常");
      expect(stdout).toContain(`最近完整知识体检：通过（检查时间 ${checkedAt}，共 0 条信号）`);
    });
  });

  test("missing snapshot → 未验证, fail-closed, never claims data health", async () => {
    await withFakeRuntime({
      availability: "missing", checkedAt: null, overallStatus: null, totalIssueCount: null, freshness: "unknown",
    }, async (port) => {
      const { code, stdout } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      expect(stdout).toContain("最近完整知识体检：未验证");
      expect(stdout).not.toContain("数据健康");
      expect(stdout).not.toContain("知识健康");
    });
  });

  test("stale snapshot (>36h) → 已过期, old verdict not carried as current guarantee", async () => {
    const checkedAt = new Date(Date.now() - 40 * HOUR).toISOString();
    await withFakeRuntime({
      availability: "available", checkedAt, overallStatus: "pass", totalIssueCount: 0, freshness: "stale",
    }, async (port) => {
      const { code, stdout } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      expect(stdout).toContain(`最近完整知识体检：已过期（检查时间 ${checkedAt}，超过 36 小时`);
      expect(stdout).not.toContain("最近完整知识体检：通过");
    });
  });

  test("patrol output never leaks non-scalar status fields (privacy)", async () => {
    const checkedAt = new Date(Date.now() - HOUR).toISOString();
    await withFakeRuntime({
      availability: "available", checkedAt, overallStatus: "warn", totalIssueCount: 5, freshness: "fresh",
    }, async (port) => {
      const { code, stdout, stderr } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      expect(stdout).toContain("最近完整知识体检：警告");
      for (const output of [stdout, stderr]) {
        expect(output).not.toContain("anon-private-slug");
        expect(output).not.toContain("/anon/vault");
      }
    });
  });

  test("invalid/corrupted snapshot → patrol renders 未验证（已损坏）, exit 0", async () => {
    // Mirrors readLastFullHealthSnapshot's invalid projection (corrupted or
    // legacy state.json): cross-layer lock that no field becomes a claim.
    await withFakeRuntime({
      availability: "invalid", checkedAt: null, overallStatus: null, totalIssueCount: null, freshness: "unknown",
    }, async (port) => {
      const { code, stdout } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      expect(stdout).toContain("最近完整知识体检：未验证（记录缺失必要字段或已损坏）");
      expect(stdout).not.toContain("最近完整知识体检：通过");
      expect(stdout).not.toContain("最近完整知识体检：警告");
    });
  });

  test("runtime health down + last full health=pass → status read renders fresh/pass, 运行健康异常, exit 1", async () => {
    // /health fails while /mcp stays usable, so the patrol still performs a
    // real status read: the pass snapshot must be shown AND must not mask the
    // runtime failure (exit stays 1).
    const checkedAt = new Date(Date.now() - HOUR).toISOString();
    await withFakeRuntime({
      availability: "available", checkedAt, overallStatus: "pass", totalIssueCount: 0, freshness: "fresh",
    }, async (port, calls) => {
      const { code, stdout } = await runPatrol(port, repoDir);
      expect(code).toBe(1);
      expect(stdout).toContain("✗ HTTP /health");
      expect(stdout).toContain("运行健康：异常");
      expect(stdout).toContain(`最近完整知识体检：通过（检查时间 ${checkedAt}，共 0 条信号）`);
      expect(stdout).toContain("RESULT: runtime unhealthy");
      // The pass line came from an actual status call, not a default string.
      expect(calls.some((c) => c.method === "tools/call" && c.tool === "status")).toBe(true);
    }, { healthDown: true });
  });

  test("fully down (dead port) → exit 1, both probes fail, knowledge axis stays 未验证", async () => {
    const port = await deadPort();
    const { code, stdout } = await runPatrol(port, repoDir);
    expect(code).toBe(1);
    expect(stdout).toContain("运行健康：异常");
    expect(stdout).toContain("最近完整知识体检：未验证（无法读取）");
    expect(stdout).not.toContain("RESULT: runtime healthy");
  });

  test("one MCP session end-to-end: initialize once, list/status reuse its header, no health call, no CLI health/doctor spawn", async () => {
    const checkedAt = new Date(Date.now() - HOUR).toISOString();
    writeFileSync(join(repoDir, "argv.log"), "");
    await withFakeRuntime({
      availability: "available", checkedAt, overallStatus: "pass", totalIssueCount: 0, freshness: "fresh",
    }, async (port, calls) => {
      const { code } = await runPatrol(port, repoDir);
      expect(code).toBe(0);
      // Exactly one initialize handshake…
      expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1);
      // …and every later MCP call on that connection carries the returned
      // session header (notifications/initialized, tools/list, tools/call).
      for (const c of calls) {
        if (c.method !== "initialize") expect(c.session).toBe("patrol-test-session");
      }
      expect(calls.filter((c) => c.method === "tools/list").map((c) => c.session)).toEqual(["patrol-test-session"]);
      // status is the ONLY tool call — no health, no checkAll, no re-init.
      expect(calls.filter((c) => c.method === "tools/call").map((c) => c.tool)).toEqual(["status"]);
    });
    // Behavioral #208 lock: the only CLI process daily spawns is perf-diagnose —
    const spawns = readFileSync(join(repoDir, "argv.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0][0]).toBe("perf-diagnose");
  });
});
