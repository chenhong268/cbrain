#!/usr/bin/env bun
// check-first-recall-gate.ts — Offline first-install-to-first-recall v2.0 release gate
//
// Usage: bun bin/check-first-recall-gate.ts
//
// Proves the packed CLI artifact works end-to-end:
//   init → doctor → mcp-config → skill-pack → ingest → query → migration
//
// Fully offline (uses checkout node_modules via symlink). Mock embedding server on localhost.
// Fully isolated environment. Verified cleanup on ALL paths.
//
// Production dependency install is verified separately by: bun run check:install-network
// v2 release requires BOTH gates to pass.
//
// Test-only controls (env vars, ignored in production):
//   GATE_PROJECT_DIR=<path>     — override project dir (for shadow-project tests)
//   GATE_FAULT_PROVIDER=1       — use unreachable mock URL → ingest/query fail
//   GATE_FAULT_SKIP_INGEST=1    — skip ingest stage → query on empty brain
//   GATE_FAULT_SKILL=1          — delete SKILL.md → skill-pack fails
//   GATE_FAULT_INIT=1           — block init with pre-existing file → init fails
//   GATE_FAULT_VAULT_NESTED=1   — create runtime/ inside vault → artifacts fail
//   GATE_FAULT_MIGRATION_CORRUPT=1 — corrupt migration fixture DB → migration fails
//   GATE_FAULT_MCP_CRED_LEAK=1  — inject credential into report → privacy fail
//   GATE_FORCE_DETERMINISTIC=1  — skip TCP, use in-process deterministic embedding (#204)
//
// Exit codes: 0 = go, 1 = no-go, 2 = fatal error (script bug)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "url";
import { Database } from "bun:sqlite";

// ── Types ──

type GateVerdict = "go" | "no-go";

interface AssertionResult {
  readonly check: string;
  readonly passed: boolean;
  readonly actual: string;
  readonly expected: string;
}

interface StageResult {
  readonly id: string;
  readonly command: string;
  readonly exitCode: number;
  readonly duration_ms: number;
  readonly passed: boolean;
  readonly assertions: ReadonlyArray<AssertionResult>;
}

interface GateReport {
  readonly gate: "first-recall-v2";
  readonly version: string;
  readonly timestamp: string;
  readonly verdict: GateVerdict;
  readonly embedding_mode: "http" | "deterministic";
  readonly stages: ReadonlyArray<StageResult>;
  readonly cleanup: { readonly verified: boolean; readonly path: string };
  readonly duration_ms: number;
}

interface GateResult {
  readonly report: GateReport;
  readonly exitCode: number;
}

interface IsolationContext {
  readonly tmpdir: string;
  readonly homeDir: string;
  readonly bunInstallDir: string;
  readonly brainDir: string;
  configPath: string;
  readonly cwd: string;
}

interface PackResult {
  readonly tarballPath: string;
  readonly pkgDir: string;
  readonly binPath: string;
}

interface MockServer {
  readonly url: string;
  readonly port: number;
  stop(): void;
}

// (#204) How the packed CLI obtains embeddings. http = local mock server
// (preferred, issue requirement); deterministic = in-process provider when a
// localhost TCP listener cannot bind. Neither skips the mock — both are mocks.
type EmbeddingMode =
  | { readonly kind: "http"; readonly mock: MockServer }
  | { readonly kind: "deterministic" };

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
}

// ── Constants ──

const INGEST_TEXT =
  "实体A是一个重要的概念，它与主题B密切相关。方法C是解决这个问题的关键技术路径。";
const INGEST_UNIQUE_TOKEN = "实体a";  // appears in auto-generated slug
const QUERY_TEXT = "实体A 主题B 方法C"; // includes unique token for deterministic recall
const VECTOR_DIM = 2048;
const DETERMINISTIC_VECTOR = Array.from({ length: VECTOR_DIM }, (_, i) =>
  Math.sin(i * 0.001) * 0.5,
);

// ── Mock Embedding Server ──

// (#204) Probe a free localhost port via Node net rather than relying on
// Bun.serve's port:0 auto-allocation, which some environments/Bun versions
// misreport as "Failed to start server. Is port 0 in use?". Resolves to a
// concrete port number handed to Bun.serve.
function findFreeLocalhostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", () => {
      reject(new Error("mock embedding server failed to bind a localhost port"));
    });
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("mock embedding server failed to bind a localhost port"));
      });
    });
  });
}

// (#204) Deterministic, retryable localhost port selection. Probes a free port,
// binds Bun.serve to it, and retries with a fresh probe on transient failure.
// A startup failure surfaces a single sanitized message (no paths/stack/secrets)
// so the release gate stays diagnosable without leaking environment detail.
async function startMockEmbeddingServer(): Promise<MockServer> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const port = await findFreeLocalhostPort();
      const served = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/embeddings" && req.method === "POST") {
            return req.json().then((body: { input?: string[] }) => {
              const inputs = body.input ?? [];
              const data = inputs.map((_, i) => ({
                embedding: DETERMINISTIC_VECTOR,
                index: i,
              }));
              return Response.json({
                data,
                usage: { total_tokens: inputs.length * 10 },
              });
            });
          }
          return new Response("NOT_FOUND", { status: 404 });
        },
      });
      return {
        url: `http://127.0.0.1:${served.port}`,
        port: served.port,
        stop() {
          served.stop();
        },
      };
    } catch {
      // Port probe or Bun.serve failed — retry with a fresh localhost port.
    }
  }
  throw new Error("mock embedding server failed to bind a localhost port");
}

