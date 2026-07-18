import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ANONYMOUS_FIXTURE_MARKERS,
  assertTreeSymlinksContained,
  analyzeHermesHostProjection,
  buildCanaryCaseSpecs,
  buildLiveServiceFingerprint,
  buildHermesChatArgs,
  buildIsolatedHermesEnv,
  buildIsolatedHermesConfig,
  canonicalEvidenceDigest,
  canonicalSnapshotTreeDigest,
  canonicalTreeDigest,
  createHermesRuntimeManifest,
  createHermesRuntimeSnapshot,
  createAnonymousFixtureSnapshot,
  countExactCl100kTokens,
  evaluateCanaryReport,
  buildCanaryToolArguments,
  startObservingMcpProxy,
  runRealHermesProjectionCase,
  runRealHermesCanaryMatrix,
  startDeterministicInferenceStub,
  type CanaryCaseResult,
  type PublicEvidenceManifest,
  type SizePairEvidence,
  verifyHermesRuntimeManifest,
} from "../../bin/lib/hermes-structured-host-canary.js";
import { extractLiveCommandFileCandidates } from "../../bin/lib/hermes-canary-live-fingerprint.js";

const tools = ["query", "deep_recall", "cbrain_recall"] as const;
const branches = ["normal", "empty", "include_raw", "error"] as const;
const modes = ["legacy", "structured"] as const;

function evidenceManifest(): PublicEvidenceManifest {
  const digest = "a".repeat(64);
  return {
    algorithm: "sha256-canonical-json-v1",
    checkpoint_tree_digest: digest,
    checkpoint_blob_count: 42,
    bun_binary_digest: digest,
    bun_version: "1.2.3",
    node_modules_tree_digest: digest,
    node_modules_file_count: 321,
    package_manifest_digest: digest,
    lockfile_digest: digest,
    hermes_runtime_manifest_digest: digest,
    tokenizer_blob_digest: digest,
    fixture_schema_digest: digest,
    semantic_config_template_digest: digest,
    tool_schema_digest: digest,
  };
}

function caseResult(
  mode: (typeof modes)[number],
  tool: (typeof tools)[number],
  branch: (typeof branches)[number],
): CanaryCaseResult {
  const error = branch === "error";
  const structuredSuccess = mode === "structured" && !error;
  const includeRaw = branch === "include_raw";
  const legacyRaw = mode === "legacy" && !error && (tool !== "deep_recall" || includeRaw);
  const auditContract =
    !structuredSuccess || !includeRaw
      ? "none"
      : tool === "query"
        ? "query_locator_metadata"
        : tool === "deep_recall"
          ? "deep_locator_metadata"
          : "frontdoor_routing_metadata";

  return {
    case_id: `${mode}:${tool}:${branch}`,
    mode,
    tool,
    branch,
    runtime_identity_verified: true,
    advertised_tool_verified: true,
    advertised_schema_verified: true,
    cbrain_invocation_count: 1,
    cbrain_call_verified: true,
    mcp_session_verified: true,
    session_cleanup_verified: true,
    case_cleanup_verified: true,
    semantic_config_verified: true,
    host_projection_verified: true,
    round_trip_verified: true,
    result_title_present: branch === "normal" || includeRaw,
    result_body_present: branch === "normal" || includeRaw,
    empty_contract_verified: branch !== "empty" || true,
    error_contract_verified: !error || true,
    legacy_raw_present: legacyRaw,
    default_audit_present: false,
    expected_audit_contract: auditContract,
    audit_contract_verified: true,
    audit_redaction_exercised: !error && structuredSuccess && includeRaw,
    sensitive_input_sent: error,
    direct_error_sensitive_echo_observed: error,
    error_redaction_exercised: error,
    audit_sensitive_exposed: false,
    surface_internal_exposed: false,
    expected_projection_kind: error
      ? "mcp_error_only"
      : structuredSuccess
        ? "result_plus_structured"
        : "legacy_result_only",
    observed_projection_kind: error
      ? "mcp_error_only"
      : structuredSuccess
        ? "result_plus_structured"
        : "legacy_result_only",
    projection_contract_verified: true,
    text_structured_consistent: structuredSuccess ? true : null,
    token_method: "tiktoken_cl100k_base_exact",
    result_text_tokens: 100,
    structured_content_tokens: structuredSuccess ? 20 : 0,
    wrapper_total_tokens: structuredSuccess ? 120 : 110,
    wrapper_total_code_units: structuredSuccess ? 480 : 440,
  };
}

function sizePairs(): SizePairEvidence[] {
  return tools.flatMap((tool) =>
    (["normal", "empty"] as const).map((branch) => ({
      pair_id: `${tool}:${branch}`,
      tool,
      branch,
      ab: {
        order: "legacy_then_structured" as const,
        legacy_tokens: 160,
        structured_tokens: 170,
        legacy_code_units: 640,
        structured_code_units: 680,
      },
      ba: {
        order: "structured_then_legacy" as const,
        legacy_tokens: 161,
        structured_tokens: 169,
        legacy_code_units: 644,
        structured_code_units: 676,
      },
      worst_structured_tokens: 170,
      best_legacy_tokens: 160,
      growth_tokens: 10,
      ratio: 170 / 160,
      absolute_gate_passed: true,
      relative_or_floor_gate_passed: true,
    })),
  );
}

function validInput() {
  const manifest = evidenceManifest();
  return {
    cases: modes.flatMap((mode) => tools.flatMap((tool) => branches.map((branch) => caseResult(mode, tool, branch)))),
    size_pairs: sizePairs(),
    primary_executions: 24,
    size_repetition_executions: 12,
    real_hermes_host: true,
    runtime_snapshot_verified: true,
    cbrain_snapshot_verified: true,
    tokenizer_offline_verified: true,
    live_fingerprint_unchanged: true,
    cleanup_verified: true,
    semantic_answer_quality_not_measured: true,
    evidence_manifest: manifest,
    observed_evidence_manifest: manifest,
    evidence_generation_digest: canonicalEvidenceDigest(manifest),
    rollback_command_id: null,
  } as const;
}

