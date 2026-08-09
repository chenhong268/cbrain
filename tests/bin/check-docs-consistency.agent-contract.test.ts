import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentContractTools,
  checkAgentFacingRoutingProfile,
  checkAgentProfileSkillContract,
  checkNoNewAgentAliasReferences,
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

describe("checkAgentProfileSkillContract (#335)", () => {
  const skillFiles = ["signal-router.md", "signal-detector.md"] as const;
  const validSkill = [
    "# Synthetic profile signal contract",
    "Use only the unified daily call:",
    "`profile({ action: \"update\", entries: [{ scope: \"open\", source: \"explicit\" }] })`",
    "Do not use action: \"remove\", action: \"reload\", source: \"observed\", or source: \"inferred\".",
    "fixture-body-sentinel",
  ].join("\n");
  const valid = () => Object.fromEntries(skillFiles.map((file) => [file, validSkill]));
  const checkName = (file: string) => `agent profile skill contract @skills/${file}`;

  test("accepts the unified explicit open update contract in both canonical skills", () => {
    expect(checkAgentProfileSkillContract(withSkills(valid()))).toEqual([{
      check: "agent profile skill contract",
      passed: true,
      detail: "signal-router.md and signal-detector.md use the unified explicit open update contract",
    }]);
  });

  test("reads only the two canonical signal skills", () => {
    const dir = withSkills({
      ...valid(),
      "decoy.md": "update_profile profile({ action: \"remove\", source: \"observed\" }) decoy-body-sentinel",
    });
    expect(fails(checkAgentProfileSkillContract(dir))).toBe(false);
  });

  for (const file of skillFiles) {
    test(`rejects missing ${file}`, () => {
      const files = valid();
      delete files[file];
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: `missing skill file: ${file}`,
      }]);
    });
  }

  for (const file of skillFiles) {
    for (const alias of ["get_profile", "update_profile", "remove_profile", "reload_profile"]) {
      test(`rejects ${alias} in ${file} without echoing body text`, () => {
        const files = valid();
        files[file] += `\nUse ${alias} fixture-body-alias-sentinel`;
        expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
          check: checkName(file),
          passed: false,
          detail: `forbidden alias: ${alias}`,
        }]);
      });
    }
  }

  const requiredTokens = [
    ["profile(", "profile_call("],
    ["action: \"update\"", "action: \"write\""],
    ["entries", "records"],
    ["scope: \"open\"", "scope: \"scoped\""],
    ["source: \"explicit\"", "source: \"manual\""],
  ] as const;
  for (const file of skillFiles) {
    for (const [token, replacement] of requiredTokens) {
      test(`rejects ${file} missing ${token}`, () => {
        const files = valid();
        files[file] = files[file].replace(token, replacement);
        expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
          check: checkName(file),
          passed: false,
          detail: token === 'scope: "open"'
            ? 'forbidden daily token: scope: "scoped"'
            : `missing required token: ${token}`,
        }]);
      });
    }
  }

  for (const file of skillFiles) {
    for (const token of [
      'action: "remove"',
      'action: "reload"',
      'source: "observed"',
      'source: "inferred"',
    ]) {
      test(`rejects positive ${token} in ${file}`, () => {
        const files = valid();
        files[file] += `\nCall profile({ ${token} }) fixture-body-forbidden-sentinel`;
        expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
          check: checkName(file),
          passed: false,
          detail: `forbidden daily token: ${token}`,
        }]);
      });
    }
  }

  for (const file of skillFiles) {
    test(`rejects a positive remove call after an unrelated negative sentence in ${file}`, () => {
      const files = valid();
      files[file] += '\nDo not use aliases. Call profile({ action: "remove" }) fixture-body-scope-sentinel';
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: 'forbidden daily token: action: "remove"',
      }]);
    });

    test(`rejects the second positive remove call after a negated occurrence in ${file}`, () => {
      const files = valid();
      files[file] += '\nDo not use action: "remove"; instead call profile({ action: "remove" }) fixture-body-repeat-sentinel';
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: 'forbidden daily token: action: "remove"',
      }]);
    });

    test(`rejects a required canonical call when its only occurrence is negated in ${file}`, () => {
      const files = valid();
      files[file] = [
        "# Synthetic profile signal contract",
        '`Never call profile({ action: "update", entries: [{ scope: "open", source: "explicit" }] })`',
        "fixture-body-negated-call-sentinel",
      ].join("\n");
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: "missing required token: profile(",
      }]);
    });

    test(`rejects a private update after a safe canonical decoy in ${file}`, () => {
      const files = valid();
      files[file] += '\nprofile({ action: "update", entries: [{ scope: "private", source: "explicit" }] })';
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: 'forbidden daily token: scope: "private"',
      }]);
    });

    test(`rejects a scoped update after a safe canonical decoy in ${file}`, () => {
      const files = valid();
      files[file] += '\nprofile({ action: "update", entries: [{ scope: "scoped", source: "explicit" }] })';
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: 'forbidden daily token: scope: "scoped"',
      }]);
    });

    test(`rejects mixed open and private entries inside one call in ${file}`, () => {
      const files = valid();
      files[file] += '\nprofile({ action: "update", entries: [{ scope: "open", source: "explicit" }, { scope: "private", source: "explicit" }] })';
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: 'forbidden daily token: scope: "private"',
      }]);
    });

    for (const reminder of ["不要忘记", "别忘记", "do not forget to", "don't forget to", "never forget to"]) {
      test(`treats ${reminder} remove as a positive reminder in ${file}`, () => {
        const files = valid();
        files[file] += `\n${reminder} call profile({ action: "remove" })`;
        expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
          check: checkName(file),
          passed: false,
          detail: 'forbidden daily token: action: "remove"',
        }]);
      });
    }

    for (const reminder of ["Do not ever forget to call", "千万不要忘了调用"]) {
      test(`treats reminder variant ${reminder} as positive in ${file}`, () => {
        const files = valid();
        files[file] += `\n${reminder} profile({ action: "remove" })`;
        expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
          check: checkName(file),
          passed: false,
          detail: 'forbidden daily token: action: "remove"',
        }]);
      });
    }

    test(`rejects an over-limit unclosed call after a safe canonical decoy in ${file}`, () => {
      const files = valid();
      files[file] += `\nprofile({ action: "update", entries: [{ content: "${"x".repeat(900)}`;
      expect(checkAgentProfileSkillContract(withSkills(files))).toEqual([{
        check: checkName(file),
        passed: false,
        detail: "malformed profile call",
      }]);
    });

    test(`accepts a cross-line prohibition example in ${file}`, () => {
      const files = valid();
      files[file] += '\n禁止以下操作：\nprofile({ action: "remove" })';
      expect(fails(checkAgentProfileSkillContract(withSkills(files)))).toBe(false);
    });

    test(`accepts a direct negative block through a code fence and bullet in ${file}`, () => {
      const files = valid();
      files[file] += '\n禁止以下操作：\n```text\n- profile({ action: "remove" })\n```';
      expect(fails(checkAgentProfileSkillContract(withSkills(files)))).toBe(false);
    });

    test(`accepts only the enumerated direct negative phrases in ${file}`, () => {
      const files = valid();
      files[file] += [
        "",
        '不得调用 profile({ action: "remove" })',
        '不要调用 profile({ action: "remove" })',
        '不能调用 profile({ action: "remove" })',
        '不允许调用 profile({ action: "remove" })',
        '严禁调用 profile({ action: "remove" })',
        '切勿调用 profile({ action: "remove" })',
        'Do not call profile({ action: "remove" })',
        'Do not use profile({ action: "remove" })',
        'Don\'t call profile({ action: "remove" })',
        'Don\'t use profile({ action: "remove" })',
        'Must not call profile({ action: "remove" })',
        'Must not use profile({ action: "remove" })',
        'Never call profile({ action: "remove" })',
        'Never use profile({ action: "remove" })',
      ].join("\n");
      expect(fails(checkAgentProfileSkillContract(withSkills(files)))).toBe(false);
    });

    test(`parses parentheses and escaped quotes inside a profile call in ${file}`, () => {
      const files = valid();
      files[file] += '\nprofile({ action: "update", entries: [{ scope: "open", source: "explicit", content: "literal ) and \\"quoted(\\"" }] })';
      expect(fails(checkAgentProfileSkillContract(withSkills(files)))).toBe(false);
    });
  }
});