// (#204) Resolve how the packed CLI obtains embeddings.
// Preferred: HTTP mock server on localhost (issue requires a local mock server).
// If a TCP listener cannot bind (some environments reject localhost bind on both
// Bun.serve and node:net), fall back to the in-process deterministic provider
// (embedding.provider="deterministic") — no socket, no HTTP, no creds. This is
// NOT a pass downgrade: embeddings still work and ingest+query still run.
async function resolveEmbeddingMode(): Promise<EmbeddingMode> {
  // ── Test-only: force the deterministic path (simulates a TCP-less env) ──
  if (process.env.GATE_FORCE_DETERMINISTIC === "1") {
    return { kind: "deterministic" };
  }
  // ── Test-only fault: unreachable provider URL → ingest/query fail → no-go ──
  if (process.env.GATE_FAULT_PROVIDER === "1") {
    return { kind: "http", mock: { url: "http://127.0.0.1:1", port: 1, stop() {} } };
  }
  try {
    return { kind: "http", mock: await startMockEmbeddingServer() };
  } catch {
    // TCP listener unavailable — use in-process deterministic embeddings.
    return { kind: "deterministic" };
  }
}

// ── Isolation ──

function createIsolation(): IsolationContext {
  const base = mkdtempSync(join(tmpdir(), "cbrain-gate-"));
  const homeDir = join(base, "home");
  const bunInstallDir = join(base, "bun");
  const brainDir = join(base, "brain");
  const cwd = join(base, "cwd");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(bunInstallDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  return { tmpdir: base, homeDir, bunInstallDir, brainDir, configPath: "", cwd };
}

// Build a CLEAN env for subprocesses — allowlist only, no inherited secrets.
function buildIsolatedEnv(
  ctx: IsolationContext,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  // Only inherit truly safe system vars
  const safeKeys = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TEMP", "TMP", "__CF_USER_TEXT_ENCODING"];
  const inherited: Record<string, string> = {};
  for (const key of safeKeys) {
    if (process.env[key]) inherited[key] = process.env[key]!;
  }

  return {
    ...inherited,
    // PATH: need bun + system tools, but no cbrain bin
    PATH: `${ctx.bunInstallDir}/bin:${process.env.PATH ?? ""}`.split(":")
      .filter((p) => !p.includes("cbrain") || p.includes("cbrain-gate"))
      .join(":"),
    HOME: ctx.homeDir,
    BUN_INSTALL: ctx.bunInstallDir,
    XDG_CONFIG_HOME: join(ctx.homeDir, ".config"),
    XDG_DATA_HOME: join(ctx.homeDir, ".local", "share"),
    XDG_CACHE_HOME: join(ctx.homeDir, ".cache"),
    CBRAIN_CONFIG: ctx.configPath,
    ZHIPU_API_KEY: "gate-test-fake-key",
    // Explicitly clear any inherited provider vars
    ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: "" } : {}),
    ...extraEnv,
  };
}

// ── Pack + Offline Install ──
// Uses checkout node_modules via symlink — fully offline, no network needed.
// Production dependency install is verified by check:install-network separately.

function packAndInstall(projectDir: string, ctx: IsolationContext, version: string): PackResult {
  // Verify checkout has deps
  if (!existsSync(join(projectDir, "node_modules"))) {
    throw new Error("node_modules not found in checkout — run bun install first");
  }

  // Deterministic tarball name: cbrain-{version}.tgz
  const tarballName = `cbrain-${version}.tgz`;
  const tarballInProject = join(projectDir, tarballName);
  let backupPath: string | null = null;

  // Backup pre-existing same-version tarball (if any) — restored in finally
  if (existsSync(tarballInProject)) {
    backupPath = `${tarballInProject}.gate-backup`;
    renameSync(tarballInProject, backupPath);
  }

  try {
    // Pack — always creates cbrain-{version}.tgz in project dir
    execSync("bun pm pack", { cwd: projectDir, encoding: "utf-8", timeout: 30_000 });

    if (!existsSync(tarballInProject)) {
      throw new Error("bun pm pack produced no tarball");
    }

    // Move tarball to isolated dir — never leaves artifacts in project dir
    const packDir = join(ctx.tmpdir, "pack");
    mkdirSync(packDir, { recursive: true });
    const isolatedTarball = join(packDir, tarballName);
    renameSync(tarballInProject, isolatedTarball);

    // Extract
    execSync(`tar -xzf "${isolatedTarball}" -C "${packDir}"`, { encoding: "utf-8" });

    // Find package dir (the extracted directory, not our tarball)
    const entries = readdirSync(packDir).filter((e) => e !== tarballName);
    if (entries.length === 0) throw new Error("tarball was empty");
    const pkgDir = join(packDir, entries[0]);

    // OFFLINE: symlink checkout node_modules — no network needed.
    // Production dependency install is proven by check:install-network separately.
    symlinkSync(join(projectDir, "node_modules"), join(pkgDir, "node_modules"));

    return {
      tarballPath: isolatedTarball,
      pkgDir,
      binPath: join(pkgDir, "src", "cli", "index.ts"),
    };
  } finally {
    // Always restore pre-existing tarball — even on failure
    if (backupPath && existsSync(backupPath)) {
      renameSync(backupPath, tarballInProject);
    }
  }
}

