#!/usr/bin/env bun
// check-docs-consistency.ts — Public docs vs code consistency gate for v2.0
//
// Usage:
//   bun bin/check-docs-consistency.ts           # verify (exit 1 on drift)
//   bun bin/check-docs-consistency.ts --update  # regenerate auto-generated index sections
//
// Env:
//   DOCS_DIR  override the docs root (testing); README stays at PROJECT_DIR/README.md.
//             --update writes under DOCS_DIR too, so tests never touch the real checkout.
//
// Verifies public docs reflect current code:
//   1. Version refs (#vX.Y.Z) match package.json (or use the <新版本号> placeholder)
//   2. Every `cbrain <cmd>` in docs (inline + fenced code blocks) exists in the real CLI
//   3. `cbrain sync` recovery flag combos are valid per resolveSyncMode (catches bare --reindex)
//   4. Tool/command counts in docs match registration output
//   5. No fake distribution claims (homebrew / standalone / `bun add cbrain` / `npx cbrain`)
//   6. Auto-generated index sections are in sync with code
//
// A line may opt out of a check with one of:
//   <!-- docs-consistency:ignore-version -->
//   <!-- docs-consistency:ignore-command -->   (also opts out of sync-recovery)
//   <!-- docs-consistency:ignore-count -->
//
// Exit codes: 0 = pass, 1 = fail, 2 = fatal error

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../src/mcp/register.js";
import { buildProgram } from "../src/cli/program.js";
import { resolveSyncMode, type SyncOptions } from "../src/cli/commands/reindex.js";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;
const UPDATE = process.argv.includes("--update");
const DOCS_DIR = process.env.DOCS_DIR ?? join(PROJECT_DIR, "docs");
const SKILLS_INDEX = process.env.SKILLS_INDEX ?? join(PROJECT_DIR, "skills", "feature-index.md");

interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

interface ToolInfo {
  name: string;
  description: string;
}

// ── Truth sources ──────────────────────────────────────────────────────────

/** Build the real Commander program and read its registered commands.
 *  buildProgram() only declares `.command().action()` — it never parses argv
 *  nor invokes the actions (which call loadConfig()/DB), so importing it is
 *  side-effect-free. This is the source of truth, not a source-code regex. */
function getCliCommands(): Map<string, string> {
  const cmds = new Map<string, string>();
  for (const cmd of buildProgram().commands) {
    cmds.set(cmd.name(), cmd.description());
  }
  return cmds;
}

/** A chainable no-op Proxy: any property read or call returns itself.
 *  Lets registerAllTools run its registration phase against ctx fields it
 *  dereferences up front (e.g. `const provenance = ctx.provenance`). */
function makeNoopChain(): unknown {
  const proxy = new Proxy(function noop() { /* chain */ }, {
    get: () => proxy,
    apply: () => proxy,
  });
  return proxy;
}

/** Count MCP tools by feeding a spy server to registerAllTools. Covers both
 *  registerTool (current API) and the deprecated .tool() used by provenance.ts. */
function getMcpTools(): ToolInfo[] {
  const tools: ToolInfo[] = [];
  const spy = {
    registerTool(name: string, config: unknown): unknown {
      const desc = (config as { description?: string } | null)?.description ?? "";
      tools.push({ name, description: desc });
      return {};
    },
    tool(name: string, ...rest: unknown[]): unknown {
      const desc = typeof rest[0] === "string" ? rest[0] : "";
      tools.push({ name, description: desc });
      return {};
    },
  } as unknown as McpServer;
  const mockCtx = makeNoopChain() as Parameters<typeof registerAllTools>[1];
  registerAllTools(spy, mockCtx);
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Doc loading ────────────────────────────────────────────────────────────

function loadDocs(): Map<string, string> {
  const docs = new Map<string, string>();
  const readme = join(PROJECT_DIR, "README.md");
  if (existsSync(readme)) docs.set("README.md", readFileSync(readme, "utf-8"));
  if (existsSync(DOCS_DIR)) {
    for (const f of readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))) {
      docs.set(`docs/${f}`, readFileSync(join(DOCS_DIR, f), "utf-8"));
    }
  }
  if (existsSync(SKILLS_INDEX)) {
    docs.set("skills/feature-index.md", readFileSync(SKILLS_INDEX, "utf-8"));
  }
  return docs;
}