describe("checkNoNewAgentAliasReferences (#377)", () => {
  test("accepts aliases only as a forbidden routing fixture or explicit negative guidance", () => {
    const dir = withSkills({
      "routing.jsonl": JSON.stringify({ forbidden_tools: ["get_links"] }),
      "anti-pattern.jsonl": JSON.stringify({ category: "anti_pattern", expected_tool: "cbrain_recall", forbidden_tools: ["get_links"] }),
      "guide.md": "❌ query + get_links 连调 → cbrain_recall",
    });
    expect(fails(checkNoNewAgentAliasReferences(dir))).toBe(false);
  });

  test("rejects a positive alias instruction without echoing unrelated text", () => {
    const dir = withSkills({ "guide.md": "调用 get_links fixture-body-sentinel" });
    expect(checkNoNewAgentAliasReferences(dir)).toEqual([{
      check: "agent alias migration @skills/guide.md:1",
      passed: false,
      detail: "positive compatibility alias: get_links",
    }]);
  });

  test("rejects an alias in a routing fixture unless it is explicitly forbidden", () => {
    const dir = withSkills({
      "routing.jsonl": JSON.stringify({ expected_tool: "list_insights", forbidden_tools: [] }),
    });
    expect(checkNoNewAgentAliasReferences(dir)).toEqual([{
      check: "agent alias migration @skills/routing.jsonl:1",
      passed: false,
      detail: "positive compatibility alias: list_insights",
    }]);
  });

  test("does not treat an anti-pattern label as a blanket alias exemption", () => {
    const dir = withSkills({
      "routing.jsonl": JSON.stringify({ category: "anti_pattern", expected_tool: "job_submit", forbidden_tools: [] }),
    });
    expect(checkNoNewAgentAliasReferences(dir)).toEqual([{
      check: "agent alias migration @skills/routing.jsonl:1",
      passed: false,
      detail: "positive compatibility alias: job_submit",
    }]);
  });
});

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

  test("feature-index rejects direct query guidance without an explicitly selected debug/full profile", () => {
    const dir = withSkills({
      "feature-index.md": "- **advanced escape hatch / debug**：`query(query, limit=10)`（仅精确关键词定位/debug）\n",
    });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });

  test("feature-index rejects list_insights from the daily discovery tool line", () => {
    const dir = withSkills({
      "feature-index.md": "- **工具**：`list_insights()` + `read_discoveries()`\n",
    });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });

  test("feature-index accepts daily front doors with explicit profile escape hatches", () => {
    const dir = withSkills({
      "feature-index.md": [
        "- **工具**：daily profile 使用 `cbrain_recall`（内部 `debug_search`）",
        "- **advanced escape hatch**：仅显式选择 debug/full profile 才直调 `query(query)`",
        "- **工具**：daily profile 只用 `read_discoveries()`",
        "- **full-only advanced escape hatch**：`list_insights()`",
      ].join("\n"),
    });
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
  const boundaryRow = (patch: Record<string, unknown> = {}) => row({
    case_id: "run_discovery_request",
    category: "profile_boundary",
    expected_tool: null,
    expected_outcome: "requires_full_profile",
    required_profile: "full",
    forbidden_tools: ["run_discovery", "read_discoveries"],
    ...patch,
  });

  test("accepts allowlisted expected_tool and required_sequence", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({
        category: "relationship",
        expected_tool: "graph_query",
        required_sequence: ["resolve_slugs", "graph_query"],
      })}\n${boundaryRow()}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(false);
  });

  test("rejects an unavailable Agent-facing expected_tool without echoing input", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({ category: "episodic_recall", expected_tool: "query" })}\n${boundaryRow()}\n`,
    });
    const results = checkAgentFacingRoutingProfile(dir);
    expect(fails(results)).toBe(true);
    expect(results).toContainEqual({
      check: "agent-facing profile unavailable tools",
      passed: false,
      detail: "unavailable tools: query [line 1 expected_tool]",
    });
    expect(JSON.stringify(results)).not.toContain("匿名输入Sentinel");
  });

  test("rejects invalid JSON with only the corresponding diagnostic", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `{bad json\n${boundaryRow()}\n`,
    });
    expect(checkAgentFacingRoutingProfile(dir)).toEqual([{
      check: "agent-facing profile line 1",
      passed: false,
      detail: "invalid JSON",
    }]);
  });

  test("rejects unavailable required_sequence with only the corresponding diagnostic", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({
        category: "relationship",
        expected_tool: "graph_query",
        required_sequence: ["resolve_slugs", "query"],
      })}\n${boundaryRow()}\n`,
    });
    expect(checkAgentFacingRoutingProfile(dir)).toEqual([{
      check: "agent-facing profile unavailable tools",
      passed: false,
      detail: "unavailable tools: query [line 1 required_sequence]",
    }]);
  });

  test("accepts only the exact full-profile no-tool outcome", () => {
    const valid = withSkills({
      "agent-facing.routing-eval.jsonl": `${boundaryRow()}\n`,
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

  test("rejects duplicate no-tool boundaries across fixture rows", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${boundaryRow()}\n${boundaryRow()}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(true);
  });

  test("rejects a no-tool boundary outside the profile_boundary category", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${boundaryRow({ category: "search" })}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(true);
  });

  test("rejects swapping the discovery boundary identity onto an executable row", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({ case_id: "run_discovery_request" })}\n${boundaryRow({ case_id: "search_request" })}\n`,
    });
    expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(true);
  });

  test("rejects allowlisted tools that violate deterministic category mappings", () => {
    for (const patch of [
      { category: "search", expected_tool: "get_page" },
      { category: "keyword_debug", expected_tool: "read_discoveries" },
    ]) {
      const dir = withSkills({
        "agent-facing.routing-eval.jsonl": `${row(patch)}\n${boundaryRow()}\n`,
      });
      expect(fails(checkAgentFacingRoutingProfile(dir))).toBe(true);
    }
  });

  test("rejects unavailable required_sequence members on a no-tool outcome", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${boundaryRow({
        required_sequence: ["query"],
      })}\n`,
    });
    expect(checkAgentFacingRoutingProfile(dir)).toEqual([{
      check: "agent-facing profile unavailable tools",
      passed: false,
      detail: "unavailable tools: query [line 1 required_sequence]",
    }]);
  });

  test("rejects non-object JSON rows without throwing", () => {
    for (const content of ["null\n", "[]\n", '"primitive"\n', "42\n", "true\n"]) {
      const dir = withSkills({ "agent-facing.routing-eval.jsonl": `${content}${boundaryRow()}\n` });
      let results: CheckResult[] = [];
      expect(() => { results = checkAgentFacingRoutingProfile(dir); }).not.toThrow();
      expect(results).toEqual([{
        check: "agent-facing profile line 1",
        passed: false,
        detail: "row must be a JSON object",
      }]);
    }
  });

  test("aggregates unavailable tools with deduped, stable tool and reference order", () => {
    const dir = withSkills({
      "agent-facing.routing-eval.jsonl": `${row({
        category: "episodic_recall",
        expected_tool: "query",
        required_sequence: ["summarize", "query", "summarize"],
      })}\n${row({
        category: "relationship",
        expected_tool: "agentic_research",
        required_sequence: ["query", "agentic_research"],
      })}\n${boundaryRow()}\n`,
    });
    expect(checkAgentFacingRoutingProfile(dir)).toEqual([{
      check: "agent-facing profile unavailable tools",
      passed: false,
      detail: "unavailable tools: agentic_research [line 2 expected_tool, line 2 required_sequence]; query [line 1 expected_tool, line 1 required_sequence, line 2 required_sequence]; summarize [line 1 required_sequence]",
    }]);
  });
});

