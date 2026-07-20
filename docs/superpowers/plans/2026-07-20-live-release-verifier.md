# Live-Release Verifier Implementation Plan (#368)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A checkout-independent, read-only verifier that resolves the active CBrain deployment from loaded launchd evidence (never caller cwd) and proves HTTP/package/manifest/skill-target version coherence.

**Architecture:** Two layers. (1) A thin bash bootstrap that reads `launchctl print` to derive the active root, then spawns the active-root verifier by absolute path — cwd-agnostic, no global CLI. (2) A fat TypeScript verifier built as pure functions over an injected dependency interface (launchctl / lsof / libproc / HTTP / skill-pack), so every fail-closed matrix case is deterministic and tested without touching the real service. The verifier self-proves its own code lives under the active root before trusting itself.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`. Reuses `bin/lib/hermes-canary-live-fingerprint.ts` patterns, imports `src/cli/commands/skill-pack.ts` directly, mirrors `scripts/ops/verify-cbrain-http-mcp-migration.sh` checks.

---

## Scope (from issue #368)

Implement exactly one deterministic read-only path. No MCP tool / HTTP endpoint / DB table / daemon / registry / global CLI / service restart / rollback / version bump. Inactive checkouts and rollback candidates are explanatory only and never affect aggregate success.

## File Structure

| File | Responsibility | Status |
|:---|:---|:---|
| `bin/lib/live-release-verify.ts` | Pure verifier core: types, dependency interface, `verifyLiveRelease(deps)`, output schema, fail-code map, sanitizer. No system calls. | Create |
| `bin/lib/live-release-deps.ts` | Real `LiveReleaseDeps` implementation: launchctl print parse, lsof listener+cwd, libproc `processStart`, HTTP `/health`, `verifySkillPack`/`compareTarget` via skill-pack import. | Create |
| `bin/live-release-verify.ts` | CLI entrypoint: builds real deps, self-proves `import.meta.url` under active root, emits human/JSON, sets stable exit code. | Create |
| `skills/release-verify-bootstrap.sh` | Thin cwd-independent bash: read launchd service evidence → derive active root → spawn `<active_root>/bin/live-release-verify.ts` by absolute path. | Create |
| `skills/release-verify.md` | Hermes skill contract: use the bootstrap, forbid cwd fallback, inactive = explanation only, report "runtime version unverified" on failure. | Create |
| `skills/MANIFEST.json` | Add `release-verify.md` + `release-verify-bootstrap.sh` to inventory; keep `packVersion` in sync with `package.json`. | Modify |
| `tests/release/live-release-verify.test.ts` | Deterministic unit tests over `verifyLiveRelease` with fake deps covering all 12 fail matrix rows + privacy + read-only black-box + bootstrap cwd-independence. | Create |

## Dependency-Injection Interface (the seam that makes this testable)

```ts
// bin/lib/live-release-verify.ts
export interface ServiceEvidence {
  readonly label: string;                 // e.g. "ai.cbrain.serve"
  readonly pid: number;                   // loaded service PID
  readonly program: string;               // configured Program (absolute)
  readonly programArguments: readonly string[]; // configured ProgramArguments
  readonly workingDirectory: string;      // configured WorkingDirectory (absolute)
  readonly lastExitStatus: number | null;
}
export interface ProcessIdentity { readonly pid: number; readonly startUsec: string } // libproc birth
export interface ListenerOwner { readonly pid: number; readonly count: number }
export interface TargetResult { readonly path: string; readonly status: "current"|"stale"|"missing"|"incompatible"|"unverified" }