// ── Checks ─────────────────────────────────────────────────────────────────

function checkVersions(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const re = /#v(\d+\.\d+\.\d+)/g;
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-version -->")) return;
      for (const m of line.matchAll(re)) {
        if (m[1] !== VERSION) {
          out.push({ check: `version @${file}:${i + 1}`, passed: false, detail: `#v${m[1]} ≠ v${VERSION}` });
        }
      }
    });
  }
  if (out.length === 0) out.push({ check: "version refs", passed: true, detail: `all #v refs == v${VERSION}` });
  return out;
}

/** Matches `cbrain <subcommand>` whether it sits in inline code or a fenced
 *  code block. The leading char class (line-start, backtick, quote, or space)
 *  avoids matching "cbrain" as a bare word inside prose like "the cbrain
 *  project". */
const CBRAIN_CMD_RE = /(^|[`'"\s])cbrain ([a-z][a-z-]*)/g;

function checkCommands(docs: Map<string, string>, cli: Set<string>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-command -->")) return;
      for (const m of line.matchAll(CBRAIN_CMD_RE)) {
        if (!cli.has(m[2])) {
          out.push({ check: `command @${file}:${i + 1}`, passed: false, detail: `\`cbrain ${m[2]}\` 不存在` });
        }
      }
    });
  }
  if (out.length === 0) out.push({ check: "command refs", passed: true, detail: "all `cbrain <cmd>` exist (inline + code blocks)" });
  return out;
}

/** Validate every `cbrain sync ...` combo in the docs against resolveSyncMode.
 *  Catches the classic footgun: bare `cbrain sync --reindex` is REJECTED by
 *  resolveSyncMode (--reindex requires --slug). The three correct recovery
 *  paths (--slug X --reindex / --reindex-quarantined / --reindex-vectors) pass. */
function checkSyncRecovery(docs: Map<string, string>, cli: Set<string>): CheckResult[] {
  if (!cli.has("sync")) return []; // nothing to validate against
  const out: CheckResult[] = [];
  // Match EACH `cbrain sync` on a line and capture only its own contiguous
  // `--flag [value]` segment, so multiple commands on one line (the recovery
  // docs list all three scopes together) are validated independently instead
  // of being blended into one invalid combo. Values stop at backtick/pipe/quote
  // so the segment ends at the code-fence boundary.
  const syncCmdRe = /(^|[`'"\s])cbrain sync((?:\s+--[\w-]+(?:\s+[^\s`'|]+)?)*)/g;
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-command -->")) return;
      for (const m of line.matchAll(syncCmdRe)) {
        const rest = m[2];
        // --reindex must NOT match --reindex-vectors / --reindex-quarantined
        const opts: SyncOptions = {
          slug: /--slug\b/.test(rest) ? "placeholder" : undefined,
          reindex: /--reindex(?![a-z-])/.test(rest),
          reindexVectors: /--reindex-vectors\b/.test(rest),
          reindexQuarantined: /--reindex-quarantined\b/.test(rest),
        };
        const r = resolveSyncMode(opts);
        if (!r.ok) {
          out.push({ check: `sync recovery @${file}:${i + 1}`, passed: false, detail: `\`cbrain sync${rest.trim()}\` → ${r.message}` });
        }
      }
    });
  }
  if (out.length === 0) out.push({ check: "sync recovery combos", passed: true, detail: "all `cbrain sync` flag combos valid" });
  return out;
}

function checkCounts(docs: Map<string, string>, toolCount: number, cmdCount: number): CheckResult[] {
  const out: CheckResult[] = [];
  // Patterns: "41 MCP tools", "38 个 MCP 工具", "N 个工具", "37 tools,", "(N total)"
  const toolRe = /(\d+)\s*(?:MCP tools|MCP工具|个 MCP 工具|个 MCP|个工具|tools,)/g;
  const totalRe = /\((\d+)\s*total\)/g;
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-count -->")) return;
      for (const m of line.matchAll(toolRe)) {
        const n = Number(m[1]);
        if (n !== toolCount) {
          out.push({ check: `tool count @${file}:${i + 1}`, passed: false, detail: `声称 ${n}，实际 ${toolCount}` });
        }
      }
      for (const m of line.matchAll(totalRe)) {
        const n = Number(m[1]);
        // "(N total)" — accept either the tool count or the command count depending
        // on the heading context; we only have the line, so allow both.
        if (n !== toolCount && n !== cmdCount) {
          out.push({ check: `total count @${file}:${i + 1}`, passed: false, detail: `(${n} total) 与工具数(${toolCount})/命令数(${cmdCount}) 均不符` });
        }
      }
    });
  }
  if (out.length === 0) out.push({ check: "tool/command counts", passed: true, detail: `tools=${toolCount} commands=${cmdCount}` });
  return out;
}

