# Governed Daily Agent Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one governed unified Profile path to daily Agent sessions while limiting reads to open data, writes to explicit open batches, and keeping the tool surface at 20.

**Architecture:** Replace `append_page` with `profile` in the daily allowlist, then enforce action-level policy at the unified handler using a small pure policy module. Build Agent-visible get metadata only from returned open entries, retain full/debug compatibility, and protect the canonical signal skills with a docs-consistency gate plus real MCP protocol tests.

**Tech Stack:** TypeScript, Bun, Zod, MCP SDK, YAML ProfileManager, `bun:test`.

## Global Constraints

- Issue #335 only; parent #333 and dependent #336 remain separate.
- Daily `agent` tool count MUST stay `<= 20`.
- Daily get exposes only `scope: "open"`, including counts and module metadata.
- Daily update accepts only a non-empty whole-batch-valid set of `source: "explicit"`, `scope: "open"` entries.
- Existing hidden target IDs fail generically before all writes.
- Daily remove/reload fail closed; legacy aliases stay outside the daily surface.
- Full/debug unified Profile behavior and full-only aliases remain compatible.
- No Profile schema, database, ontology, vault, migration, structured-output, or Hermes-memory change.
- All public examples and diagnostics remain anonymous and privacy-safe.
- Every production change follows RED -> verify RED -> GREEN -> verify GREEN.

---

## File map

- Create `src/mcp/tools/profile-policy.ts`: pure daily Profile authorization and visible-stat helpers.
- Modify `src/mcp/tools/profile.ts`: dynamic Agent description/schema and action-level dispatch policy.
- Modify `src/mcp/tool-profiles.ts`: bounded `append_page` -> `profile` capability swap.
- Create `tests/mcp/profile-agent-policy.test.ts`: real in-memory MCP policy, privacy, atomicity, and schema tests.
- Modify `tests/mcp/tool-profiles.test.ts`: allowlist and compatibility assertions.
- Modify `tests/mcp/attach-tools.test.ts`: real discovery surface assertions.
- Modify `tests/http/mcp-per-session.test.ts`: HTTP Agent discovery/call smoke.
- Modify `bin/check-docs-consistency.ts`: signal-skill Profile contract drift gate.
- Modify `tests/bin/check-docs-consistency.agent-contract.test.ts`: drift-gate mutation tests.
- Modify `skills/signal-router.md` and `skills/signal-detector.md`: real unified Profile call contract.
- Modify `tests/mcp/project-state.test.ts`: remove stale comment only if the existing assertion wording becomes inaccurate; keep alias exclusion assertion.

---

### Task 1: Swap the bounded daily tool capability

**Files:**
- Modify: `tests/mcp/tool-profiles.test.ts`
- Modify: `tests/mcp/attach-tools.test.ts`
- Modify: `src/mcp/tool-profiles.ts`

**Interfaces:**
- Produces: `AGENT_ALLOWLIST` containing `profile` and not `append_page`, still length 20.
- Preserves: full inventory and debug `profile` exposure.

- [ ] **Step 1: Write failing allowlist tests**

Replace the obsolete #291 assertion and extend surface assertions:

```ts
test("agent exposes governed unified profile and not its aliases (#335)", () => {
  expect(isToolAllowedForProfile("profile", "agent")).toBe(true);
  for (const alias of ["get_profile", "update_profile", "remove_profile", "reload_profile"]) {
    expect(isToolAllowedForProfile(alias, "agent")).toBe(false);
  }
});

test("append_page moves to full-only when profile enters the bounded agent surface (#335)", () => {
  expect(isToolAllowedForProfile("append_page", "agent")).toBe(false);
  expect(isToolAllowedForProfile("append_page", "full")).toBe(true);
  expect(TOOL_PROFILE_ALLOWLISTS.agent).toHaveLength(20);
});
```

