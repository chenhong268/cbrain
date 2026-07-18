import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { createHttpServer } from "../../src/http/server.js";
import { buildContext } from "../../src/mcp/context.js";
import { OUTPUT_MODE_ENV } from "../../src/mcp/output-mode.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CREDENTIAL_PATH_UNSAFE_PATTERNS,
  DISPLAY_UNSAFE_PATTERNS,
  SLUG_VALUE_RE,
} from "../../src/core/safety/display-safety.js";
export {
  buildLiveServiceFingerprint,
  captureStableLiveServiceFingerprint,
} from "./hermes-canary-live-fingerprint.js";
export type {
  LiveArtifactIdentity,
  LiveLaunchdIdentity,
  LiveProcessIdentity,
  LiveServiceFingerprint,
} from "./hermes-canary-live-fingerprint.js";

export type OutputMode = "legacy" | "structured";
export type ToolName = "query" | "deep_recall" | "cbrain_recall";
export type Branch = "normal" | "empty" | "include_raw" | "error";
export type TokenMethod = "tiktoken_cl100k_base_exact";
export type ProjectionKind = "legacy_result_only" | "result_plus_structured" | "mcp_error_only";
export type AuditContract = "none" | "query_locator_metadata" | "deep_locator_metadata" | "frontdoor_routing_metadata";

export interface CanaryCaseSpec {
  case_id: string;
  mode: OutputMode;
  tool: ToolName;
  branch: Branch;
}

export interface CanaryCaseResult extends CanaryCaseSpec {
  runtime_identity_verified: boolean;
  advertised_tool_verified: boolean;
  advertised_schema_verified: boolean;
  cbrain_invocation_count: number;
  cbrain_call_verified: boolean;
  mcp_session_verified: boolean;
  session_cleanup_verified: boolean;
  case_cleanup_verified: boolean;
  semantic_config_verified: boolean;
  host_projection_verified: boolean;
  round_trip_verified: boolean;
  result_title_present: boolean;
  result_body_present: boolean;
  empty_contract_verified: boolean;
  error_contract_verified: boolean;
  legacy_raw_present: boolean;
  default_audit_present: boolean;
  expected_audit_contract: AuditContract;
  audit_contract_verified: boolean;
  audit_redaction_exercised: boolean;
  sensitive_input_sent: boolean;
  direct_error_sensitive_echo_observed: boolean;
  error_redaction_exercised: boolean;
  audit_sensitive_exposed: boolean;
  surface_internal_exposed: boolean;
  expected_projection_kind: ProjectionKind;
  observed_projection_kind: ProjectionKind;
  projection_contract_verified: boolean;
  text_structured_consistent: boolean | null;
  token_method: TokenMethod;
  result_text_tokens: number;
  structured_content_tokens: number;
  wrapper_total_tokens: number;
  wrapper_total_code_units: number;
}

export interface SizePairEvidence {
  pair_id: string;
  tool: ToolName;
  branch: "normal" | "empty";
  ab: {
    order: "legacy_then_structured";
    legacy_tokens: number;
    structured_tokens: number;
    legacy_code_units: number;
    structured_code_units: number;
  };
  ba: {
    order: "structured_then_legacy";
    legacy_tokens: number;
    structured_tokens: number;
    legacy_code_units: number;
    structured_code_units: number;
  };
  worst_structured_tokens: number;
  best_legacy_tokens: number;
  growth_tokens: number;
  ratio: number | null;
  absolute_gate_passed: boolean;
  relative_or_floor_gate_passed: boolean;
}

export interface PublicEvidenceManifest {
  algorithm: "sha256-canonical-json-v1";
  checkpoint_tree_digest: string;
  checkpoint_blob_count: number;
  bun_binary_digest: string;
  bun_version: string;
  node_modules_tree_digest: string;
  node_modules_file_count: number;
  package_manifest_digest: string;
  lockfile_digest: string;
  hermes_runtime_manifest_digest: string;
  tokenizer_blob_digest: string;
  fixture_schema_digest: string;
  semantic_config_template_digest: string;
  tool_schema_digest: string;
}

export interface CanaryEvaluationInput {
  cases: readonly CanaryCaseResult[];
  size_pairs: readonly SizePairEvidence[];
  primary_executions: number;
  size_repetition_executions: number;
  real_hermes_host: boolean;
  runtime_snapshot_verified: boolean;
  cbrain_snapshot_verified: boolean;
  tokenizer_offline_verified: boolean;
  live_fingerprint_unchanged: boolean;
  cleanup_verified: boolean;
  semantic_answer_quality_not_measured: boolean;
  evidence_manifest: PublicEvidenceManifest;
  observed_evidence_manifest: PublicEvidenceManifest;
  evidence_generation_digest: string;
  rollback_command_id: null | "cbrain-structured-cohort-rollback-v1";
}

export type CanaryReasonCode =
  | "CASE_MATRIX_INCOMPLETE"
  | "CASE_CONTRACT_FAILED"
  | "SIZE_EVIDENCE_INVALID"
  | "SIZE_GROWTH_EXCEEDED"
  | "HOST_NOT_VERIFIED"
  | "SNAPSHOT_NOT_VERIFIED"
  | "TOKENIZER_NOT_OFFLINE"
  | "LIVE_FINGERPRINT_DRIFT"
  | "CLEANUP_NOT_VERIFIED"
  | "EVIDENCE_DIGEST_MISMATCH"
  | "SEMANTIC_SCOPE_MISSTATED"
  | "ROLLBACK_NOT_EXECUTABLE";

export interface HermesStructuredCanaryReport {
  verdict: "go" | "no-go";
  host_compatibility: "compatible" | "incompatible";
  rollout_readiness: "ready" | "blocked";
  reason_codes: CanaryReasonCode[];
  matrix: {
    expected_cases: 24;
    completed_cases: number;
    size_repetition_executions: number;
  };
  evidence_manifest: PublicEvidenceManifest;
  evidence_generation_digest: string;
  semantic_answer_quality_not_measured: true;
}

