#!/usr/bin/env bun
/**
 * `bin/live-release-verify.ts` — checkout-independent read-only live-release verifier.
 *
 * Resolves the active CBrain deployment from loaded launchd evidence (never caller
 * cwd) and proves HTTP / package / manifest / skill-target version coherence.
 * Spawned by `skills/release-verify-bootstrap.sh`. Self-proves its own path is
 * under the active root before trusting itself, so a stale-checkout cwd cannot
 * impersonate the active deployment.
 *
 * Read-only. Emits privacy-safe human or JSON output. Exit 0 pass / 1 fail.
 *
 * Required skill targets: `CBRAIN_REQUIRED_SKILL_TARGETS` (colon-separated absolute
 * paths). If unset, probes the standard Hermes skill install path.
 * Rollback candidate (explanatory, inactive): `CBRAIN_ROLLBACK_CANDIDATE`.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRealDeps } from "./lib/live-release-deps.js";
import { verifyLiveRelease, type VerifyOptions, type VerifyResult } from "./lib/live-release-verify.js";

function formatHuman(result: VerifyResult): string {
  if (result.status === "pass") {
    const lines = [
      "",
      "  CBrain Live-Release Verify: PASS",
      `  Service:    ${result.service?.label} (birth ${result.service?.pid_birth})`,
      `  Active:     ${result.active?.root} v${result.active?.version}`,
      `  Versions:   http=${result.versions?.http} package=${result.versions?.package} manifest=${result.versions?.manifest}`,
    ];
    for (const target of result.targets ?? []) {
      lines.push(`  Target:     ${target.path} [${target.status}]`);
    }
    lines.push(`  Caller cwd: ${result.caller_cwd?.path} [${result.caller_cwd?.classification}]`);
    if (result.rollback) {
      lines.push(`  Rollback:   ${result.rollback.path} [${result.rollback.classification}]`);
    }
    lines.push("");
    return lines.join("\n");
  }
  return `\n  CBrain Live-Release Verify: FAIL [${result.code}] (layer ${result.layer})\n`;
}

function main(): number {
  const ownVerifierPath = realpathSync(fileURLToPath(import.meta.url));
  const deps = buildRealDeps(ownVerifierPath);

  const opts: Partial<VerifyOptions> = {
    requiredTargets: process.env.CBRAIN_REQUIRED_SKILL_TARGETS?.split(":").filter(Boolean) ?? [],
  };
  if (process.env.CBRAIN_ROLLBACK_CANDIDATE) opts.rollbackCandidate = process.env.CBRAIN_ROLLBACK_CANDIDATE;

  const result = verifyLiveRelease(deps, opts);
  const json = process.argv.includes("--json");
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : formatHuman(result));
  return result.status === "pass" ? 0 : 1;
}

process.exitCode = main();