In `attach-tools.test.ts`, require `profile`, forbid `append_page` and all aliases.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/mcp/tool-profiles.test.ts tests/mcp/attach-tools.test.ts
```

Expected: FAIL because Agent excludes `profile` and includes `append_page`.

- [ ] **Step 3: Implement the one-for-one allowlist swap**

In `AGENT_ALLOWLIST`, replace only:

```ts
"append_page",
```

with:

```ts
"profile",
```

Update the surrounding comment to identify Profile as governed at the handler layer and `put_page` as the daily page-update path.

- [ ] **Step 4: Verify GREEN**

Run the same focused command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-profiles.ts tests/mcp/tool-profiles.test.ts tests/mcp/attach-tools.test.ts
git commit -m "feat(profile): expose governed daily profile tool"
```

---

### Task 2: Add pure daily Profile policy and whole-batch preflight

**Files:**
- Create: `src/mcp/tools/profile-policy.ts`
- Create: `tests/mcp/profile-agent-policy.test.ts`

**Interfaces:**
- Produces:
  - `type AgentProfilePolicyCode = "PROFILE_ACTION_FORBIDDEN" | "PROFILE_SCOPE_FORBIDDEN" | "PROFILE_UPDATE_INVALID"`
  - `validateAgentProfileUpdate(profile: ProfileManager, entries: ProfileUpdateInput[] | undefined): AgentProfilePolicyCode | null`
  - `buildAgentVisibleStats(entries: ProfileEntry[]): AgentVisibleProfileStats`
- Consumes: `ProfileManager.getEntry()` and `profileEntrySchema.safeParse()` only; no writes.

- [ ] **Step 1: Write RED tests for pure validation**

Create the test file with a temporary `ProfileManager` and synthetic entries. Cover:

```ts
const valid = {
  id: "response-length-short",
  type: "preference" as const,
  category: "communication" as const,
  scope: "open" as const,
  content: "回复保持简洁",
  source: "explicit" as const,
};

expect(validateAgentProfileUpdate(profile, [valid])).toBeNull();
expect(validateAgentProfileUpdate(profile, [])).toBe("PROFILE_UPDATE_INVALID");
expect(validateAgentProfileUpdate(profile, [{ ...valid, source: "observed" }])).toBe("PROFILE_UPDATE_INVALID");
expect(validateAgentProfileUpdate(profile, [{ ...valid, scope: "private" }])).toBe("PROFILE_UPDATE_INVALID");
expect(validateAgentProfileUpdate(profile, [valid, { ...valid }])).toBe("PROFILE_UPDATE_INVALID");
```

Seed scoped/private existing IDs in temporary YAML, then assert both direct collision and `[newValid, hiddenCollision]` return the generic code. Snapshot the file bytes and `getEntries()` before/after to prove the validator itself has zero side effects. Also cover empty/whitespace ID/content, invalid enum via runtime cast, and non-empty `agents`.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test tests/mcp/profile-agent-policy.test.ts
```

Expected: FAIL because `profile-policy.ts` does not exist.

- [ ] **Step 3: Implement pure policy helpers**

Create:

```ts
import type { ProfileManager } from "../../profile/manager.js";
import { profileEntrySchema, type ProfileEntry } from "../../profile/schema.js";

export type AgentProfilePolicyCode =
  | "PROFILE_ACTION_FORBIDDEN"
  | "PROFILE_SCOPE_FORBIDDEN"
  | "PROFILE_UPDATE_INVALID";

export interface ProfileUpdateInput {
  id: string;
  type: "preference" | "constraint" | "context" | "habit";
  category: "communication" | "work" | "health" | "finance" | "interests" | "general";
  scope: "open" | "scoped" | "private";
  agents?: string[];
  content: string;
  priority?: "high" | "normal";
  source?: "explicit" | "observed" | "inferred";
  tags?: string[];
}

export interface AgentVisibleProfileStats {
  total: number;
  byScope: Record<string, number>;
  byType: Record<string, number>;
  modules: number;
}