function checkBinary(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  // Only flag claims that a binary/package distribution EXISTS or an install
  // method that isn't actually supported. Honest negatives ("binaries are not
  // available yet") are allowed, so we do not match "standalone".
  const bad = [
    /brew install cbrain/i,
    /homebrew[^.]*cbrain/i,
    /brew tap/i,
    /prebuilt binary/i,
    /npm install -g cbrain/i,
    /bun add cbrain/i,
    /npx cbrain/i,
  ];
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      for (const re of bad) {
        const m = line.match(re);
        if (m) out.push({ check: `install claim @${file}:${i + 1}`, passed: false, detail: `"${m[0]}" 不是支持的安装/发行方式` });
      }
    });
  }
  if (out.length === 0) out.push({ check: "install claims", passed: true, detail: "no unsupported distribution claims" });
  return out;
}

/** Catch docs that recommend bypassing the maintenance wrapper (#212):
 *  - `cbrain watch` (removed command; also caught by checkCommands, but this
 *    makes the intent explicit and catches prose that spells it out)
 *  - bare `bun run src/cli/index.ts (compact|dream)` (bypasses wrapper →
 *    concurrent writer risk per #208 single-writer gate)
 *  Wrapper usage (bin/cbrain-maintenance.sh) and valid `cbrain <cmd>` CLI
 *  verbs for one-shot commands are NOT flagged. Respects the
 *  docs-consistency:ignore-command opt-out (used for the "cbrain watch 已废弃"
 *  negative example in docs/hermes-integration.md). */
function checkLegacyCronPatterns(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const bad = [
    /\bcbrain watch\b/,
    /\bbun run src\/cli\/index\.ts\s+(compact|dream)\b/,
  ];
  for (const [file, text] of docs) {
    text.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-command -->")) return;
      for (const re of bad) {
        const m = line.match(re);
        if (m) {
          out.push({
            check: `legacy cron pattern @${file}:${i + 1}`,
            passed: false,
            detail: `"${m[0]}" 绕过 wrapper（用 bin/cbrain-maintenance.sh 走 /mcp，见 docs/hermes-integration.md）`,
          });
        }
      }
    });
  }
  if (out.length === 0) {
    out.push({
      check: "legacy cron patterns",
      passed: true,
      detail: "no cbrain watch / bare bun run compact|dream bypasses",
    });
  }
  return out;
}

// ── MCP tool reference check ───────────────────────────────────────────────

/** Remove auto-generated sections so tool-ref linting only sees hand-written
 *  prose. The auto-gen tables are code-generated and always correct. */
function stripAutoGen(text: string): string {
  let out = text;
  for (const key of ["mcp-tools", "cli-commands"]) {
    const start = `<!-- cbrain:auto-gen ${key}:start -->`;
    const end = `<!-- cbrain:auto-gen ${key}:end -->`;
    const si = out.indexOf(start);
    const ei = out.indexOf(end);
    if (si !== -1 && ei > si) out = `${out.slice(0, si)}${out.slice(ei + end.length)}`;
  }
  return out;
}

/** Validate that every MCP tool name referenced in hand-written docs is a real
 *  registered MCP tool. This is the gate that catches phantom tools
 *  (put_raw_data, get_config, ...) the `cbrain <cmd>` verb check can't see —
 *  AND catches a CLI command (e.g. `backup`) masquerading as an MCP tool.
 *
 *  Only real MCP tools are accepted. CLI inventory is linted separately by
 *  checkCommands over `cbrain <cmd>` verbs, so merging CLI names in here would
 *  let a CLI verb silently pass as a tool.
 *
 *  Two structural anchors — chosen for zero false positives:
 *   1. Tool subsection headings:  `### query`  /  `### \`query\``
 *   2. First columns of *tool* tables only. A table counts as a tool table when
 *      its header row (the line above the `|---|` separator) contains 工具 or
 *      Tool. Parameter tables (参数/类型/...), capability tables (Category/
 *      Skill/Page Type) and prose that merely mentions "tool" never trip it.
 *  Auto-generated sections are stripped first. */

