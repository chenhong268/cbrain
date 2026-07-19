import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { loadConfigSafe, resolveRuntimePath } from "../context.js";
import {
  COHORT_ID,
  ROLLBACK_COMMAND_ID,
  STRUCTURED_COHORT_LABEL,
  deploymentDigest,
  rollbackStructuredCohort,
  type RollbackDeps,
  type RollbackResult,
  type RollbackTarget,
} from "../../core/release/structured-cohort-rollback.js";

const PLIST_BASENAME = "ai.cbrain.structured-cohort-v1.plist";
const RECEIPT_BASENAME = "structured-cohort-v1.json";
const BACKUP_BASENAME = "structured-cohort-v1.pre-rollback.plist";
const LOCK_BASENAME = ".structured-cohort-rollback.lock";
const RECEIPT_KEYS = ["schema_version", "command_id", "cohort_id", "config_identity", "health_port", "deployment_digest"] as const;
const PLIST_KEYS = new Set([
  "EnvironmentVariables",
  "KeepAlive",
  "Label",
  "ProcessType",
  "ProgramArguments",
  "RunAtLoad",
  "ThrottleInterval",
]);
const ENV_KEYS = new Set([
  "CBRAIN_OUTPUT_BOUNDARY",
  "CBRAIN_CONFIG",
  "CBRAIN_ROLLOUT_COHORT_ID",
  "CBRAIN_ROLLOUT_CONFIG_IDENTITY",
  "CBRAIN_ROLLOUT_DEPLOYMENT_DIGEST",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 4096;
const MAX_PLIST_BYTES = 64 * 1024;

type Receipt = {
  schema_version: 1;
  command_id: typeof ROLLBACK_COMMAND_ID;
  cohort_id: typeof COHORT_ID;
  config_identity: string;
  health_port: number;
  deployment_digest: string;
};

type LaunchctlResult = { status: number; stdout: string };
type HealthResult = { status: number; body: string; redirected: boolean };

export type ProductionRollbackOptions = {
  runtimePath: string;
  home?: string;
  uid?: number;
  expectedScriptPath?: string;
  activeConfigPath: string;
  processId?: number;
  processIdentity?: (pid: number) => string | null;
  launchctl?: (args: readonly string[]) => LaunchctlResult;
  healthRequest?: (url: string) => Promise<HealthResult>;
};

type SecureBytes = { bytes: Buffer; dev: number; ino: number };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureDirectory(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error("invalid");
  }
}

function secureBytes(path: string, uid: number, maxBytes: number): SecureBytes {
  const before = lstatSync(path);
  if (
    !before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 || before.size > maxBytes
  ) throw new Error("invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("invalid");
    }
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) throw new Error("invalid");
    return { bytes, dev: opened.dev, ino: opened.ino };
  } finally {
    closeSync(fd);
  }
}

function validateActiveConfig(path: string, uid: number): void {
  const before = lstatSync(path);
  if (
    !before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
    (before.mode & 0o022) !== 0 || before.size > 1024 * 1024
  ) throw new Error("invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) throw new Error("invalid");
  } finally {
    closeSync(fd);
  }
}

function receiptKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)) {
    if (match[1].includes("\\")) throw new Error("invalid");
    keys.push(JSON.parse(match[1]) as string);
  }
  return keys;
}

function strictReceiptBytes(input: SecureBytes): Receipt {
  const text = input.bytes.toString("utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid");
  const keys = receiptKeys(text);
  if (keys.length !== RECEIPT_KEYS.length || new Set(keys).size !== keys.length) throw new Error("invalid");
  if (keys.slice().sort().join("\0") !== [...RECEIPT_KEYS].sort().join("\0")) throw new Error("invalid");
  if (Object.keys(parsed).sort().join("\0") !== [...RECEIPT_KEYS].sort().join("\0")) throw new Error("invalid");
  if (parsed.schema_version !== 1 || parsed.command_id !== ROLLBACK_COMMAND_ID || parsed.cohort_id !== COHORT_ID) {
    throw new Error("invalid");
  }
  if (
    !Number.isInteger(parsed.health_port) || (parsed.health_port as number) < 1024 ||
    (parsed.health_port as number) > 65_535 || typeof parsed.deployment_digest !== "string" ||
    !SHA256.test(parsed.deployment_digest) || typeof parsed.config_identity !== "string" || !SHA256.test(parsed.config_identity)
  ) throw new Error("invalid");
  return parsed as Receipt;
}