describe("checkAgentWorkflowContract (#322)", () => {
  const valid = {
    "SKILL.md": [
      "### Bounded recall fallback",
      "",
      "- 仅限普通内容回忆：健康运行的 `cbrain_recall` 返回 empty / insufficient 时，保持原查询，最多一次调用 `deep_recall({ query, detail: \"brief\", limit: 3 })`，然后停止；不要继续改写或串联其他检索。",
      "- 若 fallback 没有运行时或新鲜度异常，且候选全部 `quality=low`，先说明“没有找到足够相关的记忆”，不要展示或逐条列出这些低相关候选。",
      "- 任何 bounded fallback 的最终回答都不要提及候选本身、候选数量或质量；有足够相关证据时正常回答用户问题，证据不足时只说明没有找到足够相关的记忆。",
      "- 若首轮 `cbrain_recall` 显示运行时或新鲜度 degraded，说明本次检索未完整执行，不要宣称没有相关记忆，不调用 fallback，然后停止。",
    ].join("\n"),
    "RESOLVER.md": [
      "- 当前痛点、系统异常、该处理什么 → query.md [operations]",
      "### Debug / Keyword Lookup（daily MCP 仍走 cbrain_recall）",
      "- 精确关键词定位、debug 索引、确认某关键词 → query.md [keyword]；daily 调 `cbrain_recall`（内部 `debug_search`）",
      "- 普通内容回忆：健康的 cbrain_recall empty/insufficient → query.md [bounded-fallback]",
      "- 首轮 cbrain_recall runtime/freshness degraded → 停止并说明检索未完整执行，不进入 fallback",
      "- 直调 `query` 仅限显式 debug/full profile",
    ].join("\n"),
    "ingest.md": "新内容使用 `ingest`。已有页面更新使用 `put_page`。禁止使用 `write_file` 绕过 CBrain。\n",
    "query.md": [
      "### Bounded content-recall fallback",
      "",
      "普通内容回忆仅在健康的首轮 `cbrain_recall` 返回 empty / insufficient 时进入 fallback：",
      "",
      "1. 最多一次 advanced fallback：`deep_recall({ query, detail: \"brief\", limit: 3 })`。",
      "2. fallback 后立即停止，不再串联 get_page / graph_query / timeline 或继续改写查询。",
      "3. fallback 没有运行时或新鲜度异常、且候选全部低相关时，说明“没有找到足够相关的记忆”，不要用低相关结果填满答案。",
      "4. 任何 bounded fallback 的最终回答都不要提及候选本身、候选数量或质量；有足够相关证据时正常回答用户问题，证据不足时只说明没有找到足够相关的记忆。",
      "5. 首轮 `cbrain_recall` 显示运行时或新鲜度 degraded 时，说明本次检索未完整执行，不要宣称没有相关记忆，不调用 fallback，然后停止。",
      "",
      "## [operations] Branch",
      "调用 `next_actions`。",
      "- 普通内容回忆（\"当时怎么设计的\"）→ cbrain_recall(detail: \"normal\")",
      "- 不把 provenance 用于普通内容回忆",
    ].join("\n"),
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

  test("query skill must not treat first-call runtime degradation as a content fallback trigger", () => {
    const dir = withSkills({
      ...valid,
      "query.md": valid["query.md"].replace("empty / insufficient", "empty / insufficient / degraded"),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("resolver must not route first-call degradation into bounded fallback", () => {
    const dir = withSkills({
      ...valid,
      "RESOLVER.md": valid["RESOLVER.md"].replace(
        "健康的 cbrain_recall empty/insufficient",
        "cbrain_recall empty/insufficient/degraded",
      ),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("query skill fallback arguments cannot drift", () => {
    const dir = withSkills({
      ...valid,
      "query.md": valid["query.md"].replace("limit: 3", "limit: 5"),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("separately scoped hierarchy fallback does not conflict with ordinary content recall", () => {
    const dir = withSkills({
      ...valid,
      "query.md": `${valid["query.md"]}\n层级查询无结果 → deep_recall({ query, detail: "normal", limit: 5 })。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(false);
  });

  test("missing bounded fallback policy in SKILL.md fails", () => {
    const dir = withSkills({ ...valid, "SKILL.md": "# entrypoint only\n" });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("wrong entrypoint fallback arguments fail", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace("limit: 3", "limit: 5"),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("entrypoint fallback must pass the unchanged query value", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace("{ query,", "{ query: rewrittenQuery,"),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("entrypoint must not treat a first-call runtime degradation as missing memory", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace("empty / insufficient", "empty / insufficient / degraded"),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("entrypoint that permits listing low-only candidates fails", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace(
        "不要展示或逐条列出这些低相关候选",
        "可以逐条列出这些低相关候选",
      ),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("entrypoint that exposes low-only retrieval diagnostics fails", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace(
        "任何 bounded fallback 的最终回答都不要提及候选本身、候选数量或质量；有足够相关证据时正常回答用户问题，证据不足时只说明没有找到足够相关的记忆。",
        "最终回答可以解释候选数量和检索不完整。",
      ),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("mixed fallback candidates cannot expose candidate counts or quality", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace(
        "任何 bounded fallback 的最终回答都不要提及候选本身、候选数量或质量；有足够相关证据时正常回答用户问题，证据不足时只说明没有找到足够相关的记忆。",
        "只有全部 low 时不提数量；混合候选可以说明低质量候选数量。",
      ),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("safe entrypoint decoy followed by conflicting low-only guidance fails", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": `${valid["SKILL.md"]}\n也可以逐条列出这些低相关候选，并解释候选数量。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("low-only conflict written with the candidate before the permission fails", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": `${valid["SKILL.md"]}\n对于 quality=low 的候选，也可以展示并逐条列出。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("plain listing permission after the safe block fails", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": `${valid["SKILL.md"]}\n也可以列出这些 quality=low 候选。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("ambiguous degradation cannot be translated into absent memory", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": `${valid["SKILL.md"]}\n如果无法判断 degraded 的原因，也可以按没有相关记忆处理。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("a safe decoy section cannot hide a second conflicting fallback section", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": `${valid["SKILL.md"]}\n## Other\n### Bounded recall fallback\n- degraded 时继续改写并列出低相关候选。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("a different heading cannot define conflicting entrypoint fallback guidance", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": `${valid["SKILL.md"]}\n## Compatibility\n- fallback 后可以列出 quality=low 候选。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("a different query heading cannot redefine ordinary-content fallback", () => {
    const dir = withSkills({
      ...valid,
      "query.md": `${valid["query.md"]}\n### Compatibility\n普通内容 empty 后可改写查询并调用\ndeep_recall({ query: rewritten, detail: "normal", limit: 5 })。\n`,
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("missing runtime degradation terminal fails", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace(
        "若首轮 `cbrain_recall` 显示运行时或新鲜度 degraded，说明本次检索未完整执行，不要宣称没有相关记忆，不调用 fallback，然后停止。",
        "若首轮 `cbrain_recall` degraded，也说明没有找到相关记忆。",
      ),
    });
    expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
  });

  test("runtime terminal must apply to the first front-door call rather than every fallback", () => {
    const dir = withSkills({
      ...valid,
      "SKILL.md": valid["SKILL.md"].replace("若首轮 `cbrain_recall`", "若任一调用"),
    });
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