export interface LiveReleaseDeps {
  readonly ownVerifierPath: string;                          // import.meta.url resolved
  readServiceEvidence(label: string): ServiceEvidence;       // launchctl print parse
  listCbrainServiceOwners(): readonly string[];              // launchctl list grep
  readProcessIdentity(pid: number): ProcessIdentity | null;  // libproc processStart
  readProcessCwd(pid: number): string | null;                // lsof -p PID cwd
  readListenerOwner(port: number): ListenerOwner;            // lsof -iTCP:port
  readCallerCwd(): string;                                    // process.cwd
  fetchHealthVersion(url: string, timeoutMs: number): { ok: true; version: string } | { ok: false; code: HttpFailCode };
  readPackageVersion(root: string): { ok: true; version: string } | { ok: false };
  readManifestVersion(root: string): { ok: true; version: string; files: readonly string[] } | { ok: false };
  verifySkillTarget(rootSkillsDir: string, targetDir: string): TargetResult; // wraps skill-pack compareTarget
}
```

`verifyLiveRelease(deps, opts)` is a pure function returning `{ status: "pass"|"fail"; code?: FailCode; ...sanitized evidence }`. Tests inject a `FakeLiveReleaseDeps`.

## Output Schema (privacy-safe)

```jsonc
// pass
{"schema_version":1,"status":"pass","service":{"label":"ai.cbrain.serve","pid_birth":"hashed"},"active":{"root":"<basename>","version":"2.0.8"},"versions":{"http":"2.0.8","package":"2.0.8","manifest":"2.0.8"},"targets":[{"path":"<basename>","status":"current"}],"caller_cwd":{"path":"<basename>","classification":"inactive"}}
// fail
{"schema_version":1,"status":"fail","code":"LISTENER_OWNER_MISMATCH","layer":"process"}
```

- Paths emitted as **basename only** (no `/Users/`, no `$HOME`). PID emitted as a birth-identity hash digest, never raw command text.
- Human output mirrors this with stable section headers; failure prints `code` + one-line layer.

## Fail-Code Map (16 distinct layers — never collapse to one generic code)

| Code | Layer | Trigger |
|:---|:---|:---|
| `SERVICE_NOT_FOUND` | service | no loaded ai.cbrain.serve |
| `MULTIPLE_SERVICE_OWNERS` | service | >1 cbrain service label loaded |
| `SERVICE_EVIDENCE_INVALID` | service | launchctl print unreadable/malformed/missing fields |
| `PROCESS_NOT_RUNNING` | process | service PID absent or exited |
| `PROCESS_GENERATION_CHANGED` | process | PID/start identity changed between the two reads (after one bounded retry) |
| `EXECUTABLE_ROOT_MISMATCH` | process | plist program/workdir disagree with process cwd |
| `LISTENER_COUNT_INVALID` | listener | port listeners ≠ 1 |
| `LISTENER_OWNER_MISMATCH` | listener | listener PID ≠ service PID |
| `HTTP_UNAVAILABLE` | http | timeout / non-2xx |
| `HTTP_RESPONSE_INVALID` | http | non-JSON / missing version field |
| `ACTIVE_PACKAGE_INVALID` | version | package.json missing/unparseable/no version |
| `ACTIVE_MANIFEST_INVALID` | version | MANIFEST.json missing/unparseable/no packVersion |
| `ACTIVE_VERSION_MISMATCH` | version | http ≠ package ≠ manifest |
| `TARGET_SET_EMPTY` | target | no required targets configured |
| `TARGET_VERIFICATION_FAILED` | target | any target stale/missing/incompatible/unverified |
| `VERIFIER_ROOT_MISMATCH` | verifier | verifier code path not under active root |

## TDD Task Breakdown

### Task A — Pure core: service & process evidence (matrix 1-6)
- [ ] Write failing tests (fake deps): no service; multiple owners; multiple listeners; listener PID ≠ service PID; program/workdir/cwd disagree; PID absent; PID/start changes between two reads → bounded retry once then `PROCESS_GENERATION_CHANGED`.
- [ ] Implement `verifyLiveRelease` service+process phases: require exactly one owner → parse evidence → require PID running → cross-check listener (count==1, owner==service PID) → cross-check executable root (program+workdir vs process cwd) → two-read stability over `{label,pid,start,command-root,cwd,listener-owner}` with one bounded retry.
- [ ] GREEN.

### Task B — Version & target coherence (matrix 7-10)
- [ ] Write failing tests: HTTP timeout/non-2xx/non-JSON/missing-version; package/manifest missing/invalid/no-version; http≠pkg≠manifest; required target set empty; target stale/missing/incompatible/unverified; **inactive caller cwd + different rollback candidate version must NOT fail**.
- [ ] Implement http/package/manifest read + equality; required-targets enumeration (env `CBRAIN_REQUIRED_SKILL_TARGETS` colon list, default-probe `$HOME/.hermes/skills/brain-ops/cbrain`), each via `verifySkillTarget` → must be `current`. Caller cwd and explicit rollback candidate classified inactive, excluded from aggregate.
- [ ] GREEN.

### Task C — Privacy + read-only black-box (matrix 11-12)
- [ ] Write failing tests: pass/fail JSON+human output contains no `/Users/`, no credential-shaped string, no stack trace, no vault/skill body; black-box run leaves fixture tree byte-identical (hash before==after); source-grep assertion that `bin/live-release-verify.ts` + `bin/lib/live-release-*.ts` contain no write/mutate/spawn-mutating APIs.
- [ ] Implement output sanitizer (basename paths, hash PID birth, drop non-allowlisted fields) + black-box hash helper.
- [ ] GREEN.

### Task D — Real deps + CLI + self-root proof
- [ ] Implement `bin/lib/live-release-deps.ts` (launchctl print parse via `launchctl print gui/<uid>/<label>`; lsof; libproc `processStart` ported from bootstrap-hermes-structured-host-canary; HTTP fetch with timeout; skill-pack import).
- [ ] Implement `bin/live-release-verify.ts`: resolve own path via `import.meta.url`, build real deps, require `ownVerifierPath` is under active root else `VERIFIER_ROOT_MISMATCH`, emit output, exit `0` pass / `1` fail.
- [ ] Smoke: run from a non-active cwd → still resolves active root.

### Task E — Bootstrap + skill contract
- [ ] `skills/release-verify-bootstrap.sh`: pure `/bin/sh`, read service evidence via `launchctl print`, parse `working directory` (fallback: derive from Program), `exec bun "<root>/bin/live-release-verify.ts" "$@"`; on parse failure emit `{"schema_version":1,"status":"fail","code":"SERVICE_EVIDENCE_INVALID"}` and exit 1. No sourcing, no cwd reliance.
- [ ] Test: bootstrap spawned from an arbitrary cwd with a fake `launchctl` on PATH still locates the active root verifier (inject via PATH + a stub launchctl print fixture).
- [ ] `skills/release-verify.md`: contract text (use bootstrap, forbid cwd fallback, inactive=explanation, failure→"runtime version unverified", never fabricate mismatch).
- [ ] Update `skills/MANIFEST.json` inventory + `packVersion`.

### Task F — Review + gates + commit
- [ ] code-reviewer agent on the diff.
- [ ] `bun test tests/release/live-release-verify.test.ts`; `bun run check:docs`; `bash bin/check-resolver-pilot.sh`; `bun run lint`; `bun run check`; `git diff --check`; `git show --check HEAD`.
- [ ] Read-only live smoke (no service/skill/config mutation); anonymized summary only.
- [ ] Single commit. No push / PR / issue close.

## Reuse checklist
- launchctl/lsof/plutil parse patterns ← `bin/lib/hermes-canary-live-fingerprint.ts`, `scripts/ops/verify-cbrain-http-mcp-migration.sh`.
- libproc `processStart` birth identity ← `bin/bootstrap-hermes-structured-host-canary.ts`.
- skill-pack `verifySkillPack` / `compareTarget` / `resolveSkillsDir` ← direct import (cwd-independent via `import.meta.url`).
- Privacy output regex ← bootstrap canary `/(?:\/Users\/|\/home\/|[A-Za-z]:\\|Bearer\s+|api[_-]?key\s*[:=])/i`.

## Explicit non-goals (do not expand)
No global CLI install; no checkout/worktree deletion; no runtime config migration; no MCP tool / HTTP endpoint / DB table / daemon / registry; no service restart / live target mutation / rollback; no `status.sampledAt`, discovery-freshness, or duplicate-candidate calibration; no version bump / release / issue close; no cherry-pick of `1ea9688` (Hermes operational truth is a follow-up).

## Residual risks (to report)
- Real `launchctl print` field names are parsed from text output; if macOS changes the format, `SERVICE_EVIDENCE_INVALID` fires (fail-closed, acceptable).
- Required-target default probe assumes the standard Hermes skill path; env override exists for non-standard layouts.
- Bootstrap trusts launchctl text parsing; if launchctl itself is spoofed the threat is out of scope (local single-user host).