function parsePlistBytes(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > MAX_PLIST_BYTES) throw new Error("invalid");
  const raw = bytes.toString("utf8");
  if (!raw.startsWith("<?xml") || /<!ENTITY/i.test(raw)) throw new Error("invalid");
  const rawKeys = [...raw.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  if (rawKeys.some((key) => key.includes("&")) || new Set(rawKeys).size !== rawKeys.length) throw new Error("invalid");
  const text = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    encoding: "utf8",
    input: bytes,
    maxBuffer: MAX_PLIST_BYTES * 2,
    timeout: 2000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("invalid");
  return value;
}

function validateEntrypoint(path: string, expectedPath: string, uid: number): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1 ||
    (stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0 || path !== expectedPath ||
    realpathSync(path) !== path || realpathSync(expectedPath) !== expectedPath
  ) throw new Error("invalid");
}

function targetFrom(
  plist: Record<string, unknown>,
  receipt: Receipt,
  expectedScriptPath: string,
  activeConfigPath: string,
  uid: number,
): RollbackTarget {
  if (Object.keys(plist).some((key) => !PLIST_KEYS.has(key))) throw new Error("invalid");
  if (plist.Label !== STRUCTURED_COHORT_LABEL || !Array.isArray(plist.ProgramArguments)) throw new Error("invalid");
  if (Object.keys(plist).length !== PLIST_KEYS.size) throw new Error("invalid");
  if (plist.RunAtLoad !== true || plist.KeepAlive !== true || plist.ProcessType !== "Background" || plist.ThrottleInterval !== 10) {
    throw new Error("invalid");
  }
  const programArguments = plist.ProgramArguments;
  if (programArguments.some((item) => typeof item !== "string" || /[\n\r\0]/.test(item))) throw new Error("invalid");
  if (
    programArguments.length !== 5 || programArguments[1] !== "serve" || programArguments[2] !== "--http" ||
    programArguments[3] !== "--port" || programArguments[4] !== String(receipt.health_port)
  ) throw new Error("invalid");
  validateEntrypoint(programArguments[0] as string, expectedScriptPath, uid);

  const env = plist.EnvironmentVariables;
  if (!env || Array.isArray(env) || typeof env !== "object") throw new Error("invalid");
  const environment = env as Record<string, unknown>;
  if (Object.keys(environment).length !== ENV_KEYS.size || Object.keys(environment).some((key) => !ENV_KEYS.has(key))) {
    throw new Error("invalid");
  }
  const mode = environment.CBRAIN_OUTPUT_BOUNDARY;
  if (mode !== "legacy" && mode !== "structured") throw new Error("invalid");
  if (environment.CBRAIN_ROLLOUT_COHORT_ID !== COHORT_ID) throw new Error("invalid");
  if (environment.CBRAIN_ROLLOUT_CONFIG_IDENTITY !== receipt.config_identity) throw new Error("invalid");
  if (environment.CBRAIN_ROLLOUT_DEPLOYMENT_DIGEST !== receipt.deployment_digest) throw new Error("invalid");
  const configPath = environment.CBRAIN_CONFIG;
  if (
    typeof configPath !== "string" || !configPath.startsWith("/") || /[\n\r\0]/.test(configPath) ||
    configPath !== activeConfigPath || realpathSync(configPath) !== configPath || realpathSync(activeConfigPath) !== activeConfigPath
  ) throw new Error("invalid");
  validateActiveConfig(configPath, uid);
  const args = programArguments as string[];
  const target: RollbackTarget = {
    label: STRUCTURED_COHORT_LABEL,
    cohortId: COHORT_ID,
    configIdentity: receipt.config_identity,
    mode,
    healthPort: receipt.health_port,
    programArguments: args,
    deploymentDigest: receipt.deployment_digest,
  };
  if (deploymentDigest(target) !== receipt.deployment_digest) throw new Error("invalid");
  return target;
}

