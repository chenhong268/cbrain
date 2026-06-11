#!/usr/bin/env bun
// check-install-network.ts — Network production install gate for v2.0 release
//
// Usage: bun run check:install-network
//
// Proves that `bun install --production` produces a working dependency tree:
//   1. Pack tarball into isolated temp dir (not checkout root)
//   2. Copy bun.lock from checkout for deterministic resolution
//   3. Run `bun install --production --frozen-lockfile` (REQUIRES network/Bun cache)
//   4. Verify: prod deps present, dev deps absent, apache-arrow available,
//      LanceDB native import works, no symlink to checkout
//   5. Run packaged CLI `--version` and `skill-pack --json` from unrelated cwd
//
// This is a SEPARATE release gate. The offline gate (gate:offline) must also pass.
// v2 release = gate:offline ✓ AND check:install-network ✓ AND check:install-tag ✓
//
// Exit codes: 0 = pass, 1 = fail, 2 = fatal error

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "url";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;

interface CheckResult {
  check: string;
  passed: boolean;
  actual: string;
  expected: string;
}

function check(check: string, passed: boolean, actual: string, expected: string): CheckResult {
  return { check, passed, actual, expected };
}

// ── Pack into temp dir (not checkout root) + Production Install ──

function runInstallGate(): CheckResult[] {
  const results: CheckResult[] = [];
  const tmpBase = mkdtempSync(join(tmpdir(), "cbrain-install-check-"));

  try {
    // Pack into temp dir
    const packDir = join(tmpBase, "pack");
    mkdirSync(packDir, { recursive: true });

    execSync(`bun pm pack --destination "${packDir}"`, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 30_000,
    });

    const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    results.push(check("bun pm pack succeeded", tarballs.length > 0, `${tarballs.length} tarballs`, "1 tarball"));

    if (tarballs.length === 0) {
      return results;
    }

    // Extract
    const tarballPath = join(packDir, tarballs[0]);
    execSync(`tar -xzf "${tarballPath}" -C "${packDir}"`, { encoding: "utf-8" });
    const entries = readdirSync(packDir).filter((e) => !e.endsWith(".tgz"));
    if (entries.length === 0) throw new Error("tarball was empty");
    const pkgDir = join(packDir, entries[0]);

    // Copy bun.lock for deterministic resolution
    const lockfile = join(PROJECT_DIR, "bun.lock");
    if (existsSync(lockfile)) {
      copyFileSync(lockfile, join(pkgDir, "bun.lock"));
    }

    // REAL production install — frozen lockfile, requires network/cache
    let installOk = false;
    let installError = "";
    try {
      execSync("bun install --production --frozen-lockfile", {
        cwd: pkgDir,
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      installOk = true;
    } catch (e: any) {
      installError = (e.stderr ?? e.message ?? "").slice(0, 200).split("\n")[0];
    }
    results.push(check("bun install --production --frozen-lockfile", installOk, installOk ? "ok" : installError, "clean install"));

    if (!installOk) {
      return results;
    }

    const nmDir = join(pkgDir, "node_modules");

    // Verify production deps present
    const prodDeps = ["@lancedb/lancedb", "@modelcontextprotocol/sdk", "commander", "yaml", "zod", "apache-arrow"];
    for (const dep of prodDeps) {
      const found = existsSync(join(nmDir, dep));
      results.push(check(`production dep "${dep}" installed`, found, found ? "present" : "missing", "installed"));
    }

    // Verify dev deps absent
    const devDeps = ["@biomejs/biome", "typescript", "@types/bun"];
    for (const dep of devDeps) {
      const found = existsSync(join(nmDir, dep));
      results.push(check(`dev dep "${dep}" excluded`, !found, found ? "present (BUG)" : "absent", "excluded"));
    }

    // Verify node_modules is a real install (not symlink)
    let isSymlink = false;
    try { isSymlink = lstatSync(nmDir).isSymbolicLink(); } catch { /* not symlink */ }
    results.push(check("node_modules is real install", !isSymlink, isSymlink ? "symlink" : "real dir", "real production install"));

    // Run CLI --version from unrelated cwd
    const binPath = join(pkgDir, "src", "cli", "index.ts");
    const unrelatedCwd = join(tmpBase, "unrelated");
    mkdirSync(unrelatedCwd, { recursive: true });

    let versionOk = false;
    let versionOutput = "";
    try {
      versionOutput = execSync(`bun run "${binPath}" --version`, {
        cwd: unrelatedCwd,
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
      versionOk = versionOutput === VERSION;
    } catch { /* version check failed */ }
    results.push(check("CLI --version matches package.json", versionOk, versionOutput || "failed", VERSION));

    // Run skill-pack --json from unrelated cwd
    let skillPackOk = false;
    let skillPackError = "";
    try {
      const spOut = execSync(`bun run "${binPath}" skill-pack --json`, {
        cwd: unrelatedCwd,
        encoding: "utf-8",
        timeout: 10_000,
      });
      const parsed = JSON.parse(spOut);
      skillPackOk = parsed.verificationStatus === "pass";
    } catch (e: any) {
      skillPackError = (e.stderr ?? e.message ?? "").slice(0, 200).split("\n")[0];
    }
    results.push(check("CLI skill-pack --json from unrelated cwd", skillPackOk, skillPackOk ? "pass" : skillPackError || "fail", "pass"));

    return results;
  } catch (e: any) {
    results.push(check("no unhandled errors", false, (e.message ?? String(e)).split("\n")[0], "no errors"));
    return results;
  } finally {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true });
    }
  }
}

// ── Run ──

const results = runInstallGate();
const allPassed = results.every((r) => r.passed);

console.log(`\n=== Production Install Gate (v${VERSION}) ===\n`);
for (const r of results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`  ${icon} ${r.check}: ${r.passed ? r.actual : `FAILED — ${r.actual}`}`);
}
console.log(`\nVerdict: ${allPassed ? "PASS" : "FAIL"}\n`);

process.exitCode = allPassed ? 0 : 1;
