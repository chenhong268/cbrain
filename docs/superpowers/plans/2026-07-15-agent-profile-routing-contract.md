# Agent Profile Routing Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every executable Agent-facing routing fixture callable through the real daily MCP profile, while representing full-profile-only discovery execution honestly.

**Architecture:** Keep the daily tool allowlist and TypeScript front-door router unchanged. Add a deterministic fixture-to-profile checker, prove the actual registration surface over MCP protocol, then align canonical skill prose and routing fixtures to the existing `cbrain_recall` internal routes.

**Tech Stack:** TypeScript, Bun test, MCP SDK `InMemoryTransport`, JSONL skill fixtures, shell resolver gate.

## Global Constraints

- `query`, `summarize`, and `run_discovery` remain absent from `AGENT_ALLOWLIST`.
- `run_discovery` is available only through `full`, not `maintenance`.
- No MCP handler, TypeScript front-door router, ranking, database, or output-envelope change.
- Structured calls omit raw/routing data unless `include_raw: true`; #343 never opts in.
- No real names, organizations, paths, credentials, or vault bodies in fixtures or diagnostics.
- The unrelated resolver-pilot numeric privacy false positive is recorded but not fixed here.

---

### Task 1: Add the fixture-to-agent-profile consistency gate

**Files:**
- Modify: `tests/bin/check-docs-consistency.agent-contract.test.ts`
- Modify: `bin/check-docs-consistency.ts`

**Interfaces:**
- Consumes: `AGENT_ALLOWLIST`, `skills/agent-facing.routing-eval.jsonl`.
- Produces: `checkAgentFacingRoutingProfile(skillsDir, agentAllowlist?) -> CheckResult[]`.
- Executable rows require an allowlisted `expected_tool` and allowlisted `required_sequence` entries.
- No-tool rows require the exact `requires_full_profile` contract.

- [ ] **Step 1: Write failing checker tests**

Add `checkAgentFacingRoutingProfile` to the test import and add a helper that writes
`agent-facing.routing-eval.jsonl` under an isolated temporary skills directory.
Add these cases:

```ts
describe("checkAgentFacingRoutingProfile (#343)", () => {
  const row = (patch: Record<string, unknown> = {}) => JSON.stringify({
    input: "匿名输入Sentinel",
    category: "search",
    expected_tool: "cbrain_recall",
    expected_args: {},
    forbidden_tools: [],
    forbidden_output_terms: [],
    ...patch,
  });

  test("accepts allowlisted expected_tool and required_sequence", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({
        expected_tool: "graph_query",
        required_sequence: ["resolve_slugs", "graph_query"],
      })}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(false);
  });

  test("rejects an unavailable Agent-facing expected_tool without echoing input", () => {
    const dir = withSkills({ "agent-facing.routing-eval.jsonl": `${row({ expected_tool: "query" })}\n` });
    const results = checkAgentFacingRoutingProfile(dir);
    expect(fails(results)).toBe(true);
    expect(results.some((x) => x.detail.includes("query"))).toBe(true);
    expect(JSON.stringify(results)).not.toContain("匿名输入Sentinel");
  });

  test("rejects invalid JSON and unavailable required_sequence members", () => {
    const invalid = withSkills({ "agent-facing.routing-eval.jsonl": "{bad json\n" });
    expect(fails(checkAgentFacingRoutingProfile(invalid))).toBe(true);
    const sequence = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({ required_sequence: ["cbrain_recall", "query"] })}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(sequence))).toBe(true);
  });

  test("accepts only the exact full-profile no-tool outcome", () => {
    const valid = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({
        expected_tool: null,
        expected_outcome: "requires_full_profile",
        required_profile: "full",
        forbidden_tools: ["run_discovery", "read_discoveries"],
      })}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(valid))).toBe(false);

    for (const patch of [
      { expected_tool: null },
      { expected_tool: null, expected_outcome: "requires_full_profile", required_profile: "maintenance" },
      { expected_tool: null, expected_outcome: "requires_full_profile", required_profile: "full", forbidden_tools: ["run_discovery"] },
    ]) {
      const dir = withSkills({ "agent-facing.routing-eval.jsonl": `${row(patch)}\n` });
      expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the checker tests and verify RED**

Run:

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts
```

Expected: compile/test failure because `checkAgentFacingRoutingProfile` is not exported.

- [ ] **Step 3: Implement the minimal checker**

Add the exported function near the existing Agent contract checks:

```ts
export function checkAgentFacingRoutingProfile(
  skillsDir: string,
  agentAllowlist: readonly string[] = AGENT_ALLOWLIST,
): CheckResult[] {
  const file = join(skillsDir, "agent-facing.routing-eval.jsonl");
  if (!existsSync(file)) {
    return [{ check: "agent-facing profile", passed: false, detail: "agent-facing routing fixture missing" }];
  }
  const allowed = new Set(agentAllowlist);
  const failures: CheckResult[] = [];
  const lines = readFileSync(file, "utf-8").split("\n");

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      failures.push({ check: `agent-facing profile line ${index + 1}`, passed: false, detail: "invalid JSON" });
      return;
    }

    if (row.expected_tool === null) {
      const forbidden = Array.isArray(row.forbidden_tools) ? row.forbidden_tools : [];
      const validBoundary =
        row.expected_outcome === "requires_full_profile" &&
        row.required_profile === "full" &&
        forbidden.includes("run_discovery") &&
        forbidden.includes("read_discoveries");
      if (!validBoundary) failures.push({
        check: `agent-facing profile line ${index + 1}`,
        passed: false,
        detail: "invalid requires_full_profile contract",
      });
      return;
    }

    if (typeof row.expected_tool !== "string" || !row.expected_tool.trim()) {
      failures.push({ check: `agent-facing profile line ${index + 1}`, passed: false, detail: "expected_tool must be non-empty or explicit no-tool boundary" });
      return;
    }
    if (!allowed.has(row.expected_tool)) failures.push({
      check: `agent-facing profile line ${index + 1}`,
      passed: false,
      detail: `expected_tool unavailable in agent profile: ${row.expected_tool}`,
    });

    if (row.required_sequence !== undefined && !Array.isArray(row.required_sequence)) {
      failures.push({ check: `agent-facing profile line ${index + 1}`, passed: false, detail: "required_sequence must be an array" });
      return;
    }
    for (const tool of (row.required_sequence ?? []) as unknown[]) {
      if (typeof tool !== "string" || !allowed.has(tool)) failures.push({
        check: `agent-facing profile line ${index + 1}`,
        passed: false,
        detail: `required_sequence tool unavailable in agent profile: ${String(tool)}`,
      });
    }
  });

  return failures.length > 0 ? failures : [{
    check: "agent-facing profile",
    passed: true,
    detail: "all executable routes are discoverable; no-tool boundaries are explicit",
  }];
}
```

Wire it into `main()` immediately after `checkAgentContractTools`:

```ts
...checkAgentFacingRoutingProfile(join(PROJECT_DIR, "skills")),
```

- [ ] **Step 4: Verify unit GREEN and canonical fixture RED**

Run:

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts
bun run check:docs
```

Expected: unit tests pass; `check:docs` fails and names `query`, `summarize`, and
`run_discovery` line numbers without printing fixture input.

- [ ] **Step 5: Commit the checker**

```bash
git add bin/check-docs-consistency.ts tests/bin/check-docs-consistency.agent-contract.test.ts
git commit -m "test(agent): gate routing against daily profile"
```

---

### Task 2: Add a real MCP discovery and execution smoke

**Files:**
- Create: `tests/mcp/agent-facing-profile-handshake.test.ts`

**Interfaces:**
- Consumes: `createServer`, `CBrainDeps`, `OUTPUT_MODE_ENV`, MCP `Client`, `InMemoryTransport`, and the canonical Agent-facing JSONL.
- Produces: protocol-level proof that fixture tools are discoverable and `cbrain_recall` executes debug/overview routes with structured output.

- [ ] **Step 1: Create the anonymous protocol test harness**

Reuse the deterministic embedding/Lance stubs and `wireTransport` shape from
`tests/mcp/output-trust-boundary-transport.test.ts`. Create a temporary DB/vault,
construct deps with `toolProfile: "agent"`, and set `CBRAIN_OUTPUT_BOUNDARY=structured`
only inside the serial test scope.

Parse the fixture with:

```ts
type AgentFacingRow = {
  input: string;
  category: string;
  expected_tool: string | null;
  expected_args: Record<string, unknown>;
  expected_outcome?: string;
  required_profile?: string;
};

