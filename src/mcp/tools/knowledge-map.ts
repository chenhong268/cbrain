import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import type { ToolSummary } from "./format-result.js";
import { readLatestKnowledgeMap, type LatestKnowledgeMapReport } from "../../core/knowledge-map-latest.js";

// Display budget — cap section items so the default envelope stays compact.
const MAX_DOMAINS = 5;
const MAX_BRIDGES = 5;
const MAX_GAPS = 5;

/** MCP `raw` payload — bounded, no absolute filesystem paths (filename only). */
interface KnowledgeMapRaw {
  report_date: string | null;
  filename: string | null;
  markdown?: string;
}

interface KnowledgeMapEnvelope {
  display: string;
  summary: ToolSummary;
  result_summary: string;
  raw?: KnowledgeMapRaw;
}

export function registerKnowledgeMapTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "read_knowledge_map",
    {
      description:
        "【知识图谱】读取最近一次生成的知识图谱报告（由每周 dream 的 knowledge-map 阶段或 `cbrain knowledge-map` 生成）。" +
        "回答：我的知识图谱长什么样 / 哪些领域成熟 / 哪些领域成长中 / 哪些条目桥接多个领域 / 哪些条目孤立。" +
        "默认返回精简摘要（display/summary/result_summary），不含 slug、权重、置信度等内部字段。" +
        "需要完整报告 Markdown 时传 include_raw=true。只读，不重算图谱。",
      inputSchema: {
        include_raw: z
          .boolean()
          .optional()
          .describe("true=在 raw.markdown 返回完整报告原文（含调试附录，仅开发用）；默认 false 只返回精简摘要"),
      },
    },
    async ({ include_raw }: { include_raw?: boolean }) => {
      const report = readLatestKnowledgeMap(ctx.outputsDir);
      const envelope = buildEnvelope(report, include_raw === true);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      };
    },
  );
}

/** Build the user-facing envelope from the latest report (or a graceful empty one). */
function buildEnvelope(report: LatestKnowledgeMapReport | null, includeRaw: boolean): KnowledgeMapEnvelope {
  if (!report) {
    const empty =
      "CBrain 还没有生成知识图谱报告。运行 `cbrain knowledge-map` 立即生成，或等待每周 dream 的 knowledge-map 阶段自动生成。";
    const summary: ToolSummary = {
      status: "empty",
      count: 0,
      truncated: false,
      message: "暂无知识图谱报告",
      next_steps: [
        "运行 `cbrain knowledge-map` 立即生成报告",
        "或等待每周 dream 自动生成（knowledge-map 阶段）",
      ],
    };
    return { display: empty, summary, result_summary: "暂无知识图谱报告" };
  }

  const { display, summary, resultSummary } = renderDisplay(report);
  const envelope: KnowledgeMapEnvelope = { display, summary, result_summary: resultSummary };
  if (includeRaw) {
    envelope.raw = { report_date: report.date, filename: report.filename, markdown: report.markdown };
  }
  return envelope;
}

/**
 * Render a compact, item-capped display from the report Markdown. Strips the
 * #241 debug appendix (which carries slugs/JSON) so the default display never
 * leaks internals, drops the original title (replaced by a dated header), and
 * caps domains / bridges / gaps to keep the first read short.
 */
function renderDisplay(report: LatestKnowledgeMapReport): {
  display: string;
  summary: ToolSummary;
  resultSummary: string;
} {
  const body = stripDebugAppendix(report.markdown);
  const lines = body.split("\n");

  let overview = "";
  let section = "";
  let domains = 0;
  let bridges = 0;
  let gaps = 0;
  let skipDomainCore = false;
  let truncated = false;
  const out: string[] = [`CBrain 已生成知识图谱报告（${report.date}）。`, ""];

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.startsWith("# 知识图谱报告")) continue; // title replaced by the dated header
    if (overview === "" && trimmed !== "" && !line.startsWith("#")) {
      overview = trimmed;
      out.push(overview, "");
      continue;
    }
    if (line.startsWith("## ")) {
      section = trimmed;
      skipDomainCore = false;
      out.push(line);
      continue;
    }
    if (line.startsWith("### ")) {
      if (section.startsWith("主要领域")) {
        domains += 1;
        skipDomainCore = domains > MAX_DOMAINS;
        if (skipDomainCore) {
          truncated = true;
          continue;
        }
      }
      out.push(line);
      continue;
    }
    if (skipDomainCore && trimmed.startsWith("核心条目")) continue; // core line of a dropped domain
    if (line.startsWith("- ")) {
      if (section.startsWith("桥接节点")) {
        bridges += 1;
        if (bridges > MAX_BRIDGES) {
          truncated = true;
          continue;
        }
      } else if (section.startsWith("孤立与弱连接")) {
        gaps += 1;
        if (gaps > MAX_GAPS) {
          truncated = true;
          continue;
        }
      }
    }
    out.push(line);
  }

  const display = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const summary: ToolSummary = {
    status: "ok",
    count: domains,
    truncated,
    message: overview || `知识图谱报告（${report.date}）`,
  };
  return { display, summary, resultSummary: summary.message };
}

/**
 * Drop the #241 debug appendix. It is introduced by a horizontal rule (`---`)
 * followed by `## 调试附录`; everything from that rule onward carries internal
 * slugs/JSON and must not reach the default display.
 */
function stripDebugAppendix(markdown: string): string {
  const idx = markdown.indexOf("## 调试附录");
  if (idx === -1) return markdown;
  const before = markdown.slice(0, idx);
  const ruleIdx = before.lastIndexOf("\n---");
  return (ruleIdx !== -1 ? markdown.slice(0, ruleIdx) : before).trimEnd();
}
