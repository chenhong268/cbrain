import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentContractTools,
  checkAgentFacingRoutingProfile,
  checkAgentWorkflowContract,
  checkIngestPageTypeDocs,
  checkToolDescriptions,
  type CheckResult,
} from "../../bin/check-docs-consistency.js";
import { AGENT_ALLOWLIST } from "../../src/mcp/tool-profiles.js";

// Synthetic tool set: agent allowlist + a sample of excluded tools.
const TOOLS = new Set<string>([
  ...AGENT_ALLOWLIST,
  "query", "get_chunks", "expand_entity", "summarize", "brain_storm",
  "dossier", "agentic_research", "get_links", "deep_recall",
  "sync", "health",
]);

const dirs: string[] = [];
function withSkills(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-agent-contract-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
  }
});
function fails(r: CheckResult[]): boolean {
  return r.some((x) => !x.passed);
}

describe("checkAgentContractTools (#316)", () => {
  test("Check 2 backticked: 优先用 `deep_recall` fails", () => {
    const dir = withSkills({ "a.md": "- 优先用 `deep_recall` 查询\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 backticked: `deep_recall` 是默认查询工具 fails", () => {
    const dir = withSkills({ "a.md": "- `deep_recall` 是默认查询工具\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 BARE: 优先用 deep_recall (no backticks) fails", () => {
    const dir = withSkills({ "a.md": "- 优先用 deep_recall 查询\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 BARE: 默认查询工具 deep_recall fails", () => {
    const dir = withSkills({ "a.md": "- 默认查询工具 deep_recall\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 passes: deep_recall framed as advanced/fallback", () => {
    const dir = withSkills({ "a.md": "- deep_recall 是 advanced fallback，仅精细参数时直调\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("Check 2 passes: deep_recall framed as direct-call only escape hatch (bare)", () => {
    const dir = withSkills({ "a.md": "- deep_recall 是 direct-call only 的 escape hatch\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });

  test("Check 1 backticked: 首选 `query` fails", () => {
    const dir = withSkills({ "a.md": "- 首选 `query` 搜索\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 1 BARE: 首选 query fails", () => {
    const dir = withSkills({ "a.md": "- 首选 query 搜索\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 1 BARE: 默认 summarize fails", () => {
    const dir = withSkills({ "a.md": "- 默认 summarize 出总结\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 1 BARE: 优先 brain_storm fails", () => {
    const dir = withSkills({ "a.md": "- 优先 brain_storm 做推理\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });

  test("arrow cue: 自然语言 → query fails (excluded tool routed)", () => {
    const dir = withSkills({ "a.md": "- 自然语言 → query\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("arrow cue: 总结 → summarize fails", () => {
    const dir = withSkills({ "a.md": "- 总结 → summarize\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("arrow cue: 精确关键词 → query.md [keyword] passes (skill-file target)", () => {
    const dir = withSkills({ "a.md": "- 精确关键词/debug → query.md [keyword]\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("arrow cue: 自然语言 → query.md [cbrain_recall] passes", () => {
    const dir = withSkills({ "a.md": "- 自然语言 → query.md [cbrain_recall]\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });

  test("opt-out comment passes for an excluded first-choice tool", () => {
    const dir = withSkills({ "a.md": "- 优先用 query <!-- docs-consistency:ignore-agent-contract -->\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("Check 1 passes: excluded tool framed as advanced escape hatch", () => {
    const dir = withSkills({ "a.md": "- → advanced escape hatch：summarize（debug/internal profile 工具）\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("Check 1 passes: query as a parameter name is not the query tool", () => {
    const dir = withSkills({ "a.md": "- 默认 cbrain_recall({ query, detail: \"brief\" })\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("clean skills dir passes", () => {
    const dir = withSkills({ "a.md": "- 首选 cbrain_recall\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
});

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

describe("checkAgentWorkflowContract (#322)", () => {
  const valid = {
    "RESOLVER.md": "- 当前痛点、系统异常、该处理什么 → query.md [operations]\n",
    "ingest.md": "新内容使用 `ingest`。已有页面更新使用 `put_page`。禁止使用 `write_file` 绕过 CBrain。\n",
    "query.md": "## [operations] Branch\n调用 `next_actions`。\n普通 recall degraded 时最多一次 fallback，然后停止。\n",
    "brain-ops.md": "### Step 5: UPDATE\n已有页面更新使用 `put_page` 默认 patch。\n",
  };

  test("canonical create/update/operations/bounded contract passes", () => {
    expect(fails(checkAgentWorkflowContract(withSkills(valid)))).toBe(false);
  });

  test("positive write_file vault guidance fails", () => {
    const dir = withSkills({ ...valid, "ingest.md": "写 CBrain 失败时使用 `write_file` 写 vault。\n" });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("existing-page update routed to ingest fails", () => {
    const dir = withSkills({ ...valid, "brain-ops.md": "### Step 5: UPDATE\n已有页面更新使用 `ingest`。\n" });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("missing operational next_actions route fails", () => {
    const dir = withSkills({ ...valid, "query.md": "普通 recall degraded 时最多一次 fallback，然后停止。\n" });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("fallback without one-shot stop condition fails", () => {
    const dir = withSkills({ ...valid, "query.md": "## [operations] Branch\n调用 `next_actions`。\n失败后继续 fallback。\n" });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });
});

describe("checkToolDescriptions (#316)", () => {
  const T = (name: string, description: string) => ({ name, description });
  test("deep_recall described as 默认查询工具 fails", () => {
    expect(fails(checkToolDescriptions([T("deep_recall", "【默认查询工具】查找实体…")]))).toBe(true);
  });
  test("deep_recall described as advanced escape hatch passes", () => {
    expect(fails(checkToolDescriptions([T("deep_recall", "【高级 escape hatch】默认前门是 cbrain_recall，仅精细参数时直调…")]))).toBe(false);
  });
  test("query description: 自然语言问题请用 deep_recall (bare) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "底层搜索。自然语言问题请用 deep_recall。")]))).toBe(true);
  });
  test("query description: 自然语言问题请用 `deep_recall` (backtick) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "底层搜索。自然语言问题请用 `deep_recall`。")]))).toBe(true);
  });
  test("query description: 事实回忆 → deep_recall (arrow) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "❌ 不要用于自然语言问题。事实回忆 → deep_recall，全貌 → summarize。")]))).toBe(true);
  });
  test("query description: 全貌 → summarize (arrow to excluded) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "全貌 → summarize。")]))).toBe(true);
  });
  test("query description pointing NL to cbrain_recall passes", () => {
    expect(fails(checkToolDescriptions([T("query", "底层搜索。自然语言问题请用 cbrain_recall。")]))).toBe(false);
  });
  test("query description: arrow to an agent-allowlisted tool passes", () => {
    expect(fails(checkToolDescriptions([T("query", "组织架构 → get_org_tree。")]))).toBe(false);
  });
  test("maintenance pipeline description passes (dream: sync → enrich → health)", () => {
    // `→` in non-query tool descriptions describes a maintenance pipeline, not NL routing.
    expect(fails(checkToolDescriptions([T("dream", "夜间维护：sync → enrich → seal → health → report。")]))).toBe(false);
  });
});

describe("checkIngestPageTypeDocs (#318)", () => {
  test("fails when docs claim unsupported MCP ingest pageType values", () => {
    const docs = new Map<string, string>([[
      "docs/mcp-tools.md",
      '| pageType | "entity" | "concept" | "event" | "record" | "source" | 否 | 默认 record |',
    ]]);
    expect(fails(checkIngestPageTypeDocs(docs))).toBe(true);
  });

  test("passes when docs match the MCP ingest schema", () => {
    const docs = new Map<string, string>([[
      "docs/mcp-tools.md",
      '| pageType | "record" | "insight" | 否 | 默认 record；实体/概念由 NER 自动抽取 |',
    ]]);
    expect(fails(checkIngestPageTypeDocs(docs))).toBe(false);
  });

  test("ignores explanatory prose without quoted enum claims", () => {
    const docs = new Map<string, string>([[
      "docs/mcp-tools.md",
      "pageType 只控制记录类页面；实体和概念通过 NER / resolver 生成，不作为 MCP ingest pageType 传入。",
    ]]);
    expect(fails(checkIngestPageTypeDocs(docs))).toBe(false);
  });
});
