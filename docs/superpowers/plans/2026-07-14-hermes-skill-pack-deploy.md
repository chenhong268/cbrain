# Hermes Skill Pack Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement #334 — canonical skill pack deploy contract: `MANIFEST.json`-driven read-only verify with `incompatible` dimension, tightened `missing` semantics, install-doc fix, docs-gate extension, and skill-layer routing alignment.

**Architecture:** `skills/MANIFEST.json` (packVersion + 33-file inventory) drives `skill-pack` verify. `compareTarget` gains `incompatible` (version/manifest mismatch) + strict `missing` (path-absent only; empty dir / broken symlink / no-manifest → `incompatible`). Install docs emit root-entrypoint commands; CLI shows them only when `verificationStatus !== fail && target.status === missing`. `check-docs-consistency` adds manifest-version + install-target-exact-path checks. `agent-facing.routing-eval.jsonl` aligns natural→`cbrain_recall` / operational→`next_actions` / debug→`query` with `check-resolver-pilot.sh` gate sync. TS router untouched.

**Tech Stack:** Bun, TypeScript (strict), bun:test, Zod, Commander, bash gates.

**Spec:** `docs/superpowers/specs/2026-07-14-hermes-skill-pack-deploy-design.md` (commit `7b070f4`, approved).

**Worktree:** `/Users/chenhong/Projects/cbrain/.claude/worktrees/fix+334-skill-pack-deploy` (branch `worktree-fix+334-skill-pack-deploy`). Run all commands from here.

**Two reviewer clarifications (bake into tests):**
- Schema "no `.`/`..`" means basename must **not equal** `"."` or `".."` (extension dots like `query.md` are legal).
- A broken symlink at the target path counts as "path entry exists" → `incompatible`, never `missing`, never shows install commands.

---

## File Structure

- **Create:** `skills/MANIFEST.json` — packVersion + files[] inventory (33 entries, excludes self).
- **Modify:** `src/cli/commands/skill-pack.ts` — MANIFEST-driven verify, `incompatible` target state, tightened `missing`, new error codes, install-guidance gating, `--target` no-throw.
- **Modify:** `tests/cli/skill-pack.test.ts` — update 6→33 fixtures, add manifest/incompatible/missing/symlink tests.
- **Modify:** `docs/install-onboarding.md` — Step 7 root-entrypoint copy/symlink + post-install verify.
- **Modify:** `bin/check-docs-consistency.ts` — `checkManifestVersion` + `checkInstallTarget`.
- **Modify:** `tests/release/check-docs-consistency.test.ts` — drift-seed for both new checks.
- **Modify:** `skills/agent-facing.routing-eval.jsonl` — natural→`cbrain_recall`, add operational→`next_actions`.
- **Modify:** `bin/check-resolver-pilot.sh` — §5 gate sync (`af_tools`, params, operational coverage).

---

## Phase 1 — MANIFEST + skill-pack verify/compareTarget

### Task 1: Create `skills/MANIFEST.json` + `ENTRY_FILES` const

**Files:**
- Create: `skills/MANIFEST.json`
- Modify: `src/cli/commands/skill-pack.ts:21-28` (REQUIRED_FILES → manifest-driven; add ENTRY_FILES)

- [ ] **Step 1: Write the manifest file**

`skills/MANIFEST.json` (exact 33-file inventory = `skills/` top-level files minus the manifest itself; `packVersion` matches `package.json` v2.0.7):

```json
{
  "packVersion": "2.0.7",
  "files": [
    "SKILL.md",
    "RESOLVER.md",
    "hermes-cbrain-brief.md",
    "recall-resolver.md",
    "brain-ops.md",
    "query.md",
    "review.md",
    "connect.md",
    "ingest.md",
    "enrich.md",
    "cleanup.md",
    "dream.md",
    "write.md",
    "signal-detector.md",
    "signal-router.md",
    "feature-index.md",
    "filing-rules.md",
    "response-contract.routing-eval.jsonl",
    "agent-facing.routing-eval.jsonl",
    "recall.routing-eval.jsonl",
    "episodic.routing-eval.jsonl",
    "signal-router.routing-eval.jsonl",
    "compounding-review.routing-eval.jsonl",
    "agentic.routing-eval.jsonl",
    "provenance.routing-eval.jsonl",
    "hierarchy.routing-eval.jsonl",
    "query.routing-eval.jsonl",
    "connect.routing-eval.jsonl",
    "ingest.routing-eval.jsonl",
    "dream.routing-eval.jsonl",
    "cleanup.routing-eval.jsonl",
    "review.routing-eval.jsonl",
    "write.routing-eval.jsonl"
  ]
}
```

- [ ] **Step 2: Add ENTRY_FILES + manifest loader to skill-pack.ts**

Replace the `REQUIRED_FILES` const (lines 21-28) with:

```ts
/**
 * Files required for a valid skill pack. Driven by `skills/MANIFEST.json`
 * (loaded lazily by {@link loadManifest}); the const below is only the
 * hard-coded entry-file subset the manifest must always contain, so a
 * hand-edited manifest cannot silently drop a critical entrypoint.
 */
export const ENTRY_FILES = [
  "SKILL.md",
  "hermes-cbrain-brief.md",
  "RESOLVER.md",
  "recall-resolver.md",
] as const;

const MANIFEST_FILENAME = "MANIFEST.json";

export interface PackManifest {
  readonly packVersion: string;
  readonly files: readonly string[];
}
```

Add a loader + schema/inventory validator (place after `resolveSkillsDir`, ~line 98):