/** Enforce the #223 daily-patrol contract:
 *  - `bin/daily-patrol.sh` must NOT invoke `bun test`, `bun run check`, or
 *    `cbrain doctor` (single-writer topology: cron must not spawn stdio CLI
 *    that touches runtime; full suite belongs to nightly/release).
 *  - `docs/patrol.md` must not recommend running `bun test`/`bun run check`
 *    in the daily patrol path. */
function checkDailyPatrolContract(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const badInScript = [
    /\bbun test\b/,
    /\bbun run check\b/,
    /\bcbrain doctor\b/,
  ];
  const scriptPath = join(PROJECT_DIR, "bin", "daily-patrol.sh");
  if (existsSync(scriptPath)) {
    const script = readFileSync(scriptPath, "utf-8");
    script.split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("#")) return; // 跳过注释
      for (const re of badInScript) {
        const m = line.match(re);
        if (m) {
          out.push({
            check: `daily-patrol contract @bin/daily-patrol.sh:${i + 1}`,
            passed: false,
            detail: `"${m[0]}" 违反 #223：daily patrol 不调 full suite / doctor（single-writer 拓扑，见 docs/patrol.md）`,
          });
        }
      }
    });
    // cwd 独立检查（#223 review）：脚本必须解析 PROJECT_DIR + 支持 CBRAIN_REPO_DIR，
    // 不依赖 caller cwd。否则从非 repo 目录跑会静默跳过 perf/gate → 误报 healthy。
    if (!script.includes("PROJECT_DIR=") || !script.includes("CBRAIN_REPO_DIR")) {
      out.push({
        check: "daily-patrol cwd independence",
        passed: false,
        detail: "daily-patrol.sh 必须解析 PROJECT_DIR + 支持 CBRAIN_REPO_DIR（独立于 caller cwd，#223 review）",
      });
    }
    // 裸 `bun src/cli/index.ts`（无 $PROJECT_DIR 前缀）= cwd 依赖反模式
    if (/\bbun src\/cli\/index\.ts\b/.test(script)) {
      out.push({
        check: "daily-patrol cwd independence",
        passed: false,
        detail: "daily-patrol.sh 含裸 `bun src/cli/index.ts`（需 `bun \"$PROJECT_DIR/src/cli/index.ts\"` 独立于 cwd）",
      });
    }
    // perf-diagnose 必须在 (cd $PROJECT_DIR && ...) 下——src/cli/index.ts 内部
    // loadConfig() 按 cwd 找 cbrain.json，裸绝对路径但 cwd 错会静默失败（#223 review）
    if (/perf-diagnose/.test(script) && !/\(cd "\$PROJECT_DIR" &&[^)]*perf-diagnose/.test(script)) {
      out.push({
        check: "daily-patrol perf cwd",
        passed: false,
        detail: "perf-diagnose 必须在 (cd \"$PROJECT_DIR\" && ...) 下（loadConfig 按 cwd 找 cbrain.json），#223 review",
      });
    }
    // MCP tools/list 响应里除 tool.name 外，还可能有 inputSchema.properties.name
    // 等字段。grep `"name"` 会把参数名也算进工具总数，造成 patrol 报告
    // 与 docs/health 真值不一致。
    if (/grep\s+-o\s+['"]"name"['"]/.test(script)) {
      out.push({
        check: "daily-patrol mcp tool count",
        passed: false,
        detail: "daily-patrol.sh 不得用 grep '\"name\"' 统计 MCP tools；必须解析 result.tools.length",
      });
    }
  }
  const patrolDoc = docs.get("docs/patrol.md");
  if (patrolDoc) {
    patrolDoc.split("\n").forEach((line, i) => {
      if (line.includes("<!-- docs-consistency:ignore-command -->")) return;
      // patrol.md 提 bun test/check 必须在 nightly/release 语境，不能在 daily 推荐
      if (/\bdaily\b.*\bbun (test|run check)\b/i.test(line)) {
        out.push({
          check: `daily-patrol doc @docs/patrol.md:${i + 1}`,
          passed: false,
          detail: `daily 行不应推荐 bun test/check（#223：daily bounded，full suite 留 nightly/release）`,
        });
      }
    });
  }
  if (out.length === 0) {
    out.push({
      check: "daily-patrol contract",
      passed: true,
      detail: "daily-patrol.sh 不调 full suite/doctor；docs/patrol.md daily 不推荐 bun test/check",
    });
  }
  return out;
}

