#!/usr/bin/env bun
// check-v2-preflight.ts — v2.0 preflight aggregator
//
// Runs the already-owned release gates as one go/no-go packet. This script does
// not duplicate journey logic; it orchestrates existing gates and returns one
// concise JSON report for the release manager.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;

type Verdict = "go" | "no-go";
type CheckStatus = "pass" | "fail";

export interface PreflightCheckSpec {
  readonly id: string;
  readonly label: string;
  readonly command: readonly string[];
  readonly required: boolean;
  readonly timeoutMs: number;
}

export interface PreflightCheckResult {
  readonly id: string;
  readonly label: string;
  readonly command: readonly string[];
  readonly required: boolean;
  readonly status: CheckStatus;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
}

export interface PreflightReport {
  readonly gate: "v2-preflight";
  readonly version: string;
  readonly timestamp: string;
  readonly verdict: Verdict;
  readonly checks: readonly PreflightCheckResult[];
  readonly failed_stage: string | null;
  readonly reason: string | null;
  readonly next_action: string | null;
  readonly duration_ms: number;
}

export type CommandRunner = (spec: PreflightCheckSpec) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}>;

export const DEFAULT_PREFLIGHT_CHECKS: readonly PreflightCheckSpec[] = [
  {
    id: "offline-first-recall",
    label: "Fresh install / first recall gate",
    command: ["bun", "run", "gate:offline"],
    required: true,
    timeoutMs: 180_000,
  },
  {
    id: "rc-journeys",
    label: "v2 RC journey quality gate",
    command: ["bun", "run", "gate:rc"],
    required: true,
    timeoutMs: 180_000,
  },
  {
    id: "hermes-dialogue",
    label: "Hermes natural-dialogue gate",
    command: ["bun", "run", "gate:hermes"],
    required: true,
    timeoutMs: 180_000,
  },
  {
    id: "performance",
    label: "Deterministic performance gate",
    command: ["bun", "run", "gate:perf"],
    required: true,
    timeoutMs: 180_000,
  },
  {
    id: "docs-consistency",
    label: "Public docs/code consistency gate",
    command: ["bun", "run", "check:docs"],
    required: true,
    timeoutMs: 60_000,
  },
  {
    id: "resolver-pilot",
    label: "Hermes resolver/skill pilot check",
    command: ["bash", "bin/check-resolver-pilot.sh"],
    required: true,
    timeoutMs: 60_000,
  },
];

function tail(text: string, maxChars = 2000): string {
  const sanitized = text
    .replaceAll(PROJECT_DIR, "<project>")
    .replaceAll(process.env.HOME ?? "", "<home>")
    .trim();
  if (sanitized.length <= maxChars) return sanitized;
  return sanitized.slice(sanitized.length - maxChars);
}

export async function runCommand(spec: PreflightCheckSpec): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}> {
  const started = performance.now();
  const proc = Bun.spawn([...spec.command], {
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: safeEnv(),
  });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, spec.timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killTimer);

  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr: timedOut ? `${stderr}\nTimed out after ${spec.timeoutMs}ms` : stderr,
    durationMs: Math.round(performance.now() - started),
  };
}

function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "BUN_INSTALL"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export async function runPreflight(
  checks: readonly PreflightCheckSpec[] = DEFAULT_PREFLIGHT_CHECKS,
  runner: CommandRunner = runCommand,
): Promise<PreflightReport> {
  const started = performance.now();
  const results: PreflightCheckResult[] = [];

  for (const spec of checks) {
    const result = await runner(spec);
    results.push({
      id: spec.id,
      label: spec.label,
      command: spec.command,
      required: spec.required,
      status: result.exitCode === 0 ? "pass" : "fail",
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
    });
  }

  const firstFailed = results.find((r) => r.required && r.status === "fail") ?? null;
  return {
    gate: "v2-preflight",
    version: VERSION,
    timestamp: new Date().toISOString(),
    verdict: firstFailed ? "no-go" : "go",
    checks: results,
    failed_stage: firstFailed?.id ?? null,
    reason: firstFailed ? `${firstFailed.label} failed with exit code ${firstFailed.exit_code}` : null,
    next_action: firstFailed
      ? `Inspect ${firstFailed.id} stdout_tail/stderr_tail, fix the underlying gate, then rerun bun run gate:v2-preflight.`
      : null,
    duration_ms: Math.round(performance.now() - started),
  };
}

function printHumanSummary(report: PreflightReport): void {
  const lines = [
    `v2 preflight: ${report.verdict.toUpperCase()} (${report.duration_ms}ms)`,
    ...report.checks.map((c) => `  ${c.status === "pass" ? "PASS" : "FAIL"} ${c.id} (${c.duration_ms}ms)`),
  ];
  if (report.next_action) lines.push(`next: ${report.next_action}`);
  console.error(lines.join("\n"));
}

if (import.meta.main) {
  try {
    const report = await runPreflight();
    printHumanSummary(report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.verdict === "go" ? 0 : 1);
  } catch (error) {
    const report: PreflightReport = {
      gate: "v2-preflight",
      version: VERSION,
      timestamp: new Date().toISOString(),
      verdict: "no-go",
      checks: [],
      failed_stage: "fatal",
      reason: error instanceof Error ? error.message : String(error),
      next_action: "Fix the preflight script failure, then rerun bun run gate:v2-preflight.",
      duration_ms: 0,
    };
    console.error(`v2 preflight: FATAL — ${report.reason}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
}