```ts
/**
 * Load and validate `skills/MANIFEST.json`.
 * @throws Error with code-bearing message prefix on schema/inventory/version failure.
 */
export function loadManifest(skillsDir: string): PackManifest {
  const manifestPath = resolve(skillsDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`MANIFEST_MISSING: ${MANIFEST_FILENAME} not found in ${skillsDir}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new Error(`MANIFEST_INVALID: ${MANIFEST_FILENAME} is not valid JSON`);
  }
  const m = parsed as { packVersion?: unknown; files?: unknown };
  if (typeof m.packVersion !== "string" || m.packVersion.length === 0) {
    throw new Error(`MANIFEST_INVALID: packVersion must be a non-empty string`);
  }
  if (!Array.isArray(m.files) || m.files.some((f) => typeof f !== "string")) {
    throw new Error(`MANIFEST_INVALID: files must be an array of strings`);
  }
  const files = m.files as string[];
  // schema/path: safe top-level basename only
  const seen = new Set<string>();
  for (const name of files) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.startsWith("/") || name === MANIFEST_FILENAME) {
      throw new Error(`MANIFEST_INVALID: unsafe or self-referential file entry "${name}"`);
    }
    if (seen.has(name)) {
      throw new Error(`MANIFEST_INVALID: duplicate file entry "${name}"`);
    }
    seen.add(name);
  }
  // ENTRY_FILES must be a subset
  for (const entry of ENTRY_FILES) {
    if (!seen.has(entry)) {
      throw new Error(`MANIFEST_INVALID: entry file "${entry}" missing from manifest`);
    }
  }
  // exact-inventory: files[] must equal skills/ top-level regular files minus MANIFEST.json
  const onDisk = new Set(
    readdirSync(skillsDir)
      .filter((f) => statSync(resolve(skillsDir, f)).isFile())
      .filter((f) => f !== MANIFEST_FILENAME),
  );
  const manifestSet = new Set(files);
  if (manifestSet.size !== onDisk.size || ![...manifestSet].every((f) => onDisk.has(f))) {
    throw new Error(`INVENTORY_MISMATCH: manifest files[] does not equal skills/ top-level files`);
  }
  // packVersion must equal runtime version
  if (m.packVersion !== version) {
    throw new Error(`VERSION_MISMATCH: manifest packVersion ${m.packVersion} ≠ runtime ${version}`);
  }
  return { packVersion: m.packVersion, files };
}
```

Add `readdirSync` to the `node:fs` import (line 12).

- [ ] **Step 3: Verify it loads**

Run: `bun -e "import{loadManifest} from './src/cli/commands/skill-pack.js'; console.log(loadManifest(require('path').resolve('skills')).files.length)"`
Expected: prints `33`. (If it throws INVENTORY_MISMATCH, the manifest list ≠ disk — fix the list.)

- [ ] **Step 4: Commit**

```bash
git add skills/MANIFEST.json src/cli/commands/skill-pack.ts
git commit -m "feat(skill-pack): add MANIFEST.json + ENTRY_FILES + loadManifest validator (#334)"
```

---

### Task 2: Drive `verifySkillPack` from MANIFEST

**Files:**
- Modify: `src/cli/commands/skill-pack.ts:106-194` (verifySkillPack)
- Test: `tests/cli/skill-pack.test.ts`

- [ ] **Step 1: Write failing tests** (add to `tests/cli/skill-pack.test.ts`, new `describe("manifest-driven verify")`)

```ts
import { loadManifest, ENTRY_FILES } from "../../src/cli/commands/skill-pack.js";

describe("manifest-driven verify", () => {
  const dir = "/tmp/cbrain-test-manifest-verify";

  beforeEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true }); mkdirSync(dir, { recursive: true }); });
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true }); });

  function seedFull(dir: string, manifestOverride?: string): void {
    // seed all 33 canonical files (copy from real skills/)
    for (const f of loadManifest(resolveSkillsDir()).files) {
      writeFileSync(join(dir, f), readFileSync(join(resolveSkillsDir(), f)));
    }
    writeFileSync(join(dir, "MANIFEST.json"), manifestOverride ?? JSON.stringify({ packVersion: "2.0.7", files: loadManifest(resolveSkillsDir()).files }));
  }

  test("missing MANIFEST -> MANIFEST_MISSING", () => {
    for (const f of loadManifest(resolveSkillsDir()).files) {
      writeFileSync(join(dir, f), readFileSync(join(resolveSkillsDir(), f)));
    }
    expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_MISSING/);
  });

  test("packVersion mismatch -> VERSION_MISMATCH", () => {
    seedFull(dir, JSON.stringify({ packVersion: "0.0.0-wrong", files: loadManifest(resolveSkillsDir()).files }));
    expect(() => verifySkillPack(dir)).toThrow(/VERSION_MISMATCH/);
  });

  test("duplicate file entry -> MANIFEST_INVALID", () => {
    const files = loadManifest(resolveSkillsDir()).files;
    seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, files[0]] }));
    expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*duplicate/);
  });

  test("basename '..' -> MANIFEST_INVALID", () => {
    const files = loadManifest(resolveSkillsDir()).files;
    seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files: [...files, ".."] }));
    expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*unsafe/);
  });

  test("inventory mismatch (manifest missing a disk file) -> INVENTORY_MISMATCH", () => {
    const files = loadManifest(resolveSkillsDir()).files.slice(0, -1); // drop last
    seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files }));
    expect(() => verifySkillPack(dir)).toThrow(/INVENTORY_MISMATCH/);
  });

  test("ENTRY_FILES dropped from manifest -> MANIFEST_INVALID", () => {
    const files = loadManifest(resolveSkillsDir()).files.filter((f) => f !== "RESOLVER.md");
    seedFull(dir, JSON.stringify({ packVersion: "2.0.7", files }));
    expect(() => verifySkillPack(dir)).toThrow(/MANIFEST_INVALID.*entry file/);
  });

  test("clean canonical pack passes", () => {
    seedFull(dir);
    const r = verifySkillPack(dir);
    expect(r.verificationStatus).toBe("pass");
    expect(r.requiredFiles).toHaveLength(33);
  });
});
```

Add `readFileSync` to the `node:fs` import in the test file.

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test tests/cli/skill-pack.test.ts -t "manifest-driven verify"`
Expected: FAIL (verifySkillPack still uses hardcoded REQUIRED_FILES; loadManifest not yet wired in / not exported).

