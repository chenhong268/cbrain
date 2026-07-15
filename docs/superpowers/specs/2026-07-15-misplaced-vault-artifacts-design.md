# #341 Misplaced Vault Artifacts — Design

**Date:** 2026-07-15
**Issue:** [#341](https://github.com/chenhong268/cbrain/issues/341)
**Status:** Approved after dual adversarial review

## 1. Problem

CBrain treats `vaultPath` as the canonical Markdown root, while Obsidian or a
File Provider may operate on a parent directory. In that layout, unresolved
wikilinks, conflict copies, or delayed cloud materialization can create
Markdown files and CBrain-shaped directories beside `vaultPath`. Those
entries are outside CBrain's managed tree and SQLite index, but current
`health` and `fsck` can still report a healthy system.

#345 closes the restore transaction lifecycle for exact managed artifacts such
as `.pre-restore`, `.rollback`, WAL, and SHM. It deliberately does not scan
or delete sibling entries. #341 supplies that missing observability layer. It
must not become a general parent-directory crawler or an automatic cleanup
facility.

## 2. Goals

1. Detect bounded, recognizable misplaced artifacts outside `vaultPath`.
2. Surface the same read-only signal through `fsck` and daily `health`.
3. Distinguish zero-byte Markdown from other entries without declaring either
   category safe to delete.
4. Detect File Provider conflict-copy names such as `brain 2` and
   `records 2` without scanning arbitrary sibling directories.
5. Keep the new default signal private: counts and stable categories only,
   never candidate paths, filenames, Markdown content, stack traces, or
   credentials.
6. Never mutate, move, merge, ingest, or delete a detected entry.

## 3. Considered Approaches

### 3.1 Extend only the fsck vault probe

This is the smallest code change, but the daily Hermes `health` path would
remain blind. It does not solve the observed user workflow.

### 3.2 Add watcher-based continuous monitoring

This can detect changes immediately, but it adds persistent state, event
debouncing, File Provider churn, and writer lifecycle concerns. That
complexity is unnecessary for an observability issue.

### 3.3 Shared read-only shallow scanner — selected

A deterministic scanner returns a private-safe aggregate. The fsck vault probe
and HealthChecker adapt that aggregate into their existing report types. The
scanner performs no mutation and has no DB dependency.

## 4. Trusted Scan Root

The scan root is never inferred by walking upward from `vaultPath`.

1. Introduce `loadConfigWithPath()` as the sole parser/search implementation.
   It returns the parsed config plus the discovered config path:

   ```ts
   export interface LoadedCBrainConfig {
     config: CBrainConfig;
     configPath: string;
     configRoot: string;
   }
   ```

   `loadConfig()` becomes a compatibility wrapper that returns
   `loadConfigWithPath().config`; no caller may search for the active config a
   second time. `loadConfigSafe()` reuses the same internal path resolver and
   parser but converts resolution/parse failures to `null`; it is not a
   second search implementation.
2. Resolve a config-file symlink to its physical target with `realpath`, then
   set `configRoot = dirname(realConfigPath)`. The physical target directory,
   not the lexical symlink parent, is the only eligible root.
3. Preserve current runtime path semantics: normalize configured
   `vaultPath` and `dbPath` with `resolve()`. The loaded config object and
   its path travel together, so there is no later identity match against a
   second parse.
4. Create a branded `TrustedVaultBoundary` only when:
   - the existing `vaultPath` is a real directory, not a symlink;
   - its physical path is a **direct child** of `configRoot`; and
   - `configRoot/.obsidian` is a real directory, not a symlink.
5. Capture the device, inode, and directory type of both `configRoot` and
   `vaultPath` in the boundary. If the active config cannot be resolved or
   any eligibility condition fails, no boundary is created.

```ts
declare const trustedVaultBoundaryBrand: unique symbol;

export interface TrustedVaultBoundary {
  readonly configRoot: string;
  readonly vaultPath: string;
  readonly rootIdentity: EntryIdentity;
  readonly vaultIdentity: EntryIdentity;
  readonly [trustedVaultBoundaryBrand]: true;
}

export function resolveTrustedVaultBoundary(
  loaded: LoadedCBrainConfig,
): TrustedVaultBoundary | undefined;
```

Only the resolver can construct this branded value. The scanner, fsck,
HealthChecker, `CBrainDeps`, and `ToolContext` receive the boundary object,
not separately forgeable `configRoot` and `vaultPath` strings.

The scanner performs one bounded name enumeration of the physical
`configRoot`, reads metadata for recognized direct entries only, and never
opens a candidate file or descends into a candidate directory. It never reads
the parent of `configRoot` or recursively searches general siblings.

Root and vault identities are checked after enumeration against the values
captured by `TrustedVaultBoundary`. A change/disappearance in either device,
inode, or directory type makes the already-eligible scan incomplete; it cannot
fall back to ineligible or clean. Node/Bun path APIs cannot make enumeration
and identity verification one atomic syscall, so this is an observability
check rather than an adversarial filesystem sandbox. Even under a replacement
race, only one level of names may be enumerated; no candidate body or subtree
is opened and no enumerated name is emitted.

### 4.1 Config loader compatibility table

| source state | strict `loadConfigWithPath/loadConfig` | `loadConfigSafe` | fallback |
|---|---|---|---|
| explicit `CBRAIN_CONFIG`, valid | return that file | return that file | none |
| explicit path missing | existing fixed error + exit 1 | `null` | never search upward |
| explicit file malformed | preserve strict parse failure | `null` | never search upward |
| no explicit path, upward file valid | return nearest file | return nearest file | n/a |
| no explicit path, nearest file malformed | preserve strict parse failure | `null` | never skip to a higher config |
| no config found | existing fixed error + exit 1 | `null` | n/a |

`findConfig(startDir)` reuses the same nearest-path resolver and preserves its
existing public shape: valid config, `null` when absent, parse failure when
the nearest file is malformed. Tests lock all six rows and prove explicit
failure never falls back.

## 5. Candidate Contract

The scanner considers only these non-hidden direct children of `configRoot`:

1. entries whose names end in `.md` (regular files are classified by size;
   symlinks and special entries require review);
2. entries named `brain`, `records`, or `raw`;
3. File Provider numeric conflict variants matching
   `brain N`, `records N`, or `raw N`, where `2 <= N <= 99`;
4. numeric conflict variants of the configured vault directory name, such as
   `vault N`, where `2 <= N <= 99`.

The exact configured `vaultPath` entry is always excluded. Hidden entries,
`.obsidian`, `.cbrain`, `cbrain.json`, ordinary non-Markdown files, and
unrecognized sibling directories are ignored.

The numeric grammar is ASCII-only and canonical:

```text
N := [2-9] | [1-9][0-9]
```

It accepts `2`, `9`, `10`, and `99`, and rejects `0`, `1`, `02`,
`100`, `2026`, `+2`, `2.0`, and Unicode digits. The configured vault
basename is escaped before being inserted into a regular expression.

The scanner never recurses into or opens a candidate directory. A recognized
directory is itself enough evidence of boundary drift and always requires
review, whether empty or non-empty. Therefore `brain/concepts/x.md` is
detected by the direct `brain` entry without reading `concepts` or
`x.md`. Candidate symlinks and other non-regular entry types are classified
from `lstat` metadata and always require review.

## 6. Classification and Interface

Create a focused module:

```ts
export interface MisplacedVaultArtifactScan {
  eligible: boolean;
  zeroByteMarkdownCount: number;
  reviewRequiredCount: number;
  unreadableCount: number;
}

export interface MisplacedVaultArtifactLocalDetail {
  relativePath: string;
  classification: "zero_byte_markdown" | "review_required" | "unreadable";
}

export interface MisplacedVaultArtifactInspection {
  scan: MisplacedVaultArtifactScan;
  localDetails: readonly MisplacedVaultArtifactLocalDetail[];
}

export function inspectMisplacedVaultArtifacts(
  boundary?: TrustedVaultBoundary,
  options?: { includeLocalDetails?: boolean },
): MisplacedVaultArtifactInspection;
```

Every adapter projects from this single inspection snapshot. With
`includeLocalDetails !== true`, `localDetails` is always empty so Health,
MCP, reports, and repair planning cannot accidentally retain names. If final
root/vault identity verification fails, the inspector discards all collected
details and returns the appropriate nonzero `unreadableCount`.

Classification:

- zero-byte top-level regular Markdown file → `zeroByteMarkdownCount`;
- non-empty top-level Markdown file → `reviewRequiredCount`;
- every recognized directory → `reviewRequiredCount`;
- symlink or other special recognized entry → `reviewRequiredCount`;
- candidate metadata failure → `unreadableCount`.

`unreadableCount` is separate from review count so callers can say the scan
was incomplete. No raw filesystem error crosses the scanner boundary.

The implementation accepts an internal filesystem-dependency seam for
deterministic race/error tests. Production dependencies are only
`realpath/lstat/readdir`; no read, open, write, copy, rename, or remove
primitive is present.

### 6.1 State Table

| condition | eligible | zeroByteMarkdownCount | reviewRequiredCount | unreadableCount |
|---|---:|---:|---:|---:|
| trusted boundary cannot be established | false | 0 | 0 | 0 |
| trusted root established and clean | true | 0 | 0 | 0 |
| trusted root disappears or root enumeration/identity check fails | true | 0 | 0 | 1 |
| active vault changes, disappears, or becomes a symlink after eligibility | true | preserve prior count | preserve prior count | at least 1 |
| some candidates classify and a later candidate metadata lookup fails | true | preserve prior count | preserve prior count | increment per failed candidate |

Only the first row means “not eligible.” Once trust eligibility is
established, an operational failure can never be converted into a clean or
ineligible result.

## 7. fsck Integration

`FsckInput` gains optional `vaultBoundary`. The vault layer passes it to the
shared scanner through `probeVault`.

The probe emits up to three findings:

| check | severity | meaning |
|---|---|---|
| `vault.misplaced_zero_byte_markdown` | warning | zero-byte top-level Markdown file |
| `vault.misplaced_review_required_artifact` | warning | non-empty Markdown, recognized directory, or special entry needs review |
| `vault.misplaced_artifact_scan_incomplete` | warning | one or more candidate entries could not be classified |

All findings use counts and anonymous `item_N` samples only. Details and
suggested actions contain no path or filename. `repair-plan` maps all three
checks to `needs_review`, `canExecute: false`; this issue adds no
`--fix`, `--execute`, delete, move, or ingest path.

`cbrain fsck --layer vault` remains read-only: DB bytes, vault mtimes, and
candidate entries are unchanged before and after the probe.

### 7.1 Explicit local detail

Default JSON, Markdown, repair-plan, Health, and MCP surfaces remain aggregate
only. For manual location, fsck adds `--local-details` with these constraints:

- valid only with `--layer vault`;
- incompatible with `--json`, `--repair-plan`, and repair flags;
- prints recognized paths relative to `configRoot` plus the generic
  classification; never prints an absolute root or file body;
- never writes the relative paths into report files, state, repair-plan, logs,
  MCP, or action candidates.

This explicit local-only preview is still read-only and carries a warning that
zero bytes do not prove deletion safety. `runFsck` invokes the inspector
exactly once and derives both findings and optional local details from that
snapshot.

Local-detail exit semantics are fixed:

- invalid flag combination → exit 2, no scan;
- eligible and clean → exit 0;
- any finding or incomplete inspection → exit 1;
- an identity/root failure after enumeration → discard every collected name,
  print one fixed path-free incomplete diagnostic, exit 1.

Each relative path is emitted on exactly one line using reversible JSON-style
escaping. C0 controls, DEL, ESC, newline, and tab use visible JSON escapes;
Unicode bidi controls (`U+061C`, `U+200E–U+200F`,
`U+202A–U+202E`, `U+2066–U+2069`) are forced to visible
`\\uXXXX` escapes. None reaches the terminal raw, and the absolute root is
never printed.

## 8. Health Integration

HealthChecker receives optional `vaultBoundary` and adds a
`文件系统卫生` dimension backed by the same scanner.

- zero-byte Markdown candidates produce one medium-severity issue and dimension
  `warn`;
- review-required entries produce one medium-severity issue and dimension
  `warn`;
- unreadable candidates produce one medium-severity issue and dimension
  `warn`.

`HealthIssue` gains optional stable `code`, separate from page `slug`.
Filesystem-hygiene issues use `slug: "-"` and distinct codes for zero-byte,
review-required, and incomplete signals. Delta/state identity uses
`issue.code ?? issue.slug`. Both actions and full-report renderers use plain
`-` for `slug: "-"` and must never produce `[[-]]` or a wikilink from
`code`. Descriptions contain aggregate counts only. The HealthChecker report
may still write its normal report files, but the scanner itself performs no
writes.

`vaultBoundary` is parsed once and threaded through these exact construction
paths:

1. CLI `health`;
2. CLI `health-debt`;
3. CLI `dream`;
4. `CBrainDeps → ToolContext → MCP ops.health`;
5. `CBrainDeps → ToolContext → registerDreamWorker`;
6. `CBrainDeps → ToolContext → health-backed action-candidates`.

Health-debt adds an explicit `文件系统卫生 → needs_review` rule. It must not
fall through to `observe_only`, and health-backed action candidates inherit
the same classification. `RepairAction` retains optional `code`; the
health-debt planner copies it from `HealthIssue`, and action-candidate stable
identity uses `code` before dimension/group/slug. The three filesystem
categories therefore produce three distinct stable refs rather than collapsing
onto the shared `slug: "-"`. No health-debt execute path is created.

Synthetic callers must pass a boundary explicitly; a plain config object is
never allowed to trigger a new cwd search.

### 8.1 MCP health projection

`formatHealthEnvelope` currently returns the full `HealthReport` as legacy
`raw`, including absolute `reportPaths`. For the MCP health surface, this
issue changes `raw` to a compatibility projection that preserves timestamp,
status, dimensions, metrics, and delta but omits `reportPaths`.

Health does not currently implement the recall/query structured-boundary mode,
so legacy and structured host settings receive the same path-free health
projection. This is not a claim that all historical health issue content is
safe against prompt injection; the broader cross-tool boundary remains #327.
The new filesystem-hygiene findings themselves contain counts and generic text
only.

### 8.2 Operator documentation projection

`docs/vault-spec.md` is the normative storage-boundary reference and
`docs/install-onboarding.md` is the operator runbook. Both explain the nested
Obsidian-root cause, aggregate default warnings, explicit relative/escaped
`--local-details`, zero-byte uncertainty, the never-auto-delete rule, and the
unchanged #345 exact restore-residual boundary. Examples remain anonymous.

## 9. Error and Privacy Boundaries

- Failure to establish a trusted scan root is a silent ineligible state, not a
  scan of a guessed directory.
- After eligibility is established, failure to enumerate or identity-check the
  trusted `configRoot` yields one incomplete-scan
  signal without raw error text.
- Per-candidate metadata failures increment `unreadableCount`.
- The scanner never reads Markdown bodies.
- The MCP health projection never includes `reportPaths`. Existing local CLI
  health output continues to expose its operator-requested report output paths;
  that established CLI behavior is not redefined as private. New default
  findings, persisted report content, tests, docs, fixtures, and logs for this
  signal must not contain a candidate path, filename, entity, organization,
  email, credential, or stack trace. Only explicit fsck `--local-details` may
  show relative candidate paths.
- Tests use anonymous temporary roots and argument-array subprocesses where a
  CLI boundary is exercised.

## 10. Test Strategy

TDD begins with the scanner contract:

1. ineligible without a branded boundary, without a real `.obsidian`
   directory, or when `vaultPath` is not a direct physical child;
2. clean root produces zero counts;
3. top-level zero-byte/non-empty Markdown classification;
4. exact `brain/records/raw` entries always require review without traversal;
5. `brain 2`, `records 2`, and configured-vault numeric variants, including
   accepted `2/9/10/99` and rejected
   `0/1/02/100/2026/+2/2.0/Unicode digit`;
6. hidden, runtime, ordinary file, and arbitrary-directory exclusions;
7. candidate symlink/broken symlink is not opened and requires review;
8. root identity replacement during enumeration becomes incomplete;
9. vault replacement by symlink/different directory/missing after eligibility
   becomes incomplete, never clean or ineligible;
10. root disappearance, permission/non-`ENOENT` failure, and partial
   candidate classification preserve `eligible:true` and honest counts;
11. unreadable/error injection collapses to counts without raw detail;
12. the six config-loader rows preserve strict/safe and no-fallback behavior.
13. local-details discards all names on root/vault replacement and returns the
    fixed nonzero incomplete result;
14. newline, tab, ESC, DEL, and bidi-control filenames are reversibly escaped
    and cannot forge terminal lines.

Integration tests then prove:

- fsck emits stable checks and exit status;
- repair-plan is review-only;
- health emits the same counts in `文件系统卫生`;
- CLI health, health-debt, CLI dream, MCP health, dream worker, and
  health-backed action-candidates all receive the same explicit root;
- health-debt and action-candidates classify the signal as `needs_review`;
- the three optional issue codes survive health-debt and produce distinct
  action-candidate stable refs;
- health actions/full reports render global codes as plain text and never create
  a wikilink;
- config-root identity is parsed once and threaded only from the active config;
- read-only hashes/mtimes remain unchanged;
- real MCP handler text omits `reportPaths` and contains no synthetic secret
  candidate path, filename, file body, or stack text;
- `--local-details` is explicit, relative-only, non-persistent, and rejected
  with JSON/repair modes;
- `repair-plan --execute` and health action-candidates preserve a before/after
  snapshot of candidate entries even when an executable FTS item is present.

Focused tests, lint, docs consistency, full `bun run check`, diff check, and a
privacy scan are required before merge.

## 11. Non-goals

- No automatic cleanup, confirmation UI, quarantine, move, ingest, or merge.
- No recursive scan of arbitrary parent or sibling directories.
- No watcher or File Provider event subscription.
- No change to CBrain page write paths unless separate evidence proves CBrain
  itself writes outside `vaultPath`.
- No change to #345 exact restore residual ownership.
- No live-vault scan or mutation as part of implementation acceptance.

## 12. Release Boundary

This issue closes the observability gap only. The operator still decides what
to do with every detected entry. A later issue may propose an explicit,
preview-first cleanup workflow, but it must separately prove ownership and
zero-partial-mutation semantics.