describe("Hermes structured host canary contract", () => {
  test("builds exactly the frozen 24 primary cases", () => {
    const specs = buildCanaryCaseSpecs();
    expect(specs).toHaveLength(24);
    expect(new Set(specs.map((item) => item.case_id)).size).toBe(24);
    expect(specs.filter((item) => item.branch === "error")).toHaveLength(6);
  });

  test("keeps host compatibility separate from blocked rollout readiness", () => {
    const report = evaluateCanaryReport(validInput());
    expect(report.host_compatibility).toBe("compatible");
    expect(report.rollout_readiness).toBe("blocked");
    expect(report.verdict).toBe("no-go");
    expect(report.reason_codes).toEqual(["ROLLBACK_NOT_EXECUTABLE"]);
  });

  test("fails closed when a primary case is missing or a projection contract is false", () => {
    const missing = validInput();
    expect(evaluateCanaryReport({ ...missing, cases: missing.cases.slice(1) }).host_compatibility).toBe("incompatible");

    const broken = validInput();
    const cases = broken.cases.map((item, index) =>
      index === 0 ? { ...item, projection_contract_verified: false } : item,
    );
    expect(evaluateCanaryReport({ ...broken, cases }).host_compatibility).toBe("incompatible");
  });

  test("rejects malformed AB/BA evidence and recomputes growth gates", () => {
    const input = validInput();
    const duplicate = [...input.size_pairs.slice(0, 5), input.size_pairs[0]];
    expect(evaluateCanaryReport({ ...input, size_pairs: duplicate }).host_compatibility).toBe("incompatible");

    const wrongSelector = input.size_pairs.map((pair, index) =>
      index === 0 ? { ...pair, worst_structured_tokens: 169 } : pair,
    );
    expect(evaluateCanaryReport({ ...input, size_pairs: wrongSelector }).host_compatibility).toBe("incompatible");
  });

  test("binds the aggregate digest to the fixed-key public evidence manifest", () => {
    const input = validInput();
    expect(input.evidence_generation_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      evaluateCanaryReport({
        ...input,
        evidence_generation_digest: "b".repeat(64),
      }).host_compatibility,
    ).toBe("incompatible");

    expect(
      evaluateCanaryReport({
        ...input,
        observed_evidence_manifest: {
          ...input.observed_evidence_manifest,
          node_modules_tree_digest: "b".repeat(64),
        },
      }).host_compatibility,
    ).toBe("incompatible");
  });

  test("fails closed on wrong tool correlation, MCP session cleanup, or semantic config", () => {
    const input = validInput();
    for (const field of [
      "cbrain_call_verified",
      "mcp_session_verified",
      "session_cleanup_verified",
      "case_cleanup_verified",
      "semantic_config_verified",
    ] as const) {
      const cases = input.cases.map((item, index) => (index === 0 ? { ...item, [field]: false } : item));
      expect(evaluateCanaryReport({ ...input, cases }).host_compatibility, field).toBe("incompatible");
    }
  });

  test("fails closed on every branch-specific mandatory case field", () => {
    const input = validInput();
    const mutations: Array<{
      name: string;
      select: (item: CanaryCaseResult) => boolean;
      patch: Partial<CanaryCaseResult>;
    }> = [
      { name: "title", select: (item) => item.branch === "normal", patch: { result_title_present: false } },
      { name: "body", select: (item) => item.branch === "normal", patch: { result_body_present: false } },
      { name: "empty", select: (item) => item.branch === "empty", patch: { empty_contract_verified: false } },
      { name: "error", select: (item) => item.branch === "error", patch: { error_contract_verified: false } },
      { name: "raw", select: (item) => item.mode === "legacy", patch: { legacy_raw_present: false } },
      {
        name: "default-audit",
        select: (item) => item.mode === "structured" && item.branch === "normal",
        patch: { default_audit_present: true },
      },
      {
        name: "audit-contract",
        select: (item) => item.mode === "structured" && item.branch === "include_raw",
        patch: { audit_contract_verified: false },
      },
      {
        name: "audit-redaction",
        select: (item) => item.mode === "structured" && item.branch === "include_raw",
        patch: { audit_redaction_exercised: false },
      },
      {
        name: "sensitive-input",
        select: (item) => item.branch === "error",
        patch: { sensitive_input_sent: false },
      },
      {
        name: "direct-echo-evidence",
        select: (item) => item.branch === "error",
        patch: { error_redaction_exercised: false },
      },
      {
        name: "sensitive-surface",
        select: (item) => item.mode === "structured" && item.branch === "normal",
        patch: { audit_sensitive_exposed: true },
      },
      {
        name: "internal-surface",
        select: (item) => item.mode === "structured" && item.branch === "normal",
        patch: { surface_internal_exposed: true },
      },
    ];
    for (const mutation of mutations) {
      let applied = false;
      const cases = input.cases.map((item) => {
        if (applied || !mutation.select(item)) return item;
        applied = true;
        return { ...item, ...mutation.patch };
      });
      expect(applied, mutation.name).toBe(true);
      expect(evaluateCanaryReport({ ...input, cases }).host_compatibility, mutation.name).toBe("incompatible");
    }
  });
});