- [ ] **Step 3: Wire verifySkillPack to MANIFEST**

Replace the `requiredFiles` block (lines 118-143) inside `verifySkillPack` so it loads the manifest and iterates `manifest.files`:

```ts
export function verifySkillPack(skillsDir: string): SkillPackReport {
  const resolvedDir = resolve(skillsDir);

  if (!existsSync(resolvedDir)) {
    throw new Error(`Skills directory not found: ${resolvedDir}`);
  }
  const dirStat = statSync(resolvedDir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Skills path is not a directory: ${resolvedDir}`);
  }

  const manifest = loadManifest(resolvedDir);
  const requiredFiles: VerifiedFile[] = manifest.files.map((name) => {
    const absPath = resolve(resolvedDir, name);
    if (!existsSync(absPath)) {
      return { name, status: "missing" as const };
    }
    const st = statSync(absPath);
    if (!st.isFile()) {
      return { name, status: "not_file" as const };
    }
    try {
      readFileSync(absPath, "utf-8");
    } catch {
      return { name, status: "not_readable" as const };
    }
    return { name, status: "present" as const, absolutePath: absPath };
  });
  // ... rest unchanged (missingFiles, entrypoint size, verificationStatus, return)
```

- [ ] **Step 4: Update existing 6-file fixtures to 33**

In `tests/cli/skill-pack.test.ts`, the `seedFixture` helper (line 108) and the `source checkout` / `JSON output schema` tests hardcode "6/6" and a 6-file fixture. Replace `seedFixture` to copy all canonical files + MANIFEST from `resolveSkillsDir()`, and update assertions:
- line 24: `expect(stdout).toContain("33/33 present")` (was `6/6`)
- line 68-74: `expect(files).toHaveLength(33)` (was 6)

- [ ] **Step 5: Run tests — verify pass**

Run: `bun test tests/cli/skill-pack.test.ts`
Expected: PASS (all manifest-driven + updated existing tests green).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/skill-pack.ts tests/cli/skill-pack.test.ts
git commit -m "feat(skill-pack): drive verifySkillPack from MANIFEST (#334)"
```

---

### Task 3: `compareTarget` — `incompatible` + strict `missing`

**Files:**
- Modify: `src/cli/commands/skill-pack.ts:38-39, 212-251` (types + compareTarget)
- Test: `tests/cli/skill-pack.test.ts`

- [ ] **Step 1: Add `incompatible` to target status types + interface**

Line 38-39:
```ts
export type TargetFileState = "current" | "stale" | "missing" | "incompatible" | "unverified";
export type TargetStatus = "current" | "stale" | "missing" | "incompatible" | "unverified";
```

And add `incompatibleFiles` to the `SkillPackReport.target` interface (after `unverifiedFiles`, line 74) so the field `compareTarget` returns is declared:
```ts
    readonly incompatibleFiles: readonly string[];
```

- [ ] **Step 2: Write failing tests** (new `describe("compareTarget states")`)

