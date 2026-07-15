# #341 Misplaced Vault Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, read-only detection of Obsidian/File Provider artifacts outside the configured `vaultPath`, visible through fsck and health without automatic cleanup or default path disclosure.

**Architecture:** A single config loader produces a physical config root, which is resolved into a branded `TrustedVaultBoundary`. One shared filesystem inspector produces aggregate counts and optional local-only details from a single snapshot. fsck and HealthChecker adapt only aggregate data; explicit `fsck --local-details` is the sole path-bearing projection.

**Tech Stack:** TypeScript, Bun, `bun:test`, Commander, Node-compatible `fs` APIs, existing FsckReport/HealthReport/repair-plan/action-candidate contracts.

## Global Constraints

- Never scan above the physical directory containing the active `cbrain.json`.
- Scan only when the physical `vaultPath` is a direct child and `.obsidian` is a real directory.
- Never recurse into candidates, follow candidate symlinks, or read Markdown bodies.
- Numeric collision suffixes are ASCII integers `2..99` only.
- Default findings expose counts and stable codes, never candidate names or paths.
- No delete, move, copy, rename, ingest, merge, repair execute, or live-vault acceptance run.
- All filesystem-hygiene signals are warning/needs-review only.
- Explicit local details are relative-only, terminal-safe, non-persistent, and derived from the same inspection snapshot as findings.
- #345 restore ownership/finalization behavior is unchanged.

---

### Task 1: Unify config loading and create the trusted boundary

**Files:**
- Modify: `src/cli/context.ts`
- Create: `tests/cli/config-boundary.test.ts`
- Test: `tests/cli/context.test.ts`

**Interfaces:**
- Produces: `LoadedCBrainConfig`, `loadConfigWithPath(startDir?)`, and the existing strict/safe wrappers backed by one resolver.
- Consumes later: Task 2's `resolveTrustedVaultBoundary()`.

- [ ] **Step 1: Write failing loader compatibility tests**

Add table-driven cases for explicit valid/missing/malformed, upward valid/malformed, and fully missing configurations. The test must prove an explicit failure never falls back:

```ts
for (const scenario of scenarios) {
  test(scenario.name, () => {
    const result = scenario.safe
      ? loadConfigSafe(scenario.startDir, scenario.env)
      : loadConfigWithPath(scenario.startDir, scenario.env);
    scenario.assert(result);
  });
}
```

Use only anonymous temporary directories. For malformed cases, assert safe returns `null` and strict preserves a parse failure. For explicit missing, inject/capture the strict exit path and assert no upward file is read.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
bun test tests/cli/config-boundary.test.ts
```

Expected: FAIL because `loadConfigWithPath` and injectable resolution arguments do not exist.

- [ ] **Step 3: Implement one path resolver and wrappers**

Add:

```ts
export interface LoadedCBrainConfig {
  config: CBrainConfig;
  configPath: string;
  configRoot: string;
}

export function loadConfigWithPath(
  startDir = process.cwd(),
  explicitPath = process.env.CBRAIN_CONFIG,
): LoadedCBrainConfig;
```

The internal resolver returns the explicit path without fallback, otherwise the nearest upward `cbrain.json`. Resolve a config symlink using `realpathSync`; set `configRoot = dirname(realConfigPath)`. Make `loadConfig()`, `loadConfigSafe()`, and `findConfig()` reuse that resolver while preserving the spec's strict/safe state table.

- [ ] **Step 4: Run focused loader tests**

```bash
bun test tests/cli/config-boundary.test.ts tests/cli/context.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/context.ts tests/cli/config-boundary.test.ts tests/cli/context.test.ts
git commit -m "refactor(config): unify active config resolution"
```

---

### Task 2: Build the single-snapshot filesystem inspector

**Files:**
- Create: `src/core/maintenance/misplaced-vault-artifacts.ts`
- Create: `tests/core/misplaced-vault-artifacts.test.ts`

**Interfaces:**
- Produces:

```ts
export interface EntryIdentity {
  dev: number;
  ino: number;
  kind: "directory";
}

export interface TrustedVaultBoundary {
  readonly configRoot: string;
  readonly vaultPath: string;
  readonly rootIdentity: EntryIdentity;
  readonly vaultIdentity: EntryIdentity;
  readonly [trustedVaultBoundaryBrand]: true;
}

export interface MisplacedVaultArtifactScan {
  eligible: boolean;
  zeroByteMarkdownCount: number;
  reviewRequiredCount: number;
  unreadableCount: number;
}

export interface MisplacedVaultArtifactInspection {
  scan: MisplacedVaultArtifactScan;
  localDetails: readonly {
    relativePath: string;
    classification: "zero_byte_markdown" | "review_required" | "unreadable";
  }[];
}