export function validateAgentProfileUpdate(
  profile: ProfileManager,
  entries: ProfileUpdateInput[] | undefined,
): AgentProfilePolicyCode | null {
  if (!entries || entries.length === 0) return "PROFILE_UPDATE_INVALID";
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.source !== "explicit" || entry.scope !== "open") return "PROFILE_UPDATE_INVALID";
    if (entry.agents && entry.agents.length > 0) return "PROFILE_UPDATE_INVALID";
    if (typeof entry.id !== "string" || !entry.id.trim()) return "PROFILE_UPDATE_INVALID";
    if (typeof entry.content !== "string" || !entry.content.trim()) return "PROFILE_UPDATE_INVALID";
    if (ids.has(entry.id)) return "PROFILE_UPDATE_INVALID";
    ids.add(entry.id);
    const parsed = profileEntrySchema.safeParse({ ...entry, updated_at: "1970-01-01" });
    if (!parsed.success) return "PROFILE_UPDATE_INVALID";
    const existing = profile.getEntry(entry.id);
    if (existing && existing.scope !== "open") return "PROFILE_UPDATE_INVALID";
  }
  return null;
}

export function buildAgentVisibleStats(entries: ProfileEntry[]): AgentVisibleProfileStats {
  const byScope: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const entry of entries) {
    byScope[entry.scope] = (byScope[entry.scope] ?? 0) + 1;
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }
  return { total: entries.length, byScope, byType, modules: 0 };
}
```

Keep the error generic: do not return an ID, parse issue, existing scope, or path.

- [ ] **Step 4: Verify GREEN and refactor only duplication**

Run the focused test. Expected: pass. If the interface duplicates the handler type, import `ProfileUpdateInput` from this module in Task 3 rather than maintain two definitions.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/profile-policy.ts tests/mcp/profile-agent-policy.test.ts
git commit -m "feat(profile): preflight daily profile updates"
```

---

### Task 3: Enforce action policy and privacy-safe get envelopes

**Files:**
- Modify: `tests/mcp/profile-agent-policy.test.ts`
- Modify: `src/mcp/tools/profile.ts`

**Interfaces:**
- Consumes: Task 2 policy helpers.
- Produces: Agent-only open get, explicit-open update, stable policy errors, hidden metadata suppression.

- [ ] **Step 1: Add RED real-handler tests**

Using a real Agent-profile `McpServer` + `InMemoryTransport` + `Client`, seed one open entry, one scoped entry, one private entry, and a named module. Assert:

```ts
const getResult = await client.callTool({ name: "profile", arguments: { action: "get" } });
const body = JSON.parse((getResult.content[0] as { text: string }).text);
expect(body.raw.entries.map((entry: { id: string }) => entry.id)).toEqual(["open-entry"]);
expect(body.raw.meta).toMatchObject({ total: 1, filtered: 1, loaded_modules: [], scope: "open" });
expect(JSON.stringify(body)).not.toContain("private-entry");
expect(JSON.stringify(body)).not.toContain("scoped-entry");
expect(JSON.stringify(body)).not.toContain("module-alpha");
```

Add policy error assertions for scoped/private get, observed/inferred update, empty batch, hidden-ID collision, mixed batch, remove, and reload. After every rejection, compare Profile YAML bytes and current entries to the baseline. Assert returned error JSON has only stable code/message and contains none of the synthetic content/path/hidden IDs.

- [ ] **Step 2: Verify RED**

Run the new test file. Expected: policy calls currently succeed or leak hidden metadata.

- [ ] **Step 3: Implement Agent dispatch policy**

In `profile.ts`:

```ts
const AGENT_MESSAGES: Record<AgentProfilePolicyCode, string> = {
  PROFILE_ACTION_FORBIDDEN: "Daily Agent sessions cannot remove or reload Profile entries.",
  PROFILE_SCOPE_FORBIDDEN: "Daily Agent sessions can read open Profile entries only.",
  PROFILE_UPDATE_INVALID: "Daily Agent updates require a valid batch of explicit, open Profile entries.",
};

function policyError(code: AgentProfilePolicyCode) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message: AGENT_MESSAGES[code] } }) }],
    isError: true,
  };
}
```

At the start of `runProfileAction`, branch only for `ctx.toolProfile === "agent"`:

- reject remove/reload;
- reject explicit scoped/private get;
- force open get and pass `buildAgentVisibleStats(entries)` plus `[]` modules;
- preflight the entire update before calling `updateProfile` once.

Keep the existing full/debug path byte-compatible.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test tests/mcp/profile-agent-policy.test.ts tests/mcp/server.test.ts tests/mcp/v193-ux-gate.test.ts
```

Expected: all pass, including existing full alias/envelope behavior.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/profile.ts tests/mcp/profile-agent-policy.test.ts
git commit -m "feat(profile): enforce daily action policy"
```

---

### Task 4: Make Agent tool self-description truthful

**Files:**
- Modify: `tests/mcp/profile-agent-policy.test.ts`
- Modify: `src/mcp/tools/profile.ts`

**Interfaces:**
- Produces: Agent-specific `profile` description and source schema with three enum values, no default.
- Preserves: full/debug source default `observed` and compatibility description.

- [ ] **Step 1: Add RED `tools/list` schema tests**

Inspect the real listed `profile` tool. Assert Agent description contains `open`, `explicit`, and `unavailable`, excludes the claim that aliases remain available, and its source property has:

```ts
expect(sourceSchema.enum).toEqual(["explicit", "observed", "inferred"]);
expect(sourceSchema.default).toBeUndefined();
expect(sourceSchema.description).toContain("explicit");
```

For full/debug, assert the existing default is still `observed`. Call the debug
tool with a synthetic observed/private entry and prove the existing unrestricted
behavior remains available. Verify observed/inferred Agent calls pass input
validation and return `PROFILE_UPDATE_INVALID`; verify missing source fails as
Invalid Params before the handler and creates no file.

- [ ] **Step 2: Verify RED**

Run the test file. Expected: current schema advertises observed default and aliases.

- [ ] **Step 3: Implement dynamic registration config**

Inside `registerProfileTools`, set `const isAgent = ctx.toolProfile === "agent"` and choose:

```ts
const sourceSchema = isAgent
  ? z.enum(["explicit", "observed", "inferred"])
      .describe("Daily Agent sessions allow explicit only; observed/inferred fail closed")
  : z.enum(["explicit", "observed", "inferred"])
      .default("observed")
      .describe("How this was learned");
```

Use Agent-aware tool/action/scope descriptions while retaining all action/scope enum values for deterministic denial. Do not change alias registrations.

- [ ] **Step 4: Verify GREEN**