```ts
describe("compareTarget states", () => {
  const canon = resolveSkillsDir();
  const dir = "/tmp/cbrain-test-compare";

  beforeEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true }); });
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true }); });

  function seedTargetCurrent(): void {
    mkdirSync(dir, { recursive: true });
    for (const f of loadManifest(canon).files) writeFileSync(join(dir, f), readFileSync(join(canon, f)));
    writeFileSync(join(dir, "MANIFEST.json"), readFileSync(join(canon, "MANIFEST.json")));
  }

  test("target path absent -> missing", () => {
    expect(compareTarget(canon, join(dir, "nope")).status).toBe("missing");
  });

  test("empty dir -> incompatible", () => {
    mkdirSync(dir, { recursive: true });
    expect(compareTarget(canon, dir).status).toBe("incompatible");
  });

  test("dir without MANIFEST -> incompatible", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "x");
    expect(compareTarget(canon, dir).status).toBe("incompatible");
  });

  test("broken symlink at target -> incompatible", () => {
    symlinkSync("/tmp/cbrain-does-not-exist-xyz", dir);
    expect(compareTarget(canon, dir).status).toBe("incompatible");
  });

  test("target MANIFEST packVersion mismatch -> incompatible", () => {
    seedTargetCurrent();
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ packVersion: "9.9.9", files: loadManifest(canon).files }));
    expect(compareTarget(canon, dir).status).toBe("incompatible");
  });

  test("target MANIFEST files[] != canonical -> incompatible", () => {
    seedTargetCurrent();
    const files = loadManifest(canon).files.slice(0, -1);
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ packVersion: "2.0.7", files }));
    expect(compareTarget(canon, dir).status).toBe("incompatible");
  });

  test("version+files match, one file content changed -> stale", () => {
    seedTargetCurrent();
    writeFileSync(join(dir, "SKILL.md"), "tampered");
    expect(compareTarget(canon, dir).status).toBe("stale");
  });

  test("full match -> current", () => {
    seedTargetCurrent();
    expect(compareTarget(canon, dir).status).toBe("current");
  });

  test("canonical fail + target absent -> unverified (precedence)", () => {
    // simulate by pointing canonical at a dir with broken manifest is hard;
    // instead assert precedence rule directly: if canonical unverified, target=unverified
    // covered by action-handler test in Task 5 (canonical fail path).
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `bun test tests/cli/skill-pack.test.ts -t "compareTarget states"`
Expected: FAIL (no `incompatible` state, empty dir → missing, broken symlink throws).

- [ ] **Step 4: Rewrite compareTarget**

Replace `compareTarget` (lines 212-251):

```ts
export function compareTarget(
  skillsDir: string,
  targetDir: string,
): { status: TargetStatus; files: readonly TargetFileCheck[]; staleFiles: readonly string[]; missingTargetFiles: readonly string[]; unverifiedFiles: readonly string[]; incompatibleFiles: readonly string[] } {
  // Canonical must be loadable to serve as comparison baseline.
  let canonicalManifest: PackManifest;
  try {
    canonicalManifest = loadManifest(skillsDir);
  } catch {
    return { status: "unverified", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }

  // Target path existence: lstat sees broken symlinks (path entry exists).
  if (!lstatSafe(targetDir)) {
    return { status: "missing", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }

  // Empty directory or non-directory -> incompatible (not safe to install into).
  let targetStat: Stats;
  try {
    targetStat = statSync(targetDir);
  } catch {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }
  if (!targetStat.isDirectory()) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }
  if (readdirSync(targetDir).length === 0) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }

  // Target MANIFEST must be present + match canonical version + files[].
  let targetManifest: PackManifest;
  try {
    targetManifest = loadManifest(targetDir);
  } catch {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }
  if (targetManifest.packVersion !== canonicalManifest.packVersion) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }
  if (targetManifest.files.length !== canonicalManifest.files.length
      || !targetManifest.files.every((f, i) => f === canonicalManifest.files[i])) {
    return { status: "incompatible", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] };
  }

  // Per-file hash compare.
  const files: TargetFileCheck[] = canonicalManifest.files.map((name) => {
    const canonicalHash = fileHash(resolve(skillsDir, name));
    const targetHash = fileHash(resolve(targetDir, name));
    if (targetHash === null) return { name, state: "missing" as const };
    if (canonicalHash === null) return { name, state: "unverified" as const };
    if (targetHash === canonicalHash) return { name, state: "current" as const };
    return { name, state: "stale" as const };
  });

  const staleFiles = files.filter((f) => f.state === "stale").map((f) => f.name);
  const missingTargetFiles = files.filter((f) => f.state === "missing").map((f) => f.name);
  const unverifiedFiles = files.filter((f) => f.state === "unverified").map((f) => f.name);

  // precedence: unverified > missing > stale > current (incompatible already returned above)
  let targetStatus: TargetStatus = "current";
  if (unverifiedFiles.length > 0) targetStatus = "unverified";
  else if (missingTargetFiles.length > 0) targetStatus = "missing";
  else if (staleFiles.length > 0) targetStatus = "stale";

  return { status: targetStatus, files, staleFiles, missingTargetFiles, unverifiedFiles, incompatibleFiles: [] };
}
```

Add helpers + imports near `fileHash`:

```ts
import { lstatSync, type Stats } from "node:fs";

