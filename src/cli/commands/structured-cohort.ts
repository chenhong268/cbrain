import { execFileSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { loadConfig, resolveRuntimePath } from "../context.js";
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
const RECEIPT_KEYS = ["schema_version", "command_id", "cohort_id", "health_port", "deployment_digest"] as const;

type Receipt = {
  schema_version: 1;
  command_id: typeof ROLLBACK_COMMAND_ID;
  cohort_id: typeof COHORT_ID;
  health_port: number;
  deployment_digest: string;
};

function strictReceipt(path: string, uid: number): Receipt {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error("invalid");
  const text = readFileSync(path, "utf8");
  if (text.length > 4096) throw new Error("invalid");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid");
  if (Object.keys(parsed).sort().join("\0") !== [...RECEIPT_KEYS].sort().join("\0")) throw new Error("invalid");
  for (const key of RECEIPT_KEYS) {
    const occurrences = [...text.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
    if (occurrences !== 1) throw new Error("invalid");
  }
  if (parsed.schema_version !== 1 || parsed.command_id !== ROLLBACK_COMMAND_ID || parsed.cohort_id !== COHORT_ID) {
    throw new Error("invalid");
  }
  if (!Number.isInteger(parsed.health_port) || typeof parsed.deployment_digest !== "string") throw new Error("invalid");
  return parsed as Receipt;
}

function parsePlist(path: string, uid: number): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw new Error("invalid");
  const text = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.Label !== STRUCTURED_COHORT_LABEL || !Array.isArray(value.ProgramArguments)) throw new Error("invalid");
  return value;
}

function targetFrom(plist: Record<string, unknown>, receipt: Receipt): RollbackTarget {
  const env = plist.EnvironmentVariables as Record<string, unknown> | undefined;
  const mode = env?.CBRAIN_OUTPUT_BOUNDARY;
  const programArguments = (plist.ProgramArguments as unknown[]).filter((item): item is string => typeof item === "string");
  if (programArguments.length !== (plist.ProgramArguments as unknown[]).length) throw new Error("invalid");
  return {
    label: String(plist.Label),
    mode: mode as RollbackTarget["mode"],
    healthPort: receipt.health_port,
    programArguments,
    deploymentDigest: receipt.deployment_digest,
  };
}

export function createProductionRollbackDeps(options: {
  runtimePath: string;
  home?: string;
  uid?: number;
}): RollbackDeps {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("unsupported");
  const rolloutDir = resolve(options.runtimePath, "rollout");
  const receiptPath = join(rolloutDir, RECEIPT_BASENAME);
  const plistPath = join(options.home ?? homedir(), "Library", "LaunchAgents", PLIST_BASENAME);
  const lockPath = join(rolloutDir, ".structured-cohort-rollback.lock");
  let receipt: Receipt;
  let target: RollbackTarget;

  return {
    acquireLock: () => {
      mkdirSync(rolloutDir, { recursive: true, mode: 0o700 });
      let fd: number;
      try { fd = openSync(lockPath, "wx", 0o600); } catch { return null; }
      return () => {
        try { closeSync(fd); } finally { try { unlinkSync(lockPath); } catch { /* bounded cleanup */ } }
      };
    },
    loadTarget: () => {
      receipt = strictReceipt(receiptPath, uid);
      target = targetFrom(parsePlist(plistPath, uid), receipt);
      return target;
    },
    writeLegacy: () => {
      const backupPath = join(rolloutDir, "structured-cohort-v1.pre-rollback.plist");
      try { copyFileSync(plistPath, backupPath, constants.COPYFILE_EXCL); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      chmodSync(backupPath, 0o600);
      const tempPath = join(dirname(plistPath), `.${basename(plistPath)}.${randomUUID()}.tmp`);
      try {
        copyFileSync(plistPath, tempPath);
        chmodSync(tempPath, 0o600);
        execFileSync("/usr/bin/plutil", ["-replace", "EnvironmentVariables.CBRAIN_OUTPUT_BOUNDARY", "-string", "legacy", tempPath], {
          stdio: "ignore",
        });
        const updated = targetFrom(parsePlist(tempPath, uid), receipt);
        if (updated.mode !== "legacy" || deploymentDigest(updated) !== target.deploymentDigest) throw new Error("invalid");
        renameSync(tempPath, plistPath);
      } finally {
        try { unlinkSync(tempPath); } catch { /* renamed or bounded cleanup */ }
      }
    },
    restart: async () => {
      const domain = `gui/${uid}`;
      try {
        execFileSync("/bin/launchctl", ["bootout", `${domain}/${STRUCTURED_COHORT_LABEL}`], { stdio: "ignore" });
      } catch {
        // A not-loaded cohort is safe to bootstrap; bootstrap remains mandatory.
      }
      execFileSync("/bin/launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
    },
    readHealth: async () => {
      const response = await fetch(`http://127.0.0.1:${receipt.health_port}/health`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return { ok: false };
      return await response.json() as { ok: boolean; output_boundary?: unknown };
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
        const config = loadConfig();
        result = await rollbackStructuredCohort(createProductionRollbackDeps({ runtimePath: resolveRuntimePath(config) }));
      } catch {
        result = { schema_version: 1, status: "failed", code: "TARGET_INVALID" } as const;
      }
      console.log(JSON.stringify(result));
      if (result.status === "failed") process.exitCode = 1;
    });
}