function readRows(): AgentFacingRow[] {
  return readFileSync(join(PROJECT_ROOT, "skills/agent-facing.routing-eval.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentFacingRow);
}
```

- [ ] **Step 2: Add the discovery assertions**

```ts
test("real agent tools/list satisfies every executable Agent-facing route", async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  const rows = readRows();

  for (const row of rows) {
    if (row.expected_tool !== null) expect(names.has(row.expected_tool), row.category).toBe(true);
  }
  for (const excluded of ["query", "summarize", "run_discovery"]) expect(names.has(excluded)).toBe(false);
  for (const required of ["cbrain_recall", "next_actions", "read_discoveries"]) expect(names.has(required)).toBe(true);

  const boundary = rows.find((row) => row.expected_outcome === "requires_full_profile");
  expect(boundary?.expected_tool).toBeNull();
  expect(boundary?.required_profile).toBe("full");
});
```

- [ ] **Step 3: Add real debug and overview calls**

Call `cbrain_recall` with the exact anonymous fixture inputs for `keyword_debug`
and `overview`. Assert no MCP error and no default structured leakage:

```ts
for (const category of ["keyword_debug", "overview"] as const) {
  const row = rows.find((candidate) => candidate.category === category)!;
  const result = await client.callTool({
    name: "cbrain_recall",
    arguments: { query: row.input, ...row.expected_args },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const blob = JSON.stringify(result);
  for (const forbidden of ["\"raw\"", "routing", "next_tool", "search_meta", "strategy_path"]) {
    expect(blob).not.toContain(forbidden);
  }
}
```

- [ ] **Step 4: Run the test and verify RED against the old fixture**

Run:

```bash
bun test tests/mcp/agent-facing-profile-handshake.test.ts
```

Expected: FAIL because old rows expect `query`, `summarize`, and `run_discovery`,
which the real Agent discovery does not return.

Do not commit the red test alone; Task 3 makes the canonical contract green.

---

### Task 3: Align canonical fixtures, resolver gate, and skill policy

**Files:**
- Modify: `skills/agent-facing.routing-eval.jsonl`
- Modify: `skills/hermes-cbrain-brief.md`
- Modify: `skills/RESOLVER.md`
- Modify: `skills/recall-resolver.md`
- Modify: `skills/query.md`
- Modify: `bin/check-resolver-pilot.sh`
- Test: `tests/mcp/agent-facing-profile-handshake.test.ts`

**Interfaces:**
- Executable Agent-facing `expected_tool` values become the five daily tools used by this fixture: `cbrain_recall`, `recall_episode`, `read_discoveries`, `graph_query`, `next_actions`.
- Discovery execution becomes an explicit no-tool/full-profile boundary.

- [ ] **Step 1: Update the four drifting fixture contracts**

Use these exact semantic replacements:

```json
{"input":"帮我跑一次发现检测","category":"profile_boundary","expected_tool":null,"expected_outcome":"requires_full_profile","required_profile":"full","expected_args":{},"forbidden_tools":["run_discovery","read_discoveries"],"forbidden_output_terms":["score","distance","shared_neighbors","debug","_debug","candidate","filter","图距离","共享邻居","跳","桥接","候选","过滤","hops"],"rationale":"daily agent 不执行发现检测；明确要求 full profile，不用读取旧结果冒充执行"}
{"input":"总结类请求却绕过cbrain_recall直调底层工具","category":"anti_pattern","expected_tool":"cbrain_recall","expected_args":{"detail":"normal"},"forbidden_tools":["query","summarize"],"forbidden_output_terms":[],"rationale":"总结/概览统一走 cbrain_recall 内部 overview"}
{"input":"帮我总结一下项目E的全貌","category":"overview","expected_tool":"cbrain_recall","expected_args":{"detail":"normal"},"forbidden_tools":["query","summarize"],"forbidden_output_terms":[],"rationale":"总结+全貌 → cbrain_recall 内部 overview"}
{"input":"确认关键词'主题A'被索引到哪些页面","category":"keyword_debug","expected_tool":"cbrain_recall","expected_args":{"detail":"brief"},"forbidden_tools":["query"],"forbidden_output_terms":["raw","routing","next_tool"],"rationale":"显式关键词 debug → cbrain_recall 内部 debug_search；daily profile 不直调 query"}
```

- [ ] **Step 2: Update resolver-pilot structural assertions**

In section 5:

```bash
af_tools=("cbrain_recall" "recall_episode" "read_discoveries" "graph_query" "next_actions")
```

Change the message from eight to five executable expected tools. Add a Python
assertion that exactly one `profile_boundary` row has `expected_tool is None`,
`expected_outcome == "requires_full_profile"`, `required_profile == "full"`,
and both forbidden substitute tools.

In section 5c remove the `keyword_debug` exception: any Agent-facing
`expected_tool == "query"` is now a failure. Keep the lower-level
`recall.routing-eval.jsonl` keyword/debug exception unchanged.

- [ ] **Step 3: Align daily skill prose**

Apply these rules consistently:

```md
- 精确关键词/debug → `cbrain_recall`（内部 `debug_search`）；只有显式选择 debug/full profile 的诊断会话才直调 `query`。
- 总结/全貌 → `cbrain_recall`（内部 overview）；`summarize` 仅 debug/full advanced escape hatch。
- daily Agent 只用 `read_discoveries` 读取已有发现。用户明确要求“运行检测”时，说明需要 full profile；当前会话不调用 `run_discovery`，也不以 `read_discoveries` 冒充新运行。
```

Required locations:

- `hermes-cbrain-brief.md`: replace direct keyword/query and run-discovery guidance.
- `query.md`: `[keyword]` branch calls `cbrain_recall`; operations/discovery branch documents the full-profile boundary.
- `recall-resolver.md`: daily decision tree uses internal debug route; direct `query` remains explicitly debug/full only.
- `RESOLVER.md`: keep `query.md [keyword]` as a skill-file route, but state its daily MCP call is `cbrain_recall`; mark `run_discovery` full-only.

- [ ] **Step 4: Verify the gate and transport tests turn GREEN**

Run:

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts tests/mcp/agent-facing-profile-handshake.test.ts tests/mcp/tool-profiles.test.ts tests/mcp/frontdoor.test.ts
bun run check:docs
```

Expected: all pass; docs gate reports the Agent-facing profile contract green.

Run:

```bash
bash bin/check-resolver-pilot.sh
```

Expected #343 sections 5/5b/5c: green. The command may still exit 1 only for the
documented pre-existing numeric privacy false positive introduced by #342; no
new #343 failure is acceptable.

- [ ] **Step 5: Commit the aligned contract**

```bash
git add skills/agent-facing.routing-eval.jsonl skills/hermes-cbrain-brief.md skills/RESOLVER.md skills/recall-resolver.md skills/query.md bin/check-resolver-pilot.sh tests/mcp/agent-facing-profile-handshake.test.ts
git commit -m "fix(agent): align routing with daily tool discovery"
```

---

### Task 4: Adversarial verification and release gate

**Files:**
- Review all changes from `origin/main..HEAD`.

**Interfaces:**
- Produces merge-ready evidence, not new product behavior.

- [ ] **Step 1: Run focused verification**

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts \
  tests/mcp/agent-facing-profile-handshake.test.ts \
  tests/mcp/tool-profiles.test.ts \
  tests/mcp/attach-tools.test.ts \
  tests/core/frontdoor-router.test.ts \
  tests/mcp/frontdoor.test.ts \
  tests/mcp/recall-query-output-boundary.test.ts
bun run check:docs
bun run lint
```

- [ ] **Step 2: Dispatch adversarial reviewers**

Use independent reviewers for:

1. contract/spec coverage and honest no-tool handling;
2. code/mutation review of malformed JSON, null-shape, unavailable sequence,
   allowlist drift, and protocol discovery;
3. privacy/output-boundary review, including fixture diagnostics not echoing
   user input.

Fix every Critical/High/Medium finding and re-dispatch until pass.

- [ ] **Step 3: Run full verification**

```bash
bun run check
git diff --check origin/main..HEAD
git status --short
```

Privacy scan the issue diff for real names, absolute user paths, credentials,
emails, vault content, and stack traces. Functional public repository URLs are
allowed.

- [ ] **Step 4: Publish and close #343**

```bash
git push -u origin codex/fix-343-agent-contract
gh pr create --base main --head codex/fix-343-agent-contract \
  --title "fix: align Agent routing with tool discovery" \
  --body-file <prepared-body>
```

The PR body must include `Closes #343`, the no-permission-expansion decision,
focused/full evidence, adversarial results, and the unrelated resolver-pilot
baseline false positive. Wait for PR CI, merge only when green, verify #343 is
closed and main CI passes, then remove the remote/local feature branch and
worktree without touching user-owned untracked plans in the main checkout.

## Self-review

- Spec coverage: executable route invariant, explicit full-profile boundary,
  real discovery/call smoke, output boundary, and privacy are each mapped to a
  task.
- Placeholder scan: no TODO/TBD/"similar to" placeholders remain.
- Type consistency: `expected_tool` is `string | null`; the checker and MCP test
  use the same no-tool fields and exact outcome strings.
- Scope: no allowlist, router, handler, database, or ranking modification is
  planned.