function checkToolReferences(docs: Map<string, string>, tools: Set<string>): CheckResult[] {
  const out: CheckResult[] = [];
  const SEPARATOR_RE = /^\|[\s:|-]+\|$/;
  for (const [file, raw] of docs) {
    const lines = stripAutoGen(raw).split("\n");
    // Mark data-row indices whose table is a tool table — header is the line
    // directly above a `|---|` separator, and must contain 工具/Tool.
    const toolRows = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (SEPARATOR_RE.test(lines[i])) {
        const header = lines[i - 1] ?? "";
        if (/工具|tool/i.test(header)) {
          for (let j = i + 1; j < lines.length && lines[j].startsWith("|"); j++) toolRows.add(j);
        }
      }
    }
    lines.forEach((line, i) => {
      const ref = toolRows.has(i)
        ? line.match(/^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|/)?.[1]
        : line.match(/^###\s+`?([a-z][a-z0-9_]*)`?\s*$/)?.[1];
      if (ref && !tools.has(ref)) {
        out.push({ check: `tool ref @${file}:${i + 1}`, passed: false, detail: `\`${ref}\` 不是已注册的 MCP 工具（CLI 命令不可冒充工具）` });
      }
    });
  }
  if (out.length === 0) out.push({ check: "MCP tool refs", passed: true, detail: "all tool references are registered MCP tools (headings + tool tables)" });
  return out;
}

/** Validate MCP tool names on `**工具**` lines in the skill index. feature-index.md
 *  recommends tools as `**工具**：\`tool_name(params)\`` — a format the heading/
 *  table anchors in checkToolReferences don't catch. This is the gate that
 *  catches phantom tools like submit_feedback / get_config / set_config there. */
function checkSkillsToolRefs(docs: Map<string, string>, tools: Set<string>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const [file, raw] of docs) {
    if (file !== "skills/feature-index.md") continue;
    stripAutoGen(raw).split("\n").forEach((line, i) => {
      // Only inspect lines that recommend a tool: `- **工具**：...`
      if (!/^\s*-\s*\*\*工具\*\*/.test(line)) return;
      // Pull the leading identifier of every backticked token on the line.
      for (const m of line.matchAll(/`([a-z][a-z0-9_]*)/g)) {
        if (!tools.has(m[1])) {
          out.push({ check: `skill tool ref @${file}:${i + 1}`, passed: false, detail: `\`${m[1]}\` 不是已注册的 MCP 工具` });
        }
      }
    });
  }
  if (out.length === 0) out.push({ check: "skill tool refs", passed: true, detail: "feature-index.md `**工具**` 行工具调用全部已注册" });
  return out;
}

// ── Auto-generated index sections ──────────────────────────────────────────

// docsFile is relative to DOCS_DIR; the in-memory docs map keys it as `docs/<docsFile>`.
const SECTION_KEYS = {
  "mcp-tools": { docsFile: "mcp-tools.md" },
  "cli-commands": { docsFile: "usage.md" },
} as const;
type SectionKey = keyof typeof SECTION_KEYS;

/** Flatten + truncate a cell for the index table. Truncation takes the first
 *  sentence, then cuts on a word boundary (never mid-word like the old
 *  hard slice(0,120) that produced "...conf", "...re"). */
function escapeCell(s: string): string {
  const flat = s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const firstSentence = flat.split(/(?<=[。.!?！？])\s/)[0] ?? flat;
  const MAX = 110;
  if (firstSentence.length <= MAX) return firstSentence;
  const cut = firstSentence.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 40 ? cut.slice(0, lastSpace) : cut}…`;
}

function generateMcpIndex(tools: ToolInfo[]): string {
  const rows = tools.map((t) => `| \`${t.name}\` | ${escapeCell(t.description) || "—"} |`).join("\n");
  return `共 ${tools.length} 个 MCP 工具（\`cbrain serve\` 注册输出，按字母序）。\n\n| 工具 | 说明 |\n|------|------|\n${rows}\n`;
}