// ── CLI Runner (async — Bun.spawn does NOT block event loop) ──

async function runCli(
  binPath: string,
  args: string[],
  ctx: IsolationContext,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<CliResult> {
  const start = performance.now();
  try {
    const proc = Bun.spawn([process.execPath, "run", binPath, ...args], {
      cwd: ctx.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Race process exit vs timeout — always clear the timer
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        proc.kill();
        reject(new Error(`TIMEOUT after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let exitCode: number;
    try {
      exitCode = await Promise.race([proc.exited, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return { exitCode, stdout, stderr, duration_ms: Math.round(performance.now() - start) };
  } catch (e) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      duration_ms: Math.round(performance.now() - start),
    };
  }
}

// ── Assertion Helpers ──
// Every stage uses assertions.every(a => a.passed) for its verdict — no exceptions.

function assertExitCode(result: CliResult, expected: number): AssertionResult {
  return {
    check: `exit code ${expected}`,
    passed: result.exitCode === expected,
    actual: String(result.exitCode),
    expected: String(expected),
  };
}

function assertExitCodeOkOrWarn(result: CliResult): AssertionResult {
  return {
    check: "exit code 0 or 1 (warn allowed)",
    passed: result.exitCode <= 1,
    actual: String(result.exitCode),
    expected: "0 or 1",
  };
}

function assertJsonField(stdout: string, field: string, expected: unknown): AssertionResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { check: `json.${field} === ${JSON.stringify(expected)}`, passed: false, actual: "JSON parse failed", expected: String(expected) };
  }
  const actual = parsed[field];
  return { check: `json.${field} === ${JSON.stringify(expected)}`, passed: actual === expected, actual: String(actual), expected: String(expected) };
}

function assertJsonParseable(stdout: string, label: string): AssertionResult {
  try {
    JSON.parse(stdout);
    return { check: label, passed: true, actual: "valid JSON", expected: "valid JSON" };
  } catch {
    return { check: label, passed: false, actual: "invalid JSON", expected: "valid JSON" };
  }
}

function assertFieldExists(stdout: string, field: string): AssertionResult {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stdout); } catch {
    return { check: `json has "${field}"`, passed: false, actual: "JSON parse failed", expected: `field "${field}" exists` };
  }
  const val = parsed[field];
  return {
    check: `json has "${field}"`,
    passed: val !== undefined && val !== null && String(val).length > 0,
    actual: val === undefined ? "undefined" : val === null ? "null" : String(val).slice(0, 80),
    expected: `non-empty "${field}"`,
  };
}

function assertContains(haystack: string, needle: string, label: string): AssertionResult {
  return { check: label, passed: haystack.includes(needle), actual: haystack.includes(needle) ? "found" : "not found", expected: `contains "${needle}"` };
}

function assertNotContains(haystack: string, needle: string, label: string): AssertionResult {
  return { check: label, passed: !haystack.includes(needle), actual: haystack.includes(needle) ? "found (bad)" : "not found (good)", expected: `does not contain "${needle}"` };
}

function assertMatches(text: string, pattern: RegExp, label: string): AssertionResult {
  return { check: label, passed: pattern.test(text), actual: pattern.test(text) ? "matched" : "no match", expected: `matches ${pattern}` };
}

/** Derive stage passed from ALL assertions — the single source of truth. */
function verdict(assertions: ReadonlyArray<AssertionResult>): boolean {
  return assertions.every((a) => a.passed);
}

function makeStage(
  id: string,
  command: string,
  result: CliResult,
  assertions: ReadonlyArray<AssertionResult>,
): StageResult {
  return { id, command, exitCode: result.exitCode, duration_ms: result.duration_ms, passed: verdict(assertions), assertions };
}

function makeSyntheticStage(
  id: string,
  assertions: ReadonlyArray<AssertionResult>,
): StageResult {
  return { id, command: "(internal check)", exitCode: verdict(assertions) ? 0 : 1, duration_ms: 0, passed: verdict(assertions), assertions };
}

// ── Config Patching ──

function patchConfig(configPath: string, mode: EmbeddingMode): void {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  if (mode.kind === "deterministic") {
    // (#204) In-process deterministic embeddings: no HTTP server, no TCP, no creds.
    config.embedding.provider = "deterministic";
    config.embedding.apiKey = "gate-test-fake-key";
    delete config.embedding.baseUrl;
  } else {
    config.embedding.provider = "zhipu";
    config.embedding.baseUrl = mode.mock.url;
    config.embedding.apiKey = "gate-test-fake-key";
  }
  config.ner = { enabled: false };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// ── v1.9 Migration Fixture Builder ──
// Creates a minimal SQLite DB with pre-migration schema + data.
// Does NOT use `cbrain init` — schema is built with raw SQL.

const V19_FIXTURE_SLUG = "records/v1-9-fixture";
const V19_FIXTURE_TITLE = "v1.9迁移测试记录";
const V19_FIXTURE_BODY = "组织D在主题B中采用了方法C的核心策略。这段记录来自模拟的v1.9安装。";
const V19_QUERY_TEXT = "组织D 主题B";

function buildV19FixtureDB(dbPath: string, vaultPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(join(vaultPath, "records"), { recursive: true });
  for (const sub of ["entities", "concepts", "insights"]) {
    mkdirSync(join(vaultPath, "brain", sub), { recursive: true });
  }

  // Create DB with v1.9-era base schema (before migrations)
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  // Base tables — minimal v1.9 schema
  db.exec(`CREATE TABLE IF NOT EXISTS pages (
    slug TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT,
    tier INTEGER DEFAULT 3,
    mention_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_slug TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(page_slug, chunk_index)
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(page_slug, content, tokenize='trigram')`);
  db.exec(`CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_slug TEXT NOT NULL,
    to_slug TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'mentions',
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_slug, to_slug, relation)
  )`);

  // Insert fixture data
  db.run("INSERT INTO pages (slug, type, title, file_path) VALUES (?, ?, ?, ?)",
    [V19_FIXTURE_SLUG, "record", V19_FIXTURE_TITLE, `${V19_FIXTURE_SLUG}.md`]);
  db.run("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)",
    [V19_FIXTURE_SLUG, V19_FIXTURE_BODY]);
  db.run("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)",
    [V19_FIXTURE_SLUG, V19_FIXTURE_BODY]);
  db.run("INSERT INTO config (key, value) VALUES ('schema_version', '1')");

  db.close();

  // Create vault markdown file
  const mdPath = join(vaultPath, `${V19_FIXTURE_SLUG}.md`);
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, `---\ntitle: "${V19_FIXTURE_TITLE}"\ntype: record\n---\n\n${V19_FIXTURE_BODY}\n`);
}

// ── Stage 1: init ──

async function runStageInit(binPath: string, ctx: IsolationContext, env: Record<string, string>): Promise<StageResult> {
  const result = await runCli(binPath, ["init", "--dir", ctx.brainDir, "--json"], ctx, env);

  const assertions: AssertionResult[] = [
    assertExitCode(result, 0),
    assertJsonParseable(result.stdout, "init output is valid JSON"),
    assertJsonField(result.stdout, "status", "ok"),
    assertJsonField(result.stdout, "created", true),
  ];

  // Extract configPath and verify it's inside tmpdir
  try {
    const parsed = JSON.parse(result.stdout);
    const cp = parsed.configPath;
    if (typeof cp === "string" && cp.length > 0) {
      ctx.configPath = cp;
      assertions.push(assertContains(cp, ctx.tmpdir, "config path inside tmpdir"));
    } else {
      assertions.push({ check: "configPath present", passed: false, actual: String(cp), expected: "non-empty string" });
    }
  } catch {
    assertions.push({ check: "configPath present", passed: false, actual: "JSON parse failed", expected: "non-empty string" });
  }

  return makeStage("init", "cbrain init --dir <brain> --json", result, assertions);
}

// ── Stage 2: doctor --first-run ──

async function runStageDoctor(binPath: string, ctx: IsolationContext, env: Record<string, string>): Promise<StageResult> {
  const result = await runCli(binPath, ["doctor", "--first-run", "--json"], ctx, env);

  const assertions: AssertionResult[] = [
    assertExitCodeOkOrWarn(result),
    assertJsonParseable(result.stdout, "doctor output is valid JSON"),
    assertFieldExists(result.stdout, "overallStatus"),
    assertFieldExists(result.stdout, "readinessState"),
  ];

  // After init + patching: readiness must be ≥ missing_index (creds are set)
  try {
    const parsed = JSON.parse(result.stdout);
    const rs = parsed.readinessState as string | undefined;
    const validStates = ["missing_index", "service_active", "ready"];
    assertions.push({
      check: "readinessState >= missing_index",
      passed: !!rs && validStates.includes(rs),
      actual: rs ?? "missing",
      expected: "missing_index | service_active | ready",
    });
  } catch {
    assertions.push({ check: "readinessState >= missing_index", passed: false, actual: "parse error", expected: "missing_index | service_active | ready" });
  }

  return makeStage("doctor", "cbrain doctor --first-run --json", result, assertions);
}

// ── Stage 3: mcp-config ──

async function runStageMcpConfig(binPath: string, ctx: IsolationContext, env: Record<string, string>): Promise<StageResult> {
  const result = await runCli(binPath, ["mcp-config"], ctx, env);

  const assertions: AssertionResult[] = [
    assertExitCode(result, 0),
    assertJsonParseable(result.stdout, "mcp-config output is valid JSON"),
  ];

  // Parse JSON and verify structure
  try {
    const parsed = JSON.parse(result.stdout);
    const cbrain = parsed.mcpServers?.cbrain as Record<string, unknown> | undefined;
    assertions.push({
      check: "has mcpServers.cbrain",
      passed: !!cbrain && typeof cbrain === "object",
      actual: cbrain ? "present" : "missing",
      expected: "mcpServers.cbrain object",
    });

    if (cbrain) {
      // command/args must point to installed artifact, not source checkout
      const args = cbrain.args as string[] | undefined;
      const argStr = (args ?? []).join(" ");
      assertions.push(assertContains(argStr, ctx.tmpdir, "CLI args point into installed package"));
      assertions.push(assertNotContains(argStr, "Projects/cbrain", "CLI args not in source checkout"));

      // env must have CBRAIN_CONFIG but NOT contain credentials
      const envObj = cbrain.env as Record<string, string> | undefined;
      assertions.push(assertContains(JSON.stringify(envObj ?? {}), "CBRAIN_CONFIG", "env has CBRAIN_CONFIG"));
      assertions.push(assertNotContains(JSON.stringify(envObj ?? {}), "gate-test-fake-key", "no API key in MCP config env"));
    }
  } catch {
    assertions.push({ check: "mcp-config JSON structure", passed: false, actual: "parse error", expected: "valid structure" });
  }

  return makeStage("mcp-config", "cbrain mcp-config", result, assertions);
}

// ── Stage 4: skill-pack ──

async function runStageSkillPack(binPath: string, ctx: IsolationContext, env: Record<string, string>): Promise<StageResult> {
  const result = await runCli(binPath, ["skill-pack", "--json"], ctx, env);

  const assertions: AssertionResult[] = [
    assertExitCode(result, 0),
    assertJsonParseable(result.stdout, "skill-pack output is valid JSON"),
  ];

  try {
    const parsed = JSON.parse(result.stdout);
    assertions.push({
      check: "verificationStatus is pass",
      passed: parsed.verificationStatus === "pass",
      actual: String(parsed.verificationStatus),
      expected: "pass",
    });
    assertions.push({
      check: "no missing files",
      passed: Array.isArray(parsed.missingFiles) && parsed.missingFiles.length === 0,
      actual: JSON.stringify(parsed.missingFiles),
      expected: "[]",
    });
    // packPath must be inside installed package, not source checkout
    const packPath = String(parsed.packPath ?? "");
    assertions.push(assertContains(packPath, ctx.tmpdir, "packPath inside installed package"));
    assertions.push(assertNotContains(packPath, "Projects/cbrain", "packPath not in source checkout"));
  } catch {
    assertions.push({ check: "skill-pack JSON fields", passed: false, actual: "parse error", expected: "valid fields" });
  }

  return makeStage("skill-pack", "cbrain skill-pack --json", result, assertions);
}

// ── Stage 5: ingest ──

async function runStageIngest(binPath: string, ctx: IsolationContext, env: Record<string, string>): Promise<StageResult> {
  const result = await runCli(binPath, ["ingest", INGEST_TEXT, "--no-ner"], ctx, env, 60_000);

  const assertions: AssertionResult[] = [
    assertExitCode(result, 0),
    assertContains(result.stdout, "✓ Created:", "page created"),
    assertMatches(result.stdout, /records\//, "slug has records/ prefix"),
    assertContains(result.stdout, INGEST_UNIQUE_TOKEN, "output contains unique fixture token"),
    assertNotContains(result.stderr, "Error:", "no stderr errors"),
  ];

  return makeStage("ingest", 'cbrain ingest "..." --no-ner', result, assertions);
}

// ── Stage 6: query ──

async function runStageQuery(binPath: string, ctx: IsolationContext, env: Record<string, string>): Promise<StageResult> {
  const result = await runCli(binPath, ["query", QUERY_TEXT], ctx, env, 60_000);

  const assertions: AssertionResult[] = [
    assertExitCode(result, 0),
    {
      check: "non-empty output",
      passed: result.stdout.trim().length > 0,
      actual: result.stdout.trim().length > 0 ? "has content" : "empty",
      expected: "non-empty",
    },
    assertNotContains(result.stdout, "没有找到相关内容", "results found"),
    // Must recall the specific fixture, not just any records/ match
    assertContains(result.stdout, INGEST_UNIQUE_TOKEN, "query returns our unique fixture token"),
  ];

  return makeStage("query", `cbrain query "${QUERY_TEXT}"`, result, assertions);
}

// ── Stage 7: v1.9 Migration ──
// Creates a DB with pre-migration schema + data, then verifies current CLI can read it.
// Assertions: schema migration ran, integrity check, FK check, idempotent reopen,
// query returns fixture data, vault/runtime separation.

async function runStageMigration(binPath: string, ctx: IsolationContext, env: Record<string, string>, mode: EmbeddingMode): Promise<StageResult> {
  const migrationBrain = join(ctx.tmpdir, "migration-brain");
  const migrationVault = join(migrationBrain, "vault");
  const migrationDbPath = join(migrationBrain, "brain.sqlite");
  const migrationLancePath = join(migrationBrain, "lancedb");
  const migrationRuntime = join(migrationBrain, "runtime");
  mkdirSync(migrationRuntime, { recursive: true });

  // Build v1.9 fixture DB (NOT via init — raw SQL)
  buildV19FixtureDB(migrationDbPath, migrationVault);

  // ── Test-only fault: corrupt the fixture DB ──
  if (process.env.GATE_FAULT_MIGRATION_CORRUPT === "1") {
    // Overwrite DB with garbage — integrity checks must catch this
    writeFileSync(migrationDbPath, "CORRUPTED_DB_DATA_" + "X".repeat(100));
  }

  // Write config pointing to mock server
  const migrationConfig = {
    vaultPath: migrationVault,
    dbPath: migrationDbPath,
    lancePath: migrationLancePath,
    runtimePath: migrationRuntime,
    embedding: mode.kind === "deterministic"
      ? { provider: "deterministic", apiKey: "gate-test-fake-key" }
      : { provider: "zhipu", apiKey: "gate-test-fake-key", baseUrl: mode.mock.url },
    ner: { enabled: false },
  };
  const migrationConfigPath = join(migrationBrain, "cbrain.json");
  writeFileSync(migrationConfigPath, JSON.stringify(migrationConfig, null, 2) + "\n");

  const migrationEnv = { ...env, CBRAIN_CONFIG: migrationConfigPath };

  // Doctor on migrated DB — current code runs migrations on open
  const doctorResult = await runCli(binPath, ["doctor", "--first-run", "--json"], ctx, migrationEnv);

  // Parse doctor output — must have a valid structured status
  let doctorParsed: Record<string, unknown> | null = null;
  try { doctorParsed = JSON.parse(doctorResult.stdout); } catch { /* handled by assertions */ }

  // Query on migrated DB — must find the v1.9 fixture
  const queryResult = await runCli(binPath, ["query", V19_QUERY_TEXT], ctx, migrationEnv, 60_000);

  // Second doctor call — must be idempotent (same result)
  const doctor2Result = await runCli(binPath, ["doctor", "--first-run", "--json"], ctx, migrationEnv);

  // Verify vault/runtime separation on migrated brain
  const vaultOk = !existsSync(join(migrationVault, "brain.sqlite"))
    && !existsSync(join(migrationVault, "lancedb"))
    && !existsSync(join(migrationVault, "runtime"));

  // Post-migration DB integrity checks
  let integrityOk = false;
  let fkOk = false;
  let schemaVersionOk = false;
  let requiredColumnsOk = false;
  let migrationV5Ok = false;

  try {
    const db = new Database(migrationDbPath, { readonly: true });

    // PRAGMA integrity_check
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    integrityOk = integrity?.integrity_check === "ok";

    // PRAGMA foreign_key_check (returns empty if OK)
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    fkOk = Array.isArray(fkViolations) && fkViolations.length === 0;

    // Schema version must exist and v5 migration must have run
    const sv = db.prepare("SELECT value FROM config WHERE key = 'schema_version'").get() as { value: string } | undefined;
    schemaVersionOk = !!sv?.value;

    // Required post-migration columns must exist (links.weight, pages.expires_at, etc.)
    const pageCols = db.prepare("PRAGMA table_info(pages)").all() as { name: string }[];
    const colNames = pageCols.map((c) => c.name);
    requiredColumnsOk = colNames.includes("expires_at") && colNames.includes("confidence_decay");

    // v5 migration marker must exist
    const v5 = db.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | undefined;
    migrationV5Ok = v5?.value === "1";

    db.close();
  } catch {
    // DB open failure — assertions will show false
  }

  const assertions: AssertionResult[] = [
    {
      check: "migration doctor exit 0 or 1",
      passed: doctorResult.exitCode <= 1,
      actual: String(doctorResult.exitCode),
      expected: "0 or 1",
    },
    assertJsonParseable(doctorResult.stdout, "migration doctor output is valid JSON"),
    {
      check: "migration doctor overallStatus is not error",
      passed: !!doctorParsed && doctorParsed.overallStatus !== "error",
      actual: String(doctorParsed?.overallStatus ?? "missing"),
      expected: "non-error status",
    },
    {
      check: "migration query found v1.9 fixture",
      passed: queryResult.exitCode === 0 && queryResult.stdout.includes("组织D"),
      actual: queryResult.exitCode === 0 ? (queryResult.stdout.includes("组织D") ? "found" : "not found") : `exit ${queryResult.exitCode}`,
      expected: "v1.9 fixture content found",
    },
    {
      check: "migration vault/runtime separation",
      passed: vaultOk,
      actual: vaultOk ? "separated" : "leaked",
      expected: "vault has no runtime artifacts",
    },
    {
      check: "PRAGMA integrity_check ok",
      passed: integrityOk,
      actual: integrityOk ? "ok" : "failed",
      expected: "ok",
    },
    {
      check: "PRAGMA foreign_key_check clean",
      passed: fkOk,
      actual: fkOk ? "clean" : "violations found",
      expected: "no violations",
    },
    {
      check: "schema_version exists in config",
      passed: schemaVersionOk,
      actual: schemaVersionOk ? "present" : "missing",
      expected: "present",
    },
    {
      check: "post-migration columns exist (expires_at, confidence_decay)",
      passed: requiredColumnsOk,
      actual: requiredColumnsOk ? "present" : "missing",
      expected: "columns exist",
    },
    {
      check: "migration_v5_raw_to_records marker present",
      passed: migrationV5Ok,
      actual: migrationV5Ok ? "present" : "missing",
      expected: "value '1'",
    },
    {
      check: "second doctor run is idempotent (exit 0)",
      passed: doctor2Result.exitCode === 0,
      actual: String(doctor2Result.exitCode),
      expected: "0",
    },
  ];

  return makeSyntheticStage("migration", assertions);
}

// ── Artifact Checks (recursive vault scan) ──

function runArtifactChecks(ctx: IsolationContext): AssertionResult[] {
  const vaultPath = join(ctx.brainDir, "vault");
  const assertions: AssertionResult[] = [];
  const forbiddenPatterns = [/\.sqlite(-wal|-shm|-journal)?$/, /^lancedb$/i, /^runtime$/i, /^outputs$/i];

  function scan(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(vaultPath, full);
      for (const pat of forbiddenPatterns) {
        if (pat.test(entry)) {
          assertions.push({
            check: `vault has no "${rel}"`,
            passed: false,
            actual: "found (bad)",
            expected: "not found",
          });
          // Don't double-report
          return;
        }
      }
      try { if (statSync(full).isDirectory()) scan(full); } catch { /* skip */ }
    }
  }

  scan(vaultPath);

  if (assertions.length === 0) {
    assertions.push({ check: "vault is clean (recursive scan)", passed: true, actual: "no runtime artifacts", expected: "clean" });
  }

  return assertions;
}

// ── Report Sanitization ──

/** Sanitize paths only (HOME, checkout). Used before privacy detection. */
function sanitizePaths(json: string): string {
  const realHome = process.env.HOME ?? "";
  let sanitized = json;
  if (realHome) sanitized = sanitized.replaceAll(realHome, "<HOME>");
  sanitized = sanitized.replaceAll("Projects/cbrain", "<CHECKOUT>");
  return sanitized;
}

/** Full sanitization: paths + credential redaction. Used for final output. */
function sanitizeForOutput(json: string): string {
  let sanitized = sanitizePaths(json);
  // Redact credential-like patterns — detection is not enough; output must not echo them
  sanitized = sanitized.replace(/sk-[a-f0-9]{8,}/gi, "<REDACTED>");
  return sanitized;
}

// ── Privacy Check ──
// Runs on path-sanitized JSON (credentials NOT yet redacted so we can detect them).

function runPrivacyCheck(pathSanitizedJson: string): AssertionResult[] {
  return [
    {
      check: "no real HOME path in output",
      passed: !pathSanitizedJson.includes("/Users/"),
      actual: pathSanitizedJson.includes("/Users/") ? "found" : "clean",
      expected: "no real home paths",
    },
    {
      check: "no checkout path in output",
      passed: !pathSanitizedJson.includes("Projects/cbrain"),
      actual: pathSanitizedJson.includes("Projects/cbrain") ? "found" : "clean",
      expected: "no checkout paths",
    },
    {
      check: "no credential patterns in output",
      passed: !/sk-[a-f0-9]{8,}/i.test(pathSanitizedJson) && !pathSanitizedJson.includes("Bearer "),
      actual: /sk-[a-f0-9]{8,}/i.test(pathSanitizedJson) ? "found" : "clean",
      expected: "no credential patterns",
    },
    {
      check: "no raw vector arrays in output",
      passed: !/"(0\.\d{4},){10}/.test(pathSanitizedJson),
      actual: /"(0\.\d{4},){10}/.test(pathSanitizedJson) ? "found vectors" : "clean",
      expected: "no raw vectors",
    },
  ];
}

// ── Main Orchestrator ──
// Returns {report, exitCode} — does NOT call process.exit().
// ALL post-isolation work (pack, mock, stages) is inside try/catch/finally.
// Cleanup in finally ALWAYS runs — even on pack/startup failure.
//
// Test-only controls (env vars):
//   GATE_PROJECT_DIR — override project dir (for isolated tests)
//   GATE_FAULT_*     — inject faults at specific points

async function executeGate(): Promise<GateResult> {
  // GATE_PROJECT_DIR allows tests to point the gate at a shadow project
  // without touching the real checkout.
  const projectDir = process.env.GATE_PROJECT_DIR
    ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")).version;
  const gateStart = performance.now();

  const ctx = createIsolation();
  let mock: MockServer | undefined;
  let embeddingMode: EmbeddingMode = { kind: "deterministic" };
  const stages: StageResult[] = [];
  let cleanupVerified = false;

  try {
    // ALL post-isolation work: pack, mock server, stage execution.
    // If ANY step throws, catch records the failure, and finally ALWAYS cleans up.
    const packResult = packAndInstall(projectDir, ctx, version);

    // ── Test-only fault: delete skill file after install ──
    if (process.env.GATE_FAULT_SKILL === "1") {
      const skillFile = join(packResult.pkgDir, "skills", "SKILL.md");
      if (existsSync(skillFile)) rmSync(skillFile, { force: true });
    }

    // (#204) Resolve embedding transport: HTTP mock (preferred) or in-process
    // deterministic fallback when a localhost TCP listener cannot bind.
    embeddingMode = await resolveEmbeddingMode();
    if (embeddingMode.kind === "http") {
      mock = embeddingMode.mock;
    }

    let env = buildIsolatedEnv(ctx);

    // ── Test-only fault: block init with pre-existing file ──
    if (process.env.GATE_FAULT_INIT === "1") {
      writeFileSync(ctx.brainDir, "block-init");
    }

    // Stage 1: init
    const initStage = await runStageInit(packResult.binPath, ctx, env);
    stages.push(initStage);

    // Subsequent stages only if init passed
    if (initStage.passed) {
      patchConfig(ctx.configPath, embeddingMode);
      env = buildIsolatedEnv(ctx);

      stages.push(await runStageDoctor(packResult.binPath, ctx, env));
      stages.push(await runStageMcpConfig(packResult.binPath, ctx, env));
      stages.push(await runStageSkillPack(packResult.binPath, ctx, env));

      // ── Test-only fault: skip ingest → empty brain query ──
      if (process.env.GATE_FAULT_SKIP_INGEST !== "1") {
        stages.push(await runStageIngest(packResult.binPath, ctx, env));
        stages.push(await runStageQuery(packResult.binPath, ctx, env));
      } else {
        // Run query on empty brain — should return no results
        stages.push(await runStageQuery(packResult.binPath, ctx, env));
      }

      stages.push(await runStageMigration(packResult.binPath, ctx, env, embeddingMode));
    }

    // ── Test-only fault: create runtime/ inside vault → artifacts fail ──
    if (process.env.GATE_FAULT_VAULT_NESTED === "1") {
      const nestedRuntime = join(ctx.brainDir, "vault", "runtime");
      mkdirSync(nestedRuntime, { recursive: true });
      writeFileSync(join(nestedRuntime, "leak.txt"), "should not exist");
    }

    // Artifact checks
    stages.push(makeSyntheticStage("artifacts", runArtifactChecks(ctx)));
  } catch (e) {
    stages.push(
      makeSyntheticStage("fatal", [
        {
          check: "no unhandled errors",
          passed: false,
          actual: e instanceof Error ? e.message : String(e),
          expected: "no errors",
        },
      ]),
    );
  } finally {
    // ── Cleanup (ALWAYS runs — even if catch itself throws) ──
    try {
      mock?.stop();
    } catch {
      /* best effort */
    }

    // Tarball is inside ctx.tmpdir — cleaned up with it.
    // Pre-existing tarball was already restored by packAndInstall's inner finally.

    if (existsSync(ctx.tmpdir)) {
      try {
        rmSync(ctx.tmpdir, { recursive: true });
        cleanupVerified = !existsSync(ctx.tmpdir);
      } catch {
        cleanupVerified = false;
      }
    } else {
      cleanupVerified = true;
    }
  }

  // ── Build report ──
  const allStagesPassed = stages.every((s) => s.passed);
  const rawReport: GateReport = {
    gate: "first-recall-v2",
    version,
    timestamp: new Date().toISOString(),
    verdict: allStagesPassed && cleanupVerified ? "go" : "no-go",
    embedding_mode: embeddingMode.kind,
    stages,
    cleanup: { verified: cleanupVerified, path: cleanupVerified ? "<cleaned>" : "<retained>" },
    duration_ms: Math.round(performance.now() - gateStart),
  };

  // ── Test-only fault: inject credential into report for privacy check ──
  // This tests that the gate's privacy + redaction pipeline works end-to-end:
  // detection → redaction → no-go verdict → clean output.
  if (process.env.GATE_FAULT_MCP_CRED_LEAK === "1") {
    const mcpIdx = rawReport.stages.findIndex((s) => s.id === "mcp-config");
    if (mcpIdx >= 0) {
      const stage = rawReport.stages[mcpIdx];
      rawReport.stages[mcpIdx] = {
        ...stage,
        assertions: [
          ...stage.assertions,
          {
            check: "simulated credential leak test",
            passed: true,
            actual: "sk-abcdef1234567890abcdef1234567890",
            expected: "no credentials in output",
          },
        ],
      };
    }
  }

  // Privacy detection on path-sanitized JSON (credentials NOT yet redacted)
  const pathSanitized = sanitizePaths(JSON.stringify(rawReport, null, 2));
  const privacyAssertions = runPrivacyCheck(pathSanitized);
  const privacyPassed = privacyAssertions.every((a) => a.passed);

  // Full sanitization for output: paths + credential redaction
  const fullySanitized = sanitizeForOutput(JSON.stringify(rawReport, null, 2));

  let finalReport: GateReport;
  let finalExitCode: number;

  if (!privacyPassed) {
    const parsed = JSON.parse(fullySanitized);
    parsed.stages = [...parsed.stages, makeSyntheticStage("privacy", privacyAssertions)];
    parsed.verdict = "no-go";
    finalReport = parsed as GateReport;
    finalExitCode = 1;
  } else {
    finalReport = JSON.parse(fullySanitized) as GateReport;
    finalExitCode = rawReport.verdict === "go" ? 0 : 1;
  }

  return { report: finalReport, exitCode: finalExitCode };
}

// ── Top-level: run gate → emit report → set exit code ──
// process.exitCode (not process.exit) lets the runtime clean up naturally.
// Outer catch handles pre-isolation fatal errors only — post-isolation errors
// are handled by try/catch/finally inside executeGate().

executeGate().then(({ report, exitCode }) => {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = exitCode;
}).catch((e) => {
  // Sanitize the fatal error — never echo real paths/stacks/secrets
  let errorDetail = e instanceof Error ? e.message : String(e);
  const realHome = process.env.HOME ?? "";
  if (realHome) errorDetail = errorDetail.replaceAll(realHome, "<HOME>");
  errorDetail = errorDetail.replaceAll("Projects/cbrain", "<CHECKOUT>");
  // Strip any remaining absolute user paths
  errorDetail = errorDetail.replace(/\/Users\/[^\s:"]+/g, "<HOME>/...");
  errorDetail = errorDetail.replace(/\/home\/[^\s:"]+/g, "<HOME>/...");
  errorDetail = errorDetail.replace(/sk-[a-f0-9]{8,}/gi, "<REDACTED>");
  // Strip stack traces — only keep the first line
  errorDetail = errorDetail.split("\n")[0];

  const errorReport = {
    gate: "first-recall-v2",
    verdict: "no-go",
    error: errorDetail,
    cleanup: { verified: false, path: "<unknown>" },
  };
  process.stdout.write(JSON.stringify(errorReport, null, 2) + "\n");
  process.exitCode = 2;
});
