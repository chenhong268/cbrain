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
import { AGENT_ALLOWLIST } from "../src/mcp/tool-profiles.js";
import { MCP_INGEST_PAGE_TYPES } from "../src/mcp/tools/ingest.js";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;
const UPDATE = process.argv.includes("--update");
const DOCS_DIR = process.env.DOCS_DIR ?? join(PROJECT_DIR, "docs");
const SKILLS_INDEX = process.env.SKILLS_INDEX ?? join(PROJECT_DIR, "skills", "feature-index.md");

export interface CheckResult {
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
  const proxy: unknown = new Proxy(function noop() { /* chain */ }, {
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

/** MANIFEST.json.packVersion must equal package.json version (drift guard).
 *  `manifestPath` parameter exists for testability; production reads the real
 *  skills/MANIFEST.json. */
export function checkManifestVersion(manifestPath: string = join(PROJECT_DIR, "skills", "MANIFEST.json")): CheckResult[] {
  const out: CheckResult[] = [];
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

/** Skill-pack install TARGET check: cp -r and ln -s must each exist, in
 *  SEPARATE fenced blocks (mutually exclusive — running both lets copy follow
 *  the symlink and write a nested copy back into the canonical pack), each
 *  destination exactly ~/.hermes/skills/brain-ops/cbrain. Policy-NEUTRAL
 *  (path + block shape only); the copy-default / symlink-dev-only policy
 *  contract is owned by checkSkillPackInstallPolicy (§7 close-loop). */
const INSTALL_TARGET = "~/.hermes/skills/brain-ops/cbrain";

export function checkInstallTarget(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  let cpOk = false;
  let lnOk = false;
  for (const [file, text] of docs) {
    const lines = text.split("\n");
    let inBlock = false;
    let blockStart = 0;
    let blockHasCp = false;
    let blockHasLn = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("```")) {
        if (inBlock) {
          if (blockHasCp && blockHasLn) {
            out.push({ check: `install-target @${file}:${blockStart + 1}`, passed: false, detail: `cp -r 和 ln -s 不得在同一 shell block（二选一；连续执行会让 copy 沿 symlink 写回 canonical pack，产生嵌套副本）` });
          }
          inBlock = false;
          blockHasCp = false;
          blockHasLn = false;
        } else {
          inBlock = true;
          blockStart = i;
          blockHasCp = false;
          blockHasLn = false;
        }
        continue;
      }
      if (!inBlock || line.includes("<!-- docs-consistency:ignore-command -->")) continue;
      const isCp = /cp\s+-r\b/.test(line);
      const isLn = /ln\s+-s\b/.test(line);
      if (!isCp && !isLn) continue;
      const dests = [...line.matchAll(/(~\/\.hermes\/skills\/[^\s"']+)/g)].map((m) => m[1]);
      for (const dest of dests) {
        if (dest === INSTALL_TARGET) {
          if (isCp) { cpOk = true; blockHasCp = true; }
          if (isLn) { lnOk = true; blockHasLn = true; }
        } else {
          out.push({ check: `install-target @${file}:${i + 1}`, passed: false, detail: `install dest must be exactly ${INSTALL_TARGET}, got ${dest}` });
        }
      }
    }
  }
  if (!cpOk) out.push({ check: "install-target copy", passed: false, detail: `missing cp -r install command targeting ${INSTALL_TARGET}` });
  if (!lnOk) out.push({ check: "install-target symlink", passed: false, detail: `missing ln -s install command targeting ${INSTALL_TARGET}` });
  if (out.length === 0) out.push({ check: "install-target path", passed: true, detail: `cp -r + ln -s target ${INSTALL_TARGET} in separate blocks (policy: copy default — see skill-pack install policy)` });
  return out;
}

/**
 * Skill-pack install POLICY gate. Closes loop INSIDE docs/install-onboarding.md
 * Step 7, split into a copy subsection (方式 A) and a symlink subsection
 * (方式 B). The symlink risks (trusted-directory + checkout-drift) are matched
 * ONLY inside the symlink subsection — copy's pros ("trusted root", "checkout
 * won't auto-update") must never substitute (HIGH1). Commands are matched ONLY
 * inside real fenced blocks; copy subsection owns the canonical cp -r block,
 * symlink subsection owns the canonical ln -s block, each excluding the other
 * command (HIGH2). Risks must be positively phrased (negations not counted).
 * No aggregation across docs (only install-onboarding.md Step 7 is consulted).
 */
export function checkSkillPackInstallPolicy(docs: Map<string, string>): CheckResult[] {
  const FILE = "docs/install-onboarding.md";
  const text = docs.get(FILE);
  if (text === undefined) {
    return [{ check: "skill-pack install policy", passed: false, detail: `缺少 ${FILE}：部署政策必须在该文件第七步闭环（不聚合其他文档）` }];
  }
  const headingRe = /^## 第七步：验证 Hermes 技能包[^\n]*$/m;
  const startMatch = headingRe.exec(text);
  if (!startMatch) {
    return [{ check: "skill-pack install policy", passed: false, detail: `${FILE} 缺少「## 第七步：验证 Hermes 技能包」标题：政策必须在该段闭环` }];
  }
  const afterStart = text.slice(startMatch.index + startMatch[0].length);
  const nextHeading = afterStart.search(/^## /m);
  const section = nextHeading === -1 ? afterStart : afterStart.slice(0, nextHeading);

  const out: CheckResult[] = [];

  // Locate copy (方式 A) and symlink (方式 B) subsection headings.
  const copyIdx = section.search(/方式\s*A[^\n]*?复制/);
  const symlinkIdx = section.search(/方式\s*B[^\n]*?符号链接/);
  if (copyIdx === -1) out.push({ check: `skill-pack-policy copy-heading @${FILE} §7`, passed: false, detail: `第七步缺少 copy（方式 A/复制…默认推荐）子段标题` });
  if (symlinkIdx === -1) out.push({ check: `skill-pack-policy symlink-heading @${FILE} §7`, passed: false, detail: `第七步缺少 symlink（方式 B/符号链接…仅开发）子段标题` });
  if (copyIdx !== -1 && symlinkIdx !== -1 && copyIdx >= symlinkIdx) out.push({ check: `skill-pack-policy copy-before-symlink @${FILE} §7`, passed: false, detail: `第七步：copy 子段必须位于 symlink 子段之前` });

  // copySection = copy heading .. symlink heading; symlinkSection = symlink heading .. next numbered subsection ("4.") or end.
  const copySection = copyIdx !== -1 && symlinkIdx !== -1 && copyIdx < symlinkIdx ? section.slice(copyIdx, symlinkIdx) : "";
  let symlinkSection = "";
  if (symlinkIdx !== -1) {
    const afterSymlink = section.slice(symlinkIdx);
    const nextSub = afterSymlink.slice(1).search(/^\d+\.\s/m);
    symlinkSection = nextSub === -1 ? afterSymlink : afterSymlink.slice(0, nextSub + 1);
  }

  const copyRecommended = /复制[^\n]*?(默认推荐|生产推荐|生产环境|稳定)/.test(copySection);
  const symlinkDevOnly = /符号链接[^\n]*?(仅开发|开发|试验|dev)/i.test(symlinkSection);
  const symlinkDefault = /符号链接[^\n]*?默认推荐/.test(symlinkSection);

  // HIGH1: risks matched ONLY in symlinkSection, as positively-phrased bullets
  // (a negation like 不会/不影响/避免 disqualifies the bullet).
  const NEG = /(不会|不影响|不能|避免|无法|不自动)/;
  const riskBullets = symlinkSection.split(/\n[-*] /);
  const trustedRisk = riskBullets.some((b) =>
    /(trusted[^\n]{0,20}?(director|root)|信任[^\n]{0,6}目录)/i.test(b)
    && /(外|之外)/.test(b)
    && /(告警|警告|warning)/i.test(b)
    && !NEG.test(b),
  );
  const checkoutDrift = riskBullets.some((b) =>
    /(checkout|仓库|源码)/i.test(b)
    && /(变化|修改|漂移)/.test(b)
    && /(立即|自动进入|静默)/.test(b)
    && !NEG.test(b),
  );

  // HIGH2: commands matched ONLY inside real fenced blocks (prose excluded).
  const copyBlocks = extractFencedBlocks(copySection);
  const symlinkBlocks = extractFencedBlocks(symlinkSection);
  const copyCpCount = copyBlocks.filter((b) => /cp\s+-r\b/.test(b) && b.includes(INSTALL_TARGET)).length;
  const copyLnCount = copyBlocks.filter((b) => /ln\s+-s\b/.test(b)).length;
  const symlinkLnCount = symlinkBlocks.filter((b) => /ln\s+-s\b/.test(b) && b.includes(INSTALL_TARGET)).length;
  const symlinkCpCount = symlinkBlocks.filter((b) => /cp\s+-r\b/.test(b)).length;

  if (!copyRecommended) out.push({ check: `skill-pack-policy copy-recommended @${FILE} §7`, passed: false, detail: `第七步 copy 子段：copy 必须标记默认/生产推荐（「复制（默认推荐…稳定 Hermes）」）` });
  if (!symlinkDevOnly) out.push({ check: `skill-pack-policy symlink-dev-only @${FILE} §7`, passed: false, detail: `第七步 symlink 子段：必须标记仅开发/试验` });
  if (symlinkDefault) out.push({ check: `skill-pack-policy symlink-not-default @${FILE} §7`, passed: false, detail: `第七步 symlink 子段：不得标记「默认推荐」` });
  if (!trustedRisk) out.push({ check: `skill-pack-policy trusted-risk @${FILE} §7`, passed: false, detail: `第七步 symlink 子段：必须有肯定式 trusted-directory 风险（symlink/resolved target 落 trusted directory/root 外 → 告警；否定句不算，copy 优点不算）` });
  if (!checkoutDrift) out.push({ check: `skill-pack-policy checkout-drift @${FILE} §7`, passed: false, detail: `第七步 symlink 子段：必须有肯定式 checkout-drift 风险（checkout/仓库变化立即/自动/静默影响；否定句不算）` });
  if (copyCpCount !== 1) out.push({ check: `skill-pack-policy copy-fenced-cp @${FILE} §7`, passed: false, detail: `第七步 copy 子段：必须恰有一个 canonical cp -r ${INSTALL_TARGET} fenced block（得到 ${copyCpCount}；正文 cp 不算）` });
  if (copyLnCount > 0) out.push({ check: `skill-pack-policy copy-no-ln @${FILE} §7`, passed: false, detail: `第七步 copy 子段：fenced block 不得含 ln -s（得到 ${copyLnCount}）` });
  if (symlinkLnCount !== 1) out.push({ check: `skill-pack-policy symlink-fenced-ln @${FILE} §7`, passed: false, detail: `第七步 symlink 子段：必须恰有一个 canonical ln -s ${INSTALL_TARGET} fenced block（得到 ${symlinkLnCount}；正文 ln 不算）` });
  if (symlinkCpCount > 0) out.push({ check: `skill-pack-policy symlink-no-cp @${FILE} §7`, passed: false, detail: `第七步 symlink 子段：fenced block 不得含 cp -r（得到 ${symlinkCpCount}）` });

  if (out.length === 0) out.push({ check: "skill-pack install policy", passed: true, detail: `install-onboarding.md §7 闭环：copy 子段（默认+cp fence）先于 symlink 子段（仅开发+ln fence+肯定式 trusted/checkout 风险）` });
  return out;
}

/** Extract the inner content of every ``` fenced block in `text` (excludes
 *  fence delimiters and surrounding prose). Used by the install-policy gate so
 *  a bare `cp -r`/`ln -s` in prose cannot pose as a fenced install command. */
function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
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

/** #234: catch docs that recommend bare concurrent-writer CLI maintenance
 *  (compact/dream/enrich/dedup/discover/sync) inside a periodic/cron code
 *  block. These spawn a competing writer while `serve --http` owns the runtime.
 *  Scoped to fenced code blocks that carry a periodic/cron marker, so the CLI
 *  command inventory tables and one-shot non-cron examples are not flagged.
 *  Opt out per-line or per-block with <!-- docs-consistency:ignore-command -->. */
function checkBareMaintenanceCron(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const writerRe = /(^|[\s`'"])cbrain (compact|dream|enrich|dedup|discover|sync)\b/;
  const periodicRe = /(每天|每周|每月|daily|weekly|monthly|every\s+\d+|crontab|定期|periodic)/i;
  for (const [file, raw] of docs) {
    const lines = stripAutoGen(raw).split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trimStart().startsWith("```")) { i++; continue; }
      const blockStart = i;
      const block: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        block.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or EOF)
      const blockText = block.join("\n");
      if (!periodicRe.test(blockText)) continue;
      if (blockText.includes("<!-- docs-consistency:ignore-command -->")) continue;
      block.forEach((bl, idx) => {
        if (bl.includes("<!-- docs-consistency:ignore-command -->")) return;
        const m = bl.match(writerRe);
        if (m) {
          out.push({
            check: `bare maintenance cron @${file}:${blockStart + 1 + idx}`,
            passed: false,
            detail: `"cbrain ${m[2]}" 在 periodic/cron 代码块里裸跑——并发写风险；走 bin/cbrain-maintenance.sh dream 或 MCP 工具（见 docs/hermes-integration.md）`,
          });
        }
      });
    }
  }
  if (out.length === 0) {
    out.push({
      check: "bare maintenance cron",
      passed: true,
      detail: "no bare concurrent-writer CLI in periodic/cron code blocks",
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

/** #316 — collect every tool reference on a line: backticked `tool` AND bare tool
 *  names. Bare names immediately followed by `.` (e.g. `query.md`) are NOT matched,
 *  so skill-file targets are not mistaken for tool names. */
function extractToolRefs(line: string): string[] {
  const tools = new Set<string>();
  for (const m of line.matchAll(/`([a-z_][a-z0-9_]*)`/g)) tools.add(m[1]);
  // Bare names, excluding those followed by `.` (e.g. query.md) or parameter-position
  // chars (`,)}:`) so `cbrain_recall({ query, detail })` does not read the `query`
  // parameter as the `query` tool. Also skip `[flag]` bracketed mode flags and
  // trigger-word lists separated by `、` (e.g. "dossier、RAGmap" — dossier is a user
  // trigger word there, not a tool call).
  for (const m of line.matchAll(/(?<![.\w\[])([a-z_][a-z0-9_]*)(?![.\w,)}:\]、])/g)) tools.add(m[1]);
  return [...tools];
}

/** #316 — Agent contract gate for skills/*.md.
 *  Check 1: an agent-excluded tool must not be positioned as a first choice.
 *  Check 2: `deep_recall` (in allowlist) is a restricted first-choice tool — it
 *  fails when framed as default/first choice WITHOUT an advanced/fallback cue.
 *  `→` is a first-choice cue, but skill-file targets (`xxx.md`) and agent-allowlisted
 *  tools routed via `→` do not trip the gate (debug branches and the front door stay legal).
 *  Per-line opt-out: <!-- docs-consistency:ignore-agent-contract --> */
const AGENT_CONTRACT_IGNORE = "<!-- docs-consistency:ignore-agent-contract -->";
const FIRST_CHOICE_CUES = /(首选|优先|默认|第一选择|一步搞定|default\s+query\s+tool|→)/;
const DEEP_RECALL_ADVANCED_CUES = /(advanced|fine-grained|fine\s+grained|fallback|direct-call\s+only|direct\s+call\s+only|高级|精细参数|降级|escape\s+hatch)/i;
// Check 1 exception: an excluded tool mentioned in an advanced / debug / internal /
// fallback / 禁止 context is a legitimate non-default mention (e.g. recall-resolver
// teaching "advanced escape hatch: summarize"), not default-first-choice drift.
const EXCLUDED_ALLOWED_CUES = /(advanced|fine-grained|fine\s+grained|fallback|direct-call\s+only|escape\s+hatch|debug|internal|降级|精细参数|高级|追问|关键词定位|EXPERIMENTAL|禁止|❌|仅限|仅当|不适用|不要|不能|stub|前置|降级链|上下文发现|maintenance|只读|specialized|pipeline|周报|维护)/i;

/** #316 — low-level recall alternatives Agents might pick INSTEAD of the cbrain_recall
 *  front door. Check 1 targets ONLY these (plus deep_recall via Check 2). Specialized
 *  tools (provenance / merge / profile / insight / timeline / knowledge-map / discovery /
 *  maintenance) are deliberately NOT in this set — they are purpose-built, not
 *  cbrain_recall substitutes, so teaching them is legitimate. */
const RECALL_ALTERNATIVES = new Set([
  "query", "get_chunks", "expand_entity", "summarize", "brain_storm",
  "dossier", "agentic_research", "get_links",
]);

export function checkAgentContractTools(tools: Set<string>, skillsDir: string): CheckResult[] {
  const out: CheckResult[] = [];
  if (!existsSync(skillsDir)) {
    return [{ check: "agent-contract tools", passed: true, detail: "no skills/ dir" }];
  }

  for (const f of readdirSync(skillsDir).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(skillsDir, f), "utf-8");
    text.split("\n").forEach((line, i) => {
      if (line.includes(AGENT_CONTRACT_IGNORE)) return;
      if (!FIRST_CHOICE_CUES.test(line)) return;
      const refs = extractToolRefs(line);
      // Check 1 — excluded tool as first choice (allowed if the line frames it as
      // advanced / debug / internal / fallback / 禁止 — a legitimate non-default mention)
      for (const r of refs) {
        if (RECALL_ALTERNATIVES.has(r) && !EXCLUDED_ALLOWED_CUES.test(line)) {
          out.push({
            check: `agent-contract @skills/${f}:${i + 1}`,
            passed: false,
            detail: `\`${r}\` 不在 agent profile，不应作首选/默认`,
          });
        }
      }
      // Check 2 — deep_recall restricted first-choice
      if (refs.includes("deep_recall") && !DEEP_RECALL_ADVANCED_CUES.test(line)) {
        out.push({
          check: `agent-contract deep_recall @skills/${f}:${i + 1}`,
          passed: false,
          detail: `deep_recall 是 advanced escape hatch，不应作默认/首选（用 cbrain_recall）；本行缺少 advanced/fallback 上下文`,
        });
      }
    });
  }
  if (out.length === 0) {
    out.push({ check: "agent-contract tools", passed: true, detail: "skills 无 excluded/deep_recall 首选漂移" });
  }
  return out;
}

/** #322 — keep the daily Agent on canonical write + operational recall paths.
 * This is deliberately structural and limited to managed skills: public docs
 * may discuss lower-level recovery, but skills are executable Agent policy. */
export function checkAgentWorkflowContract(skillsDir: string): CheckResult[] {
  const out: CheckResult[] = [];
  if (!existsSync(skillsDir)) {
    return [{ check: "agent workflow contract", passed: true, detail: "no skills/ dir" }];
  }

  const files = new Map<string, string>();
  for (const file of readdirSync(skillsDir).filter((name) => name.endsWith(".md"))) {
    files.set(file, readFileSync(join(skillsDir, file), "utf-8"));
  }
  const negativeCue = /(禁止|不得|不要|不能|不允许|严禁|never|do not|must not|bypass|绕过)/i;

  for (const [file, text] of files) {
    text.split("\n").forEach((line, index) => {
      if (/\bwrite_file\b/i.test(line) && !negativeCue.test(line)) {
        out.push({
          check: `agent write bypass @skills/${file}:${index + 1}`,
          passed: false,
          detail: "managed skill positively recommends write_file; CBrain writes must use ingest/put_page",
        });
      }
      if (/(已有|现有|existing).{0,24}(页面|page)?.{0,24}(更新|修改|补充|update)/i.test(line)
        && /\bingest\b(?!\.md)/i.test(line) && !negativeCue.test(line)) {
        out.push({
          check: `agent existing-page route @skills/${file}:${index + 1}`,
          passed: false,
          detail: "existing-page update is routed to ingest; use put_page patch",
        });
      }
    });
  }

  const resolver = files.get("RESOLVER.md") ?? "";
  if (!/(痛点|异常|该处理什么|what to do next)[^\n]*query\.md\s*\[operations\]/i.test(resolver)) {
    out.push({ check: "agent operations resolver", passed: false, detail: "RESOLVER lacks operations route for current problems/next work" });
  }

  const ingest = files.get("ingest.md") ?? "";
  if (!/(新内容|新增内容|new content)[\s\S]{0,120}\bingest\b/i.test(ingest)
    || !/(已有页面|现有页面|existing page)[\s\S]{0,120}\bput_page\b/i.test(ingest)) {
    out.push({ check: "agent create-update split", passed: false, detail: "ingest.md must split new content=ingest and existing page=put_page" });
  }

  const query = files.get("query.md") ?? "";
  if (!/\[operations\][\s\S]{0,500}\bnext_actions\b/i.test(query)) {
    out.push({ check: "agent operations branch", passed: false, detail: "query.md operations branch must call next_actions" });
  }
  if (!/degraded[\s\S]{0,300}(最多一次|at most one)[\s\S]{0,200}(停止|stop)/i.test(query)) {
    out.push({ check: "agent bounded recall fallback", passed: false, detail: "query.md must cap degraded fallback at one attempt and stop" });
  }

  const brainOps = files.get("brain-ops.md") ?? "";
  if (!/Step 5[^#]*\bput_page\b/is.test(brainOps)) {
    out.push({ check: "agent update path", passed: false, detail: "brain-ops Step 5 must update existing pages through put_page" });
  }

  if (out.length === 0) {
    out.push({ check: "agent workflow contract", passed: true, detail: "create/update/operations/fallback paths are canonical and bounded" });
  }
  return out;
}

/** #316 — registered MCP tool descriptions gate. `deep_recall` must not claim to be
 *  the default entry point; `query`'s description must not route natural-language
 *  paths to deep_recall / excluded tools. Scoped to those two tools so legitimate
 *  pipeline descriptions (e.g. dream `sync → enrich → seal`) are not flagged. */
const DEFAULT_CLAIM_RE = /(默认查询工具|默认查询|默认入口|default\s+query\s+tool|默认前门)/i;
const DESC_ADVANCED_CUES = /(advanced|fine-grained|fine\s+grained|fallback|direct-call\s+only|escape\s+hatch|高级|精细参数|降级)/i;
const DESC_ROUTING_RE = /(?:→|请用)\s*`?([a-z_][a-z0-9_]*)`?/g;

export function checkToolDescriptions(tools: ToolInfo[]): CheckResult[] {
  const out: CheckResult[] = [];
  const agentAllow = new Set<string>(AGENT_ALLOWLIST);
  for (const t of tools) {
    if (t.name === "deep_recall" && DEFAULT_CLAIM_RE.test(t.description) && !DESC_ADVANCED_CUES.test(t.description)) {
      out.push({ check: "tool description deep_recall", passed: false, detail: "deep_recall 注册描述仍宣称默认入口（改为 advanced/escape hatch）" });
    }
    if (t.name === "query") {
      for (const m of t.description.matchAll(DESC_ROUTING_RE)) {
        const target = m[1];
        if (!agentAllow.has(target)) {
          out.push({ check: "tool description query", passed: false, detail: `query 描述把路径指向 \`${target}\`（不在 agent profile，应指向 cbrain_recall）` });
        } else if (target === "deep_recall" && !DESC_ADVANCED_CUES.test(t.description)) {
          out.push({ check: "tool description query", passed: false, detail: "query 描述把路径指向 deep_recall，但无 advanced/fallback 上下文（应指向 cbrain_recall）" });
        }
      }
    }
  }
  if (out.length === 0) out.push({ check: "tool descriptions", passed: true, detail: "工具描述已对齐 cbrain_recall 前门" });
  return out;
}

/** #318 — MCP ingest.pageType docs must match the registered schema.
 *  MCP ingest accepts only record|insight. Entity/concept extraction happens
 *  through NER and resolver flows, not by passing entity/concept as pageType.
 *  This intentionally checks hand-written docs, not generated schemas. */
export function checkIngestPageTypeDocs(docs: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const supported = new Set<string>(MCP_INGEST_PAGE_TYPES);
  for (const [file, raw] of docs) {
    const lines = stripAutoGen(raw).split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("pageType")) return;
      if (line.includes("<!-- docs-consistency:ignore-page-type -->")) return;
      const quotedValues = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((value) => value !== "pageType");
      for (const value of quotedValues) {
        if (!supported.has(value)) {
          out.push({
            check: `ingest.pageType @${file}:${i + 1}`,
            passed: false,
            detail: `MCP ingest.pageType 文档声称支持 "${value}"，实际只支持 ${MCP_INGEST_PAGE_TYPES.map((v) => `"${v}"`).join(" | ")}`,
          });
        }
      }
    });
  }
  if (out.length === 0) {
    out.push({
      check: "ingest.pageType contract",
      passed: true,
      detail: `MCP ingest.pageType docs match schema: ${MCP_INGEST_PAGE_TYPES.join("|")}`,
    });
  }
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
    ...checkManifestVersion(),
    ...checkInstallTarget(docs),
    ...checkSkillPackInstallPolicy(docs),
    ...checkCommands(docs, new Set(cli.keys())),
    ...checkSyncRecovery(docs, new Set(cli.keys())),
    ...checkCounts(docs, tools.length, cli.size),
    ...checkBinary(docs),
    ...checkLegacyCronPatterns(docs),
    ...checkBareMaintenanceCron(docs),
    ...checkDailyPatrolContract(docs),
    ...checkToolReferences(docs, new Set(tools.map((t) => t.name))),
    ...checkSkillsToolRefs(docs, new Set(tools.map((t) => t.name))),
    ...checkToolDescriptions(tools),
    ...checkAgentContractTools(new Set(tools.map((t) => t.name)), join(PROJECT_DIR, "skills")),
    ...checkAgentWorkflowContract(join(PROJECT_DIR, "skills")),
    ...checkIngestPageTypeDocs(docs),
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

if (import.meta.main) main();