describe("Hermes runtime isolation contract", () => {
  test("builds the real chat command and exact three-tool config", () => {
    const args = buildHermesChatArgs("匿名受控请求");
    expect(args).toEqual([
      "chat",
      "-q",
      "匿名受控请求",
      "-Q",
      "--cli",
      "--max-turns",
      "4",
      "--ignore-rules",
      "--source",
      "tool",
      "--model",
      "canary-model",
      "--provider",
      "custom",
      "--toolsets",
      "mcp-cbrain_canary",
    ]);

    const config = buildIsolatedHermesConfig({
      inferencePort: 12345,
      mcpPort: 23456,
    });
    expect(config.tools.tool_search.enabled).toBe("off");
    expect(config.plugins.enabled).toEqual([]);
    expect(config.mcp_servers.cbrain_canary.tools.include).toEqual(["query", "deep_recall", "cbrain_recall"]);
    expect(JSON.stringify(config)).not.toContain("0.0.0.0");
  });

  test("constructs an allowlisted child environment without parent secrets", () => {
    const env = buildIsolatedHermesEnv({
      home: "/owned/home",
      hermesHome: "/owned/hermes",
      tempDir: "/owned/tmp",
      tokenizerCache: "/owned/tokenizer",
      managedDir: "/owned/missing-managed",
      openAiApiKey: "synthetic-value",
      path: "/approved/bin:/usr/bin:/bin",
      parentEnv: {
        OPENAI_API_KEY: "real-parent-secret",
        HTTPS_PROXY: "http://outside.invalid",
        HERMES_BUNDLED_PLUGINS: "unexpected",
        PATH: "/host/path",
      },
    });
    expect(env.OPENAI_API_KEY).toBe("synthetic-value");
    expect(env.HERMES_IGNORE_RULES).toBe("1");
    expect(env.PYTHONNOUSERSITE).toBe("1");
    expect(env.TIKTOKEN_CACHE_DIR).toBe("/owned/tokenizer");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HERMES_BUNDLED_PLUGINS).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual([
      "HERMES_HOME",
      "HERMES_IGNORE_RULES",
      "HERMES_MANAGED_DIR",
      "HOME",
      "LANG",
      "LC_ALL",
      "OPENAI_API_KEY",
      "PATH",
      "PYTHONNOUSERSITE",
      "TIKTOKEN_CACHE_DIR",
      "TMPDIR",
    ]);
  });

  test("live-service fingerprint binds process birth identity without exposing commands", () => {
    const first = buildLiveServiceFingerprint([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        started: "Fri Jul 17 10:00:00 2026",
        command: "anonymous hermes gateway",
      },
      {
        pid: 20,
        ppid: 1,
        pgid: 20,
        started: "Fri Jul 17 10:01:00 2026",
        command: "unrelated service",
      },
    ]);
    const same = buildLiveServiceFingerprint([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        started: "Fri Jul 17 10:00:00 2026",
        command: "anonymous hermes gateway",
      },
      {
        pid: 20,
        ppid: 1,
        pgid: 20,
        started: "Fri Jul 17 10:01:00 2026",
        command: "unrelated service",
      },
    ]);
    const drifted = buildLiveServiceFingerprint([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        started: "Fri Jul 17 10:02:00 2026",
        command: "anonymous hermes gateway",
      },
    ]);
    expect(first).toEqual(same);
    expect(first.digest).not.toBe(drifted.digest);
    expect(JSON.stringify(first)).not.toContain("gateway");
    expect(first.relevant_process_count).toBe(1);
  });

  test("discovers quoted and equals-form live config references without exposing command text", () => {
    const existing = new Set(["/private/anonymous wrapper", "/private/anonymous-config", "/private/anonymous-env"]);
    expect(
      extractLiveCommandFileCandidates(
        '"/private/anonymous wrapper" --config=/private/anonymous-config --env-file "/private/anonymous-env"',
        (path) => existing.has(path),
      ).sort(),
    ).toEqual([...existing].sort());
  });

  test("canonical tree digest detects same-revision byte drift and ignores excluded caches", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-runtime-tree-test-"));
    try {
      mkdirSync(join(root, "pkg", "__pycache__"), { recursive: true });
      writeFileSync(join(root, "pkg", "module.py"), "value = 1\n");
      writeFileSync(join(root, "pkg", "__pycache__", "module.pyc"), "cache-one");
      const first = canonicalTreeDigest(root);
      expect(first.file_count).toBe(1);

      writeFileSync(join(root, "pkg", "__pycache__", "module.pyc"), "cache-two");
      expect(canonicalTreeDigest(root)).toEqual(first);

      writeFileSync(join(root, "pkg", "module.py"), "value = 2\n");
      expect(canonicalTreeDigest(root).digest).not.toBe(first.digest);

      const beforeEmptyDirectory = canonicalTreeDigest(root).digest;
      mkdirSync(join(root, "pkg", "empty-runtime-dir"));
      expect(canonicalTreeDigest(root).digest).not.toBe(beforeEmptyDirectory);

      const beforeMode = canonicalTreeDigest(root).digest;
      chmodSync(join(root, "pkg", "module.py"), 0o755);
      expect(canonicalTreeDigest(root).digest).not.toBe(beforeMode);

      symlinkSync("module.py", join(root, "pkg", "module-link.py"));
      const copyRoot = mkdtempSync(join(tmpdir(), "cbrain-runtime-tree-copy-test-"));
      try {
        expect(Bun.spawnSync({ cmd: ["/bin/cp", "-cRp", root, join(copyRoot, "snapshot")] }).exitCode).toBe(0);
        expect(canonicalTreeDigest(join(copyRoot, "snapshot"))).toEqual(canonicalTreeDigest(root));
      } finally {
        rmSync(copyRoot, { recursive: true, force: true });
      }

      const fifo = join(root, "pkg", "runtime-fifo");
      expect(Bun.spawnSync({ cmd: ["/usr/bin/mkfifo", fifo] }).exitCode).toBe(0);
      expect(() => canonicalTreeDigest(root)).toThrow("unsupported runtime tree entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strict execution snapshot digest binds excluded files and permission changes", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-strict-snapshot-digest-"));
    try {
      const envPath = join(root, ".env.synthetic");
      writeFileSync(envPath, "alpha\n", { mode: 0o600 });
      const baseline = canonicalSnapshotTreeDigest(root);
      writeFileSync(envPath, "beta\n", { mode: 0o600 });
      expect(canonicalSnapshotTreeDigest(root).digest).not.toBe(baseline.digest);
      writeFileSync(envPath, "alpha\n");
      chmodSync(envPath, 0o400);
      expect(canonicalSnapshotTreeDigest(root).digest).not.toBe(baseline.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects snapshot symlinks that resolve outside the owned tree", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-contained-tree-test-"));
    const outside = mkdtempSync(join(tmpdir(), "cbrain-outside-tree-test-"));
    try {
      writeFileSync(join(outside, "module.js"), "export default 1\n");
      symlinkSync(join(outside, "module.js"), join(root, "escaped.js"));
      expect(() => assertTreeSymlinksContained(root)).toThrow("snapshot symlink escapes owned tree");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("plan's evidence entry forbids Bun dotenv bootstrap", () => {
    const plan = readFileSync(
      join(import.meta.dir, "../../docs/superpowers/plans/2026-07-17-hermes-structured-host-canary.md"),
      "utf8",
    );
    expect(plan).toContain("--no-env-file");
    expect(plan).toContain("--config=/dev/null");
    expect(plan).toContain("never use `bun run` for evidence");
  });

  test("POSIX entry scrubs the parent before the first Bun process", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-entry-test-"));
    try {
      const fakeBun = join(root, "fake-bun");
      const fakeHermes = join(root, "fake-hermes");
      writeFileSync(
        fakeBun,
        `#!/bin/sh
printf 'ARGS=%s\n' "$*"
printf 'HOME=%s\n' "$HOME"
printf 'TMPDIR=%s\n' "$TMPDIR"
printf 'PARENT_SECRET=%s\n' "\${PARENT_SECRET-unset}"
printf 'BUNFIG=%s\n' "\${BUN_CONFIG_VERBOSE_FETCH-unset}"
exit 0
`,
      );
      writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);
      chmodSync(fakeHermes, 0o755);

      const wrapper = join(import.meta.dir, "../../bin/run-hermes-structured-host-canary.sh");
      const result = Bun.spawnSync({
        cmd: [
          "/bin/sh",
          wrapper,
          "--bun",
          fakeBun,
          "--hermes",
          fakeHermes,
          "--approved-commit",
          "a".repeat(40),
        ],
        cwd: root,
        env: {
          ...process.env,
          HOME: join(root, "parent-home"),
          TMPDIR: join(root, "parent-tmp"),
          PARENT_SECRET: "must-not-cross",
          BUN_CONFIG_VERBOSE_FETCH: "must-not-cross",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain("--no-env-file");
      expect(output).toContain("--config=/dev/null");
      expect(output).not.toContain("must-not-cross");
      expect(output).toContain("PARENT_SECRET=unset");
      expect(output).toContain("BUNFIG=unset");
      expect(output).not.toContain(`HOME=${join(root, "parent-home")}`);
      const isolatedHome = output.match(/^HOME=(.+)$/m)?.[1];
      expect(isolatedHome).toBeDefined();
      expect(existsSync(dirname(isolatedHome as string))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires an externally selected approved evidence commit before Bun starts", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-approval-test-"));
    try {
      const marker = join(root, "bun-ran");
      const fakeBun = join(root, "fake-bun");
      const fakeHermes = join(root, "fake-hermes");
      writeFileSync(fakeBun, `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`);
      writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);
      chmodSync(fakeHermes, 0o755);
      const wrapper = join(import.meta.dir, "../../bin/run-hermes-structured-host-canary.sh");
      const result = Bun.spawnSync({
        cmd: ["/bin/sh", wrapper, "--bun", fakeBun, "--hermes", fakeHermes],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a clean self-consistent checkout that changed the approved manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-approval-drift-"));
    const source = join(root, "source");
    const boot = join(root, "boot");
    const runGit = (...args: string[]): string => {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: source, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, args.join(" ")).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      mkdirSync(join(source, "tests", "fixtures"), { recursive: true });
      mkdirSync(boot);
      writeFileSync(join(source, "tests", "fixtures", "hermes-structured-canary-evidence-manifest.json"), "{}\n");
      writeFileSync(join(source, "package.json"), "{}\n");
      runGit("init", "-q");
      runGit("config", "user.name", "Anonymous Reviewer");
      runGit("config", "user.email", "reviewer@example.invalid");
      runGit("add", ".");
      runGit("commit", "-qm", "approved evidence");
      const approved = runGit("rev-parse", "HEAD");
      writeFileSync(
        join(source, "tests", "fixtures", "hermes-structured-canary-evidence-manifest.json"),
        '{"changed":true}\n',
      );
      runGit("add", ".");
      runGit("commit", "-qm", "alternate evidence");
      const bootstrap = join(import.meta.dir, "../../bin/bootstrap-hermes-structured-host-canary.ts");
      const result = Bun.spawnSync({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: {
          HOME: boot,
          TMPDIR: boot,
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          CBRAIN_CANARY_BOOT_ROOT: boot,
          CBRAIN_CANARY_SOURCE_ROOT: source,
          CBRAIN_CANARY_HERMES_EXEC: join(root, "unused-hermes"),
          CBRAIN_CANARY_PARENT_MANAGED_DIR: "",
          CBRAIN_CANARY_LIVE_HOME: root,
          CBRAIN_CANARY_FAULT: "",
          CBRAIN_CANARY_APPROVED_COMMIT: approved,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString().trim()).toBe(
        '{"schema_version":1,"status":"fatal","code":"BOOTSTRAP_APPROVAL_DRIFT"}',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("kernel lock is released after an ungraceful bootstrap exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-lock-crash-"));
    const source = join(root, "source");
    const boot = join(root, "boot");
    const runGit = (...args: string[]): string => {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: source, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, args.join(" ")).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      mkdirSync(join(source, "tests", "fixtures"), { recursive: true });
      mkdirSync(boot);
      writeFileSync(join(source, "tests", "fixtures", "hermes-structured-canary-evidence-manifest.json"), "{}\n");
      writeFileSync(join(source, "package.json"), "{}\n");
      runGit("init", "-q");
      runGit("config", "user.name", "Anonymous Reviewer");
      runGit("config", "user.email", "reviewer@example.invalid");
      runGit("add", ".");
      runGit("commit", "-qm", "approved evidence");
      const approved = runGit("rev-parse", "HEAD");
      const bootstrap = join(import.meta.dir, "../../bin/bootstrap-hermes-structured-host-canary.ts");
      const baseEnv = {
        HOME: boot,
        TMPDIR: boot,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        CBRAIN_CANARY_BOOT_ROOT: boot,
        CBRAIN_CANARY_SOURCE_ROOT: source,
        CBRAIN_CANARY_HERMES_EXEC: join(root, "unused-hermes"),
        CBRAIN_CANARY_PARENT_MANAGED_DIR: "",
        CBRAIN_CANARY_LIVE_HOME: root,
        CBRAIN_CANARY_APPROVED_COMMIT: approved,
      };
      const holder = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: { ...baseEnv, CBRAIN_CANARY_FAULT: "lock_hold" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Bun.sleep(250);
      const contender = Bun.spawnSync({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: { ...baseEnv, CBRAIN_CANARY_FAULT: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(contender.exitCode).toBe(2);
      expect(contender.stdout.toString()).toContain("CANARY_LOCK_HELD");
      holder.kill("SIGKILL");
      await holder.exited;
      await Bun.sleep(100);
      const retry = Bun.spawnSync({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: { ...baseEnv, CBRAIN_CANARY_FAULT: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(retry.exitCode).toBe(2);
      expect(retry.stdout.toString()).not.toContain("CANARY_LOCK_HELD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bootstrap group TERM cannot release the detached kernel lease before cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-lock-term-"));
    const source = join(root, "source");
    const boot = join(root, "boot");
    const runGit = (...args: string[]): string => {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: source, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, args.join(" ")).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      mkdirSync(join(source, "tests", "fixtures"), { recursive: true });
      mkdirSync(boot);
      writeFileSync(join(source, "tests", "fixtures", "hermes-structured-canary-evidence-manifest.json"), "{}\n");
      writeFileSync(join(source, "package.json"), "{}\n");
      runGit("init", "-q");
      runGit("config", "user.name", "Anonymous Reviewer");
      runGit("config", "user.email", "reviewer@example.invalid");
      runGit("add", ".");
      runGit("commit", "-qm", "approved evidence");
      const approved = runGit("rev-parse", "HEAD");
      const bootstrap = join(import.meta.dir, "../../bin/bootstrap-hermes-structured-host-canary.ts");
      const baseEnv = {
        HOME: boot,
        TMPDIR: boot,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        CBRAIN_CANARY_BOOT_ROOT: boot,
        CBRAIN_CANARY_SOURCE_ROOT: source,
        CBRAIN_CANARY_HERMES_EXEC: join(root, "unused-hermes"),
        CBRAIN_CANARY_PARENT_MANAGED_DIR: "",
        CBRAIN_CANARY_LIVE_HOME: root,
        CBRAIN_CANARY_APPROVED_COMMIT: approved,
      };
      const holder = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: { ...baseEnv, CBRAIN_CANARY_FAULT: "lock_term_hold" },
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      await Bun.sleep(250);
      process.kill(-holder.pid, "SIGTERM");
      await Bun.sleep(100);
      const contender = Bun.spawnSync({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: { ...baseEnv, CBRAIN_CANARY_FAULT: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(contender.stdout.toString()).toContain("CANARY_LOCK_HELD");
      expect(await holder.exited).toBe(2);
      const retry = Bun.spawnSync({
        cmd: [process.execPath, "--no-env-file", "--config=/dev/null", bootstrap],
        cwd: boot,
        env: { ...baseEnv, CBRAIN_CANARY_FAULT: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(retry.stdout.toString()).not.toContain("CANARY_LOCK_HELD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TERM reaches the isolated bootstrap process group and removes outer temporary roots before exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-signal-test-"));
    const before = new Set(readdirSync("/tmp").filter((name) => name.startsWith("cbrain-hermes-structured-")));
    try {
      const childPidPath = join(root, "child-pid");
      const fakeBun = join(root, "fake-bun");
      const fakeHermes = join(root, "fake-hermes");
      writeFileSync(
        fakeBun,
        `#!/bin/sh\n/bin/sleep 30 &\nprintf '%s' "$!" > "${childPidPath}"\nwait\n`,
      );
      writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);
      chmodSync(fakeHermes, 0o755);
      const wrapper = join(import.meta.dir, "../../bin/run-hermes-structured-host-canary.sh");
      const process = Bun.spawn({
        cmd: [
          "/bin/sh",
          wrapper,
          "--bun",
          fakeBun,
          "--hermes",
          fakeHermes,
          "--approved-commit",
          "a".repeat(40),
        ],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      for (let attempt = 0; attempt < 100 && !existsSync(childPidPath); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(childPidPath)).toBe(true);
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      process.kill("SIGTERM");
      expect(await process.exited).toBe(143);
      expect(() => globalThis.process.kill(childPid, 0)).toThrow();
      let after = readdirSync("/tmp").filter(
        (name) => name.startsWith("cbrain-hermes-structured-") && !before.has(name),
      );
      for (let attempt = 0; after.length > 0 && attempt < 40; attempt += 1) {
        await Bun.sleep(50);
        after = readdirSync("/tmp").filter(
          (name) => name.startsWith("cbrain-hermes-structured-") && !before.has(name),
        );
      }
      expect(after).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("real bootstrap rejects unexpected environment before loading the worker", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-real-test-"));
    try {
      const fakeHermes = join(root, "fake-hermes");
      writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeHermes, 0o755);
      const wrapper = join(import.meta.dir, "../../bin/run-hermes-structured-host-canary.sh");
      const result = Bun.spawnSync({
        cmd: [
          "/bin/sh",
          wrapper,
          "--bun",
          process.execPath,
          "--hermes",
          fakeHermes,
          "--fault",
          "bootstrap",
          "--approved-commit",
          "a".repeat(40),
        ],
        cwd: root,
        env: { ...process.env, PARENT_SECRET: "must-not-cross-bootstrap" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString().trim()).toBe(
        '{"schema_version":1,"status":"fatal","code":"INJECTED_BOOTSTRAP_FAULT"}',
      );
      expect(result.stdout.toString()).not.toContain("must-not-cross-bootstrap");
      expect(result.stderr.toString()).not.toContain("must-not-cross-bootstrap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an existing managed scope before Bun can read or rewrite it", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-managed-scope-test-"));
    try {
      const managed = join(root, "managed");
      const envPath = join(managed, ".env");
      const marker = join(root, "bun-ran");
      const fakeBun = join(root, "fake-bun");
      const fakeHermes = join(root, "fake-hermes");
      mkdirSync(managed, { mode: 0o700 });
      writeFileSync(envPath, "MALFORMED LINE MUST STAY BYTE IDENTICAL\n");
      writeFileSync(fakeBun, `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`);
      writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBun, 0o755);
      chmodSync(fakeHermes, 0o755);
      const wrapper = join(import.meta.dir, "../../bin/run-hermes-structured-host-canary.sh");
      const source = readFileSync(wrapper, "utf8");
      expect(source.indexOf("[ ! -e /etc/hermes ]")).toBeLessThan(source.indexOf("/usr/bin/env -i"));
      const result = Bun.spawnSync({
        cmd: [
          "/bin/sh",
          wrapper,
          "--bun",
          fakeBun,
          "--hermes",
          fakeHermes,
          "--approved-commit",
          "a".repeat(40),
        ],
        cwd: root,
        env: { ...process.env, HERMES_MANAGED_DIR: managed },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(readFileSync(envPath, "utf8")).toBe("MALFORMED LINE MUST STAY BYTE IDENTICAL\n");
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ships the independently hashed cl100k_base artifact for offline counting", () => {
    const blob = readFileSync(join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"));
    expect(createHash("sha256").update(blob).digest("hex")).toBe(
      "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
    );
  });

  test("runtime manifest freezes complete Python and venv trees without local paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-runtime-manifest-test-"));
    try {
      const pythonBase = join(root, "private-python-base");
      const venv = join(root, "private-venv");
      const source = join(root, "private-source");
      mkdirSync(join(pythonBase, "lib"), { recursive: true });
      mkdirSync(join(pythonBase, "bin"), { recursive: true });
      mkdirSync(join(venv, "site-packages"), { recursive: true });
      mkdirSync(join(venv, "bin"), { recursive: true });
      mkdirSync(source, { recursive: true });
      writeFileSync(join(pythonBase, "lib", "json.py"), "# stdlib\n");
      writeFileSync(join(pythonBase, "bin", "python3.11"), "anonymous-python-binary\n");
      chmodSync(join(pythonBase, "bin", "python3.11"), 0o755);
      writeFileSync(join(venv, "site-packages", "mcp.py"), "# dependency\n");
      symlinkSync(join(pythonBase, "bin", "python3.11"), join(venv, "bin", "python"));
      symlinkSync("python", join(venv, "bin", "python3"));
      writeFileSync(join(venv, "bin", "hermes"), `#!${join(venv, "bin", "python3")}\n`);
      chmodSync(join(venv, "bin", "hermes"), 0o755);
      writeFileSync(join(venv, "pyvenv.cfg"), `home = ${join(pythonBase, "bin")}\n`);
      writeFileSync(join(source, "runtime.py"), "# frozen source\n");
      expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: source }).exitCode).toBe(0);
      expect(Bun.spawnSync({ cmd: ["git", "add", "runtime.py"], cwd: source }).exitCode).toBe(0);
      expect(
        Bun.spawnSync({
          cmd: [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
          ],
          cwd: source,
        }).exitCode,
      ).toBe(0);
      const sourceCommit = Bun.spawnSync({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: source,
      })
        .stdout.toString()
        .trim();
      const manifest = createHermesRuntimeManifest({
        hermesVersion: "0.18.0",
        sourceRepoRoot: source,
        sourceCommit,
        pythonBaseRoot: pythonBase,
        venvRoot: venv,
        tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
      });
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain(root);
      expect(manifest.python_base.file_count).toBe(2);
      expect(manifest.venv.file_count).toBe(5);
      expect(manifest.aggregate_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(
        verifyHermesRuntimeManifest(manifest, {
          sourceRepoRoot: source,
          pythonBaseRoot: pythonBase,
          venvRoot: venv,
          tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
        }),
      ).toBe(true);

      writeFileSync(join(venv, "site-packages", "mcp.py"), "# changed dependency\n");
      expect(
        verifyHermesRuntimeManifest(manifest, {
          sourceRepoRoot: source,
          pythonBaseRoot: pythonBase,
          venvRoot: venv,
          tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
        }),
      ).toBe(false);
      expect(
        createHermesRuntimeManifest({
          hermesVersion: "0.18.0",
          sourceRepoRoot: source,
          sourceCommit,
          pythonBaseRoot: pythonBase,
          venvRoot: venv,
          tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
        }).aggregate_digest,
      ).not.toBe(manifest.aggregate_digest);

      writeFileSync(join(venv, "site-packages", "mcp.py"), "# dependency\n");
      writeFileSync(join(source, "untracked.py"), "# ignored working-tree drift\n");
      expect(
        verifyHermesRuntimeManifest(manifest, {
          sourceRepoRoot: source,
          pythonBaseRoot: pythonBase,
          venvRoot: venv,
          tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owned process cleanup uses microsecond birth identity and explicit ancestry", () => {
    const source = readFileSync(join(import.meta.dir, "../../bin/lib/hermes-structured-host-canary.ts"), "utf8");
    expect(source).toContain("start_usec");
    expect(source).toContain("start_us");
    expect(source).toContain("identity.ppid");
    expect(source).toContain("identity.pgid");
    expect(source).toContain("captureOwnedDescendants");
  });

  test("worker marker and Hermes install-root preflight fail closed", () => {
    const bootstrap = readFileSync(join(import.meta.dir, "../../bin/bootstrap-hermes-structured-host-canary.ts"), "utf8");
    const worker = readFileSync(join(import.meta.dir, "../../bin/check-hermes-structured-host-canary.ts"), "utf8");
    expect(worker).toContain("worker-commit-marker.tmp");
    expect(worker).toContain("output_sha256");
    expect(bootstrap).toContain("CANARY_WORKER_STATUS_INVALID");
    expect(worker).toContain('name === ".env" || name.startsWith(".env.")');
  });

  test("wrapper SIGKILL is detected by the guardian and removes the owned outer root", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-wrapper-orphan-"));
    const source = join(root, "source");
    const boot = join(root, "boot");
    const childPidPath = join(root, "bootstrap-pid");
    const runGit = (...args: string[]): string => {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: source, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, args.join(" ")).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      mkdirSync(join(source, "tests", "fixtures"), { recursive: true });
      mkdirSync(boot);
      writeFileSync(join(source, "tests", "fixtures", "hermes-structured-canary-evidence-manifest.json"), "{}\n");
      writeFileSync(join(source, "package.json"), "{}\n");
      runGit("init", "-q");
      runGit("config", "user.name", "Anonymous Reviewer");
      runGit("config", "user.email", "reviewer@example.invalid");
      runGit("add", ".");
      runGit("commit", "-qm", "approved evidence");
      const approved = runGit("rev-parse", "HEAD");
      const bootstrap = join(import.meta.dir, "../../bin/bootstrap-hermes-structured-host-canary.ts");
      const command = `/usr/bin/env -i HOME=${boot} TMPDIR=${boot} PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 CBRAIN_CANARY_BOOT_ROOT=${boot} CBRAIN_CANARY_SOURCE_ROOT=${source} CBRAIN_CANARY_HERMES_EXEC=${root}/unused-hermes CBRAIN_CANARY_PARENT_MANAGED_DIR= CBRAIN_CANARY_LIVE_HOME=${root} CBRAIN_CANARY_FAULT=lock_term_hold CBRAIN_CANARY_APPROVED_COMMIT=${approved} ${process.execPath} --no-env-file --config=/dev/null ${bootstrap} >/dev/null 2>/dev/null & echo $! > ${childPidPath}; wait`;
      const wrapper = Bun.spawn({ cmd: ["/bin/sh", "-c", command], stdout: "ignore", stderr: "ignore" });
      for (let attempt = 0; !existsSync(childPidPath) && attempt < 40; attempt += 1) await Bun.sleep(25);
      const bootstrapPid = Number(readFileSync(childPidPath, "utf8").trim());
      expect(Number.isSafeInteger(bootstrapPid)).toBe(true);
      const guardianReady = join(boot, "wrapper-guardian-ready");
      for (let attempt = 0; !existsSync(guardianReady) && attempt < 120; attempt += 1) await Bun.sleep(25);
      expect(existsSync(guardianReady)).toBe(true);
      wrapper.kill("SIGKILL");
      await wrapper.exited;
      for (let attempt = 0; existsSync(boot) && attempt < 120; attempt += 1) await Bun.sleep(50);
      expect(existsSync(boot)).toBe(false);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          process.kill(bootstrapPid, 0);
          await Bun.sleep(25);
        } catch {
          break;
        }
      }
      expect(() => process.kill(bootstrapPid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("cleanup kills a recorded descendant that escapes the Hermes process group", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-hermes-escape-"));
    const marker = join(root, "escaped-marker");
    const fakeHermes = join(root, "fake-hermes");
    writeFileSync(
      fakeHermes,
      `#!/usr/bin/python3\nimport os, time\npid = os.fork()\nif pid == 0:\n    os.setsid()\n    devnull = os.open("/dev/null", os.O_RDWR)\n    for fd in (0, 1, 2):\n        os.dup2(devnull, fd)\n    if devnull > 2:\n        os.close(devnull)\n    time.sleep(1.0)\n    open(${JSON.stringify(marker)}, "w").close()\n    time.sleep(2.0)\n    os._exit(0)\ntime.sleep(0.3)\n`,
    );
    chmodSync(fakeHermes, 0o755);
    const fixture = await createAnonymousFixtureSnapshot();
    const runtime = await fixture.openRuntime("structured", "escaped-descendant");
    try {
      const result = await runRealHermesProjectionCase({
        hermesExecutable: fakeHermes,
        runtime,
        tool: "query",
        branch: "normal",
        timeoutMs: 5_000,
      });
      expect(result.case_cleanup_verified).toBe(true);
      await Bun.sleep(1_100);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await runtime.close();
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("deterministic Chat Completions SSE state machine", () => {
  test("advertises exact tools, correlates one tool message, and emits a digest-bound final marker", async () => {
    const token = "synthetic-bearer-value";
    const nonce = "case-nonce-alpha";
    const toolName = "mcp_cbrain_canary_query";
    const toolArguments = {
      query: "主题Alpha",
      strategy: "fts",
      include_raw: false,
    };
    const tools = ["mcp_cbrain_canary_query", "mcp_cbrain_canary_deep_recall", "mcp_cbrain_canary_cbrain_recall"].map(
      (name) => ({
        type: "function" as const,
        function: {
          name,
          description: "anonymous",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    );
    const stub = startDeterministicInferenceStub({
      token,
      nonce,
      toolName,
      toolArguments,
      expectedTools: tools,
    });
    try {
      const endpoint = `http://127.0.0.1:${stub.port}/v1/chat/completions`;
      const first = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "canary-model",
          stream: true,
          messages: [{ role: "user", content: `controlled ${nonce}` }],
          tools,
        }),
      });
      expect(first.status).toBe(200);
      const firstSse = await first.text();
      expect(firstSse).toContain('finish_reason":"tool_calls');
      expect(firstSse).toContain(toolName);
      const callId = stub.snapshot().model_call_id;
      expect(callId).toMatch(/^call_/);

      const toolContent = JSON.stringify({
        result: "匿名结果正文",
        structuredContent: { schema_version: 1 },
      });
      const second = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "canary-model",
          stream: true,
          messages: [
            { role: "user", content: `controlled ${nonce}` },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(toolArguments),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: callId,
              name: toolName,
              content: toolContent,
            },
          ],
          tools,
        }),
      });
      expect(second.status).toBe(200);
      const finalSse = await second.text();
      expect(finalSse).toContain(stub.snapshot().final_marker as string);
      expect(stub.snapshot().tool_message_count).toBe(1);
      expect(stub.snapshot().complete).toBe(true);
    } finally {
      stub.stop();
    }
  });

  test("fails closed on wrong bearer, non-streaming request, or schema drift", async () => {
    const expectedTools = [
      {
        type: "function" as const,
        function: {
          name: "mcp_cbrain_canary_query",
          description: "anonymous",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ];
    const stub = startDeterministicInferenceStub({
      token: "expected-token",
      nonce: "nonce-beta",
      toolName: "mcp_cbrain_canary_query",
      toolArguments: { query: "主题Alpha" },
      expectedTools,
    });
    try {
      const endpoint = `http://127.0.0.1:${stub.port}/v1/chat/completions`;
      expect((await fetch(endpoint, { method: "POST", body: "{}" })).status).toBe(401);
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: "Bearer expected-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              stream: false,
              messages: [],
              tools: expectedTools,
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: "Bearer expected-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              stream: true,
              messages: [{ role: "user", content: "nonce-beta" }],
              tools: [
                {
                  ...expectedTools[0],
                  function: {
                    ...expectedTools[0].function,
                    parameters: { type: "string" },
                  },
                },
              ],
            }),
          })
        ).status,
      ).toBe(400);
    } finally {
      stub.stop();
    }
  });

  test("does not accept a real-host schema without an exact frozen definition", () => {
    const names = ["mcp_cbrain_canary_query", "mcp_cbrain_canary_deep_recall", "mcp_cbrain_canary_cbrain_recall"];
    expect(() =>
      startDeterministicInferenceStub({
        token: "host-schema-token",
        nonce: "host-schema-nonce",
        toolName: names[0],
        toolArguments: {
          query: "alphaquerytoken",
          strategy: "fts",
          include_raw: false,
        },
        expectedToolNames: names,
      }),
    ).toThrow("exact expected tool schemas are required");
  });
});

describe("paired anonymous CBrain fixture and observing MCP proxy", () => {
  test("builds tool-specific branch arguments without transport nonces", () => {
    for (const tool of tools) {
      const normal = buildCanaryToolArguments(tool, "normal");
      const empty = buildCanaryToolArguments(tool, "empty");
      const includeRaw = buildCanaryToolArguments(tool, "include_raw");
      const error = buildCanaryToolArguments(tool, "error");
      expect(JSON.stringify(normal)).toContain(ANONYMOUS_FIXTURE_MARKERS.query);
      expect(JSON.stringify(empty)).toContain(ANONYMOUS_FIXTURE_MARKERS.missing);
      expect(includeRaw.include_raw).toBe(true);
      expect(JSON.stringify(error)).not.toContain("nonce");
      expect(Object.keys(normal)).not.toContain("nonce");
    }
    expect(buildCanaryToolArguments("query", "normal").strategy).toBe("fts");
    expect(buildCanaryToolArguments("deep_recall", "normal")).toMatchObject({
      detail: "brief",
      limit: 3,
    });
    expect(buildCanaryToolArguments("cbrain_recall", "normal")).toEqual({
      query: ANONYMOUS_FIXTURE_MARKERS.query,
      include_raw: false,
    });
  });

  test("parses the real Hermes untrusted wrapper and enforces branch-aware projection contracts", () => {
    const structured = {
      schema_version: 1,
      summary: { status: "ok", count: 1, truncated: false, message: "ok" },
      data: {
        result_count: 1,
        results: [
          {
            title: ANONYMOUS_FIXTURE_MARKERS.title,
            body: ANONYMOUS_FIXTURE_MARKERS.body,
          },
        ],
      },
      audit: {
        raw: {
          results: [{ locator: "records/anonymous-beta" }, { locator: "[redacted]" }],
          search_meta: { strategy: "fts" },
        },
      },
    };
    const hostContent =
      `<untrusted_tool_result source="mcp_cbrain_canary_query">\n` +
      "The following content was retrieved from an external source.\n\n" +
      JSON.stringify({
        result: JSON.stringify({ display: "ok", ...structured }),
        structuredContent: structured,
      }) +
      "\n</untrusted_tool_result>";
    const analysis = analyzeHermesHostProjection(
      {
        case_id: "structured:query:include_raw",
        mode: "structured",
        tool: "query",
        branch: "include_raw",
      },
      hostContent,
    );
    expect(analysis.projection_contract_verified).toBe(true);
    expect(analysis.result_title_present).toBe(true);
    expect(analysis.result_body_present).toBe(true);
    expect(analysis.observed_projection_kind).toBe("result_plus_structured");
    expect(analysis.audit_contract_verified).toBe(true);
    expect(analysis.audit_redaction_exercised).toBe(true);
    expect(analysis.text_structured_consistent).toBe(true);

    const malformed = hostContent.replace("structuredContent", "extraStructuredContent");
    expect(
      analyzeHermesHostProjection(
        {
          case_id: "structured:query:include_raw",
          mode: "structured",
          tool: "query",
          branch: "include_raw",
        },
        malformed,
      ).projection_contract_verified,
    ).toBe(false);
  });

  test("does not count answer markers hidden only in audit and scans all user-visible surfaces", () => {
    const structured = {
      schema_version: 1,
      summary: { status: "ok", count: 1, truncated: false, message: "ok" },
      data: { results: [] },
      audit: {
        raw: {
          results: [
            {
              locator: "records/anonymous-beta",
              snippet: `${ANONYMOUS_FIXTURE_MARKERS.title} ${ANONYMOUS_FIXTURE_MARKERS.body}`,
            },
            { locator: "[redacted]" },
          ],
          search_meta: { strategy: "fts" },
        },
      },
    };
    const inner = {
      schema_version: 1,
      display: "credential=LEAK /private/anonymous/secret",
      summary: structured.summary,
      data: structured.data,
      audit: structured.audit,
    };
    const hostContent =
      `<untrusted_tool_result source="mcp_cbrain_canary_query">\n` +
      "The following content was retrieved from an external source.\n\n" +
      JSON.stringify({
        result: JSON.stringify(inner),
        structuredContent: structured,
      }) +
      "\n</untrusted_tool_result>";
    const analysis = analyzeHermesHostProjection(
      {
        case_id: "structured:query:include_raw",
        mode: "structured",
        tool: "query",
        branch: "include_raw",
      },
      hostContent,
    );
    expect(analysis.result_title_present).toBe(false);
    expect(analysis.result_body_present).toBe(false);
    expect(analysis.surface_internal_exposed).toBe(true);
    expect(analysis.projection_contract_verified).toBe(false);
  });

  test("uses the full model-visible legacy result for completeness and empty leakage", () => {
    const answerByTool = {
      query: {
        display: "ok",
        summary: { status: "ok", count: 1 },
        results: [{ title: ANONYMOUS_FIXTURE_MARKERS.title, body: ANONYMOUS_FIXTURE_MARKERS.body }],
        raw: {},
      },
      deep_recall: {
        display: "ok",
        summary: { status: "ok", count: 1 },
        entities: [{ title: ANONYMOUS_FIXTURE_MARKERS.title, body: ANONYMOUS_FIXTURE_MARKERS.body }],
      },
      cbrain_recall: {
        display: ANONYMOUS_FIXTURE_MARKERS.title,
        summary: { status: "ok", count: 1 },
        raw: { body: ANONYMOUS_FIXTURE_MARKERS.body },
      },
    } as const;
    for (const tool of tools) {
      for (const branch of ["normal", "include_raw"] as const) {
        const inner = structuredClone(answerByTool[tool]) as Record<string, unknown>;
        if (tool === "deep_recall" && branch === "include_raw") inner.raw = {};
        const hostContent =
          `<untrusted_tool_result source="mcp_cbrain_canary_${tool}">\n` +
          `${JSON.stringify({ result: JSON.stringify(inner) })}\n` +
          "</untrusted_tool_result>";
        const analysis = analyzeHermesHostProjection(
          { case_id: `legacy:${tool}:${branch}`, mode: "legacy", tool, branch },
          hostContent,
        );
        expect(analysis.result_title_present, `${tool}:${branch}:title`).toBe(true);
        expect(analysis.result_body_present, `${tool}:${branch}:body`).toBe(true);
        expect(analysis.projection_contract_verified, `${tool}:${branch}:projection`).toBe(true);
      }
    }

    const leakingEmpty =
      '<untrusted_tool_result source="mcp_cbrain_canary_query">\n' +
      JSON.stringify({
        result: JSON.stringify({
          summary: { status: "empty", count: 0 },
          raw: { leaked: ANONYMOUS_FIXTURE_MARKERS.body },
        }),
      }) +
      "\n</untrusted_tool_result>";
    const empty = analyzeHermesHostProjection(
      { case_id: "legacy:query:empty", mode: "legacy", tool: "query", branch: "empty" },
      leakingEmpty,
    );
    expect(empty.result_body_present).toBe(true);
    expect(empty.empty_contract_verified).toBe(false);
    expect(empty.projection_contract_verified).toBe(false);
  });

  test("serves fixed normal and true-empty results from disposable database clones", async () => {
    const fixture = await createAnonymousFixtureSnapshot();
    const runtime = await fixture.openRuntime("structured", "direct-preflight");
    const client = new Client({
      name: "anonymous-preflight",
      version: "0.0.0",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(runtime.endpoint, {
          requestInit: { headers: { "X-CBrain-Tool-Profile": "full" } },
        }),
      );
      for (const tool of tools) {
        const normal = await client.callTool({
          name: tool,
          arguments: buildCanaryToolArguments(tool, "normal"),
        });
        const normalText = JSON.stringify(normal);
        expect(normalText).toContain(ANONYMOUS_FIXTURE_MARKERS.title);
        expect(normalText).toContain(ANONYMOUS_FIXTURE_MARKERS.body);

        const empty = await client.callTool({
          name: tool,
          arguments: buildCanaryToolArguments(tool, "empty"),
        });
        const emptyText = JSON.stringify(empty);
        expect(emptyText).not.toContain(ANONYMOUS_FIXTURE_MARKERS.title);
        expect(emptyText).not.toContain(ANONYMOUS_FIXTURE_MARKERS.body);
        expect(emptyText).toContain("empty");
        expect(emptyText).toMatch(/(?:count|total)[^0-9]{0,8}0/);

        const invalid = await client.callTool({
          name: tool,
          arguments: buildCanaryToolArguments(tool, "error"),
        });
        expect(invalid.isError).toBe(true);
      }
      const vectorProbe = await runtime.lance.search(new Float32Array(2048), 1);
      expect(vectorProbe).toEqual([]);
    } finally {
      await client.close().catch(() => {});
      await runtime.close();
      await fixture.close();
    }
    expect(fixture.removed).toBe(true);
  });

  test("forwards exact bytes and headers while recording only sessions and tools/call metadata", async () => {
    let deleted = false;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const session = request.headers.get("mcp-session-id");
        if (request.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 200 });
        }
        if (session && deleted) return new Response("gone", { status: 404 });
        const bytes = await request.arrayBuffer();
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(session ? {} : { "mcp-session-id": "anonymous-session" }),
            "x-upstream-marker": request.headers.get("x-forward-marker") ?? "missing",
          },
        });
      },
    });
    const proxy = startObservingMcpProxy({
      upstreamUrl: new URL(`http://127.0.0.1:${upstream.port}/mcp`),
    });
    try {
      const initializeBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      const initialized = await fetch(proxy.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forward-marker": "preserved",
        },
        body: initializeBody,
      });
      expect(await initialized.text()).toBe(initializeBody);
      expect(initialized.headers.get("x-upstream-marker")).toBe("preserved");
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "query",
          arguments: { query: ANONYMOUS_FIXTURE_MARKERS.query },
        },
      });
      const called = await fetch(proxy.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "anonymous-session",
        },
        body: callBody,
      });
      expect(await called.text()).toBe(callBody);
      expect(proxy.snapshot()).toEqual({
        initialize_count: 1,
        session_ids: ["anonymous-session"],
        tool_calls: [
          {
            name: "query",
            arguments: { query: ANONYMOUS_FIXTURE_MARKERS.query },
            session_id: "anonymous-session",
          },
        ],
        sensitive_input_sent: false,
        direct_error_sensitive_echo_observed: false,
        stored_body_count: 0,
      });
      const sensitiveCall = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "query",
          arguments: buildCanaryToolArguments("query", "error"),
        },
      });
      const sensitiveResponse = await fetch(proxy.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "anonymous-session",
        },
        body: sensitiveCall,
      });
      expect(await sensitiveResponse.text()).toBe(sensitiveCall);
      const sensitiveSnapshot = proxy.snapshot();
      expect(sensitiveSnapshot.sensitive_input_sent).toBe(true);
      expect(sensitiveSnapshot.direct_error_sensitive_echo_observed).toBe(true);
      expect(sensitiveSnapshot.stored_body_count).toBe(0);
      expect(await proxy.closeSessions()).toBe(true);
      expect(deleted).toBe(true);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });
});

const realHermesTest = process.env.CBRAIN_RUN_REAL_HERMES_CANARY === "1" ? test : test.skip;

function requiredRealEnv(name: "HERMES_EXEC_PATH" | "HERMES_PYTHON_EXEC_PATH"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for real Hermes tests`);
  return value;
}

realHermesTest("counts actual host wrapper strings with the frozen offline cl100k artifact", async () => {
  const counted = await countExactCl100kTokens({
    pythonExecutable: requiredRealEnv("HERMES_PYTHON_EXEC_PATH"),
    tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
    values: ["hello", "你好"],
  });
  expect(counted.counts).toEqual([1, 2]);
  expect(counted.method).toBe("tiktoken_cl100k_base_exact");
  expect(counted.tokenizer_blob_digest).toBe("223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7");
});

realHermesTest(
  "clones the approved Hermes runtime into a read-only relocation-safe snapshot",
  async () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../fixtures/hermes-structured-host-runtime-manifest.json"), "utf8"),
    );
    const hermesExecutable = realpathSync(requiredRealEnv("HERMES_EXEC_PATH"));
    const venvRoot = dirname(dirname(hermesExecutable));
    const sourceRepoRoot = dirname(venvRoot);
    const pythonBaseRoot = dirname(dirname(realpathSync(join(venvRoot, "bin", "python"))));
    const snapshot = await createHermesRuntimeSnapshot({
      manifest,
      sourceRepoRoot,
      pythonBaseRoot,
      venvRoot,
      tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
    });
    try {
      expect(snapshot.identity_verified).toBe(true);
      expect(snapshot.read_only_verified).toBe(true);
      expect(snapshot.hermes_version).toContain("0.18.0");
      expect(snapshot.aggregate_digest).toMatch(/^[a-f0-9]{64}$/);
      const fixture = await createAnonymousFixtureSnapshot();
      const runtime = await fixture.openRuntime("structured", "snapshot-smoke");
      try {
        const projected = await runRealHermesProjectionCase({
          hermesExecutable: snapshot.hermesExecutable,
          runtime,
          tool: "query",
          branch: "normal",
        });
        expect(projected.final_marker_verified).toBe(true);
        expect(snapshot.verifyUnchanged()).toBe(true);
      } finally {
        await runtime.close();
        await fixture.close();
      }
    } finally {
      await snapshot.close();
    }
    expect(snapshot.removed).toBe(true);
  },
  120_000,
);

realHermesTest("real Hermes chat projects one structured query result through the next model turn", async () => {
  const fixture = await createAnonymousFixtureSnapshot();
  const runtime = await fixture.openRuntime("structured", "real-smoke");
  try {
    const result = await runRealHermesProjectionCase({
      hermesExecutable: requiredRealEnv("HERMES_EXEC_PATH"),
      runtime,
      tool: "query",
      branch: "normal",
      timeoutMs: 30_000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.final_marker_verified).toBe(true);
    expect([...result.advertised_tool_names].sort()).toEqual(
      ["mcp_cbrain_canary_query", "mcp_cbrain_canary_deep_recall", "mcp_cbrain_canary_cbrain_recall"].sort(),
    );
    expect(result.tool_calls).toEqual([
      {
        name: "query",
        arguments: buildCanaryToolArguments("query", "normal"),
        session_id: result.session_ids[0],
      },
    ]);
    expect(result.call_correlation_verified).toBe(true);
    expect(result.semantic_config_verified).toBe(true);
    expect(result.case_cleanup_verified).toBe(true);
    expect(result.tool_content).toContain(ANONYMOUS_FIXTURE_MARKERS.title);
    expect(result.tool_content).toContain(ANONYMOUS_FIXTURE_MARKERS.body);
    expect(result.sessions_closed).toBe(true);
    expect(
      analyzeHermesHostProjection(
        {
          case_id: "structured:query:normal",
          mode: "structured",
          tool: "query",
          branch: "normal",
        },
        result.tool_content,
      ).projection_contract_verified,
    ).toBe(true);
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

realHermesTest(
  "real Hermes completes the 24 primary plus 12 AB/BA repetition matrix",
  async () => {
    let runtimeSnapshotChecks = 0;
    let cbrainSnapshotChecks = 0;
    const matrix = await runRealHermesCanaryMatrix({
      hermesExecutable: requiredRealEnv("HERMES_EXEC_PATH"),
      pythonExecutable: requiredRealEnv("HERMES_PYTHON_EXEC_PATH"),
      tokenizerPath: join(import.meta.dir, "../fixtures/cl100k_base.tiktoken"),
      verifyRuntimeSnapshot: () => {
        runtimeSnapshotChecks += 1;
        return true;
      },
      verifyCbrainSnapshot: () => {
        cbrainSnapshotChecks += 1;
        return true;
      },
    });
    expect(matrix.cases).toHaveLength(24);
    expect(matrix.size_pairs).toHaveLength(6);
    expect(matrix.primary_executions).toBe(24);
    expect(matrix.size_repetition_executions).toBe(12);
    expect(runtimeSnapshotChecks).toBe(76);
    expect(cbrainSnapshotChecks).toBe(76);
    expect(matrix.runtime_snapshot_checks_verified).toBe(true);
    expect(matrix.cbrain_snapshot_checks_verified).toBe(true);
    expect(
      matrix.cases.filter((item) => item.branch !== "error").every((item) => item.projection_contract_verified),
    ).toBe(true);
    expect(matrix.cases.filter((item) => item.branch === "error").every((item) => item.error_redaction_exercised)).toBe(
      true,
    );
    expect(matrix.cases.every((item) => item.cbrain_invocation_count === 1)).toBe(true);
    expect(matrix.cases.every((item) => item.cbrain_call_verified && item.mcp_session_verified)).toBe(true);
    expect(
      matrix.cases
        .filter((item) => item.branch === "normal" || item.branch === "include_raw")
        .every((item) => item.result_title_present && item.result_body_present),
    ).toBe(true);
    expect(
      matrix.cases
        .filter((item) => item.branch === "error")
        .every(
          (item) =>
            item.sensitive_input_sent &&
            item.direct_error_sensitive_echo_observed &&
            item.error_redaction_exercised &&
            item.audit_sensitive_exposed &&
            !item.error_contract_verified,
        ),
    ).toBe(true);
    const report = evaluateCanaryReport({
      ...validInput(),
      cases: matrix.cases,
      size_pairs: matrix.size_pairs,
    });
    expect(report.host_compatibility).toBe("incompatible");
    expect(report.reason_codes).toEqual(["CASE_CONTRACT_FAILED", "ROLLBACK_NOT_EXECUTABLE"]);
    expect(matrix.size_pairs.every((pair) => pair.absolute_gate_passed && pair.relative_or_floor_gate_passed)).toBe(
      true,
    );
    expect(matrix.cleanup_verified).toBe(true);
  },
  120_000,
);