const MODES = ["legacy", "structured"] as const;
const TOOLS = ["query", "deep_recall", "cbrain_recall"] as const;
const BRANCHES = ["normal", "empty", "include_raw", "error"] as const;
const DEFAULT_BRANCHES = ["normal", "empty"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_KEYS = [
  "algorithm",
  "checkpoint_tree_digest",
  "checkpoint_blob_count",
  "bun_binary_digest",
  "bun_version",
  "node_modules_tree_digest",
  "node_modules_file_count",
  "package_manifest_digest",
  "lockfile_digest",
  "hermes_runtime_manifest_digest",
  "tokenizer_blob_digest",
  "fixture_schema_digest",
  "semantic_config_template_digest",
  "tool_schema_digest",
] as const;

export interface IsolatedHermesConfigOptions {
  inferencePort: number;
  mcpPort: number;
}

export interface IsolatedHermesEnvOptions {
  home: string;
  hermesHome: string;
  tempDir: string;
  tokenizerCache: string;
  managedDir: string;
  openAiApiKey: string;
  path: string;
  parentEnv?: Record<string, string | undefined>;
}

export interface CanonicalTreeDigest {
  digest: string;
  file_count: number;
}

export interface HermesRuntimeManifest {
  schema_version: 1;
  hermes_version: string;
  source_commit: string;
  source_tree_digest: string;
  source_blob_count: number;
  python_base: CanonicalTreeDigest;
  venv: CanonicalTreeDigest;
  runtime_relation: {
    entrypoint: "bin/hermes";
    entrypoint_digest: string;
    interpreter_name: "python" | "python3" | "python3.11";
    python_executable_digest: string;
    pyvenv_config_digest: string;
  };
  tokenizer_blob_digest: string;
  exclusions: readonly [".git", ".env", ".env.*", "__pycache__", "*.pyc", ".DS_Store"];
  aggregate_digest: string;
}

export interface CreateHermesRuntimeManifestOptions {
  hermesVersion: string;
  sourceRepoRoot: string;
  sourceCommit: string;
  pythonBaseRoot: string;
  venvRoot: string;
  tokenizerPath: string;
}

export interface VerifyHermesRuntimeManifestOptions {
  sourceRepoRoot: string;
  pythonBaseRoot: string;
  venvRoot: string;
  tokenizerPath: string;
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

export interface DeterministicInferenceStubOptions {
  token: string;
  nonce: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  expectedTools?: ChatToolDefinition[];
  expectedToolNames?: string[];
}

export interface DeterministicInferenceStubSnapshot {
  state: "awaiting_tool_call" | "awaiting_tool_result" | "complete" | "failed";
  model_call_id: string | null;
  tool_message_count: number;
  final_marker: string | null;
  complete: boolean;
  advertised_tool_names: string[];
  advertised_schema_verified: boolean;
  tool_content: string | null;
}

export interface DeterministicInferenceStub {
  port: number;
  snapshot(): DeterministicInferenceStubSnapshot;
  stop(): void;
}

export const ANONYMOUS_FIXTURE_MARKERS = Object.freeze({
  query: "alphaquerytoken",
  missing: "unrelatedabsentdelta",
  title: "记录Beta固定标题",
  body: "正文Gamma固定内容",
  safe_locator: "records/anonymous-beta",
  sensitive_path: "/private/cbrain-canary/credential.txt",
  sensitive_credential: "api_key=sk-anonymous0000000000000000",
});

export interface AnonymousFixtureRuntime {
  endpoint: URL;
  lance: LanceDBManager;
  close(): Promise<void>;
}

export interface AnonymousFixtureSnapshot {
  readonly removed: boolean;
  openRuntime(mode: OutputMode, label: string): Promise<AnonymousFixtureRuntime>;
  close(): Promise<void>;
}

export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  session_id: string | null;
}

export interface ObservingMcpProxySnapshot {
  initialize_count: number;
  session_ids: string[];
  tool_calls: ObservedToolCall[];
  sensitive_input_sent: boolean;
  direct_error_sensitive_echo_observed: boolean;
  stored_body_count: 0;
}

export interface ObservingMcpProxy {
  endpoint: URL;
  snapshot(): ObservingMcpProxySnapshot;
  closeSessions(): Promise<boolean>;
  stop(): void;
}

export interface RealHermesProjectionCaseResult {
  exit_code: number;
  final_marker_verified: boolean;
  advertised_tool_names: string[];
  advertised_schema_verified: boolean;
  tool_calls: ObservedToolCall[];
  tool_content: string;
  sensitive_input_sent: boolean;
  direct_error_sensitive_echo_observed: boolean;
  sessions_closed: boolean;
  initialize_count: number;
  session_ids: string[];
  call_correlation_verified: boolean;
  semantic_config_verified: boolean;
  case_cleanup_verified: boolean;
}

export interface HermesHostProjectionAnalysis {
  result_title_present: boolean;
  result_body_present: boolean;
  empty_contract_verified: boolean;
  error_contract_verified: boolean;
  legacy_raw_present: boolean;
  default_audit_present: boolean;
  expected_audit_contract: AuditContract;
  audit_contract_verified: boolean;
  audit_redaction_exercised: boolean;
  error_redaction_exercised: boolean;
  audit_sensitive_exposed: boolean;
  surface_internal_exposed: boolean;
  expected_projection_kind: ProjectionKind;
  observed_projection_kind: ProjectionKind;
  projection_contract_verified: boolean;
  text_structured_consistent: boolean | null;
  result_text: string;
  structured_content_json: string;
  wrapper_text: string;
}

export interface ExactTokenCountResult {
  method: TokenMethod;
  tokenizer_version: string;
  tokenizer_blob_digest: string;
  cleanup_verified: boolean;
  counts: number[];
}

export interface RealHermesCanaryMatrixResult {
  cases: CanaryCaseResult[];
  size_pairs: SizePairEvidence[];
  primary_executions: 24;
  size_repetition_executions: 12;
  tokenizer_version: string;
  tokenizer_blob_digest: string;
  cleanup_verified: boolean;
  tool_schema_digest: string;
  runtime_snapshot_checks_verified: boolean;
  cbrain_snapshot_checks_verified: boolean;
}

export interface HermesRuntimeSnapshot {
  hermesExecutable: string;
  pythonExecutable: string;
  hermes_version: string;
  aggregate_digest: string;
  identity_verified: boolean;
  read_only_verified: boolean;
  readonly removed: boolean;
  verifyUnchanged(): boolean;
  close(): Promise<void>;
}

export function buildCanaryToolArguments(tool: ToolName, branch: Branch): Record<string, unknown> {
  if (branch === "error") {
    const sensitive = `${ANONYMOUS_FIXTURE_MARKERS.sensitive_credential} ${ANONYMOUS_FIXTURE_MARKERS.sensitive_path}`;
    if (tool === "query")
      return {
        query: ANONYMOUS_FIXTURE_MARKERS.query,
        strategy: sensitive,
        include_raw: false,
      };
    if (tool === "deep_recall")
      return {
        query: ANONYMOUS_FIXTURE_MARKERS.query,
        detail: sensitive,
        limit: 3,
        include_raw: false,
      };
    return {
      query: ANONYMOUS_FIXTURE_MARKERS.query,
      detail: sensitive,
      include_raw: false,
    };
  }
  const query = branch === "empty" ? ANONYMOUS_FIXTURE_MARKERS.missing : ANONYMOUS_FIXTURE_MARKERS.query;
  const include_raw = branch === "include_raw";
  if (tool === "query") return { query, strategy: "fts", include_raw };
  if (tool === "deep_recall") return { query, detail: "brief", limit: 3, include_raw };
  return { query, include_raw };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function containsForbiddenSurface(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.normalize("NFKC");
    return DISPLAY_UNSAFE_PATTERNS.some((pattern) => pattern.test(normalized)) || SLUG_VALUE_RE.test(normalized);
  }
  if (Array.isArray(value)) return value.some(containsForbiddenSurface);
  const record = asRecord(value);
  if (!record) return false;
  const forbidden = new Set(["raw", "slug", "score", "routing", "latency_ms"]);
  return Object.entries(record).some(
    ([key, child]) => forbidden.has(key) || containsForbiddenSurface(key) || containsForbiddenSurface(child),
  );
}

function containsSensitiveMaterial(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return (
    CREDENTIAL_PATH_UNSAFE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    /canary-[0-9a-f]{8}-[0-9a-f-]{27}/i.test(normalized)
  );
}

export function analyzeHermesHostProjection(spec: CanaryCaseSpec, toolContent: string): HermesHostProjectionAnalysis {
  const expectedKind: ProjectionKind =
    spec.branch === "error"
      ? "mcp_error_only"
      : spec.mode === "structured"
        ? "result_plus_structured"
        : "legacy_result_only";
  const expectedAudit: AuditContract =
    spec.mode !== "structured" || spec.branch !== "include_raw"
      ? "none"
      : spec.tool === "query"
        ? "query_locator_metadata"
        : spec.tool === "deep_recall"
          ? "deep_locator_metadata"
          : "frontdoor_routing_metadata";
  let titlePresent = false;
  let bodyPresent = false;
  const fallback: HermesHostProjectionAnalysis = {
    result_title_present: titlePresent,
    result_body_present: bodyPresent,
    empty_contract_verified: false,
    error_contract_verified: false,
    legacy_raw_present: false,
    default_audit_present: false,
    expected_audit_contract: expectedAudit,
    audit_contract_verified: false,
    audit_redaction_exercised: false,
    error_redaction_exercised: false,
    audit_sensitive_exposed: containsSensitiveMaterial(toolContent),
    surface_internal_exposed: false,
    expected_projection_kind: expectedKind,
    observed_projection_kind: "legacy_result_only",
    projection_contract_verified: false,
    text_structured_consistent: spec.mode === "structured" && spec.branch !== "error" ? false : null,
    result_text: "",
    structured_content_json: "",
    wrapper_text: toolContent,
  };
  try {
    const opening = `<untrusted_tool_result source="mcp_cbrain_canary_${spec.tool}">\n`;
    const closing = "\n</untrusted_tool_result>";
    if (!toolContent.startsWith(opening) || !toolContent.endsWith(closing)) return fallback;
    const jsonStart = toolContent.indexOf("{", opening.length);
    if (jsonStart < 0) return fallback;
    const outer = asRecord(JSON.parse(toolContent.slice(jsonStart, -closing.length)));
    if (!outer) return fallback;

    if (spec.branch === "error") {
      const errorText = typeof outer.error === "string" ? outer.error : "";
      const exactError = exactKeys(outer, ["error"]);
      const sanitized =
        errorText.length > 0 &&
        !containsSensitiveMaterial(errorText) &&
        !/(?:stack trace|\n\s+at\s+|Traceback \()/i.test(errorText);
      return {
        ...fallback,
        error_contract_verified: exactError && sanitized && !titlePresent && !bodyPresent,
        audit_contract_verified: true,
        observed_projection_kind: exactError ? "mcp_error_only" : "legacy_result_only",
        projection_contract_verified: exactError && sanitized,
        result_text: errorText,
      };
    }

    if (typeof outer.result !== "string") return fallback;
    const inner = asRecord(JSON.parse(outer.result));
    if (!inner) return fallback;
    const structured = asRecord(outer.structuredContent);
    const structuredVisibleData = [inner.display, inner.summary, inner.data, structured?.summary, structured?.data];
    const completenessData = spec.mode === "legacy" ? inner : structuredVisibleData;
    const visibleText = JSON.stringify(completenessData);
    titlePresent = visibleText.includes(ANONYMOUS_FIXTURE_MARKERS.title);
    bodyPresent = visibleText.includes(ANONYMOUS_FIXTURE_MARKERS.body);
    const summary = asRecord(inner.summary);
    const structuredSummary = asRecord(structured?.summary);
    const count = summary?.count;
    const status = summary?.status;
    const emptyVerified =
      spec.branch !== "empty" ||
      (status === "empty" &&
        count === 0 &&
        !titlePresent &&
        !bodyPresent &&
        (spec.mode !== "structured" || (structuredSummary?.status === "empty" && structuredSummary.count === 0)));
    const innerAudit = asRecord(inner.audit);
    const structuredAudit = asRecord(structured?.audit);
    const defaultAuditPresent = spec.branch !== "include_raw" && (innerAudit !== null || structuredAudit !== null);
    const audit = structuredAudit ?? innerAudit;
    const auditRaw = asRecord(audit?.raw);
    const auditText = JSON.stringify(audit ?? {});
    const nonSensitiveAuditMarkerSurvived =
      spec.tool === "cbrain_recall"
        ? auditText.includes('"chosen_route":"content_recall"')
        : auditText.includes(ANONYMOUS_FIXTURE_MARKERS.safe_locator);
    const auditRedactionExercised =
      expectedAudit !== "none" &&
      nonSensitiveAuditMarkerSurvived &&
      auditText.includes("[redacted]") &&
      !auditText.includes(ANONYMOUS_FIXTURE_MARKERS.sensitive_path) &&
      !auditText.includes(ANONYMOUS_FIXTURE_MARKERS.sensitive_credential);
    let auditVerified = expectedAudit === "none" ? audit === null : auditRaw !== null;
    if (expectedAudit === "query_locator_metadata") {
      auditVerified &&=
        Array.isArray(auditRaw?.results) && auditRaw.results.length > 0 && asRecord(auditRaw?.search_meta) !== null;
    } else if (expectedAudit === "deep_locator_metadata") {
      auditVerified &&=
        Array.isArray(auditRaw?.entities) && auditRaw.entities.length > 0 && asRecord(auditRaw?.search_meta) !== null;
    } else if (expectedAudit === "frontdoor_routing_metadata") {
      auditVerified &&=
        asRecord(auditRaw?.routing) !== null && Array.isArray(auditRaw?.entities) && auditRaw.entities.length > 0;
    }
    if (expectedAudit !== "none") auditVerified &&= auditRedactionExercised;
    const textStructuredConsistent =
      spec.mode === "structured"
        ? structured !== null &&
          inner.schema_version === structured.schema_version &&
          canonicalJson(inner.summary) === canonicalJson(structured.summary) &&
          canonicalJson(inner.data) === canonicalJson(structured.data) &&
          canonicalJson(inner.audit) === canonicalJson(structured.audit)
        : null;
    const legacyRaw = inner.raw !== undefined;
    const exactOuter =
      spec.mode === "structured" ? exactKeys(outer, ["result", "structuredContent"]) : exactKeys(outer, ["result"]);
    const expectedLegacyRaw = spec.mode === "legacy" && (spec.tool !== "deep_recall" || spec.branch === "include_raw");
    const surfaceInternal =
      spec.mode === "structured" && structured !== null ? containsForbiddenSurface(structuredVisibleData) : false;
    const projectionVerified =
      exactOuter &&
      (spec.mode === "structured" ? structured !== null && textStructuredConsistent === true : structured === null) &&
      legacyRaw === expectedLegacyRaw &&
      !defaultAuditPresent &&
      auditVerified &&
      emptyVerified &&
      !surfaceInternal;
    return {
      ...fallback,
      result_title_present: titlePresent,
      result_body_present: bodyPresent,
      empty_contract_verified: emptyVerified,
      legacy_raw_present: legacyRaw,
      default_audit_present: defaultAuditPresent,
      audit_contract_verified: auditVerified,
      audit_redaction_exercised: auditRedactionExercised,
      audit_sensitive_exposed: containsSensitiveMaterial(auditText),
      surface_internal_exposed: surfaceInternal,
      observed_projection_kind: structured ? "result_plus_structured" : "legacy_result_only",
      projection_contract_verified: projectionVerified,
      text_structured_consistent: textStructuredConsistent,
      result_text: outer.result,
      structured_content_json: structured ? JSON.stringify(structured) : "",
    };
  } catch {
    return fallback;
  }
}

export async function countExactCl100kTokens(options: {
  pythonExecutable: string;
  tokenizerPath: string;
  values: readonly string[];
}): Promise<ExactTokenCountResult> {
  if (!isAbsolute(options.pythonExecutable)) throw new Error("Python executable must be absolute");
  if (!options.values.every((value) => typeof value === "string")) throw new Error("token inputs must be strings");
  const blob = readFileSync(options.tokenizerPath);
  const blobDigest = createHash("sha256").update(blob).digest("hex");
  const expectedDigest = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7";
  if (blobDigest !== expectedDigest) throw new Error("invalid cl100k_base artifact");
  const root = mkdtempSync(resolve(tmpdir(), "cbrain-cl100k-offline-"));
  const cache = resolve(root, "cache");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const sourceUrl = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken";
  const cacheKey = createHash("sha1").update(sourceUrl).digest("hex");
  copyFileSync(options.tokenizerPath, resolve(cache, cacheKey));
  const script = [
    "import hashlib, importlib.metadata, json, os, socket, sys",
    "_connect = socket.socket.connect",
    "def _guard(self, address):",
    "    host = str(address[0]) if isinstance(address, tuple) and address else ''",
    "    if host not in {'127.0.0.1', '::1', 'localhost'}:",
    "        raise RuntimeError('non-loopback socket blocked')",
    "    return _connect(self, address)",
    "socket.socket.connect = _guard",
    "import tiktoken",
    "cache_file = os.path.join(os.environ['TIKTOKEN_CACHE_DIR'], os.environ['CBRAIN_TIKTOKEN_CACHE_KEY'])",
    "with open(cache_file, 'rb') as handle: digest = hashlib.sha256(handle.read()).hexdigest()",
    `assert digest == '${expectedDigest}'`,
    "values = json.load(sys.stdin)",
    "encoding = tiktoken.get_encoding('cl100k_base')",
    "counts = [len(encoding.encode(value)) for value in values]",
    "print(json.dumps({'counts': counts, 'tokenizer_version': importlib.metadata.version('tiktoken'), 'tokenizer_blob_digest': digest}, separators=(',', ':')))",
  ].join("\n");
  let result: ExactTokenCountResult | undefined;
  try {
    const child = Bun.spawn({
      cmd: [options.pythonExecutable, "-I", "-c", script],
      cwd: root,
      env: {
        HOME: root,
        HERMES_HOME: resolve(root, "hermes-home"),
        HERMES_MANAGED_DIR: resolve(root, "missing-managed"),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONNOUSERSITE: "1",
        TIKTOKEN_CACHE_DIR: cache,
        CBRAIN_TIKTOKEN_CACHE_KEY: cacheKey,
        TMPDIR: root,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(options.values));
    child.stdin.end();
    const stdoutPromise = readBoundedText(child.stdout as ReadableStream<Uint8Array>, 1_000_000);
    const stderrPromise = readBoundedText(child.stderr as ReadableStream<Uint8Array>, 1_000_000);
    const exitCode = await child.exited;
    const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) throw new Error("offline tokenizer process failed");
    const parsed = asRecord(JSON.parse(stdout));
    const counts = parsed?.counts;
    if (
      !Array.isArray(counts) ||
      counts.length !== options.values.length ||
      !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
      typeof parsed?.tokenizer_version !== "string" ||
      parsed.tokenizer_blob_digest !== expectedDigest
    )
      throw new Error("invalid offline tokenizer response");
    result = {
      method: "tiktoken_cl100k_base_exact",
      tokenizer_version: parsed.tokenizer_version,
      tokenizer_blob_digest: expectedDigest,
      cleanup_verified: false,
      counts: counts as number[],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (result) {
      try {
        lstatSync(root);
      } catch (error) {
        result.cleanup_verified = error instanceof Error && error.message.includes("ENOENT");
      }
    }
  }
  if (!result) throw new Error("offline tokenizer produced no result");
  return result;
}

function copyOnWriteTree(source: string, destination: string): void {
  try {
    execFileSync("/bin/cp", ["-cRp", source, destination], { stdio: "ignore" });
  } catch {
    throw new Error("copy-on-write runtime clone failed");
  }
}

function stripRuntimeExclusions(root: string): void {
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (
        name === ".git" ||
        name === "__pycache__" ||
        name === ".DS_Store" ||
        name === ".env" ||
        name.startsWith(".env.") ||
        (stat.isFile() && name.endsWith(".pyc"))
      ) {
        rmSync(path, { recursive: true, force: true });
      } else if (stat.isDirectory()) {
        visit(path);
      }
    }
  };
  visit(root);
}

function setTreeReadOnly(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
      chmodSync(path, 0o555);
    } else if (stat.isFile()) {
      chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
    } else {
      throw new Error("unsupported runtime snapshot entry");
    }
  };
  visit(root);
}

