import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ANONYMOUS_FIXTURE_MARKERS,
  buildHermesChatArgs,
  buildIsolatedHermesConfig,
  canonicalEvidenceDigest,
  canonicalSnapshotTreeDigest,
  canonicalTreeDigest,
  assertTreeSymlinksContained,
  captureStableLiveServiceFingerprint,
  createHermesRuntimeSnapshot,
  evaluateCanaryReport,
  runRealHermesCanaryMatrix,
  type HermesRuntimeManifest,
  type PublicEvidenceManifest,
} from "./lib/hermes-structured-host-canary.js";

const ALLOWED_ENV = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "LANG",
  "LC_ALL",
  "CBRAIN_CANARY_SNAPSHOT_ROOT",
  "CBRAIN_CANARY_ORIGINAL_HERMES",
  "CBRAIN_CANARY_CHECKPOINT_DIGEST",
  "CBRAIN_CANARY_CHECKPOINT_BLOB_COUNT",
  "CBRAIN_CANARY_SOURCE_NODE_MODULES_DIGEST",
  "CBRAIN_CANARY_SOURCE_NODE_MODULES_FILE_COUNT",
  "CBRAIN_CANARY_EXECUTION_NODE_MODULES_DIGEST",
  "CBRAIN_CANARY_EXECUTION_NODE_MODULES_FILE_COUNT",
  "CBRAIN_CANARY_EXECUTION_SOURCE_DIGEST",
  "CBRAIN_CANARY_EXECUTION_SOURCE_FILE_COUNT",
  "CBRAIN_CANARY_FAULT",
  "CBRAIN_CANARY_LIVE_HOME",
  "CBRAIN_CANARY_PRE_LIVE_FINGERPRINT",
  "HERMES_MANAGED_DIR",
]);

type FatalStage = "ENV" | "HERMES_SNAPSHOT" | "MATRIX" | "LIVE_POST" | "EVIDENCE" | "SERIALIZATION";
let fatalStage: FatalStage = "ENV";

function exitWorker(code: 0 | 1 | 2): never {
  try {
    const snapshotRoot = process.env.CBRAIN_CANARY_SNAPSHOT_ROOT;
    if (!snapshotRoot) throw new Error("missing snapshot root");
    writeFileSync(join(dirname(snapshotRoot), "worker-exit-status"), `${code}\n`, { mode: 0o600 });
  } catch {
    process.exit(2);
  }
  process.exit(code);
}