export function resolveTrustedVaultBoundary(input: {
  configRoot: string;
  vaultPath: string;
}): TrustedVaultBoundary | undefined;

export function inspectMisplacedVaultArtifacts(
  boundary?: TrustedVaultBoundary,
  options?: { includeLocalDetails?: boolean },
  overrides?: Partial<MisplacedInspectorDeps>,
): MisplacedVaultArtifactInspection;

export function escapeLocalDetailPath(path: string): string;
```

- [ ] **Step 1: Write boundary and candidate RED tests**

Cover:

- missing/symlink `.obsidian`;
- lexical child whose physical vault is elsewhere;
- absent/symlink vault;
- clean eligible root;
- zero/nonzero `.md`;
- exact `brain/records/raw`;
- accepted `2/9/10/99`;
- rejected `0/1/02/100/2026/+2/2.0/Unicode digit`;
- regex-special vault basename;
- hidden/unrecognized siblings;
- candidate symlink/broken symlink.

Assert candidate directories are never enumerated by making the injected `readdir` throw if called for any path except `configRoot`.

- [ ] **Step 2: Run scanner tests and verify RED**

```bash
bun test tests/core/misplaced-vault-artifacts.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal boundary and inspector**

Use `lstatSync`, `realpathSync`, and one `readdirSync(configRoot)`. Candidate classification uses only `lstat` size/type. After candidate classification, re-check both root and vault identities. Any mismatch or post-eligibility failure sets `unreadableCount >= 1` and clears `localDetails`.

Use this exact suffix grammar:

```ts
const CONFLICT_SUFFIX = "(?:[2-9]|[1-9][0-9])";
```

Escape the vault basename before constructing its expression.

- [ ] **Step 4: Add race/error and terminal-safety tests**

Inject:

- root replacement after enumeration;
- vault replacement by symlink, other directory identity, and missing;
- root enumeration failure;
- one candidate metadata failure after earlier successful classifications;
- filenames containing newline, tab, ESC, DEL, `U+202E`, and `U+2066`.

Assert final identity failure returns `eligible:true`, nonzero unreadable, and no details. Assert `escapeLocalDetailPath` returns one printable line with no raw control/bidi characters.

- [ ] **Step 5: Run scanner tests and commit**

```bash
bun test tests/core/misplaced-vault-artifacts.test.ts
git add src/core/maintenance/misplaced-vault-artifacts.ts tests/core/misplaced-vault-artifacts.test.ts
git commit -m "feat(health): inspect misplaced vault artifacts safely"
```

---

### Task 3: Integrate fsck, repair-plan, and local details

**Files:**
- Modify: `src/core/fsck/vault-probe.ts`
- Modify: `src/core/fsck/repair-plan.ts`
- Modify: `src/cli/commands/fsck.ts`
- Modify: `tests/core/fsck/vault-probe.test.ts`
- Modify: `tests/core/fsck/repair-plan.test.ts`
- Modify: `tests/cli/fsck.test.ts`
- Modify: `tests/cli/fsck.blackbox.test.ts`
- Modify: `tests/cli/fsck.readonly.test.ts`

**Interfaces:**
- `FsckInput.vaultBoundary?: TrustedVaultBoundary`
- `FsckInput.includeLocalDetails?: boolean`
- `FsckResult.localDetails?: readonly MisplacedVaultArtifactLocalDetail[]`

- [ ] **Step 1: Write fsck findings and repair-plan RED tests**

Assert the vault layer emits these warning findings:

```ts
"vault.misplaced_zero_byte_markdown"
"vault.misplaced_review_required_artifact"
"vault.misplaced_artifact_scan_incomplete"
```

Assert each repair item is `needs_review`, `canExecute:false`, has no execute command, and `repair-plan --execute` leaves candidate snapshots unchanged even when stale FTS rows are executable.

- [ ] **Step 2: Verify RED**

```bash
bun test tests/core/fsck/vault-probe.test.ts tests/core/fsck/repair-plan.test.ts tests/cli/fsck.test.ts
```

Expected: FAIL with missing findings/input.

- [ ] **Step 3: Implement one-inspection fsck projection**

When the vault layer is selected, call `inspectMisplacedVaultArtifacts` exactly once. Pass its aggregate into the vault finding builder and return optional details from the same result. Do not call the inspector from both `runFsck` and `probeVault`.

Add explicit repair-plan rules with:

```ts
{
  bucket: "needs_review",
  canExecute: false,
  prerequisite: "human review required; zero bytes do not prove deletion safety",
  verifyCommand: "cbrain fsck --json --layer vault",
}
```

- [ ] **Step 4: Add and implement CLI flag validation**

Add `.option("--local-details", ...)`. Reject before opening DB:

- missing/non-vault `--layer`;
- `--json`;
- `--repair-plan`;
- `--repair-stale-fts`.

Invalid combinations exit 2. Clean exits 0. Any finding/incomplete exits 1. On identity failure print only a fixed path-free incomplete diagnostic. Otherwise print `classification + escapeLocalDetailPath(relativePath)`, one entry per line.

- [ ] **Step 5: Prove read-only and privacy behavior**

Black-box tests use argument arrays and anonymous temp roots. Hash DB and candidate tree plus record mtimes before/after default/local/repair-plan runs. Verify default JSON/human output contains no synthetic filename/body/root. Verify local mode includes escaped relative names but not the root/body.

- [ ] **Step 6: Run focused tests and commit**

```bash
bun test tests/core/fsck/vault-probe.test.ts tests/core/fsck/repair-plan.test.ts tests/cli/fsck.test.ts tests/cli/fsck.blackbox.test.ts tests/cli/fsck.readonly.test.ts
git add src/core/fsck src/cli/commands/fsck.ts tests/core/fsck tests/cli/fsck.test.ts tests/cli/fsck.blackbox.test.ts tests/cli/fsck.readonly.test.ts
git commit -m "feat(fsck): report misplaced vault artifacts"
```

---

### Task 4: Add the health dimension without creating wikilinks or identity collisions

**Files:**
- Modify: `src/core/maintenance/health.ts`
- Modify: `src/core/maintenance/health-debt.ts`
- Modify: `src/core/maintenance/action-candidates.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/core/health-debt.test.ts`
- Modify: `tests/core/action-candidates.test.ts`

**Interfaces:**
- `HealthIssue.code?: string`
- `RepairAction.code?: string`
- HealthChecker constructor adds final optional `vaultBoundary?: TrustedVaultBoundary`.

- [ ] **Step 1: Write health dimension RED tests**

Create a synthetic inspection root and assert `文件系统卫生`:

- is absent/clean when ineligible;
- warns with one medium issue per nonzero category;
- uses `slug:"-"` and distinct stable codes;
- contains counts only;
- never contains candidate names.

- [ ] **Step 2: Write renderer and identity RED tests**

Assert actions/full report do not contain `[[-]]`, the issue code, or candidate names. Run two health checks and verify state/delta keys use `code ?? slug`, preserving three distinct categories.

- [ ] **Step 3: Implement health code and dimension**

Add:

```ts
function healthIssueIdentity(issue: HealthIssue): string {
  return issue.code ?? issue.slug;
}

function pageReference(slug: string): string {
  return slug && slug !== "-" ? `[[${slug}]]` : "-";
}
```

Use the identity helper in state/delta computation and the page helper in both actions/full report renderers. Add `checkFilesystemHygiene()` to `checkAll()`, backed by the single aggregate inspector call.

- [ ] **Step 4: Lock health-debt and action identity**

Copy `issue.code` into `RepairAction.code`. Add an explicit `文件系统卫生` branch returning `needs_review`. Change stable ref:

```ts
const scope = action.code ?? (action.slug && action.slug !== "-" ? action.slug : "global");
```

Assert the three codes produce three stable, distinct action-candidate refs and no candidate path reaches persisted display/metadata.

- [ ] **Step 5: Run focused tests and commit**

```bash
bun test tests/core/health.test.ts tests/core/health-debt.test.ts tests/core/action-candidates.test.ts
git add src/core/maintenance/health.ts src/core/maintenance/health-debt.ts src/core/maintenance/action-candidates.ts tests/core
git commit -m "feat(health): surface filesystem hygiene warnings"
```

---

### Task 5: Thread one trusted boundary through CLI, MCP, dream, and action candidates

**Files:**
- Modify: `src/cli/context.ts`
- Modify: `src/cli/commands/server.ts`
- Modify: `src/cli/commands/maintenance.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/context.ts`
- Modify: `src/mcp/tools/ops.ts`
- Modify: `src/mcp/tools/action-candidates.ts`
- Modify: `tests/cli/context.test.ts`
- Modify: `tests/cli/tool-profile-threading.test.ts`
- Modify: `tests/mcp/action-candidates.test.ts`
- Create: `tests/mcp/filesystem-hygiene.test.ts`

**Interfaces:**
- `CBrainDeps.vaultBoundary?: TrustedVaultBoundary`
- `ToolContext.vaultBoundary?: TrustedVaultBoundary`
- `createDeps(config, requireEmbedding, vaultBoundary?)`

- [ ] **Step 1: Write threading RED tests**

Assert plain synthetic `createDeps(config)` leaves the boundary undefined. Assert an explicitly resolved boundary survives `createDeps → buildContext`. Add source-level contract assertions or injected constructor spies covering:

1. CLI health;
2. CLI health-debt;
3. CLI dream;
4. MCP ops.health;
5. registerDreamWorker;
6. health-backed action-candidates.

- [ ] **Step 2: Verify RED**

```bash
bun test tests/cli/context.test.ts tests/cli/tool-profile-threading.test.ts tests/mcp/filesystem-hygiene.test.ts tests/mcp/action-candidates.test.ts
```

- [ ] **Step 3: Implement explicit threading**

Server/maintenance entrypoints call `loadConfigWithPath()` once, resolve one boundary, and pass both config and boundary downward. No `createDeps`, MCP tool, dream worker, or HealthChecker call may search cwd.

Update all six HealthChecker construction points to pass `ctx/deps/vaultBoundary`.

- [ ] **Step 4: Run focused tests and commit**

```bash
bun test tests/cli/context.test.ts tests/cli/tool-profile-threading.test.ts tests/mcp/filesystem-hygiene.test.ts tests/mcp/action-candidates.test.ts
git add src/cli src/mcp tests/cli tests/mcp
git commit -m "refactor(runtime): thread trusted vault boundary"
```

---

### Task 6: Project MCP health safely, document the operator boundary, and verify

**Files:**
- Modify: `src/mcp/tools/format-result.ts`
- Modify: `tests/mcp/health-dream-envelope.test.ts`
- Modify: `tests/mcp/filesystem-hygiene.test.ts`
- Modify: `docs/vault-spec.md`
- Modify: `docs/install-onboarding.md`
- Modify: `docs/cli-reference.md` if fsck flags are enumerated there
- Modify: `docs/superpowers/specs/2026-07-15-misplaced-vault-artifacts-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-misplaced-vault-artifacts.md`

**Interfaces:**
- `HealthEnvelopeRaw = Omit<HealthReport, "reportPaths">`

- [ ] **Step 1: Write MCP projection RED tests**

Build a report whose `reportPaths` and candidate fixture contain synthetic secret sentinels. Assert the real MCP health handler's final JSON text excludes report paths, candidate names, bodies, controls, and stack text while preserving timestamp/status/dimensions/metrics/delta.

- [ ] **Step 2: Implement the path-free health projection**

```ts
function projectHealthReport(report: HealthReport): Omit<HealthReport, "reportPaths"> {
  const { reportPaths: _reportPaths, ...projected } = report;
  return projected;
}
```

Use it in every `formatHealthEnvelope` branch, including the clean/zero-action branch.

- [ ] **Step 3: Update operator docs**

Document:

- why nested Obsidian root layouts can create misplaced entries;
- what default fsck/health warnings mean;
- `--local-details` is explicit, relative, escaped, and read-only;
- zero bytes do not prove safe deletion;
- numbered/unmanaged directories are never auto-deleted;
- #345 remains exact restore residual handling.

All examples use anonymous roots and filenames.

- [ ] **Step 4: Run adversarial code and mutation review**

Dispatch two read-only reviewers:

1. code/security reviewer: scan scope, symlink/race, config identity, exit codes, readonly;
2. test/mutation reviewer: remove identity recheck, widen numeric regex, follow directory, leak details, collapse codes, restore reportPaths, and verify tests fail.

Fix every CRITICAL/HIGH/MEDIUM and repeat until both return PASS.

- [ ] **Step 5: Run complete verification**

```bash
bun test tests/cli/config-boundary.test.ts tests/core/misplaced-vault-artifacts.test.ts tests/core/fsck/vault-probe.test.ts tests/core/fsck/repair-plan.test.ts tests/cli/fsck.test.ts tests/cli/fsck.blackbox.test.ts tests/cli/fsck.readonly.test.ts tests/core/health.test.ts tests/core/health-debt.test.ts tests/core/action-candidates.test.ts tests/mcp/filesystem-hygiene.test.ts tests/mcp/health-dream-envelope.test.ts
bun run lint
bun run check:docs
bun run check
git diff --check
```

Privacy scan the full issue diff for real names, absolute user paths, credentials, candidate fixture bodies, and stack traces. Confirm no live vault was scanned or modified.

- [ ] **Step 6: Commit**

```bash
git add src tests docs
git commit -m "docs: explain misplaced vault artifact warnings"
```

## Completion Gate

- [ ] Spec and plan coverage rechecked with no placeholder/type drift.
- [ ] Dual adversarial review PASS.
- [ ] Focused, lint, docs, and full checks PASS.
- [ ] Worktree contains only #341 changes.
- [ ] Branch pushed; PR includes `Closes #341`.
- [ ] PR CI and post-merge main CI PASS.
- [ ] #341 closed; remote feature branch deleted.
- [ ] #343 becomes the next urgent bug before #335.
