import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ANONYMOUS_FIXTURE_MARKERS,
  buildHermesChatArgs,
  buildIsolatedHermesConfig,
  canonicalEvidenceDigest,
  canonicalTreeDigest,
  captureStableLiveServiceFingerprint,
  createHermesRuntimeSnapshot,
  evaluateCanaryReport,
  runRealHermesCanaryMatrix,
  type HermesRuntimeManifest,
  type PublicEvidenceManifest,
} from "./lib/hermes-structured-host-canary.js";

const ALLOWED_ENV = new Set([
  "HOME", "TMPDIR", "PATH", "LANG", "LC_ALL",
  "CBRAIN_CANARY_SNAPSHOT_ROOT", "CBRAIN_CANARY_ORIGINAL_HERMES",
  "CBRAIN_CANARY_CHECKPOINT_DIGEST", "CBRAIN_CANARY_CHECKPOINT_BLOB_COUNT",
  "CBRAIN_CANARY_FAULT",
]);

function fatal(): never {
  process.stdout.write('{"schema_version":1,"status":"fatal","code":"CANARY_FATAL"}\n');
  process.exit(2);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) fatal();
  return value;
}

try {
  if (Object.keys(process.env).some((key) => !ALLOWED_ENV.has(key))) fatal();
  const snapshotRoot = realpathSync(requiredEnv("CBRAIN_CANARY_SNAPSHOT_ROOT"));
  const originalHermes = realpathSync(requiredEnv("CBRAIN_CANARY_ORIGINAL_HERMES"));
  const checkpointDigest = requiredEnv("CBRAIN_CANARY_CHECKPOINT_DIGEST");
  const checkpointBlobCount = Number(requiredEnv("CBRAIN_CANARY_CHECKPOINT_BLOB_COUNT"));
  if (!/^[a-f0-9]{64}$/.test(checkpointDigest) || !Number.isSafeInteger(checkpointBlobCount) || checkpointBlobCount < 1) fatal();

  const sourceRoot = join(snapshotRoot, "source");
  const nodeModulesRoot = join(sourceRoot, "node_modules");
  const manifestPath = join(sourceRoot, "tests/fixtures/hermes-structured-host-runtime-manifest.json");
  const tokenizerPath = join(sourceRoot, "tests/fixtures/cl100k_base.tiktoken");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as HermesRuntimeManifest;
  const originalVenv = dirname(dirname(originalHermes));
  const originalSource = dirname(originalVenv);
  const originalPythonBase = dirname(dirname(realpathSync(join(originalVenv, "bin", "python"))));

  const hermesSnapshot = await createHermesRuntimeSnapshot({
    manifest,
    sourceRepoRoot: originalSource,
    pythonBaseRoot: originalPythonBase,
    venvRoot: originalVenv,
    tokenizerPath,
  });
  let matrix: Awaited<ReturnType<typeof runRealHermesCanaryMatrix>>;
  let preLive: ReturnType<typeof captureStableLiveServiceFingerprint>;
  try {
    preLive = captureStableLiveServiceFingerprint();
    if (process.env.CBRAIN_CANARY_FAULT === "matrix") throw new Error("injected matrix fault");
    matrix = await runRealHermesCanaryMatrix({
      hermesExecutable: hermesSnapshot.hermesExecutable,
      pythonExecutable: hermesSnapshot.pythonExecutable,
      tokenizerPath,
    });
  } finally {
    await hermesSnapshot.close();
  }
  const postLive = captureStableLiveServiceFingerprint();
  const liveUnchanged = preLive.digest === postLive.digest
    && preLive.relevant_process_count === postLive.relevant_process_count;

  const nodeModules = canonicalTreeDigest(nodeModulesRoot);
  const evidenceManifest: PublicEvidenceManifest = {
    algorithm: "sha256-canonical-json-v1",
    checkpoint_tree_digest: checkpointDigest,
    checkpoint_blob_count: checkpointBlobCount,
    bun_binary_digest: sha256(process.execPath),
    bun_version: Bun.version,
    node_modules_tree_digest: nodeModules.digest,
    node_modules_file_count: nodeModules.file_count,
    package_manifest_digest: sha256(join(sourceRoot, "package.json")),
    lockfile_digest: sha256(join(sourceRoot, "bun.lock")),
    hermes_runtime_manifest_digest: sha256(manifestPath),
    tokenizer_blob_digest: matrix.tokenizer_blob_digest,
    fixture_schema_digest: createHash("sha256").update(JSON.stringify({
      markers: ANONYMOUS_FIXTURE_MARKERS,
      page_type: "note",
      chunk_count: 1,
      vector_rows: 0,
    })).digest("hex"),
    semantic_config_template_digest: createHash("sha256").update(JSON.stringify({
      config: buildIsolatedHermesConfig({ inferencePort: 10_001, mcpPort: 10_002 }),
      args: buildHermesChatArgs("controlled <nonce>"),
    })).digest("hex"),
  };
  const evidenceDigest = canonicalEvidenceDigest(evidenceManifest);
  const report = evaluateCanaryReport({
    cases: matrix.cases,
    size_pairs: matrix.size_pairs,
    primary_executions: matrix.primary_executions,
    size_repetition_executions: matrix.size_repetition_executions,
    real_hermes_host: true,
    runtime_snapshot_verified: true,
    cbrain_snapshot_verified: true,
    tokenizer_offline_verified: true,
    live_fingerprint_unchanged: liveUnchanged,
    cleanup_verified: hermesSnapshot.removed,
    semantic_answer_quality_not_measured: true,
    evidence_manifest: evidenceManifest,
    evidence_generation_digest: evidenceDigest,
    rollback_command_id: null,
  });
  const output = {
    schema_version: 1,
    status: "complete",
    report,
    case_metrics: matrix.cases,
    size_pairs: matrix.size_pairs,
    runtime: {
      cbrain_version: JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version,
      hermes_version: manifest.hermes_version,
      tokenizer_version: matrix.tokenizer_version,
      real_hermes_host: true,
      hermes_snapshot_verified: true,
      cbrain_snapshot_verified: true,
      tokenizer_offline_verified: true,
      live_relevant_process_count: preLive.relevant_process_count,
      live_fingerprint_unchanged: liveUnchanged,
      cleanup_verified: hermesSnapshot.removed,
      semantic_answer_quality_not_measured: true,
    },
  };
  const serialized = JSON.stringify(output);
  if (/(?:\/Users\/|\/home\/|[A-Za-z]:\\|Bearer\s+|api[_-]?key\s*[:=])/i.test(serialized)) fatal();
  process.stdout.write(`${serialized}\n`);
  process.exit(report.verdict === "go" ? 0 : 1);
} catch {
  fatal();
}