function treeIsReadOnly(root: string): boolean {
  const visit = (path: string): boolean => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return true;
    if ((stat.mode & 0o222) !== 0) return false;
    if (stat.isDirectory()) return readdirSync(path).every((name) => visit(resolve(path, name)));
    return stat.isFile();
  };
  return visit(root);
}

function setTreeOwnerWritable(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) visit(resolve(path, name));
    } else if (stat.isFile()) {
      chmodSync(path, 0o600);
    }
  };
  visit(root);
}

export async function createHermesRuntimeSnapshot(options: {
  manifest: HermesRuntimeManifest;
  sourceRepoRoot: string;
  pythonBaseRoot: string;
  venvRoot: string;
  tokenizerPath: string;
}): Promise<HermesRuntimeSnapshot> {
  if (!verifyHermesRuntimeManifest(options.manifest, options)) {
    throw new Error("approved Hermes runtime manifest verification failed");
  }
  const ownerRoot = mkdtempSync(resolve(tmpdir(), "cbrain-hermes-runtime-snapshot-"));
  const runtimeRoot = resolve(ownerRoot, "runtime");
  const sourceRoot = resolve(runtimeRoot, "source");
  const pythonRoot = resolve(runtimeRoot, "python");
  const venvRoot = resolve(runtimeRoot, "venv");
  const tokenizerPath = resolve(runtimeRoot, "cl100k_base.tiktoken");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  let removed = false;
  try {
    execFileSync("git", ["clone", "--quiet", "--no-checkout", options.sourceRepoRoot, sourceRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", sourceRoot, "checkout", "--quiet", options.manifest.source_commit], { stdio: "ignore" });
    rmSync(resolve(sourceRoot, ".git"), { recursive: true, force: true });
    copyOnWriteTree(options.pythonBaseRoot, pythonRoot);
    copyOnWriteTree(options.venvRoot, venvRoot);
    copyFileSync(options.tokenizerPath, tokenizerPath);

    const prePython = canonicalTreeDigest(pythonRoot);
    const preVenv = canonicalTreeDigest(venvRoot);
    if (
      canonicalJson(prePython) !== canonicalJson(options.manifest.python_base) ||
      canonicalJson(preVenv) !== canonicalJson(options.manifest.venv)
    ) {
      throw new Error("Hermes runtime clone drifted before relocation");
    }
    stripRuntimeExclusions(sourceRoot);
    stripRuntimeExclusions(pythonRoot);
    stripRuntimeExclusions(venvRoot);

    const pythonLink = resolve(venvRoot, "bin", "python");
    unlinkSync(pythonLink);
    symlinkSync(resolve(pythonRoot, "bin", "python3.11"), pythonLink);
    const pyvenvPath = resolve(venvRoot, "pyvenv.cfg");
    const pyvenv = readFileSync(pyvenvPath, "utf8").replace(/^home\s*=.*$/m, `home = ${resolve(pythonRoot, "bin")}`);
    writeFileSync(pyvenvPath, pyvenv);
    const launcherPath = resolve(venvRoot, "bin", "hermes");
    const launcherLines = readFileSync(launcherPath, "utf8").split(/\r?\n/);
    launcherLines[0] = `#!${resolve(venvRoot, "bin", "python3")}`;
    writeFileSync(launcherPath, launcherLines.join("\n"));
    chmodSync(launcherPath, 0o755);

    const sitePackages = resolve(venvRoot, "lib", "python3.11", "site-packages");
    const finderNames = readdirSync(sitePackages).filter((name) =>
      /^__editable___hermes_agent_.*_finder\.py$/.test(name),
    );
    if (finderNames.length !== 1) throw new Error("unexpected Hermes editable finder inventory");
    const finderPath = resolve(sitePackages, finderNames[0]);
    const finder = readFileSync(finderPath, "utf8");
    if (!finder.includes(options.sourceRepoRoot)) throw new Error("Hermes editable finder source root missing");
    const relocatedFinder = finder.split(options.sourceRepoRoot).join(sourceRoot);
    if (relocatedFinder.includes(options.sourceRepoRoot)) throw new Error("Hermes editable finder relocation failed");
    writeFileSync(finderPath, relocatedFinder);

    assertTreeSymlinksContained(runtimeRoot);
    setTreeReadOnly(runtimeRoot);
    if (!treeIsReadOnly(runtimeRoot)) throw new Error("Hermes snapshot is writable");
    const aggregateCore = {
      source: canonicalTreeDigest(sourceRoot),
      python: canonicalTreeDigest(pythonRoot),
      venv: canonicalTreeDigest(venvRoot),
      tokenizer: createHash("sha256").update(readFileSync(tokenizerPath)).digest("hex"),
      approved_manifest: createHash("sha256").update(canonicalJson(options.manifest)).digest("hex"),
      transforms: "hermes-relocation-read-only-v1",
    };
    const aggregateDigest = createHash("sha256").update(canonicalJson(aggregateCore)).digest("hex");

    const identityHome = resolve(ownerRoot, "identity-home");
    mkdirSync(identityHome, { recursive: true, mode: 0o700 });
    const env = {
      HOME: identityHome,
      HERMES_HOME: resolve(identityHome, "hermes"),
      HERMES_MANAGED_DIR: resolve(identityHome, "missing-managed"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PYTHONNOUSERSITE: "1",
      TMPDIR: identityHome,
    };
    const probeScript =
      "import json, hermes_cli, tools.mcp_tool; print(json.dumps([hermes_cli.__file__, tools.mcp_tool.__file__]))";
    const probe = Bun.spawnSync({
      cmd: [resolve(venvRoot, "bin", "python3"), "-I", "-c", probeScript],
      cwd: sourceRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (probe.exitCode !== 0) throw new Error("Hermes snapshot import probe failed");
    const paths = JSON.parse(probe.stdout.toString()) as unknown;
    if (!Array.isArray(paths) || paths.length !== 2 || !paths.every((path) => typeof path === "string")) {
      throw new Error("Hermes snapshot import probe shape invalid");
    }
    const resolvedProbePaths = paths.map((path) => realpathSync(path as string));
    if (resolvedProbePaths.some((path) => pathWithin(realpathSync(options.sourceRepoRoot), path))) {
      throw new Error("Hermes snapshot imported original install root");
    }
    if (!resolvedProbePaths.every((path) => pathWithin(realpathSync(runtimeRoot), path))) {
      throw new Error("Hermes snapshot imported outside owned runtime");
    }
    const versionProbe = Bun.spawnSync({
      cmd: [launcherPath, "--version"],
      cwd: sourceRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (versionProbe.exitCode !== 0) throw new Error("Hermes snapshot identity failed");
    const versionText = versionProbe.stdout.toString();
    if (!versionText.includes(`Hermes Agent v${options.manifest.hermes_version}`)) {
      throw new Error("Hermes snapshot version mismatch");
    }
    const snapshot: HermesRuntimeSnapshot = {
      hermesExecutable: launcherPath,
      pythonExecutable: resolve(venvRoot, "bin", "python3"),
      hermes_version: options.manifest.hermes_version,
      aggregate_digest: aggregateDigest,
      identity_verified: true,
      read_only_verified: true,
      get removed() {
        return removed;
      },
      verifyUnchanged() {
        if (removed || !treeIsReadOnly(runtimeRoot)) return false;
        assertTreeSymlinksContained(runtimeRoot);
        const currentCore = {
          source: canonicalTreeDigest(sourceRoot),
          python: canonicalTreeDigest(pythonRoot),
          venv: canonicalTreeDigest(venvRoot),
          tokenizer: createHash("sha256").update(readFileSync(tokenizerPath)).digest("hex"),
          approved_manifest: createHash("sha256").update(canonicalJson(options.manifest)).digest("hex"),
          transforms: "hermes-relocation-read-only-v1",
        };
        return createHash("sha256").update(canonicalJson(currentCore)).digest("hex") === aggregateDigest;
      },
      async close() {
        if (removed) return;
        setTreeOwnerWritable(runtimeRoot);
        rmSync(ownerRoot, { recursive: true, force: true });
        removed = true;
      },
    };
    return snapshot;
  } catch (error) {
    try {
      if (statSync(runtimeRoot).isDirectory()) setTreeOwnerWritable(runtimeRoot);
    } catch {
      /* incomplete snapshot */
    }
    rmSync(ownerRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function createAnonymousFixtureSnapshot(): Promise<AnonymousFixtureSnapshot> {
  const root = mkdtempSync(resolve(tmpdir(), "cbrain-hermes-structured-fixture-"));
  const snapshotDirectory = resolve(root, "snapshot");
  const snapshotDb = resolve(snapshotDirectory, "brain.sqlite");
  mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
  const seed = new CBrainDB(snapshotDb);
  const pageSlug = ANONYMOUS_FIXTURE_MARKERS.safe_locator;
  try {
    const content = `${ANONYMOUS_FIXTURE_MARKERS.title}\n\n${ANONYMOUS_FIXTURE_MARKERS.body}`;
    seed.insertPage({
      slug: pageSlug,
      type: "note",
      title: ANONYMOUS_FIXTURE_MARKERS.title,
      filePath: "brain/records/anonymous-beta.md",
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
    seed.insertChunk(pageSlug, 0, content);
    seed.ftsInsert(pageSlug, `${ANONYMOUS_FIXTURE_MARKERS.query} ${content}`);
    seed.rawDb.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    seed.close();
  }
  chmodSync(snapshotDb, 0o400);

  let removed = false;
  let sequence = 0;
  const active = new Set<AnonymousFixtureRuntime>();
  const snapshot: AnonymousFixtureSnapshot = {
    get removed() {
      return removed;
    },
    async openRuntime(mode, label) {
      if (removed) throw new Error("fixture snapshot already removed");
      if (!/^[a-z0-9-]{1,64}$/.test(label)) throw new Error("invalid fixture runtime label");
      sequence += 1;
      const runtimeRoot = resolve(root, `runtime-${sequence}-${label}`);
      const dbPath = resolve(runtimeRoot, "brain.sqlite");
      const vaultPath = resolve(runtimeRoot, "vault");
      const outputsPath = resolve(runtimeRoot, "outputs");
      const profilePath = resolve(runtimeRoot, "profile");
      const lancePath = resolve(runtimeRoot, "lancedb");
      mkdirSync(vaultPath, { recursive: true, mode: 0o700 });
      mkdirSync(outputsPath, { recursive: true, mode: 0o700 });
      mkdirSync(profilePath, { recursive: true, mode: 0o700 });
      mkdirSync(resolve(vaultPath, "brain", "records"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        resolve(vaultPath, "brain", "records", "anonymous-beta.md"),
        [
          "---",
          `private_path: ${ANONYMOUS_FIXTURE_MARKERS.sensitive_path}`,
          `credential: ${ANONYMOUS_FIXTURE_MARKERS.sensitive_credential}`,
          "---",
          ANONYMOUS_FIXTURE_MARKERS.title,
          "",
          ANONYMOUS_FIXTURE_MARKERS.body,
        ].join("\n"),
      );
      copyFileSync(snapshotDb, dbPath);
      chmodSync(dbPath, 0o600);
      const db = new CBrainDB(dbPath);
      if (label.includes("include-raw")) {
        const sensitiveSupportingContent = `${ANONYMOUS_FIXTURE_MARKERS.query} ${ANONYMOUS_FIXTURE_MARKERS.sensitive_credential} ${ANONYMOUS_FIXTURE_MARKERS.sensitive_path}`;
        const sensitiveSlug = "records/anonymous-sensitive";
        db.insertPage({
          slug: sensitiveSlug,
          type: "note",
          title: `${ANONYMOUS_FIXTURE_MARKERS.sensitive_credential} ${ANONYMOUS_FIXTURE_MARKERS.sensitive_path}`,
          filePath: "brain/records/anonymous-sensitive.md",
          contentHash: createHash("sha256").update(sensitiveSupportingContent).digest("hex"),
        });
        db.insertChunk(sensitiveSlug, 0, sensitiveSupportingContent);
        db.ftsInsert(sensitiveSlug, sensitiveSupportingContent);
      }
      const lance = new LanceDBManager();
      await lance.connect(lancePath);
      await lance.warmup();
      const previousMode = process.env[OUTPUT_MODE_ENV];
      process.env[OUTPUT_MODE_ENV] = mode;
      let context: ReturnType<typeof buildContext>;
      try {
        context = buildContext({
          db,
          embedding: new DeterministicEmbeddingProvider(),
          lance,
          vaultPath,
          dbPath,
          profileDir: profilePath,
          runtimePath: outputsPath,
          nerIngestMode: "off",
          toolProfile: "full",
        });
      } finally {
        if (previousMode === undefined) delete process.env[OUTPUT_MODE_ENV];
        else process.env[OUTPUT_MODE_ENV] = previousMode;
      }
      const server = createHttpServer(context).start(0);
      let closed = false;
      const runtime: AnonymousFixtureRuntime = {
        endpoint: new URL(`http://127.0.0.1:${server.port}/mcp`),
        lance,
        async close() {
          if (closed) return;
          closed = true;
          server.stop(true);
          await lance.close().catch(() => {});
          db.close();
          rmSync(runtimeRoot, { recursive: true, force: true });
          active.delete(runtime);
        },
      };
      active.add(runtime);
      return runtime;
    },
    async close() {
      if (removed) return;
      for (const runtime of [...active]) await runtime.close();
      rmSync(root, { recursive: true, force: true });
      removed = true;
    },
  };
  return snapshot;
}

function parsedJsonRpcMessages(bytes: Uint8Array): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (Array.isArray(parsed))
      return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
  } catch {
    return [];
  }
}

export function startObservingMcpProxy(options: { upstreamUrl: URL }): ObservingMcpProxy {
  if (options.upstreamUrl.protocol !== "http:" || options.upstreamUrl.hostname !== "127.0.0.1") {
    throw new Error("MCP proxy upstream must be loopback HTTP");
  }
  const sessions = new Set<string>();
  const toolCalls: ObservedToolCall[] = [];
  const deletedSessions = new Set<string>();
  let initializeCount = 0;
  let sensitiveInputSent = false;
  let directErrorSensitiveEchoObserved = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      let requestContainsSensitiveInput = false;
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
      if (body) {
        for (const message of parsedJsonRpcMessages(body)) {
          if (message.method === "initialize") initializeCount += 1;
          if (message.method === "tools/call") {
            const params = message.params as Record<string, unknown> | undefined;
            const name = params?.name;
            const args = params?.arguments;
            if (typeof name === "string" && args && typeof args === "object" && !Array.isArray(args)) {
              const serializedArgs = canonicalJson(args);
              requestContainsSensitiveInput =
                serializedArgs.includes(ANONYMOUS_FIXTURE_MARKERS.sensitive_credential) &&
                serializedArgs.includes(ANONYMOUS_FIXTURE_MARKERS.sensitive_path);
              sensitiveInputSent ||= requestContainsSensitiveInput;
              toolCalls.push({
                name,
                arguments: structuredClone(args as Record<string, unknown>),
                session_id: request.headers.get("mcp-session-id"),
              });
            }
          }
        }
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.delete("connection");
      const upstream = await fetch(options.upstreamUrl, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
      const responseBytes = new Uint8Array(await upstream.arrayBuffer());
      if (requestContainsSensitiveInput) {
        const responseText = new TextDecoder().decode(responseBytes);
        directErrorSensitiveEchoObserved ||=
          responseText.includes(ANONYMOUS_FIXTURE_MARKERS.sensitive_credential) ||
          responseText.includes(ANONYMOUS_FIXTURE_MARKERS.sensitive_path);
      }
      const responseHeaders = new Headers(upstream.headers);
      const sessionId = responseHeaders.get("mcp-session-id");
      if (sessionId) sessions.add(sessionId);
      const requestSessionId = request.headers.get("mcp-session-id");
      if (request.method === "DELETE" && requestSessionId && upstream.status >= 200 && upstream.status < 300) {
        deletedSessions.add(requestSessionId);
      }
      return new Response(responseBytes, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    },
  });
  return {
    endpoint: new URL(`http://127.0.0.1:${server.port}/mcp`),
    snapshot() {
      return {
        initialize_count: initializeCount,
        session_ids: [...sessions].sort(),
        tool_calls: structuredClone(toolCalls),
        sensitive_input_sent: sensitiveInputSent,
        direct_error_sensitive_echo_observed: directErrorSensitiveEchoObserved,
        stored_body_count: 0,
      };
    },
    async closeSessions() {
      let valid = sessions.size === 1;
      for (const sessionId of sessions) {
        const headers = { "mcp-session-id": sessionId };
        if (!deletedSessions.has(sessionId)) {
          const closed = await fetch(options.upstreamUrl, {
            method: "DELETE",
            headers,
          });
          valid &&= closed.status >= 200 && closed.status < 300;
        }
        const rejected = await fetch(options.upstreamUrl, {
          method: "GET",
          headers,
        });
        valid &&= rejected.status === 404;
      }
      return valid;
    },
    stop() {
      server.stop(true);
    },
  };
}

function normalizedToolDefinitions(tools: readonly ChatToolDefinition[]): ChatToolDefinition[] {
  return [...structuredClone(tools)].sort((left, right) => left.function.name.localeCompare(right.function.name));
}

export function toolSchemaDigest(tools: readonly ChatToolDefinition[]): string {
  if (tools.length !== 3 || new Set(tools.map((tool) => tool.function.name)).size !== 3) {
    throw new Error("invalid canary tool schema inventory");
  }
  return createHash("sha256")
    .update(canonicalJson(normalizedToolDefinitions(tools)))
    .digest("hex");
}

export async function loadCanaryChatToolDefinitions(runtime: AnonymousFixtureRuntime): Promise<{
  tools: ChatToolDefinition[];
  digest: string;
  session_cleanup_verified: boolean;
}> {
  const proxy = startObservingMcpProxy({ upstreamUrl: runtime.endpoint });
  const client = new Client({
    name: "anonymous-schema-preflight",
    version: "0.0.0",
  });
  let listed: Awaited<ReturnType<Client["listTools"]>> | undefined;
  let sessionCleanup = false;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(proxy.endpoint, {
        requestInit: { headers: { "X-CBrain-Tool-Profile": "full" } },
      }),
    );
    listed = await client.listTools();
  } finally {
    await client.close().catch(() => {});
    sessionCleanup = await proxy.closeSessions().catch(() => false);
    proxy.stop();
  }
  if (!listed || !sessionCleanup) throw new Error("tool schema preflight did not close its MCP session");
  const wanted = new Set<string>(TOOLS);
  const selected = listed.tools.filter((tool) => wanted.has(tool.name));
  if (selected.length !== 3) throw new Error("canary tool schema inventory mismatch");
  const tools = selected.map(
    (tool): ChatToolDefinition => ({
      type: "function",
      function: {
        name: `mcp_cbrain_canary_${tool.name}`,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      },
    }),
  );
  return {
    tools,
    digest: toolSchemaDigest(tools),
    session_cleanup_verified: true,
  };
}

export function buildHermesChatArgs(prompt: string): string[] {
  return [
    "chat",
    "-q",
    prompt,
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
  ];
}

export function buildIsolatedHermesConfig(options: IsolatedHermesConfigOptions) {
  for (const port of [options.inferencePort, options.mcpPort]) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid loopback port");
  }
  return {
    model: {
      default: "canary-model",
      provider: "custom",
      base_url: `http://127.0.0.1:${options.inferencePort}/v1`,
      api_mode: "chat_completions",
    },
    providers: {
      custom: {
        name: "CBrain Canary",
        api: `http://127.0.0.1:${options.inferencePort}/v1`,
        key_env: "OPENAI_API_KEY",
        transport: "chat_completions",
        default_model: "canary-model",
        discover_models: false,
      },
    },
    agent: { max_turns: 4 },
    plugins: { enabled: [] as string[] },
    tools: { tool_search: { enabled: "off" as const } },
    mcp_servers: {
      cbrain_canary: {
        url: `http://127.0.0.1:${options.mcpPort}/mcp`,
        enabled: true,
        headers: { "X-CBrain-Tool-Profile": "full" },
        tools: {
          include: ["query", "deep_recall", "cbrain_recall"] as ToolName[],
        },
      },
    },
  };
}

async function readBoundedText(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("Hermes child output exceeded bound");
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

interface OwnedProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  start_us: number;
}

const DARWIN_PROCESS_IDENTITY_SCRIPT = `
import ctypes, json, sys
class B(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32), ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
b = B()
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
n = lib.proc_pidinfo(int(sys.argv[1]), 3, 0, ctypes.byref(b), ctypes.sizeof(b))
if n != ctypes.sizeof(b):
    sys.exit(1)
print(json.dumps({"pid": b.pid, "ppid": b.ppid, "pgid": b.pgid, "start_us": b.start_sec * 1000000 + b.start_usec}, separators=(",", ":")))
`;

function readOwnedProcessIdentity(pid: number): OwnedProcessIdentity | null {
  try {
    const value = JSON.parse(
      execFileSync("/usr/bin/python3", ["-I", "-c", DARWIN_PROCESS_IDENTITY_SCRIPT, String(pid)], {
        encoding: "utf8",
      }),
    ) as OwnedProcessIdentity;
    return [value.pid, value.ppid, value.pgid, value.start_us].every(Number.isSafeInteger) && value.pid === pid
      ? value
      : null;
  } catch {
    return null;
  }
}

function sameOwnedProcess(identity: OwnedProcessIdentity | null): boolean {
  if (!identity) return false;
  const current = readOwnedProcessIdentity(identity.pid);
  return current !== null && current.start_us === identity.start_us;
}

function captureOwnedDescendants(owned: Map<number, OwnedProcessIdentity>): void {
  let rows: Array<{ pid: number; ppid: number; pgid: number }> = [];
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" });
    rows = output.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }] : [];
    });
  } catch {
    return;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.pid) || !owned.has(row.ppid)) continue;
      const identity = readOwnedProcessIdentity(row.pid);
      if (identity && identity.ppid === row.ppid && identity.pgid === row.pgid) {
        owned.set(row.pid, identity);
        changed = true;
      }
    }
  }
}

function processGroupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function runRealHermesProjectionCase(options: {
  hermesExecutable: string;
  runtime: AnonymousFixtureRuntime;
  tool: ToolName;
  branch: Branch;
  expectedTools?: readonly ChatToolDefinition[];
  timeoutMs?: number;
}): Promise<RealHermesProjectionCaseResult> {
  if (!isAbsolute(options.hermesExecutable)) throw new Error("Hermes executable must be absolute");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("invalid Hermes timeout");
  }
  const loadedTools = options.expectedTools ?? (await loadCanaryChatToolDefinitions(options.runtime)).tools;
  const expectedTools = normalizedToolDefinitions(loadedTools);
  const args = buildCanaryToolArguments(options.tool, options.branch);
  const nonce = randomUUID();
  const token = `canary-${randomUUID()}`;
  const proxy = startObservingMcpProxy({
    upstreamUrl: options.runtime.endpoint,
  });
  const stub = startDeterministicInferenceStub({
    token,
    nonce,
    toolName: `mcp_cbrain_canary_${options.tool}`,
    toolArguments: args,
    expectedTools,
  });
  const root = mkdtempSync(resolve(tmpdir(), "cbrain-hermes-real-case-"));
  const home = resolve(root, "home");
  const hermesHome = resolve(root, "hermes-home");
  const childTmp = resolve(root, "tmp");
  const tokenizerCache = resolve(root, "tokenizer-cache");
  const cwd = resolve(root, "cwd");
  for (const path of [home, hermesHome, childTmp, tokenizerCache, cwd]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const configPath = resolve(hermesHome, "config.yaml");
  const expectedConfig = buildIsolatedHermesConfig({
    inferencePort: stub.port,
    mcpPort: proxy.endpoint.port ? Number(proxy.endpoint.port) : 0,
  });
  writeFileSync(configPath, JSON.stringify(expectedConfig, null, 2));
  chmodSync(configPath, 0o600);
  const semanticConfigVerified =
    canonicalJson(JSON.parse(readFileSync(configPath, "utf8"))) === canonicalJson(expectedConfig);
  const env = buildIsolatedHermesEnv({
    home,
    hermesHome,
    tempDir: childTmp,
    tokenizerCache,
    managedDir: resolve(root, "missing-managed"),
    openAiApiKey: token,
    path: "/usr/bin:/bin:/usr/sbin:/sbin",
  });
  const prompt = `controlled ${nonce}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessionsClosed = false;
  let result: RealHermesProjectionCaseResult | undefined;
  let childIdentity: OwnedProcessIdentity | null = null;
  const ownedProcesses = new Map<number, OwnedProcessIdentity>();
  let stopProcessMonitor = false;
  let processMonitor: Promise<void> | undefined;
  let interrupted: ((error: Error) => void) | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  try {
    child = Bun.spawn({
      cmd: [options.hermesExecutable, ...buildHermesChatArgs(prompt)],
      cwd,
      env,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    childIdentity = readOwnedProcessIdentity(child.pid);
    if (!childIdentity || childIdentity.ppid !== process.pid || childIdentity.pgid !== child.pid) {
      throw new Error("Hermes child birth identity unavailable");
    }
    ownedProcesses.set(child.pid, childIdentity);
    processMonitor = (async () => {
      while (!stopProcessMonitor) {
        captureOwnedDescendants(ownedProcesses);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      captureOwnedDescendants(ownedProcesses);
    })();
    const signalPromise = new Promise<never>((_, reject) => {
      interrupted = reject;
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => interrupted?.(new Error("Hermes case interrupted"));
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    const stdoutPromise = readBoundedText(child.stdout as ReadableStream<Uint8Array>, 1_000_000);
    const stderrPromise = readBoundedText(child.stderr as ReadableStream<Uint8Array>, 1_000_000);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Hermes case timed out")), timeoutMs);
    });
    let exitCode: number;
    try {
      exitCode = await Promise.race([child.exited, timeout, signalPromise]);
    } catch (error) {
      if (sameOwnedProcess(childIdentity)) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      await Promise.race([child.exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
      if (child.exitCode === null && sameOwnedProcess(childIdentity)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      throw error;
    }
    const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
    const inference = stub.snapshot();
    const observed = proxy.snapshot();
    sessionsClosed = await proxy.closeSessions();
    const callCorrelationVerified =
      observed.initialize_count === 1 &&
      observed.session_ids.length === 1 &&
      observed.tool_calls.length === 1 &&
      observed.tool_calls[0].name === options.tool &&
      canonicalJson(observed.tool_calls[0].arguments) === canonicalJson(args) &&
      observed.tool_calls[0].session_id === observed.session_ids[0];
    result = {
      exit_code: exitCode,
      final_marker_verified: inference.final_marker !== null && stdout.includes(inference.final_marker),
      advertised_tool_names: inference.advertised_tool_names,
      advertised_schema_verified: inference.advertised_schema_verified,
      tool_calls: observed.tool_calls,
      tool_content: inference.tool_content ?? "",
      sensitive_input_sent: observed.sensitive_input_sent,
      direct_error_sensitive_echo_observed: observed.direct_error_sensitive_echo_observed,
      sessions_closed: sessionsClosed,
      initialize_count: observed.initialize_count,
      session_ids: observed.session_ids,
      call_correlation_verified: callCorrelationVerified,
      semantic_config_verified: semanticConfigVerified,
      case_cleanup_verified: false,
    };
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (timer) clearTimeout(timer);
    stopProcessMonitor = true;
    if (processMonitor) await processMonitor.catch(() => {});
    captureOwnedDescendants(ownedProcesses);
    if (child && child.exitCode === null && sameOwnedProcess(childIdentity)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await child.exited.catch(() => {});
    }
    let processGroupClean = true;
    if (child) {
      processGroupClean = processGroupIsEmpty(child.pid);
      const ownedGroupMemberAlive = [...ownedProcesses.values()].some(
        (identity) => identity.pgid === child?.pid && sameOwnedProcess(identity),
      );
      if (!processGroupClean && ownedGroupMemberAlive) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* identity-checked best effort */
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        processGroupClean = processGroupIsEmpty(child.pid);
      }
    }
    for (const identity of ownedProcesses.values()) {
      if (!sameOwnedProcess(identity)) continue;
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch {
        /* high-resolution identity checked immediately before the signal */
      }
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (![...ownedProcesses.values()].some(sameOwnedProcess)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const descendantsClean = ![...ownedProcesses.values()].some(sameOwnedProcess);
    if (!sessionsClosed) await proxy.closeSessions().catch(() => false);
    proxy.stop();
    stub.stop();
    setTreeOwnerWritable(root);
    rmSync(root, { recursive: true, force: true });
    if (result) {
      try {
        lstatSync(root);
      } catch (error) {
        result.case_cleanup_verified =
          processGroupClean && descendantsClean && error instanceof Error && error.message.includes("ENOENT");
      }
    }
  }
  if (!result) throw new Error("real Hermes case produced no result");
  return result;
}

export async function runRealHermesCanaryMatrix(options: {
  hermesExecutable: string;
  pythonExecutable: string;
  tokenizerPath: string;
  timeoutMs?: number;
  expectedToolSchemaDigest?: string;
  verifyRuntimeSnapshot: () => boolean;
  verifyCbrainSnapshot: () => boolean;
}): Promise<RealHermesCanaryMatrixResult> {
  interface Execution {
    spec: CanaryCaseSpec;
    host: RealHermesProjectionCaseResult;
    projection: HermesHostProjectionAnalysis;
    result_text_tokens?: number;
    structured_content_tokens?: number;
    wrapper_total_tokens?: number;
  }
  const primary: Execution[] = [];
  const repetitions: Execution[] = [];
  let sequence = 0;
  let expectedTools: ChatToolDefinition[] = [];
  let schemaDigest = "";
  let preflightSessionClosed = false;
  let runtimeSnapshotChecksVerified = true;
  let cbrainSnapshotChecksVerified = true;
  const verifySnapshots = (): void => {
    runtimeSnapshotChecksVerified &&= options.verifyRuntimeSnapshot();
    cbrainSnapshotChecksVerified &&= options.verifyCbrainSnapshot();
    if (!runtimeSnapshotChecksVerified || !cbrainSnapshotChecksVerified) {
      throw new Error("canary execution snapshot drifted");
    }
  };
  verifySnapshots();
  const fixture = await createAnonymousFixtureSnapshot();
  const execute = async (spec: CanaryCaseSpec, bucket: Execution[]): Promise<void> => {
    verifySnapshots();
    sequence += 1;
    const label = `case-${sequence}-${spec.mode}-${spec.tool}-${spec.branch}`.replaceAll("_", "-");
    const runtime = await fixture.openRuntime(spec.mode, label);
    try {
      const host = await runRealHermesProjectionCase({
        hermesExecutable: options.hermesExecutable,
        runtime,
        tool: spec.tool,
        branch: spec.branch,
        expectedTools,
        timeoutMs: options.timeoutMs,
      });
      bucket.push({
        spec,
        host,
        projection: analyzeHermesHostProjection(spec, host.tool_content),
      });
    } finally {
      await runtime.close();
      verifySnapshots();
    }
  };
  try {
    const schemaRuntime = await fixture.openRuntime("structured", "schema-preflight");
    try {
      const loaded = await loadCanaryChatToolDefinitions(schemaRuntime);
      expectedTools = loaded.tools;
      schemaDigest = loaded.digest;
      preflightSessionClosed = loaded.session_cleanup_verified;
      if (options.expectedToolSchemaDigest && schemaDigest !== options.expectedToolSchemaDigest) {
        throw new Error("canary tool schema digest drifted");
      }
    } finally {
      await schemaRuntime.close();
    }
    for (const tool of TOOLS) {
      for (const branch of DEFAULT_BRANCHES) {
        for (const mode of MODES) {
          await execute({ case_id: `${mode}:${tool}:${branch}`, mode, tool, branch }, primary);
        }
      }
    }
    for (const tool of TOOLS) {
      for (const branch of ["include_raw", "error"] as const) {
        for (const mode of MODES) {
          await execute({ case_id: `${mode}:${tool}:${branch}`, mode, tool, branch }, primary);
        }
      }
    }
    for (const tool of TOOLS) {
      for (const branch of DEFAULT_BRANCHES) {
        for (const mode of ["structured", "legacy"] as const) {
          await execute({ case_id: `repeat:${mode}:${tool}:${branch}`, mode, tool, branch }, repetitions);
        }
      }
    }
  } finally {
    await fixture.close();
    verifySnapshots();
  }

  if (primary.length !== 24 || repetitions.length !== 12) throw new Error("incomplete real Hermes matrix");
  const allExecutions = [...primary, ...repetitions];
  const tokenInputs = allExecutions.flatMap((execution) => [
    execution.projection.result_text,
    execution.projection.structured_content_json,
    execution.projection.wrapper_text,
  ]);
  verifySnapshots();
  const counted = await countExactCl100kTokens({
    pythonExecutable: options.pythonExecutable,
    tokenizerPath: options.tokenizerPath,
    values: tokenInputs,
  });
  verifySnapshots();
  allExecutions.forEach((execution, index) => {
    execution.result_text_tokens = counted.counts[index * 3];
    execution.structured_content_tokens = counted.counts[index * 3 + 1];
    execution.wrapper_total_tokens = counted.counts[index * 3 + 2];
  });

  const expectedNames = ["mcp_cbrain_canary_query", "mcp_cbrain_canary_deep_recall", "mcp_cbrain_canary_cbrain_recall"]
    .sort()
    .join("\0");
  const cases = primary.map(
    ({ spec, host, projection, result_text_tokens, structured_content_tokens, wrapper_total_tokens }) => ({
      ...spec,
      runtime_identity_verified: host.exit_code === 0,
      advertised_tool_verified: [...host.advertised_tool_names].sort().join("\0") === expectedNames,
      advertised_schema_verified: host.advertised_schema_verified,
      cbrain_invocation_count: host.tool_calls.length,
      cbrain_call_verified: host.call_correlation_verified,
      mcp_session_verified: host.initialize_count === 1 && host.session_ids.length === 1,
      session_cleanup_verified: host.sessions_closed,
      case_cleanup_verified: host.case_cleanup_verified,
      semantic_config_verified: host.semantic_config_verified,
      host_projection_verified: host.final_marker_verified && host.tool_content.length > 0,
      round_trip_verified: host.final_marker_verified,
      result_title_present: projection.result_title_present,
      result_body_present: projection.result_body_present,
      empty_contract_verified: projection.empty_contract_verified,
      error_contract_verified: projection.error_contract_verified,
      legacy_raw_present: projection.legacy_raw_present,
      default_audit_present: projection.default_audit_present,
      expected_audit_contract: projection.expected_audit_contract,
      audit_contract_verified: projection.audit_contract_verified,
      audit_redaction_exercised: projection.audit_redaction_exercised,
      sensitive_input_sent: host.sensitive_input_sent,
      direct_error_sensitive_echo_observed: host.direct_error_sensitive_echo_observed,
      error_redaction_exercised:
        spec.branch === "error" && host.sensitive_input_sent && host.direct_error_sensitive_echo_observed,
      audit_sensitive_exposed: projection.audit_sensitive_exposed,
      surface_internal_exposed: projection.surface_internal_exposed,
      expected_projection_kind: projection.expected_projection_kind,
      observed_projection_kind: projection.observed_projection_kind,
      projection_contract_verified: projection.projection_contract_verified,
      text_structured_consistent: projection.text_structured_consistent,
      token_method: "tiktoken_cl100k_base_exact" as const,
      result_text_tokens: result_text_tokens as number,
      structured_content_tokens: structured_content_tokens as number,
      wrapper_total_tokens: wrapper_total_tokens as number,
      wrapper_total_code_units: projection.wrapper_text.length,
    }),
  );

  const lookup = (items: Execution[], mode: OutputMode, tool: ToolName, branch: "normal" | "empty"): Execution => {
    const found = items.find(
      (item) => item.spec.mode === mode && item.spec.tool === tool && item.spec.branch === branch,
    );
    if (!found) throw new Error("missing size execution");
    return found;
  };
  const size_pairs = TOOLS.flatMap((tool) =>
    DEFAULT_BRANCHES.map((branch): SizePairEvidence => {
      const abLegacy = lookup(primary, "legacy", tool, branch);
      const abStructured = lookup(primary, "structured", tool, branch);
      const baLegacy = lookup(repetitions, "legacy", tool, branch);
      const baStructured = lookup(repetitions, "structured", tool, branch);
      const ab = {
        order: "legacy_then_structured" as const,
        legacy_tokens: abLegacy.wrapper_total_tokens as number,
        structured_tokens: abStructured.wrapper_total_tokens as number,
        legacy_code_units: abLegacy.projection.wrapper_text.length,
        structured_code_units: abStructured.projection.wrapper_text.length,
      };
      const ba = {
        order: "structured_then_legacy" as const,
        legacy_tokens: baLegacy.wrapper_total_tokens as number,
        structured_tokens: baStructured.wrapper_total_tokens as number,
        legacy_code_units: baLegacy.projection.wrapper_text.length,
        structured_code_units: baStructured.projection.wrapper_text.length,
      };
      const worstStructured = Math.max(ab.structured_tokens, ba.structured_tokens);
      const bestLegacy = Math.min(ab.legacy_tokens, ba.legacy_tokens);
      const growth = Math.max(0, worstStructured - bestLegacy);
      return {
        pair_id: `${tool}:${branch}`,
        tool,
        branch,
        ab,
        ba,
        worst_structured_tokens: worstStructured,
        best_legacy_tokens: bestLegacy,
        growth_tokens: growth,
        ratio: bestLegacy === 0 ? null : worstStructured / bestLegacy,
        absolute_gate_passed: growth <= 128,
        relative_or_floor_gate_passed:
          bestLegacy >= 128 ? worstStructured <= bestLegacy * 1.25 : worstStructured <= bestLegacy + 32,
      };
    }),
  );
  return {
    cases,
    size_pairs,
    primary_executions: 24,
    size_repetition_executions: 12,
    tokenizer_version: counted.tokenizer_version,
    tokenizer_blob_digest: counted.tokenizer_blob_digest,
    cleanup_verified:
      preflightSessionClosed &&
      fixture.removed &&
      counted.cleanup_verified &&
      allExecutions.every((execution) => execution.host.sessions_closed && execution.host.case_cleanup_verified),
    tool_schema_digest: schemaDigest,
    runtime_snapshot_checks_verified: runtimeSnapshotChecksVerified,
    cbrain_snapshot_checks_verified: cbrainSnapshotChecksVerified,
  };
}

export function buildIsolatedHermesEnv(options: IsolatedHermesEnvOptions): Record<string, string> {
  void options.parentEnv;
  return {
    HOME: options.home,
    HERMES_HOME: options.hermesHome,
    HERMES_IGNORE_RULES: "1",
    HERMES_MANAGED_DIR: options.managedDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENAI_API_KEY: options.openAiApiKey,
    PATH: options.path,
    PYTHONNOUSERSITE: "1",
    TIKTOKEN_CACHE_DIR: options.tokenizerCache,
    TMPDIR: options.tempDir,
  };
}

const TREE_EXCLUDED_DIRS = new Set([".git", "__pycache__"]);
const TREE_EXCLUDED_FILES = new Set([".DS_Store"]);

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function assertTreeSymlinksContained(rootPath: string): void {
  const root = realpathSync(rootPath);
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(resolve(dirname(path), readlinkSync(path)));
        } catch {
          throw new Error("snapshot symlink target is unavailable");
        }
        if (!pathWithin(root, target)) throw new Error("snapshot symlink escapes owned tree");
      }
    }
  };
  visit(root);
}

export function canonicalTreeDigest(rootPath: string): CanonicalTreeDigest {
  const root = resolve(rootPath);
  const entries: Array<{
    path: string;
    kind: "directory" | "file" | "symlink";
    mode: number;
    bytes: Uint8Array;
  }> = [];
  let fileCount = 0;

  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (
        TREE_EXCLUDED_DIRS.has(name) ||
        TREE_EXCLUDED_FILES.has(name) ||
        name === ".env" ||
        name.startsWith(".env.")
      ) {
        continue;
      }
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push({
          path: normalizedRelative(root, path),
          kind: "directory",
          mode: stat.mode & 0o777,
          bytes: new Uint8Array(),
        });
        visit(path);
      } else if (stat.isSymbolicLink()) {
        fileCount += 1;
        entries.push({
          path: normalizedRelative(root, path),
          kind: "symlink",
          mode: stat.mode & 0o777,
          bytes: new TextEncoder().encode(readlinkSync(path)),
        });
      } else if (stat.isFile() && !name.endsWith(".pyc")) {
        fileCount += 1;
        entries.push({
          path: normalizedRelative(root, path),
          kind: "file",
          mode: stat.mode & 0o777,
          bytes: readFileSync(path),
        });
      } else if (!stat.isFile()) {
        throw new Error("unsupported runtime tree entry");
      }
    }
  };

  visit(root);
  const hash = createHash("sha256");
  for (const entry of entries) {
    const contentHash = createHash("sha256").update(entry.bytes).digest("hex");
    hash.update(`${entry.kind}\0${entry.path}\0${entry.mode.toString(8)}\0${entry.bytes.byteLength}\0${contentHash}\n`);
  }
  return { digest: hash.digest("hex"), file_count: fileCount };
}

export function canonicalSnapshotTreeDigest(rootPath: string): CanonicalTreeDigest {
  const root = resolve(rootPath);
  const entries: Array<{
    path: string;
    kind: "directory" | "file" | "symlink";
    mode: number;
    bytes: Uint8Array;
  }> = [];
  let fileCount = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push({
          path: normalizedRelative(root, path),
          kind: "directory",
          mode: stat.mode & 0o777,
          bytes: new Uint8Array(),
        });
        visit(path);
      } else if (stat.isSymbolicLink()) {
        fileCount += 1;
        entries.push({
          path: normalizedRelative(root, path),
          kind: "symlink",
          mode: stat.mode & 0o777,
          bytes: new TextEncoder().encode(readlinkSync(path)),
        });
      } else if (stat.isFile()) {
        fileCount += 1;
        entries.push({
          path: normalizedRelative(root, path),
          kind: "file",
          mode: stat.mode & 0o777,
          bytes: readFileSync(path),
        });
      } else {
        throw new Error("unsupported strict snapshot entry");
      }
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const entry of entries) {
    const contentHash = createHash("sha256").update(entry.bytes).digest("hex");
    hash.update(`${entry.kind}\0${entry.path}\0${entry.mode.toString(8)}\0${entry.bytes.byteLength}\0${contentHash}\n`);
  }
  return { digest: hash.digest("hex"), file_count: fileCount };
}

function inspectGitSource(
  sourceRepoRoot: string,
  sourceCommit: string,
): {
  source_tree_digest: string;
  source_blob_count: number;
} {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("invalid source commit");
  try {
    execFileSync("git", ["-C", sourceRepoRoot, "cat-file", "-e", `${sourceCommit}^{commit}`], {
      stdio: "ignore",
    });
    const listing = execFileSync("git", ["-C", sourceRepoRoot, "ls-tree", "-r", "--full-tree", sourceCommit], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    const text = listing.toString("utf8");
    const count = text.length === 0 ? 0 : text.split("\n").filter(Boolean).length;
    if (count < 1) throw new Error("empty source tree");
    return {
      source_tree_digest: createHash("sha256").update(listing).digest("hex"),
      source_blob_count: count,
    };
  } catch {
    throw new Error("invalid Hermes source repository");
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function inspectRuntimeRelation(pythonBaseRoot: string, venvRoot: string): HermesRuntimeManifest["runtime_relation"] {
  const entrypoint = resolve(venvRoot, "bin", "hermes");
  const pyvenvConfig = resolve(venvRoot, "pyvenv.cfg");
  const firstLine = readFileSync(entrypoint, "utf8").split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) throw new Error("invalid Hermes launcher");
  const interpreter = firstLine.slice(2);
  const interpreterName = basename(interpreter);
  if (!["python", "python3", "python3.11"].includes(interpreterName)) {
    throw new Error("invalid Hermes launcher interpreter");
  }
  if (dirname(interpreter) !== resolve(venvRoot, "bin")) throw new Error("launcher outside venv");

  const base = realpathSync(pythonBaseRoot);
  const resolvedInterpreter = realpathSync(interpreter);
  const resolvedVenvPython = realpathSync(resolve(venvRoot, "bin", "python"));
  if (!pathWithin(base, resolvedInterpreter) || resolvedInterpreter !== resolvedVenvPython) {
    throw new Error("venv interpreter does not resolve into Python base");
  }
  const pyvenvText = readFileSync(pyvenvConfig, "utf8");
  const homeLines = pyvenvText.split(/\r?\n/).filter((line) => /^home\s*=/.test(line));
  if (homeLines.length !== 1) throw new Error("invalid pyvenv home");
  const home = realpathSync(homeLines[0].replace(/^home\s*=\s*/, ""));
  if (!pathWithin(base, home)) throw new Error("pyvenv home outside Python base");

  return {
    entrypoint: "bin/hermes",
    entrypoint_digest: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
    interpreter_name: interpreterName as "python" | "python3" | "python3.11",
    python_executable_digest: createHash("sha256").update(readFileSync(resolvedInterpreter)).digest("hex"),
    pyvenv_config_digest: createHash("sha256").update(readFileSync(pyvenvConfig)).digest("hex"),
  };
}

export function createHermesRuntimeManifest(options: CreateHermesRuntimeManifestOptions): HermesRuntimeManifest {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(options.hermesVersion)) {
    throw new Error("invalid Hermes version");
  }
  const source = inspectGitSource(options.sourceRepoRoot, options.sourceCommit);
  const tokenizerBlobDigest = createHash("sha256").update(readFileSync(options.tokenizerPath)).digest("hex");
  if (tokenizerBlobDigest !== "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7") {
    throw new Error("invalid cl100k_base artifact");
  }
  const core = {
    schema_version: 1 as const,
    hermes_version: options.hermesVersion,
    source_commit: options.sourceCommit,
    source_tree_digest: source.source_tree_digest,
    source_blob_count: source.source_blob_count,
    python_base: canonicalTreeDigest(options.pythonBaseRoot),
    venv: canonicalTreeDigest(options.venvRoot),
    runtime_relation: inspectRuntimeRelation(options.pythonBaseRoot, options.venvRoot),
    tokenizer_blob_digest: tokenizerBlobDigest,
    exclusions: [".git", ".env", ".env.*", "__pycache__", "*.pyc", ".DS_Store"] as const,
  };
  return {
    ...core,
    aggregate_digest: createHash("sha256").update(canonicalJson(core)).digest("hex"),
  };
}

export function verifyHermesRuntimeManifest(
  manifest: HermesRuntimeManifest,
  options: VerifyHermesRuntimeManifestOptions,
): boolean {
  try {
    const { aggregate_digest: aggregateDigest, ...core } = manifest;
    if (createHash("sha256").update(canonicalJson(core)).digest("hex") !== aggregateDigest) return false;
    const source = inspectGitSource(options.sourceRepoRoot, manifest.source_commit);
    if (
      source.source_tree_digest !== manifest.source_tree_digest ||
      source.source_blob_count !== manifest.source_blob_count
    )
      return false;
    const pythonBase = canonicalTreeDigest(options.pythonBaseRoot);
    if (
      pythonBase.digest !== manifest.python_base.digest ||
      pythonBase.file_count !== manifest.python_base.file_count
    ) {
      return false;
    }
    const venv = canonicalTreeDigest(options.venvRoot);
    if (venv.digest !== manifest.venv.digest || venv.file_count !== manifest.venv.file_count) return false;
    if (
      canonicalJson(inspectRuntimeRelation(options.pythonBaseRoot, options.venvRoot)) !==
      canonicalJson(manifest.runtime_relation)
    ) {
      return false;
    }
    const tokenizerDigest = createHash("sha256").update(readFileSync(options.tokenizerPath)).digest("hex");
    return tokenizerDigest === manifest.tokenizer_blob_digest;
  } catch {
    return false;
  }
}

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function completionChunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: "chatcmpl-cbrain-canary",
    object: "chat.completion.chunk",
    created: 0,
    model: "canary-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status });
}

export function startDeterministicInferenceStub(
  options: DeterministicInferenceStubOptions,
): DeterministicInferenceStub {
  if (options.token.length < 8 || options.nonce.length < 8) throw new Error("stub credentials too short");
  if (!options.expectedTools) throw new Error("exact expected tool schemas are required");
  const expectedTools = normalizedToolDefinitions(options.expectedTools);
  const expectedNames = expectedTools.map((tool) => tool.function.name);
  if (!expectedNames.includes(options.toolName) || expectedNames.length === 0) {
    throw new Error("requested tool not in expected schema set");
  }
  if (new Set(expectedNames).size !== expectedNames.length) throw new Error("duplicate expected tool name");

  let state: DeterministicInferenceStubSnapshot["state"] = "awaiting_tool_call";
  let modelCallId: string | null = null;
  let toolMessageCount = 0;
  let finalMarker: string | null = null;
  let advertisedToolNames: string[] = [];
  let advertisedSchemaVerified = false;
  let toolContent: string | null = null;
  const expectedToolsJson = canonicalJson(expectedTools);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${options.token}`) return jsonError(401, "UNAUTHORIZED");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "canary-model", object: "model" }],
        });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return jsonError(404, "NOT_FOUND");
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > 2_000_000) return jsonError(413, "BODY_TOO_LARGE");

      let body: Record<string, unknown>;
      try {
        const text = await request.text();
        if (text.length > 2_000_000) return jsonError(413, "BODY_TOO_LARGE");
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return jsonError(400, "INVALID_JSON");
      }
      if (body.stream !== true) return jsonError(400, "STREAM_REQUIRED");
      const advertised = Array.isArray(body.tools) ? (body.tools as ChatToolDefinition[]) : [];
      advertisedToolNames = advertised
        .map((tool) => tool?.function?.name)
        .filter((name): name is string => typeof name === "string");
      advertisedSchemaVerified =
        advertised.length === expectedNames.length &&
        new Set(advertisedToolNames).size === expectedNames.length &&
        [...advertisedToolNames].sort().join("\0") === [...expectedNames].sort().join("\0") &&
        advertised.every(
          (tool) =>
            tool?.type === "function" &&
            !!tool.function &&
            typeof tool.function.description === "string" &&
            !!tool.function.parameters &&
            typeof tool.function.parameters === "object",
        );
      if (!advertisedSchemaVerified || canonicalJson(normalizedToolDefinitions(advertised)) !== expectedToolsJson) {
        return jsonError(400, "TOOL_SCHEMA_DRIFT");
      }
      const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];

      if (state === "awaiting_tool_call") {
        const userMessages = messages.filter((message) => message.role === "user");
        if (userMessages.length !== 1 || !String(userMessages[0]?.content ?? "").includes(options.nonce)) {
          state = "failed";
          return jsonError(400, "CASE_NONCE_MISSING");
        }
        modelCallId = `call_${createHash("sha256").update(options.nonce).digest("hex").slice(0, 20)}`;
        state = "awaiting_tool_result";
        const args = JSON.stringify(options.toolArguments);
        const splitAt = Math.max(1, Math.floor(args.length / 2));
        return sseResponse([
          completionChunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: modelCallId,
                type: "function",
                function: {
                  name: options.toolName,
                  arguments: args.slice(0, splitAt),
                },
              },
            ],
          }),
          completionChunk({
            tool_calls: [{ index: 0, function: { arguments: args.slice(splitAt) } }],
          }),
          completionChunk({}, "tool_calls"),
        ]);
      }

      if (state === "awaiting_tool_result") {
        const assistants = messages.filter((message) => message.role === "assistant");
        const toolMessages = messages.filter((message) => message.role === "tool");
        if (assistants.length !== 1 || toolMessages.length !== 1 || !modelCallId) {
          state = "failed";
          return jsonError(400, "TOOL_RESULT_CARDINALITY");
        }
        const assistantCalls = Array.isArray(assistants[0]?.tool_calls)
          ? (assistants[0].tool_calls as Array<Record<string, unknown>>)
          : [];
        const assistantCall = assistantCalls[0];
        const assistantFunction = assistantCall?.function as Record<string, unknown> | undefined;
        let assistantArgs: unknown;
        try {
          assistantArgs = JSON.parse(String(assistantFunction?.arguments ?? ""));
        } catch {
          state = "failed";
          return jsonError(400, "TOOL_ARGUMENTS_INVALID");
        }
        const toolMessage = toolMessages[0] as Record<string, unknown>;
        if (
          assistantCalls.length !== 1 ||
          assistantCall?.id !== modelCallId ||
          assistantFunction?.name !== options.toolName ||
          canonicalJson(assistantArgs) !== canonicalJson(options.toolArguments) ||
          toolMessage.tool_call_id !== modelCallId ||
          toolMessage.name !== options.toolName ||
          typeof toolMessage.content !== "string"
        ) {
          state = "failed";
          return jsonError(400, "TOOL_CORRELATION_FAILED");
        }
        toolMessageCount = 1;
        toolContent = toolMessage.content;
        finalMarker = `CANARY_FINAL_${createHash("sha256")
          .update(`${toolMessage.content}\0${options.nonce}`)
          .digest("hex")}`;
        state = "complete";
        return sseResponse([completionChunk({ role: "assistant", content: finalMarker }), completionChunk({}, "stop")]);
      }

      return jsonError(409, state === "complete" ? "REPLAY_REJECTED" : "STUB_FAILED");
    },
  });
  if (server.port === undefined) throw new Error("inference stub did not bind a port");

  return {
    port: server.port,
    snapshot() {
      return {
        state,
        model_call_id: modelCallId,
        tool_message_count: toolMessageCount,
        final_marker: finalMarker,
        complete: state === "complete",
        advertised_tool_names: [...advertisedToolNames],
        advertised_schema_verified: advertisedSchemaVerified,
        tool_content: toolContent,
      };
    },
    stop() {
      server.stop(true);
    },
  };
}