Run the focused policy, server, and attach-tools suites. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/profile.ts tests/mcp/profile-agent-policy.test.ts
git commit -m "fix(profile): align daily tool schema with policy"
```

---

### Task 5: Prove the governed path over HTTP

**Files:**
- Modify: `tests/http/mcp-per-session.test.ts`

**Interfaces:**
- Consumes: Agent HTTP session selection and Tasks 1-4 handler behavior.
- Produces: real HTTP discovery/update/denial regression smoke.

- [ ] **Step 1: Add a RED/behavioral HTTP test**

Add a helper that opens an Agent session, lists tools, calls `profile` with one anonymous explicit open preference, reads it back, and attempts `reload`. Assert:

- exactly bounded discovery includes `profile`, excludes `append_page` and aliases;
- update/get have `isError !== true`;
- reload has `isError === true` and `PROFILE_ACTION_FORBIDDEN`;
- no returned blob contains the temporary root path.

Also add an observed update denial and verify the explicit entry remains unchanged.

- [ ] **Step 2: Run the HTTP test**

```bash
bun test tests/http/mcp-per-session.test.ts
```

If the test passes immediately for discovery only, keep the handler calls that fail against pre-policy behavior as the RED evidence. Expected final state: all pass.

- [ ] **Step 3: Isolate the HTTP Profile store in the existing test harness**

Set `profileDir: join(TEST_DIR, "profile")` in `makeDeps()` and create that
directory in `beforeEach`. Do not change HTTP runtime code unless the RED test
reproduces a real shared-context bug.

- [ ] **Step 4: Verify GREEN and commit**

```bash
bun test tests/http/mcp-per-session.test.ts tests/mcp/attach-tools.test.ts
git add tests/http/mcp-per-session.test.ts
git commit -m "test(profile): verify governed HTTP agent path"
```

---

### Task 6: Add the canonical signal-skill drift gate

**Files:**
- Modify: `tests/bin/check-docs-consistency.agent-contract.test.ts`
- Modify: `bin/check-docs-consistency.ts`

**Interfaces:**
- Produces: `checkAgentProfileSkillContract(skillsDir: string): CheckResult[]` wired into `check:docs`.

- [ ] **Step 1: Write RED mutation tests**

Create valid synthetic `signal-router.md` and `signal-detector.md` fixtures containing the unified update contract. Then mutate one dimension per test:

- missing either file;
- any one of four aliases;
- missing `profile(`, `action: "update"`, `entries`, `scope: "open"`, or `source: "explicit"` from either file;
- positive `action: "remove"` / `action: "reload"`;
- positive `source: "observed"` / `source: "inferred"`.

Assert failures mention only file names and stable contract tokens, not fixture body text.

- [ ] **Step 2: Verify RED**

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts
```

Expected: FAIL because the checker export does not exist.

- [ ] **Step 3: Implement the deterministic checker**

Read only the two named skill files. For each, reject aliases and require the unified call tokens. Use bounded lexical regexes and stable diagnostics. Do not scan specs/plans or echo matching lines. Wire the result into the main check array beside other Agent contract checks.

- [ ] **Step 4: Verify GREEN**

Run the focused test. Existing agent-contract tests must remain green.

- [ ] **Step 5: Commit**

```bash
git add bin/check-docs-consistency.ts tests/bin/check-docs-consistency.agent-contract.test.ts
git commit -m "test(agent): gate profile skill contract"
```

---

### Task 7: Align canonical signal skills with the real schema

**Files:**
- Modify: `skills/signal-router.md`
- Modify: `skills/signal-detector.md`

**Interfaces:**
- Consumes: Task 6 checker.
- Produces: explicit-only unified Profile guidance for daily Agents.

- [ ] **Step 1: Run docs gate and verify RED against current skills**

```bash
bun run check:docs
```

Expected: FAIL for legacy aliases/missing unified contract.

- [ ] **Step 2: Replace legacy guidance**

In both files, use this complete anonymous shape (compact inline form is allowed in the detector):

```text
profile({ action: "update", entries: [{
  id: "response-length-short",
  type: "preference",
  category: "communication",
  scope: "open",
  content: "回复保持简洁",
  source: "explicit"
}] })
```

State that persistence happens only for explicit user statements. Remove all four alias calls and any reload instruction. Do not teach observed/inferred daily writes.

- [ ] **Step 3: Verify GREEN**

```bash
bun run check:docs
bash bin/check-resolver-pilot.sh
```

Expected: docs consistency passes; resolver pilot has zero FAIL (existing WARN are reported, not relabeled as failures).

- [ ] **Step 4: Commit**

```bash
git add skills/signal-router.md skills/signal-detector.md
git commit -m "docs(agent): route explicit preferences through profile"
```

---

### Task 8: Cross-layer regression and stale assertion cleanup

**Files:**
- Modify: `tests/mcp/project-state.test.ts`
- Modify: `tests/mcp/agent-facing-profile-handshake.test.ts`

**Interfaces:**
- Produces: no stale claim that Profile is absent; real daily handshake still satisfies all Agent-facing routes.

- [ ] **Step 1: Search every affected contract**

```bash
rg -n "profile.*excluded|excludes.*profile|append_page|update_profile|reload_profile" \
  src tests skills docs README.md --glob '!docs/superpowers/**'
```

Classify inventory/history references separately from active daily guidance. Do not remove full-profile alias documentation.

- [ ] **Step 2: Add or update only executable assertions**

Update stale test names/comments. Keep `update_profile` alias exclusion locked, while adding unified `profile` inclusion where the test describes the daily surface. If the real handshake test does not yet assert it, add:

```ts
expect(names.has("profile")).toBe(true);
expect(names.has("append_page")).toBe(false);
```

- [ ] **Step 3: Run cross-layer focused suites**

```bash
bun test \
  tests/mcp/tool-profiles.test.ts \
  tests/mcp/attach-tools.test.ts \
  tests/mcp/profile-agent-policy.test.ts \
  tests/mcp/agent-facing-profile-handshake.test.ts \
  tests/mcp/project-state.test.ts \
  tests/mcp/server.test.ts \
  tests/http/mcp-per-session.test.ts \
  tests/bin/check-docs-consistency.agent-contract.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit the cross-layer assertions**

```bash
git add tests/mcp/project-state.test.ts tests/mcp/agent-facing-profile-handshake.test.ts
git commit -m "test(agent): lock governed profile handshake"
```

---

### Task 9: Verification, adversarial review, and release evidence

**Files:**
- No planned production edits; fixes require a new RED regression test first.

**Interfaces:**
- Produces: merge-ready #335 branch with fresh evidence.

- [ ] **Step 1: Run static and privacy audits**

```bash
git diff main...HEAD --check
rg -n "/Users/|@[^ ]+\.[A-Za-z]{2,}|(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)|api[_-]?key|secret" \
  docs/superpowers/specs/2026-07-15-governed-agent-profile-design.md \
  docs/superpowers/plans/2026-07-15-governed-agent-profile.md \
  src/mcp/tools/profile-policy.ts src/mcp/tools/profile.ts \
  tests/mcp/profile-agent-policy.test.ts skills/signal-router.md skills/signal-detector.md
```

Expected: no user/private sentinel. Synthetic `/tmp` assertions may appear only in tests and must not be emitted by runtime errors.

- [ ] **Step 2: Run focused, docs, resolver, lint, and full gates**

```bash
bun test tests/mcp/profile-agent-policy.test.ts tests/mcp/tool-profiles.test.ts tests/mcp/attach-tools.test.ts tests/http/mcp-per-session.test.ts tests/mcp/agent-facing-profile-handshake.test.ts tests/mcp/server.test.ts tests/bin/check-docs-consistency.agent-contract.test.ts
bun run check:docs
bash bin/check-resolver-pilot.sh
bun run lint
bun run check
git diff main...HEAD --check
```

Record exact pass/fail counts and WARN separately.

- [ ] **Step 3: Dispatch three independent adversarial reviewers**

Reviewer A attacks hidden-ID collisions, mixed-batch atomicity, in-memory/file side effects, and module writeback.

Reviewer B attacks MCP schema/handler bypasses, tool description drift, HTTP/in-memory differences, full/debug compatibility, and alias exposure.

Reviewer C attacks privacy leakage through entries, meta counts, display/summary, errors, docs, diagnostics, and public examples.

They must review read-only and return concrete `file:line` findings. Fix every Critical/Important with a RED regression and rerun focused gates. Repeat until all three approve.

- [ ] **Step 4: Final commit hygiene**

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff main...HEAD --check
```

Expected: only #335 scope; no user-owned main worktree files; clean feature worktree.