function fatal(code = `CANARY_${fatalStage}_FATAL`): never {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "fatal", code })}\n`);
  exitWorker(2);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) fatal();
  return value;
}

function requiredDigest(name: string): string {
  const value = requiredEnv(name);
  if (!/^[a-f0-9]{64}$/.test(value)) fatal();
  return value;
}

function requiredPositiveInteger(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < 1) fatal();
  return value;
}

try {
  if (Object.keys(process.env).some((key) => !ALLOWED_ENV.has(key))) fatal();
  try {
    lstatSync(requiredEnv("HERMES_MANAGED_DIR"));
    fatal();
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
  }
  const snapshotRoot = realpathSync(requiredEnv("CBRAIN_CANARY_SNAPSHOT_ROOT"));
  const liveHome = realpathSync(requiredEnv("CBRAIN_CANARY_LIVE_HOME"));
  const originalHermes = realpathSync(requiredEnv("CBRAIN_CANARY_ORIGINAL_HERMES"));
  const checkpointDigest = requiredEnv("CBRAIN_CANARY_CHECKPOINT_DIGEST");
  const checkpointBlobCount = Number(requiredEnv("CBRAIN_CANARY_CHECKPOINT_BLOB_COUNT"));
  if (!/^[a-f0-9]{64}$/.test(checkpointDigest) || !Number.isSafeInteger(checkpointBlobCount) || checkpointBlobCount < 1)
    fatal();
  const sourceNodeModulesDigest = requiredDigest("CBRAIN_CANARY_SOURCE_NODE_MODULES_DIGEST");
  const sourceNodeModulesFileCount = requiredPositiveInteger("CBRAIN_CANARY_SOURCE_NODE_MODULES_FILE_COUNT");
  const executionNodeModulesDigest = requiredDigest("CBRAIN_CANARY_EXECUTION_NODE_MODULES_DIGEST");
  const executionNodeModulesFileCount = requiredPositiveInteger("CBRAIN_CANARY_EXECUTION_NODE_MODULES_FILE_COUNT");
  const executionSourceDigest = requiredDigest("CBRAIN_CANARY_EXECUTION_SOURCE_DIGEST");
  const executionSourceFileCount = requiredPositiveInteger("CBRAIN_CANARY_EXECUTION_SOURCE_FILE_COUNT");

  const sourceRoot = join(snapshotRoot, "source");
  const nodeModulesRoot = join(sourceRoot, "node_modules");
  const manifestPath = join(sourceRoot, "tests/fixtures/hermes-structured-host-runtime-manifest.json");
  const evidenceManifestPath = join(sourceRoot, "tests/fixtures/hermes-structured-canary-evidence-manifest.json");
  const tokenizerPath = join(sourceRoot, "tests/fixtures/cl100k_base.tiktoken");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as HermesRuntimeManifest;
  const expectedEvidenceManifest = JSON.parse(readFileSync(evidenceManifestPath, "utf8")) as PublicEvidenceManifest;
  const originalVenv = dirname(dirname(originalHermes));
  const originalSource = dirname(originalVenv);
  const originalPythonBase = dirname(dirname(realpathSync(join(originalVenv, "bin", "python"))));

  fatalStage = "HERMES_SNAPSHOT";
  const hermesSnapshot = await createHermesRuntimeSnapshot({
    manifest,
    sourceRepoRoot: originalSource,
    pythonBaseRoot: originalPythonBase,
    venvRoot: originalVenv,
    tokenizerPath,
  });
  let matrix: Awaited<ReturnType<typeof runRealHermesCanaryMatrix>>;
  const preLive = JSON.parse(
    Buffer.from(requiredEnv("CBRAIN_CANARY_PRE_LIVE_FINGERPRINT"), "base64").toString("utf8"),
  ) as ReturnType<typeof captureStableLiveServiceFingerprint>;
  if (preLive.algorithm !== "sha256-live-service-state-v2" || !/^[a-f0-9]{64}$/.test(preLive.digest)) fatal();
  let runtimeSnapshotVerified = false;
  const verifyCbrainSnapshot = (): boolean => {
    try {
      assertTreeSymlinksContained(sourceRoot);
      const rootMode = lstatSync(sourceRoot).mode & 0o777;
      const bunMode = lstatSync(process.execPath).mode & 0o777;
      const current = canonicalSnapshotTreeDigest(sourceRoot);
      return (
        (rootMode & 0o222) === 0 &&
        (bunMode & 0o222) === 0 &&
        current.digest === executionSourceDigest &&
        current.file_count === executionSourceFileCount &&
        sha256(process.execPath) === expectedEvidenceManifest.bun_binary_digest
      );
    } catch {
      return false;
    }
  };
  try {
    fatalStage = "MATRIX";
    if (process.env.CBRAIN_CANARY_FAULT === "matrix") throw new Error("injected matrix fault");
    matrix = await runRealHermesCanaryMatrix({
      hermesExecutable: hermesSnapshot.hermesExecutable,
      pythonExecutable: hermesSnapshot.pythonExecutable,
      tokenizerPath,
      expectedToolSchemaDigest: expectedEvidenceManifest.tool_schema_digest,
      verifyRuntimeSnapshot: () =>
        hermesSnapshot.identity_verified && hermesSnapshot.read_only_verified && hermesSnapshot.verifyUnchanged(),
      verifyCbrainSnapshot,
    });
    runtimeSnapshotVerified =
      matrix.runtime_snapshot_checks_verified &&
      hermesSnapshot.identity_verified &&
      hermesSnapshot.read_only_verified &&
      hermesSnapshot.verifyUnchanged();
  } finally {
    await hermesSnapshot.close();
  }
  fatalStage = "LIVE_POST";
  const postLive = captureStableLiveServiceFingerprint(liveHome);
  const liveUnchanged =
    preLive.digest === postLive.digest &&
    preLive.relevant_process_count === postLive.relevant_process_count &&
    preLive.launchd_job_count === postLive.launchd_job_count &&
    preLive.artifact_count === postLive.artifact_count;

  fatalStage = "EVIDENCE";
  const nodeModules = canonicalTreeDigest(nodeModulesRoot);
  const observedEvidenceManifest: PublicEvidenceManifest = {
    algorithm: "sha256-canonical-json-v1",
    checkpoint_tree_digest: checkpointDigest,
    checkpoint_blob_count: checkpointBlobCount,
    bun_binary_digest: sha256(process.execPath),
    bun_version: Bun.version,
    node_modules_tree_digest: sourceNodeModulesDigest,
    node_modules_file_count: sourceNodeModulesFileCount,
    package_manifest_digest: sha256(join(sourceRoot, "package.json")),
    lockfile_digest: sha256(join(sourceRoot, "bun.lock")),
    hermes_runtime_manifest_digest: sha256(manifestPath),
    tokenizer_blob_digest: matrix.tokenizer_blob_digest,
    fixture_schema_digest: createHash("sha256")
      .update(
        JSON.stringify({
          markers: ANONYMOUS_FIXTURE_MARKERS,
          page_type: "note",
          chunk_count: 1,
          vector_rows: 0,
        }),
      )
      .digest("hex"),
    semantic_config_template_digest: createHash("sha256")
      .update(
        JSON.stringify({
          config: buildIsolatedHermesConfig({
            inferencePort: 10_001,
            mcpPort: 10_002,
          }),
          args: buildHermesChatArgs("controlled <nonce>"),
        }),
      )
      .digest("hex"),
    tool_schema_digest: matrix.tool_schema_digest,
  };
  const evidenceDigest = canonicalEvidenceDigest(expectedEvidenceManifest);
  const cbrainSnapshotVerified =
    matrix.cbrain_snapshot_checks_verified &&
    verifyCbrainSnapshot() &&
    sourceNodeModulesDigest === expectedEvidenceManifest.node_modules_tree_digest &&
    sourceNodeModulesFileCount === expectedEvidenceManifest.node_modules_file_count &&
    nodeModules.digest === executionNodeModulesDigest &&
    nodeModules.file_count === executionNodeModulesFileCount &&
    sha256(process.execPath) === expectedEvidenceManifest.bun_binary_digest;
  const cleanupVerified = hermesSnapshot.removed && matrix.cleanup_verified;
  const report = evaluateCanaryReport({
    cases: matrix.cases,
    size_pairs: matrix.size_pairs,
    primary_executions: matrix.primary_executions,
    size_repetition_executions: matrix.size_repetition_executions,
    real_hermes_host: true,
    runtime_snapshot_verified: runtimeSnapshotVerified,
    cbrain_snapshot_verified: cbrainSnapshotVerified,
    tokenizer_offline_verified: true,
    live_fingerprint_unchanged: liveUnchanged,
    cleanup_verified: cleanupVerified,
    semantic_answer_quality_not_measured: true,
    evidence_manifest: expectedEvidenceManifest,
    observed_evidence_manifest: observedEvidenceManifest,
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
      hermes_snapshot_verified: runtimeSnapshotVerified,
      cbrain_snapshot_verified: cbrainSnapshotVerified,
      tokenizer_offline_verified: true,
      live_relevant_process_count: preLive.relevant_process_count,
      live_fingerprint_unchanged: liveUnchanged,
      cleanup_verified: cleanupVerified,
      semantic_answer_quality_not_measured: true,
    },
  };
  fatalStage = "SERIALIZATION";
  const serialized = JSON.stringify(output);
  if (/(?:\/Users\/|\/home\/|[A-Za-z]:\\|Bearer\s+|api[_-]?key\s*[:=])/i.test(serialized)) fatal();
  process.stdout.write(`${serialized}\n`);
  exitWorker(report.verdict === "go" ? 0 : 1);
} catch {
  fatal();
}