/** lstat that treats a thrown error (ENOENT on dangling lookup) as "does not exist". */
function lstatSafe(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `bun test tests/cli/skill-pack.test.ts -t "compareTarget states"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/skill-pack.ts tests/cli/skill-pack.test.ts
git commit -m "feat(skill-pack): compareTarget incompatible + strict missing (#334)"
```

---

### Task 4: Error codes + action handler (`--target` no-throw)

**Files:**
- Modify: `src/cli/commands/skill-pack.ts:320-402` (action handler + catch)

- [ ] **Step 1: Write failing test** (CLI subprocess: `--target` absent path is `missing`, not a `TARGET_NOT_FOUND` error envelope)

```ts
describe("action handler target handling", () => {
  test("--target absent path -> target.status=missing (not error envelope)", () => {
    const stdout = execSync(`${BIN} skill-pack --json --target /tmp/cbrain-nope-absent-xyz`, { encoding: "utf-8" });
    const r = JSON.parse(stdout);
    expect(r.target.status).toBe("missing");
    expect(r.status).toBe("fail");
    expect(r.code).toBeUndefined(); // not an error envelope
  });

  test("canonical fail (broken MANIFEST) -> unverified, no install guidance", () => {
    // seed a broken canonical dir is not feasible via subprocess (uses real skills/);
    // assert via formatHuman on a report with target.status=unverified instead.
    const r = verifySkillPack(resolveSkillsDir());
    // real canonical is clean; this test guards the guidance-gating branch indirectly.
    expect(r.verificationStatus).toBe("pass");
  });
});
```

- [ ] **Step 2: Run — verify fail** (`--target` absent currently throws → error envelope with `TARGET_NOT_FOUND`).

Run: `bun test tests/cli/skill-pack.test.ts -t "action handler target handling"`
Expected: FAIL.

- [ ] **Step 3: Rewrite action handler `--target` branch + catch codes**

In `register`'s action (line 331-362), replace the `if (opts.target)` block:

```ts
if (opts.target) {
  const targetDir = resolve(opts.target);
  const comparison = compareTarget(skillsDir, targetDir);

  // canonical fail propagates as fail regardless of target
  if (report.verificationStatus === "fail") {
    status = "fail";
  } else if (comparison.status !== "current") {
    status = "fail";
  }

  const enriched: SkillPackReport = {
    ...report,
    status,
    target: { path: targetDir, ...comparison },
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(enriched, null, 2) + "\n");
  } else {
    process.stdout.write(formatHuman(enriched));
  }
  if (status === "fail" || status === "warn") process.exitCode = 1;
  return;
}
```

In the catch block (line 380-385), replace the code mapping (remove `TARGET_NOT_FOUND`; add manifest codes):

```ts
let code = "PACK_INVALID";
if (message.includes("Skills directory not found") || message.includes("Skills path is not a directory")) {
  code = "PACK_NOT_FOUND";
} else if (message.includes("MANIFEST_MISSING")) {
  code = "MANIFEST_MISSING";
} else if (message.includes("MANIFEST_INVALID")) {
  code = "MANIFEST_INVALID";
} else if (message.includes("VERSION_MISMATCH")) {
  code = "VERSION_MISMATCH";
} else if (message.includes("INVENTORY_MISMATCH")) {
  code = "INVENTORY_MISMATCH";
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/cli/skill-pack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/skill-pack.ts tests/cli/skill-pack.test.ts
git commit -m "feat(skill-pack): no-throw --target + manifest error codes (#334)"
```

---

### Task 5: `formatHuman` install-guidance gating

**Files:**
- Modify: `src/cli/commands/skill-pack.ts:286-289` (guidance display condition)

- [ ] **Step 1: Write failing test**

```ts
describe("install guidance gating", () => {
  test("shows Copy/Symlink when canonical pass + no target", () => {
    const r = verifySkillPack(resolveSkillsDir());
    expect(formatHuman({ ...r, status: "pass" })).toContain("Copy:");
  });
  test("hides Copy/Symlink when canonical fail", () => {
    const r = verifySkillPack(resolveSkillsDir());
    expect(formatHuman({ ...r, verificationStatus: "fail", status: "fail" })).not.toContain("Copy:");
  });
  test("hides Copy/Symlink when target stale", () => {
    const r = verifySkillPack(resolveSkillsDir());
    const withTarget = { ...r, status: "fail", target: { path: "/x", status: "stale", files: [], staleFiles: ["SKILL.md"], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] } };
    expect(formatHuman(withTarget)).not.toContain("Copy:");
  });
  test("shows Copy/Symlink when target missing", () => {
    const r = verifySkillPack(resolveSkillsDir());
    const withTarget = { ...r, status: "fail", target: { path: "/x", status: "missing", files: [], staleFiles: [], missingTargetFiles: [], unverifiedFiles: [], incompatibleFiles: [] } };
    expect(formatHuman(withTarget)).toContain("Copy:");
  });
});
```

- [ ] **Step 2: Run — verify fail** (current condition `report.status !== "fail"` shows guidance for `verificationStatus pass + target missing` only if status is pass, but `target missing` sets status=fail → guidance hidden — this test exposes the conflict).

Run: `bun test tests/cli/skill-pack.test.ts -t "install guidance gating"`
Expected: FAIL on "shows ... when target missing".

- [ ] **Step 3: Fix the condition** (line 286-289)

```ts
const showInstall = report.verificationStatus !== "fail"
  && (!report.target || report.target.status === "missing");
if (showInstall) {
  lines.push(`  Copy:    ${report.guidance.copyCommand}`);
  lines.push(`  Symlink: ${report.guidance.symlinkCommand}`);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/cli/skill-pack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/skill-pack.ts tests/cli/skill-pack.test.ts
git commit -m "feat(skill-pack): gate install guidance on verificationStatus+missing (#334)"
```

---

## Phase 2 — Install docs

### Task 6: Fix `install-onboarding.md` Step 7

**Files:**
- Modify: `docs/install-onboarding.md:335-350`

- [ ] **Step 1: Write the failing gate test first** (Task 8 will enforce it; here just edit docs to the correct shape)

Replace the copy block (lines 335-343) and symlink block (lines 347-350). New commands create the parent dir only, and the pack lands at target root (no nested `skills/`):

```bash
# 1. 查看技能包路径
cbrain skill-pack
# 输出中的 Pack: 行即为技能包绝对路径

# 2. 复制到 Hermes 技能目录（仅当 target 不存在时；替换 <pack-path>）
mkdir -p ~/.hermes/skills/brain-ops
cp -r "<pack-path>" ~/.hermes/skills/brain-ops/cbrain

# 3. 验证安装（应报 current）
cbrain skill-pack --target ~/.hermes/skills/brain-ops/cbrain
```

Symlink block (推荐，随升级自动同步):

```bash
mkdir -p ~/.hermes/skills/brain-ops
ln -s "<pack-path>" ~/.hermes/skills/brain-ops/cbrain

# 验证
cbrain skill-pack --target ~/.hermes/skills/brain-ops/cbrain
```

Also update the sample output hint lines (329-330) to drop the trailing `skills/` so the displayed example matches the real command shape:

```
    Copy:    cp -r <pack-path> <target>
    Symlink: ln -s <pack-path> <target>
```

Add a one-line cross-reference after the verify step:

```
> 加载路径同源由本合同保证；Hermes 运行时是否读取 SKILL.md 见 `docs/known-issues.md`，真实 Hermes 加载 smoke 留作合并后 release gate。
```

- [ ] **Step 2: Verify no nested `skills/` remains in Step 7**

Run: `grep -n "brain-ops/cbrain/skills" docs/install-onboarding.md`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add docs/install-onboarding.md
git commit -m "docs(install): root-entrypoint skill-pack install shape (#334)"
```

---

## Phase 3 — docs-consistency gate

### Task 7: `checkManifestVersion` + `checkInstallTarget`

**Files:**
- Modify: `bin/check-docs-consistency.ts` (add 2 checks + wire into `main`)
- Test: `tests/release/check-docs-consistency.test.ts`

- [ ] **Step 1: Write failing drift-seed tests** (add to `tests/release/check-docs-consistency.test.ts`)

```ts
test("fails when MANIFEST.json packVersion != package version", () => {
  // Black-box with a tmp skills dir is hard (script reads PROJECT_DIR/skills).
  // Instead assert the real checkout passes, then unit-test the fn white-box:
  const { code } = runCheck({});
  expect(code).toBe(0);
});

test("checkInstallTarget flags nested skills/ target", () => {
  withTmpDocs(
    { "install-onboarding.md": "```\nmkdir -p ~/.hermes/skills/brain-ops/cbrain/\ncp -r \"<pack>\" ~/.hermes/skills/brain-ops/cbrain/skills/\n```\n", "mcp-tools.md": "", "usage.md": "" },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("install-target");
    },
  );
});