export function buildCanaryCaseSpecs(): CanaryCaseSpec[] {
  return MODES.flatMap((mode) =>
    TOOLS.flatMap((tool) =>
      BRANCHES.map((branch) => ({
        case_id: `${mode}:${tool}:${branch}`,
        mode,
        tool,
        branch,
      })),
    ),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function assertEvidenceManifest(manifest: PublicEvidenceManifest): void {
  const keys = Object.keys(manifest).sort();
  const expected = [...EVIDENCE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid evidence manifest keys");
  }
  if (manifest.algorithm !== "sha256-canonical-json-v1") throw new Error("invalid evidence algorithm");
  for (const key of EVIDENCE_KEYS) {
    if (key.endsWith("_digest") && !SHA256.test(String(manifest[key]))) {
      throw new Error("invalid evidence digest");
    }
  }
  if (!Number.isSafeInteger(manifest.checkpoint_blob_count) || manifest.checkpoint_blob_count < 1) {
    throw new Error("invalid checkpoint blob count");
  }
  if (!Number.isSafeInteger(manifest.node_modules_file_count) || manifest.node_modules_file_count < 1) {
    throw new Error("invalid node_modules file count");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(manifest.bun_version)) {
    throw new Error("invalid Bun version");
  }
}

export function canonicalEvidenceDigest(manifest: PublicEvidenceManifest): string {
  assertEvidenceManifest(manifest);
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function expectedProjectionKind(result: CanaryCaseResult): ProjectionKind {
  if (result.branch === "error") return "mcp_error_only";
  if (result.mode === "structured") return "result_plus_structured";
  return "legacy_result_only";
}

function expectedAuditContract(result: CanaryCaseResult): AuditContract {
  if (result.mode !== "structured" || result.branch !== "include_raw") return "none";
  if (result.tool === "query") return "query_locator_metadata";
  if (result.tool === "deep_recall") return "deep_locator_metadata";
  return "frontdoor_routing_metadata";
}

function expectedLegacyRaw(result: CanaryCaseResult): boolean {
  if (result.mode !== "legacy") return false;
  if (result.tool === "deep_recall") return result.branch === "include_raw";
  return result.branch !== "error";
}

function caseContractPasses(result: CanaryCaseResult): boolean {
  const successWithAnswer = result.branch === "normal" || result.branch === "include_raw";
  const structuredSuccess = result.mode === "structured" && result.branch !== "error";
  return (
    result.runtime_identity_verified &&
    result.advertised_tool_verified &&
    result.advertised_schema_verified &&
    result.cbrain_invocation_count === 1 &&
    result.cbrain_call_verified &&
    result.mcp_session_verified &&
    result.session_cleanup_verified &&
    result.case_cleanup_verified &&
    result.semantic_config_verified &&
    result.host_projection_verified &&
    result.round_trip_verified &&
    (!successWithAnswer || (result.result_title_present && result.result_body_present)) &&
    (result.branch !== "empty" || result.empty_contract_verified) &&
    (result.branch !== "error" || result.error_contract_verified) &&
    result.legacy_raw_present === expectedLegacyRaw(result) &&
    !result.default_audit_present &&
    result.expected_audit_contract === expectedAuditContract(result) &&
    result.audit_contract_verified &&
    (result.expected_audit_contract === "none" || result.audit_redaction_exercised) &&
    (result.branch === "error"
      ? result.sensitive_input_sent &&
        result.error_redaction_exercised === result.direct_error_sensitive_echo_observed
      : !result.sensitive_input_sent &&
        !result.direct_error_sensitive_echo_observed &&
        !result.error_redaction_exercised) &&
    !result.audit_sensitive_exposed &&
    !result.surface_internal_exposed &&
    result.expected_projection_kind === expectedProjectionKind(result) &&
    result.observed_projection_kind === result.expected_projection_kind &&
    result.projection_contract_verified &&
    result.text_structured_consistent === (structuredSuccess ? true : null) &&
    result.token_method === "tiktoken_cl100k_base_exact" &&
    [
      result.result_text_tokens,
      result.structured_content_tokens,
      result.wrapper_total_tokens,
      result.wrapper_total_code_units,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  );
}

function validateCaseMatrix(cases: readonly CanaryCaseResult[]): {
  complete: boolean;
  contracts: boolean;
} {
  const expected = new Map(buildCanaryCaseSpecs().map((spec) => [spec.case_id, spec]));
  if (cases.length !== 24 || new Set(cases.map((item) => item.case_id)).size !== 24) {
    return { complete: false, contracts: false };
  }
  for (const result of cases) {
    const spec = expected.get(result.case_id);
    if (!spec || spec.mode !== result.mode || spec.tool !== result.tool || spec.branch !== result.branch) {
      return { complete: false, contracts: false };
    }
  }
  return { complete: true, contracts: cases.every(caseContractPasses) };
}

function validateSizePairs(pairs: readonly SizePairEvidence[]): {
  valid: boolean;
  withinBudget: boolean;
} {
  const expectedIds = new Set(TOOLS.flatMap((tool) => DEFAULT_BRANCHES.map((branch) => `${tool}:${branch}`)));
  if (pairs.length !== 6 || new Set(pairs.map((pair) => pair.pair_id)).size !== 6) {
    return { valid: false, withinBudget: false };
  }
  let withinBudget = true;
  for (const pair of pairs) {
    if (!expectedIds.has(pair.pair_id) || pair.pair_id !== `${pair.tool}:${pair.branch}`) {
      return { valid: false, withinBudget: false };
    }
    if (pair.ab.order !== "legacy_then_structured" || pair.ba.order !== "structured_then_legacy") {
      return { valid: false, withinBudget: false };
    }
    const values = [
      pair.ab.legacy_tokens,
      pair.ab.structured_tokens,
      pair.ba.legacy_tokens,
      pair.ba.structured_tokens,
      pair.ab.legacy_code_units,
      pair.ab.structured_code_units,
      pair.ba.legacy_code_units,
      pair.ba.structured_code_units,
    ];
    if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return { valid: false, withinBudget: false };
    }
    const worstStructured = Math.max(pair.ab.structured_tokens, pair.ba.structured_tokens);
    const bestLegacy = Math.min(pair.ab.legacy_tokens, pair.ba.legacy_tokens);
    const growth = Math.max(0, worstStructured - bestLegacy);
    const ratio = bestLegacy === 0 ? null : worstStructured / bestLegacy;
    const absolutePass = growth <= 128;
    const relativeOrFloorPass =
      bestLegacy >= 128 ? worstStructured <= bestLegacy * 1.25 : worstStructured <= bestLegacy + 32;
    if (
      pair.worst_structured_tokens !== worstStructured ||
      pair.best_legacy_tokens !== bestLegacy ||
      pair.growth_tokens !== growth ||
      (ratio === null ? pair.ratio !== null : pair.ratio !== ratio) ||
      pair.absolute_gate_passed !== absolutePass ||
      pair.relative_or_floor_gate_passed !== relativeOrFloorPass
    ) {
      return { valid: false, withinBudget: false };
    }
    withinBudget &&= absolutePass && relativeOrFloorPass;
  }
  return { valid: true, withinBudget };
}

export function evaluateCanaryReport(input: CanaryEvaluationInput): HermesStructuredCanaryReport {
  const reasons: CanaryReasonCode[] = [];
  const matrix = validateCaseMatrix(input.cases);
  if (!matrix.complete || input.primary_executions !== 24) reasons.push("CASE_MATRIX_INCOMPLETE");
  else if (!matrix.contracts) reasons.push("CASE_CONTRACT_FAILED");

  const size = validateSizePairs(input.size_pairs);
  if (!size.valid || input.size_repetition_executions !== 12) reasons.push("SIZE_EVIDENCE_INVALID");
  else if (!size.withinBudget) reasons.push("SIZE_GROWTH_EXCEEDED");

  if (!input.real_hermes_host) reasons.push("HOST_NOT_VERIFIED");
  if (!input.runtime_snapshot_verified || !input.cbrain_snapshot_verified) reasons.push("SNAPSHOT_NOT_VERIFIED");
  if (!input.tokenizer_offline_verified) reasons.push("TOKENIZER_NOT_OFFLINE");
  if (!input.live_fingerprint_unchanged) reasons.push("LIVE_FINGERPRINT_DRIFT");
  if (!input.cleanup_verified) reasons.push("CLEANUP_NOT_VERIFIED");
  if (!input.semantic_answer_quality_not_measured) reasons.push("SEMANTIC_SCOPE_MISSTATED");

  let evidenceDigestMatches = false;
  try {
    evidenceDigestMatches =
      canonicalEvidenceDigest(input.evidence_manifest) === input.evidence_generation_digest &&
      canonicalJson(input.observed_evidence_manifest) === canonicalJson(input.evidence_manifest);
  } catch {
    evidenceDigestMatches = false;
  }
  if (!evidenceDigestMatches) reasons.push("EVIDENCE_DIGEST_MISMATCH");

  const hostCompatible = reasons.length === 0;
  const rolloutReady = input.rollback_command_id === "cbrain-structured-cohort-rollback-v1";
  if (!rolloutReady) reasons.push("ROLLBACK_NOT_EXECUTABLE");

  return {
    verdict: hostCompatible && rolloutReady ? "go" : "no-go",
    host_compatibility: hostCompatible ? "compatible" : "incompatible",
    rollout_readiness: rolloutReady ? "ready" : "blocked",
    reason_codes: reasons,
    matrix: {
      expected_cases: 24,
      completed_cases: input.cases.length,
      size_repetition_executions: input.size_repetition_executions,
    },
    evidence_manifest: input.evidence_manifest,
    evidence_generation_digest: input.evidence_generation_digest,
    semantic_answer_quality_not_measured: true,
  };
}
