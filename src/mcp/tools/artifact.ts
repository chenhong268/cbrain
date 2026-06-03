import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { renderArtifact, type ArtifactInput } from "../../core/artifact.js";
import type { PipelineResult } from "../../core/agentic/pipeline.js";
import type { GroundedRecallResult } from "../../core/grounded-answer.js";

function sanitizeFilename(name: string): string | null {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  if (name.endsWith(".html")) return name;
  return `${name}.html`;
}

export function registerArtifactTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "export_grounded_artifact",
    {
      description:
        "导出 grounded recall 或 agentic research 结果为本地 HTML artifact。" +
        "仅在用户明确要求导出/保存/分享时调用。不执行新的检索。",
      inputSchema: {
        result_json: z.string().max(1_000_000).describe("JSON stringified result from deep_recall(grounded) or agentic_research"),
        title: z.string().max(500).optional().describe("Artifact 标题（默认使用查询文本）"),
        filename: z.string().max(200).optional().describe("输出文件名（默认 artifact-{timestamp}.html）"),
        privacy_reviewed: z.boolean().optional().default(false).describe("确认已做隐私审查（含社交/情境内容时必填）"),
        include_social_context: z.boolean().optional().default(false).describe("包含 user_thoughts 等社交情境内容"),
        anonymize: z.boolean().optional().default(false).describe("仅匿名来源标识（slug→实体A/来源A），不保证正文内容脱敏"),
      },
    },
    async ({ result_json, title, filename, privacy_reviewed = false, include_social_context = false, anonymize = false }) => {
      // Privacy gate
      if (include_social_context && !privacy_reviewed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "privacy_gate_blocked",
              message: "包含社交/情境内容需要确认隐私审查。请设置 privacy_reviewed=true。",
            }),
          }],
        };
      }

      // Parse result
      let parsed: unknown;
      try {
        parsed = JSON.parse(result_json);
      } catch {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "invalid_json", message: "result_json 不是合法 JSON" }),
          }],
        };
      }

      // Detect kind
      const input: ArtifactInput =
        parsed !== null && typeof parsed === "object" && "evidence_board" in parsed
          ? { kind: "agentic", data: parsed as PipelineResult }
          : { kind: "grounded", data: parsed as GroundedRecallResult };

      const effectiveTitle = title ?? (input.kind === "agentic" ? input.data.query : input.data.query) ?? "CBrain Artifact";

      // Render
      const html = renderArtifact(input, {
        title: effectiveTitle,
        anonymize,
        includeSocialContext: include_social_context,
      });

      // Write
      const artifactsDir = join(ctx.outputsDir, "artifacts");
      await mkdir(artifactsDir, { recursive: true });

      const effectiveFilename = filename
        ? sanitizeFilename(filename)
        : `artifact-${Date.now()}.html`;

      if (!effectiveFilename) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "invalid_filename", message: "文件名不允许包含路径分隔符或 .." }),
          }],
        };
      }

      const outputPath = join(artifactsDir, effectiveFilename);
      if (!outputPath.startsWith(resolve(artifactsDir) + sep)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "invalid_filename", message: "文件名解析后逃逸出 artifacts 目录" }),
          }],
        };
      }
      await writeFile(outputPath, html, "utf-8");

      const privacyGate = include_social_context
        ? privacy_reviewed ? "passed" : "blocked"
        : "not_required";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            path: outputPath,
            title: effectiveTitle,
            status: input.kind === "agentic" ? (input.data as PipelineResult).status : "ok",
            privacy_gate: privacyGate,
            byte_size: Buffer.byteLength(html, "utf-8"),
            anonymization: anonymize ? "source_labels_only" : "none",
          }),
        }],
      };
    },
  );
}