function defaultProcessIdentity(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 1000,
    maxBuffer: 4096,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 1) return null;
  if (result.status !== 0 || result.error) throw new Error("unavailable");
  const value = result.stdout.trim();
  if (!value) throw new Error("unavailable");
  return value;
}

function defaultLaunchctl(args: readonly string[]): LaunchctlResult {
  const result = spawnSync("/bin/launchctl", [...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

async function defaultHealthRequest(url: string): Promise<HealthResult> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1000) });
  if (!response.body) throw new Error("invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new Error("invalid");
    }
    chunks.push(item.value);
  }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return { status: response.status, body, redirected: response.redirected };
}

function parseLaunchdPid(result: LaunchctlResult): number {
  if (result.status !== 0) throw new Error("invalid");
  const matches = [...result.stdout.matchAll(/^\s*pid\s*=\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) throw new Error("invalid");
  const pid = Number(matches[0][1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid");
  return pid;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writePrivateExclusive(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function structuredCohortEntrypoint(): string {
  return fileURLToPath(new URL("../../../bin/cbrain-serve-http.sh", import.meta.url));
}

export function createProductionRollbackDeps(options: ProductionRollbackOptions): RollbackDeps {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("unsupported");
  const home = resolve(options.home ?? homedir());
  const runtimePath = resolve(options.runtimePath);
  const rolloutDir = join(runtimePath, "rollout");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const receiptPath = join(rolloutDir, RECEIPT_BASENAME);
  const plistPath = join(launchAgentsDir, PLIST_BASENAME);
  const lockPath = join(rolloutDir, LOCK_BASENAME);
  const expectedScriptPath = resolve(options.expectedScriptPath ?? structuredCohortEntrypoint());
  const activeConfigPath = resolve(options.activeConfigPath);
  const processId = options.processId ?? process.pid;
  const processIdentity = options.processIdentity ?? defaultProcessIdentity;
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const healthRequest = options.healthRequest ?? defaultHealthRequest;
  let receipt: Receipt;
  let receiptSnapshot: SecureBytes;
  let target: RollbackTarget;
  let originalPlist: SecureBytes;
  let approvedLegacyPlist: SecureBytes | undefined;

  const validateDirectories = () => {
    secureDirectory(home, uid);
    secureDirectory(join(home, "Library"), uid);
    secureDirectory(launchAgentsDir, uid);
    secureDirectory(runtimePath, uid);
    secureDirectory(rolloutDir, uid);
  };

  const inspectProcess = (pid: number) => processIdentity(pid);
  const lockIdentity = inspectProcess(processId);
  if (!lockIdentity) throw new Error("unsupported");
  const lockValue = `v1:${processId}:${sha256(lockIdentity)}`;

  const removeObservedLock = (observed: NonNullable<ReturnType<typeof lstatSync>>, expectedValue: string): boolean => {
    const quarantinePath = join(rolloutDir, `.structured-cohort-lock-cleanup.${randomUUID()}`);
    try {
      renameSync(lockPath, quarantinePath);
      const moved = lstatSync(quarantinePath);
      if (
        moved.dev !== observed.dev || moved.ino !== observed.ino || !moved.isSymbolicLink() ||
        readlinkSync(quarantinePath) !== expectedValue
      ) return false;
      unlinkSync(quarantinePath);
      fsyncDirectory(rolloutDir);
      return true;
    } catch {
      return false;
    }
  };

  const acquireLock = (): (() => void) | null => {
    try { validateDirectories(); } catch { return null; }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        symlinkSync(lockValue, lockPath);
        const owned = lstatSync(lockPath);
        if (!owned.isSymbolicLink() || owned.uid !== uid || readlinkSync(lockPath) !== lockValue) throw new Error("invalid");
        return () => {
          const current = lstatSync(lockPath);
          if (current.dev !== owned.dev || current.ino !== owned.ino || !current.isSymbolicLink() || readlinkSync(lockPath) !== lockValue) {
            throw new Error("invalid");
          }
          if (!removeObservedLock(owned, lockValue)) throw new Error("invalid");
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
        let stale = false;
        let observed: NonNullable<ReturnType<typeof lstatSync>>;
        try {
          observed = lstatSync(lockPath);
          if (!observed.isSymbolicLink() || observed.uid !== uid) return null;
          const match = /^v1:(\d+):([a-f0-9]{64})$/.exec(readlinkSync(lockPath));
          if (!match) return null;
          const ownerIdentity = inspectProcess(Number(match[1]));
          stale = !ownerIdentity || sha256(ownerIdentity) !== match[2];
          if (!stale) return null;
          const current = lstatSync(lockPath);
          if (current.dev !== observed.dev || current.ino !== observed.ino) return null;
          if (!removeObservedLock(observed, readlinkSync(lockPath))) return null;
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  const validateReceiptSnapshot = () => {
    const current = secureBytes(receiptPath, uid, MAX_RECEIPT_BYTES);
    if (
      current.dev !== receiptSnapshot.dev || current.ino !== receiptSnapshot.ino ||
      !current.bytes.equals(receiptSnapshot.bytes)
    ) throw new Error("invalid");
  };

  const validateCurrentLegacyTarget = () => {
    validateDirectories();
    validateReceiptSnapshot();
    const current = secureBytes(plistPath, uid, MAX_PLIST_BYTES);
    const checked = targetFrom(parsePlistBytes(current.bytes), receipt, expectedScriptPath, activeConfigPath, uid);
    if (checked.mode !== "legacy" || checked.deploymentDigest !== target.deploymentDigest) throw new Error("invalid");
    if (
      !approvedLegacyPlist || current.dev !== approvedLegacyPlist.dev || current.ino !== approvedLegacyPlist.ino ||
      !current.bytes.equals(approvedLegacyPlist.bytes)
    ) throw new Error("invalid");
  };

  return {
    acquireLock,
    loadTarget: () => {
      validateDirectories();
      receiptSnapshot = secureBytes(receiptPath, uid, MAX_RECEIPT_BYTES);
      receipt = strictReceiptBytes(receiptSnapshot);
      originalPlist = secureBytes(plistPath, uid, MAX_PLIST_BYTES);
      target = targetFrom(parsePlistBytes(originalPlist.bytes), receipt, expectedScriptPath, activeConfigPath, uid);
      approvedLegacyPlist = target.mode === "legacy" ? originalPlist : undefined;
      return target;
    },
    writeLegacy: () => {
      validateDirectories();
      validateReceiptSnapshot();
      const current = secureBytes(plistPath, uid, MAX_PLIST_BYTES);
      if (current.dev !== originalPlist.dev || current.ino !== originalPlist.ino || !current.bytes.equals(originalPlist.bytes)) {
        throw new Error("invalid");
      }

      const backupPath = join(rolloutDir, BACKUP_BASENAME);
      try {
        writePrivateExclusive(backupPath, originalPlist.bytes);
        fsyncDirectory(rolloutDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = secureBytes(backupPath, uid, MAX_PLIST_BYTES);
        if (!existing.bytes.equals(originalPlist.bytes)) throw new Error("invalid");
      }

      const tempPath = join(launchAgentsDir, `.${PLIST_BASENAME}.${randomUUID()}.tmp`);
      try {
        writePrivateExclusive(tempPath, originalPlist.bytes);
        execFileSync("/usr/bin/plutil", [
          "-replace", "EnvironmentVariables.CBRAIN_OUTPUT_BOUNDARY", "-string", "legacy", tempPath,
        ], { timeout: 2000, maxBuffer: 4096, stdio: "ignore" });
        fsyncFile(tempPath);
        const temp = secureBytes(tempPath, uid, MAX_PLIST_BYTES);
        const updated = targetFrom(parsePlistBytes(temp.bytes), receipt, expectedScriptPath, activeConfigPath, uid);
        if (updated.mode !== "legacy" || deploymentDigest(updated) !== target.deploymentDigest) throw new Error("invalid");
        const unchanged = secureBytes(plistPath, uid, MAX_PLIST_BYTES);
        if (unchanged.dev !== originalPlist.dev || unchanged.ino !== originalPlist.ino || !unchanged.bytes.equals(originalPlist.bytes)) {
          throw new Error("invalid");
        }
        const finalTemp = secureBytes(tempPath, uid, MAX_PLIST_BYTES);
        if (finalTemp.dev !== temp.dev || finalTemp.ino !== temp.ino || !finalTemp.bytes.equals(temp.bytes)) throw new Error("invalid");
        renameSync(tempPath, plistPath);
        fsyncDirectory(launchAgentsDir);
        approvedLegacyPlist = secureBytes(plistPath, uid, MAX_PLIST_BYTES);
      } finally {
        try { unlinkSync(tempPath); } catch { /* renamed or private temp cleanup */ }
      }
    },
    restart: async () => {
      validateCurrentLegacyTarget();
      const domain = `gui/${uid}`;
      const service = `${domain}/${STRUCTURED_COHORT_LABEL}`;
      const before = launchctl(["print", service]);
      if (before.status === 0) {
        if (launchctl(["bootout", service]).status !== 0) throw new Error("invalid");
      } else if (before.status !== 113) {
        throw new Error("invalid");
      }
      // Revalidate immediately before handing the fixed path to bootstrap. The
      // earlier print/bootout calls must not create a substitution window.
      validateCurrentLegacyTarget();
      if (launchctl(["bootstrap", domain, plistPath]).status !== 0) throw new Error("invalid");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const after = launchctl(["print", service]);
        if (after.status === 0) {
          try { return parseLaunchdPid(after); } catch {
            if (attempt === 4) throw new Error("invalid");
            await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
            continue;
          }
        }
        if (after.status !== 113) throw new Error("invalid");
        if (attempt < 4) await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
      }
      throw new Error("invalid");
    },
    currentProcessId: async () => {
      validateCurrentLegacyTarget();
      const domain = `gui/${uid}`;
      return parseLaunchdPid(launchctl(["print", `${domain}/${STRUCTURED_COHORT_LABEL}`]));
    },
    readHealth: async () => {
      validateReceiptSnapshot();
      const response = await healthRequest(`http://127.0.0.1:${receipt.health_port}/health`);
      if (response.status !== 200 || response.redirected || Buffer.byteLength(response.body, "utf8") > 4096) return { ok: false };
      const health = JSON.parse(response.body) as Record<string, unknown>;
      return {
        ok: health.ok === true,
        output_boundary: health.output_boundary,
        cohort_id: health.cohort_id,
        config_identity: health.config_identity,
        deployment_digest: health.deployment_digest,
        process_id: health.process_id,
      };
    },
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
}

export function register(program: Command): void {
  const parent = program.command("structured-cohort").description("Manage the fixed structured pilot cohort");
  parent.command("rollback")
    .description("Restore only the fixed structured pilot cohort to legacy output")
    .option("--json", "Emit the closed rollback result as JSON")
    .action(async () => {
      let result: RollbackResult;
      try {
        const loaded = loadConfigSafe();
        if (!loaded) throw new Error("invalid");
        result = await rollbackStructuredCohort(createProductionRollbackDeps({
          runtimePath: resolveRuntimePath(loaded.config),
          activeConfigPath: loaded.configPath,
        }));
      } catch {
        result = { schema_version: 1, status: "failed", code: "TARGET_INVALID" } as const;
      }
      console.log(JSON.stringify(result));
      if (result.status === "failed") process.exitCode = 1;
    });
}
