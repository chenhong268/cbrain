import { describe, expect, test } from "bun:test";
import {
  COHORT_ID,
  ROLLBACK_COMMAND_ID,
  STRUCTURED_COHORT_LABEL,
  deploymentDigest,
  rollbackStructuredCohort,
  type RollbackDeps,
  type RollbackTarget,
} from "../../src/core/release/structured-cohort-rollback.js";

function target(mode: "legacy" | "structured" = "structured"): RollbackTarget {
  const programArguments = ["/fixture/bin/cbrain-serve-http.sh", "serve", "--http", "--port", "3401"];
  return {
    label: STRUCTURED_COHORT_LABEL,
    mode,
    healthPort: 3401,
    programArguments,
    deploymentDigest: deploymentDigest({
      label: STRUCTURED_COHORT_LABEL,
      programArguments,
      healthPort: 3401,
    }),
    cohortId: COHORT_ID,
    configAttestation: "b".repeat(64),
  };
}

function harness(initial = target()) {
  const calls: string[] = [];
  let current = initial;
  let healthyMode: "legacy" | "structured" = initial.mode;
  const deps: RollbackDeps = {
    acquireLock: () => {
      calls.push("lock");
      return () => { calls.push("unlock"); };
    },
    loadTarget: () => current,
    writeLegacy: () => {
      calls.push("write");
      current = { ...current, mode: "legacy" };
    },
    restart: async () => {
      calls.push("restart");
      healthyMode = current.mode;
      return 4242;
    },
    currentProcessId: async () => 4242,
    readHealth: async () => ({
      ok: true,
      output_boundary: healthyMode,
      cohort_id: COHORT_ID,
      config_attestation: current.configAttestation,
      deployment_digest: current.deploymentDigest,
      process_id: 4242,
    }),
    sleep: async () => {},
  };
  return { deps, calls, setHealth: (mode: "legacy" | "structured") => { healthyMode = mode; } };
}

describe("structured cohort rollback (#357)", () => {
  test("changes only the fixed cohort to legacy, restarts, verifies, and unlocks", async () => {
    const h = harness();
    expect(await rollbackStructuredCohort(h.deps)).toEqual({
      schema_version: 1,
      status: "rolled_back",
      command_id: ROLLBACK_COMMAND_ID,
      cohort_id: COHORT_ID,
      mode: "legacy",
      restart_performed: true,
      health_verified: true,
    });
    expect(h.calls).toEqual(["lock", "write", "restart", "unlock"]);
  });

  test("already healthy legacy is an idempotent no-op", async () => {
    const h = harness(target("legacy"));
    expect((await rollbackStructuredCohort(h.deps)).status).toBe("already_legacy");
    expect(h.calls).toEqual(["lock", "unlock"]);
  });

  test("legacy but unhealthy restarts and verifies for partial-failure recovery", async () => {
    const h = harness(target("legacy"));
    h.setHealth("structured");
    const result = await rollbackStructuredCohort(h.deps);
    expect(result.status).toBe("rolled_back");
    expect(h.calls).toEqual(["lock", "restart", "unlock"]);
  });

  test("rejects target substitution before mutation", async () => {
    const bad = { ...target(), label: "unrelated.service" };
    const h = harness(bad);
    expect(await rollbackStructuredCohort(h.deps)).toEqual({
      schema_version: 1,
      status: "failed",
      code: "TARGET_INVALID",
    });
    expect(h.calls).toEqual(["lock", "unlock"]);
  });

  test("rejects digest, program, port, and mode drift before mutation", async () => {
    const mutations: RollbackTarget[] = [
      { ...target(), deploymentDigest: "0".repeat(64) },
      { ...target(), programArguments: ["/bin/sh", "-c", "payload"] },
      { ...target(), healthPort: 80 },
      { ...target(), mode: "invalid" as never },
      { ...target(), cohortId: "unrelated" },
      { ...target(), configAttestation: "invalid" },
      { ...target(), programArguments: ["/fixture/bin/cbrain-serve-http.sh", "serve", "--http", "--port", "9999"] },
      { ...target(), programArguments: ["/fixture/bin/cbrain-serve-http.sh", "--http", "serve", "--port", "3401"] },
    ];
    for (const mutation of mutations) {
      const h = harness(mutation);
      expect((await rollbackStructuredCohort(h.deps)).status).toBe("failed");
      expect(h.calls).toEqual(["lock", "unlock"]);
    }
  });

  test("fails closed on lock, mutation, restart, and health failures without detail", async () => {
    const locked = harness();
    locked.deps.acquireLock = () => null;
    expect(await rollbackStructuredCohort(locked.deps)).toEqual({ schema_version: 1, status: "failed", code: "LOCKED" });

    for (const stage of ["write", "restart", "health"] as const) {
      const h = harness();
      if (stage === "write") h.deps.writeLegacy = () => { throw new Error("/private/fixture secret"); };
      if (stage === "restart") h.deps.restart = async () => { throw new Error("/private/fixture secret"); };
      if (stage === "health") h.deps.readHealth = async () => ({ ok: true, output_boundary: "structured" });
      const result = await rollbackStructuredCohort(h.deps);
      expect(JSON.stringify(result)).not.toContain("/private/fixture");
      expect(result.status).toBe("failed");
      expect(h.calls.at(-1)).toBe("unlock");
    }
  });

  test("rejects health from an unrelated process or deployment", async () => {
    for (const health of [
      { ok: true, output_boundary: "legacy", cohort_id: "other", config_attestation: target().configAttestation, deployment_digest: target().deploymentDigest, process_id: 4242 },
      { ok: true, output_boundary: "legacy", cohort_id: COHORT_ID, config_attestation: "0".repeat(64), deployment_digest: target().deploymentDigest, process_id: 4242 },
      { ok: true, output_boundary: "legacy", cohort_id: COHORT_ID, config_attestation: target().configAttestation, deployment_digest: "0".repeat(64), process_id: 4242 },
      { ok: true, output_boundary: "legacy", cohort_id: COHORT_ID, config_attestation: target().configAttestation, deployment_digest: target().deploymentDigest, process_id: 7 },
    ]) {
      const h = harness();
      h.deps.readHealth = async () => health;
      expect((await rollbackStructuredCohort(h.deps)).status).toBe("failed");
    }
  });

  test("fails closed when the owned lock cannot be released", async () => {
    const h = harness();
    h.deps.acquireLock = () => () => { throw new Error("private lock path"); };
    expect(await rollbackStructuredCohort(h.deps)).toEqual({
      schema_version: 1,
      status: "failed",
      code: "LOCK_RELEASE_FAILED",
    });
  });
});