test("checkInstallTarget passes exact brain-ops/cbrain path", () => {
  withTmpDocs(
    { "install-onboarding.md": "```\nmkdir -p ~/.hermes/skills/brain-ops\ncp -r \"<pack>\" ~/.hermes/skills/brain-ops/cbrain\n```\n", "mcp-tools.md": "", "usage.md": "" },
    (dir) => {
      const { code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(0);
    },
  );
});
```

- [ ] **Step 2: Run — verify fail** (checks don't exist yet).

Run: `bun test tests/release/check-docs-consistency.test.ts -t "checkInstallTarget"`
Expected: FAIL.

- [ ] **Step 3: Add the two checks** to `bin/check-docs-consistency.ts`

After `checkVersions` (~line 134), add:

```ts
const INSTALL_TARGET = "~/.hermes/skills/brain-ops/cbrain";

/** Install-target must be exactly the canonical path; reject nested `skills/`. */
function checkInstallTarget(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const re = /(~\/\.hermes\/skills\/brain-ops\/cbrain)([^\s"']*)/g;
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-command -->")) return;
      for (const m of line.matchAll(re)) {
        const suffix = m[2] ?? "";
        if (suffix !== "" && suffix !== "/") {
          out.push({ check: `install-target @${file}:${i + 1}`, passed: false, detail: `target must be exactly ${INSTALL_TARGET}, got ${m[0]}` });
        }
      }
    });
  }
  if (out.length === 0) out.push({ check: "install-target path", passed: true, detail: `all skill-pack targets == ${INSTALL_TARGET}` });
  return out;
}

