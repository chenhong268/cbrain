import { createHash } from "node:crypto";

export const ROLLBACK_COMMAND_ID = "cbrain-structured-cohort-rollback-v1" as const;
export const COHORT_ID = "cbrain-structured-pilot-v1" as const;
export const STRUCTURED_COHORT_LABEL = "ai.cbrain.structured-cohort-v1" as const;

export type RollbackTarget = {
  label: string;
  cohortId: string;
  configAttestation: string;
  mode: "legacy" | "structured";
  healthPort: number;
  programArguments: string[];
  deploymentDigest: string;
};

export type RollbackFailureCode =
  | "LOCKED"
  | "LOCK_RELEASE_FAILED"
  | "TARGET_INVALID"
  | "MUTATION_FAILED"
  | "RESTART_FAILED"
  | "HEALTH_NOT_VERIFIED";

export type RollbackResult =
  | {
    schema_version: 1;
    status: "rolled_back" | "already_legacy";
    command_id: typeof ROLLBACK_COMMAND_ID;
    cohort_id: typeof COHORT_ID;
    mode: "legacy";
    restart_performed: boolean;
    health_verified: true;
  }
  | { schema_version: 1; status: "failed"; code: RollbackFailureCode };

export type RollbackDeps = {
  acquireLock(): (() => void) | null;
  loadTarget(): RollbackTarget;
  writeLegacy(): void;
  restart(): Promise<number>;
  currentProcessId(): Promise<number>;
  readHealth(): Promise<{
    ok: boolean;
    output_boundary?: unknown;
    cohort_id?: unknown;
    config_attestation?: unknown;
    deployment_digest?: unknown;
    process_id?: unknown;
  }>;
  sleep(ms: number): Promise<void>;
};

export function deploymentDigest(input: {
  label: string;
  programArguments: string[];
  healthPort: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    health_port: input.healthPort,
    label: input.label,
    program_arguments: input.programArguments,
  })).digest("hex");
}

function validTarget(target: RollbackTarget): boolean {
  if (target.label !== STRUCTURED_COHORT_LABEL) return false;
  if (target.cohortId !== COHORT_ID) return false;
  if (!/^[a-f0-9]{64}$/.test(target.configAttestation)) return false;
  if (target.mode !== "legacy" && target.mode !== "structured") return false;
  if (!Number.isInteger(target.healthPort) || target.healthPort < 1024 || target.healthPort > 65_535) return false;
  if (!Array.isArray(target.programArguments) || target.programArguments.length !== 5) return false;
  const entry = target.programArguments[0];
  if (typeof entry !== "string" || !entry.endsWith("/bin/cbrain-serve-http.sh")) return false;
  if (
    target.programArguments[1] !== "serve" ||
    target.programArguments[2] !== "--http" ||
    target.programArguments[3] !== "--port" ||
    target.programArguments[4] !== String(target.healthPort)
  ) return false;
  if (target.programArguments.some((arg) => typeof arg !== "string" || /[\n\r\0]/.test(arg))) return false;
  return target.deploymentDigest === deploymentDigest(target);
}

function success(status: "rolled_back" | "already_legacy", restarted: boolean): RollbackResult {
  return {
    schema_version: 1,
    status,
    command_id: ROLLBACK_COMMAND_ID,
    cohort_id: COHORT_ID,
    mode: "legacy",
    restart_performed: restarted,
    health_verified: true,
  };
}

async function healthIsLegacy(deps: RollbackDeps, target: RollbackTarget, processId: number): Promise<boolean> {
  try {
    const health = await deps.readHealth();
    return health.ok === true &&
      health.output_boundary === "legacy" &&
      health.cohort_id === COHORT_ID &&
      health.config_attestation === target.configAttestation &&
      health.deployment_digest === target.deploymentDigest &&
      health.process_id === processId;
  } catch {
    return false;
  }
}

async function executeLockedRollback(deps: RollbackDeps): Promise<RollbackResult> {
    let target: RollbackTarget;
    try {
      target = deps.loadTarget();
    } catch {
      return { schema_version: 1, status: "failed", code: "TARGET_INVALID" };
    }
    if (!validTarget(target)) {
      return { schema_version: 1, status: "failed", code: "TARGET_INVALID" };
    }

    if (target.mode === "legacy") {
      try {
        const currentProcessId = await deps.currentProcessId();
        if (await healthIsLegacy(deps, target, currentProcessId)) {
          return success("already_legacy", false);
        }
      } catch {
        // A missing or unverifiable job must go through the bounded restart path.
      }
    }

    if (target.mode === "structured") {
      try {
        deps.writeLegacy();
      } catch {
        return { schema_version: 1, status: "failed", code: "MUTATION_FAILED" };
      }
    }

    try {
      const processId = await deps.restart();
      if (!Number.isInteger(processId) || processId <= 0) throw new Error("invalid");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (await healthIsLegacy(deps, target, processId)) return success("rolled_back", true);
        if (attempt < 4) await deps.sleep(200);
      }
    } catch {
      return { schema_version: 1, status: "failed", code: "RESTART_FAILED" };
    }
    return { schema_version: 1, status: "failed", code: "HEALTH_NOT_VERIFIED" };
}

export async function rollbackStructuredCohort(deps: RollbackDeps): Promise<RollbackResult> {
  const release = deps.acquireLock();
  if (!release) return { schema_version: 1, status: "failed", code: "LOCKED" };
  let result: RollbackResult;
  try {
    result = await executeLockedRollback(deps);
  } catch {
    result = { schema_version: 1, status: "failed", code: "TARGET_INVALID" };
  }
  try {
    release();
  } catch {
    return { schema_version: 1, status: "failed", code: "LOCK_RELEASE_FAILED" };
  }
  return result;
}