function generateCliIndex(cmds: Map<string, string>): string {
  const rows = [...cmds.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, desc]) => `| \`${name}\` | ${escapeCell(desc) || "—"} |`)
    .join("\n");
  return `共 ${cmds.size} 个 CLI 命令（\`cbrain --help\`）。\n\n| 命令 | 说明 |\n|------|------|\n${rows}\n`;
}

function readSection(text: string, key: SectionKey): string | null {
  const start = `<!-- cbrain:auto-gen ${key}:start -->`;
  const end = `<!-- cbrain:auto-gen ${key}:end -->`;
  const si = text.indexOf(start);
  const ei = text.indexOf(end);
  if (si === -1 || ei === -1 || ei < si) return null;
  return text.slice(si + start.length, ei);
}

function replaceSection(text: string, key: SectionKey, content: string): string {
  const start = `<!-- cbrain:auto-gen ${key}:start -->`;
  const end = `<!-- cbrain:auto-gen ${key}:end -->`;
  const si = text.indexOf(start);
  const ei = text.indexOf(end);
  if (si === -1 || ei === -1) return text; // section absent — leave untouched
  return `${text.slice(0, si)}${start}\n${content}${end}${text.slice(ei + end.length)}`;
}

function checkSections(docs: Map<string, string>, tools: ToolInfo[], cmds: Map<string, string>): CheckResult[] {
  const generated: Record<SectionKey, string> = {
    "mcp-tools": generateMcpIndex(tools),
    "cli-commands": generateCliIndex(cmds),
  };
  const out: CheckResult[] = [];
  for (const key of Object.keys(SECTION_KEYS) as SectionKey[]) {
    const file = `docs/${SECTION_KEYS[key].docsFile}`;
    const text = docs.get(file);
    if (!text) {
      out.push({ check: `section ${key}`, passed: false, detail: `${file} 不存在` });
      continue;
    }
    const current = readSection(text, key);
    if (current === null) {
      out.push({ check: `section ${key}`, passed: false, detail: `${file} 缺少 auto-gen 标记段` });
      continue;
    }
    const expected = `\n${generated[key]}`;
    out.push({
      check: `section ${key}`,
      passed: current.trim() === expected.trim(),
      detail: current.trim() === expected.trim() ? "in sync" : `${file} auto-gen 段与代码不一致（跑 --update 修复）`,
    });
  }
  return out;
}

// ── Run ────────────────────────────────────────────────────────────────────

function main(): void {
  const cli = getCliCommands();
  const tools = getMcpTools();
  const docs = loadDocs();

  if (UPDATE) {
    let writes = 0;
    for (const key of Object.keys(SECTION_KEYS) as SectionKey[]) {
      const path = join(DOCS_DIR, SECTION_KEYS[key].docsFile);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf-8");
      const content = key === "mcp-tools" ? generateMcpIndex(tools) : generateCliIndex(cli);
      const next = replaceSection(text, key, content);
      if (next !== text) {
        writeFileSync(path, next);
        writes++;
      }
    }
    console.log(`Updated ${writes} auto-generated section(s) under ${DOCS_DIR}. Re-run without --update to verify.`);
    process.exitCode = 0;
    return;
  }

  const results: CheckResult[] = [
    ...checkVersions(docs),
    ...checkCommands(docs, new Set(cli.keys())),
    ...checkSyncRecovery(docs, new Set(cli.keys())),
    ...checkCounts(docs, tools.length, cli.size),
    ...checkBinary(docs),
    ...checkLegacyCronPatterns(docs),
    ...checkDailyPatrolContract(docs),
    ...checkToolReferences(docs, new Set(tools.map((t) => t.name))),
    ...checkSkillsToolRefs(docs, new Set(tools.map((t) => t.name))),
    ...checkSections(docs, tools, cli),
  ];

  const allPassed = results.every((r) => r.passed);
  console.log(`\n=== Docs Consistency Gate (v${VERSION}) ===`);
  console.log(`truth: ${tools.length} MCP tools, ${cli.size} CLI commands\n`);
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} ${r.check}: ${r.passed ? r.detail : `FAILED — ${r.detail}`}`);
  }
  console.log(`\nVerdict: ${allPassed ? "PASS" : "FAIL"}\n`);
  process.exitCode = allPassed ? 0 : 1;
}

main();