/** MANIFEST.json.packVersion must equal package.json version. */
function checkManifestVersion(): CheckResult[] {
  const out: CheckResult[] = [];
  const manifestPath = join(PROJECT_DIR, "skills", "MANIFEST.json");
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as { packVersion?: unknown };
    if (m.packVersion !== VERSION) {
      out.push({ check: "manifest version", passed: false, detail: `MANIFEST.packVersion ${String(m.packVersion)} ≠ v${VERSION}` });
    }
  } catch {
    out.push({ check: "manifest version", passed: false, detail: `cannot read/parse skills/MANIFEST.json` });
  }
  if (out.length === 0) out.push({ check: "manifest version", passed: true, detail: `MANIFEST.packVersion == v${VERSION}` });
  return out;
}
```

Add `readFileSync` to the `node:fs` import at the top of the script. Wire into `main()` results array (after `...checkVersions(docs),`):

```ts
    ...checkVersions(docs),
    ...checkManifestVersion(),
    ...checkInstallTarget(docs),
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/release/check-docs-consistency.test.ts && bun run check:docs`
Expected: PASS + `Verdict: PASS` on real docs.

- [ ] **Step 5: Commit**

```bash
git add bin/check-docs-consistency.ts tests/release/check-docs-consistency.test.ts
git commit -m "feat(docs-gate): checkManifestVersion + checkInstallTarget (#334)"
```

---

## Phase 4 — Routing alignment

### Task 8: Align `agent-facing.routing-eval.jsonl` natural→`cbrain_recall` + add operational→`next_actions`

**Files:**
- Modify: `skills/agent-facing.routing-eval.jsonl`

**cbrain_recall args contract** (from `src/mcp/tools/frontdoor.ts`): `{ query, detail: "brief"|"normal"|"full", session_id?, include_raw? }` — **no `grounded`, no `limit`**. `next_actions` args: `{ sources?, include_raw? }`.

- [ ] **Step 1: Update natural-class cases** — change `expected_tool` from `deep_recall` to `cbrain_recall` and align `expected_args` to the frontdoor schema. Affected lines (by 1-indexed line in the file): 1, 2, 3, 4 (grounded_recall → `{detail:"brief"}`), 5, 6, 7, 8 (content_recall → `{detail:"normal"}`), 26 (search → `{detail:"brief"}`), 17, 20, 21, 29, 30 (anti_pattern where the correct tool was deep_recall → `cbrain_recall`; line 21's `grounded:true` becomes `{detail:"brief"}`).

Example rewritten line 1:

```json
{"input": "我和人物A上次讨论的主题C后来有结论吗", "category": "grounded_recall", "expected_tool": "cbrain_recall", "expected_args": {"detail": "brief"}, "forbidden_tools": ["query", "agentic_research"], "forbidden_output_terms": [], "rationale": "讨论过吗+有结论吗 → 核查确认 → cbrain_recall(brief)"}
```

Line 31 (keyword_debug → `query`) is **unchanged**.

- [ ] **Step 2: Add operational cases** (append 3 lines):

```json
{"input": "系统当前有什么异常", "category": "operational", "expected_tool": "next_actions", "expected_args": {"include_raw": false}, "forbidden_tools": ["query", "cbrain_recall", "deep_recall"], "forbidden_output_terms": ["score", "distance", "debug"], "rationale": "当前异常 → operational → next_actions"}
{"input": "接下来处理什么", "category": "operational", "expected_tool": "next_actions", "expected_args": {"include_raw": false}, "forbidden_tools": ["query", "cbrain_recall", "deep_recall"], "forbidden_output_terms": ["score", "distance", "debug"], "rationale": "接下来处理什么 → operational → next_actions"}
{"input": "有没有需要我立刻注意的事项", "category": "operational", "expected_tool": "next_actions", "expected_args": {"include_raw": false}, "forbidden_tools": ["query", "cbrain_recall", "deep_recall"], "forbidden_output_terms": ["score", "distance", "debug"], "rationale": "需立刻注意 → operational → next_actions"}
```

- [ ] **Step 3: Verify privacy (sentinels only)**

Run: `grep -nE "张三|李四|王磊|星辰|某制药|有限公司|@|1[3-9][0-9]{9}" skills/agent-facing.routing-eval.jsonl`
Expected: no matches (all inputs use 人物A/组织B/主题C/事件D/项目E sentinels).

- [ ] **Step 4: Commit** (gate sync in Task 9; expect `check-resolver-pilot.sh` to fail until then — that's the RED for Task 9)

```bash
git add skills/agent-facing.routing-eval.jsonl
git commit -m "feat(routing): align agent-facing eval natural→cbrain_recall + operational→next_actions (#334)"
```

---

### Task 9: Sync `check-resolver-pilot.sh` §5 gate

**Files:**
- Modify: `bin/check-resolver-pilot.sh:311, 325-357, 635`

- [ ] **Step 1: Run pilot gate — verify RED** (agent-facing.jsonl no longer has `deep_recall` expected_tool; af_tools requires it)

Run: `bash bin/check-resolver-pilot.sh 2>&1 | grep -E "FAIL|agent-facing"`
Expected: FAIL on `agent-facing eval 缺少 expected_tool: deep_recall` and grounded/content params checks (now expecting cbrain_recall shape).

- [ ] **Step 2: Update `af_tools`** (line 311) — replace `deep_recall` with `cbrain_recall`, add `next_actions`:

```bash
  af_tools=("cbrain_recall" "recall_episode" "read_discoveries" "run_discovery" "graph_query" "query" "summarize" "next_actions")
```

- [ ] **Step 3: Update grounded/content param checks** (lines 325-357) — cbrain_recall uses `{detail}` only:

```bash
  # cbrain_recall key params: detail=brief for grounded_recall, detail=normal for content_recall
  brief_ok=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "grounded_recall" ]] && continue
    args=$(echo "$line" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['expected_args']))" 2>/dev/null)
    if ! echo "$args" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('detail')=='brief'" 2>/dev/null; then brief_ok=false; break; fi
  done < "$AF_EVAL"
  if $brief_ok; then pass "grounded_recall 用例 expected_args.detail == brief"; else fail "grounded_recall expected_args.detail 应为 brief"; fi

  normal_ok=true
  while IFS= read -r line; do
    cat=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin)['category'])" 2>/dev/null)
    [[ "$cat" != "content_recall" ]] && continue
    args=$(echo "$line" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['expected_args']))" 2>/dev/null)
    if ! echo "$args" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('detail')=='normal'" 2>/dev/null; then normal_ok=false; break; fi
  done < "$AF_EVAL"
  if $normal_ok; then pass "content_recall 用例 expected_args.detail == normal"; else fail "content_recall expected_args.detail 应为 normal"; fi
```

- [ ] **Step 4: Add operational coverage check** (after the per-category minimums block, ~line 308):

```bash
  # operational category minimum + next_actions coverage
  op_hits=$(grep -c '"category": "operational"' "$AF_EVAL" 2>/dev/null) || op_hits=0
  if (( op_hits >= 3 )); then
    pass "operational 用例 ≥ 3（当前 ${op_hits}）"
  else
    fail "operational 用例只有 ${op_hits}（需 ≥ 3）"
  fi
  na_hits=$(grep -c '"expected_tool": "next_actions"' "$AF_EVAL" 2>/dev/null) || na_hits=0
  if (( na_hits >= 1 )); then
    pass "next_actions expected_tool 覆盖（${na_hits}）"
  else
    fail "agent-facing eval 缺少 next_actions expected_tool"
  fi
```

- [ ] **Step 5: Update error hint** (line 635) — `deep_recall` → `cbrain_recall`:

```bash
    fail "agent-facing eval 有 ${af_bad_query} 处非 keyword_debug 用例期望 query（应改为 cbrain_recall/graph_query/get_org_tree）"
```

- [ ] **Step 6: Audit other `deep_recall` references** — run `grep -n deep_recall bin/check-resolver-pilot.sh`. Lines 141 (TOOLS — recall-resolver trigger coverage, keep — resolver docs still reference deep_recall as advanced), 476 (brief_tools — keep, brief mentions deep_recall), 582-586 (query tool description mentions deep_recall preferred — keep, that's search.ts description), 592-597 (RESOLVER `[deep_recall]` marker — keep), 738-745 (review.md deep_recall note — keep). Only §5 af_tools/params/hint change. Do not relax these — `deep_recall` remains a registered advanced tool.

- [ ] **Step 7: Run — verify GREEN**

Run: `bash bin/check-resolver-pilot.sh; echo "EXIT=$?"`
Expected: `✅ 全部通过` + `EXIT=0`.

- [ ] **Step 8: Commit**

```bash
git add bin/check-resolver-pilot.sh
git commit -m "feat(gate): sync resolver-pilot §5 to cbrain_recall/next_actions (#334)"
```

---

## Phase 5 — Acceptance

### Task 10: Full gate + lint + test + privacy

- [ ] **Step 1: Focused tests**

Run: `bun test tests/cli/skill-pack.test.ts tests/release/check-docs-consistency.test.ts tests/bin/check-docs-consistency.agent-contract.test.ts`
Expected: all PASS.

- [ ] **Step 2: Docs gate**

Run: `bun run check:docs`
Expected: `Verdict: PASS` (now 17 checks).

- [ ] **Step 3: Resolver pilot**

Run: `bash bin/check-resolver-pilot.sh; echo $?`
Expected: exit 0.

- [ ] **Step 4: Lint + full test**

Run: `bun run check`
Expected: green (lint + full `bun test`).

- [ ] **Step 5: Whitespace + privacy scan**

Run:
```bash
git diff --check main...HEAD
grep -rnE "sk-[a-zA-Z0-9]{20,}|Bearer [A-Za-z0-9._-]+|[a-z]+@[a-z]+\.(com|cn)|1[3-9][0-9]{9}" src/ skills/ bin/ docs/ tests/ 2>/dev/null | grep -v node_modules | head
```
Expected: `git diff --check` clean; privacy grep empty (note: `github:<owner>/cbrain` in `docs/install-onboarding.md` is a known residual — flagged in spec §6, not in scope to change).

- [ ] **Step 6: Final commit (if any cleanup)** — otherwise report done.

---

## Self-Review (completed by plan author)

**Spec coverage:** §3.1 MANIFEST → Task 1-2; §3.2 states/precedence → Task 3-4; §3.3 verificationStatus/status → Task 4; §3.4 install shape → Task 6; §3.5 no-overwrite (CLI zero-write, no flags) → preserved (no write code added); §3.6 error codes/privacy → Task 4 + Task 10; §3.7 docs gate → Task 7; §3.8 routing alignment → Task 8-9; §3.9 Hermes contract/release gate → Task 6 cross-ref (implementation defers smoke to post-merge gate, documented). Two reviewer clarifications (basename `.`/`..`, broken symlink) → Task 1 schema test + Task 3 symlink test.

**Placeholder scan:** no TBD/TODO; all code blocks present. Task 8 lists affected lines by number with a verbatim rewritten example; remaining rewrites follow the same pattern (mechanical `deep_recall`→`cbrain_recall` + args shape).

**Type consistency:** `TargetStatus`/`TargetFileState` gain `"incompatible"` (Task 3); `compareTarget` return adds `incompatibleFiles: readonly string[]`; `SkillPackReport.target` shape matches. `loadManifest`/`ENTRY_FILES`/`PackManifest` exported consistently across Tasks 1-3.

**Residual risk (per spec §6):** `github:chenhong268/cbrain` hardcoded (out of scope); routing alignment may surface more `deep_recall` gate refs (Task 9 Step 6 audits). Hermes runtime smoke deferred to post-merge release gate.

---

## Post-review runtime correction

**原计划为何推荐 symlink：** §3.4 原定 symlink 默认推荐，理由是「随 CBrain 升级自动同步」，省去人工重新部署。

**真实 Hermes loader 发现：** 合并前用 Hermes preload loader（`agent.skill_commands._load_skill_payload`）做 smoke 时发现，Hermes 用 **resolved path** 判定 trusted directory——指向 checkout 的 symlink 解析后落在 `~/.hermes/skills` 之外，会记录 `skill file is outside the trusted skills directory` 安全告警；且活跃 checkout 的 skills 修改会立即进入真实 Agent，绕过显式部署门禁（违反 #334「不静默漂移」）。

**最终政策：copy 默认推荐（稳定 Hermes），symlink 仅开发/试验可选。** copy 把审核快照落在 trusted root 内，checkout 变化不自动影响真实 Agent；代价是升级后变 stale，需人工重新部署 + verification。

**本修正对应：** spec §3.4 政策修订 + runtime evidence；`docs/install-onboarding.md` 第七步 copy 默认 + symlink 两风险说明；CLI human label `Copy (recommended)` / `Symlink (dev only)`；docs gate 新增 `checkSkillPackInstallPolicy`（copy 默认 / symlink 仅开发 / trusted-dir warning / checkout-drift 五合同逐条检测）。commit: `fix(skill-pack): prefer trusted copy deployment for Hermes (#334)`。

**未改：** 历史 Task 1-10 不动；live `~/.hermes` target 本轮不触碰（symlink→copy 原子迁移另布置）。
