import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import type { TrustState, SourceCategory, ProvenanceItem } from "../../core/provenance.js";

export function normalizeForMatch(s: string): string {
  return s.replace(/[\s　，。！？、；：""''（）\]【】《》…—\-,.!?;:'"()<>]/g, "").toLowerCase();
}

const MIN_NORMALIZED_EXCERPT_LEN = 10;

export function excerptInBody(body: string, excerpt: string): boolean {
  const norm = normalizeForMatch(excerpt);
  if (norm.length < MIN_NORMALIZED_EXCERPT_LEN) return false;
  return normalizeForMatch(body).includes(norm);
}

const TRUST_TRANSITION_CATEGORY: Record<string, SourceCategory> = {
  rejected: "correction",
  superseded: "correction",
  candidate: "correction",
};

export function registerProvenanceTools(server: McpServer, ctx: ToolContext): void {
  const provenance = ctx.provenance;

  server.tool(
    "get_provenance",
    "获取知识条目的溯源信息：来源、信任状态、纠正历史",
    {
      target_type: z.enum(["link", "timeline"]).describe("目标类型：link（关系）或 timeline（事件）"),
      target_id: z.number().describe("目标 ID"),
    },
    async ({ target_type, target_id }) => {
      let item: ProvenanceItem | null;
      if (target_type === "link") {
        item = provenance.getLinkProvenance(target_id);
      } else {
        item = provenance.getTimelineProvenance(target_id);
      }

      if (!item) {
        return { content: [{ type: "text" as const, text: `未找到 ${target_type}#${target_id}` }] };
      }

      const history = provenance.getCorrectionHistory(target_type, target_id);

      const lines = [
        `## 溯源信息 (${target_type}#${target_id})`,
        "",
        `**来源类型**: ${item.provenance.source_type}`,
        `**来源分类**: ${item.provenance.source_category}`,
        `**信任状态**: ${item.provenance.trust_state}`,
        `**置信度**: ${item.provenance.confidence}`,
        item.provenance.source_page_slug ? `**来源页面**: ${item.provenance.source_page_slug}` : null,
        item.provenance.evidence ? `**证据**: ${item.provenance.evidence}` : null,
        `**创建时间**: ${item.provenance.created_at}`,
      ].filter(Boolean);

      if (history.length > 0) {
        lines.push("", "### 纠正历史");
        for (const h of history) {
          lines.push(`- ${h.old_trust_state} → ${h.new_trust_state} (${h.source_category})${h.reason ? ` — ${h.reason}` : ""} [${h.created_at}]`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "set_trust_state",
    "设置知识条目的信任状态（仅降级/纠正，不可升级为 trusted）。要将条目升级为 trusted，请使用 confirm_evidence。",
    {
      target_type: z.enum(["link", "timeline"]).describe("目标类型"),
      target_id: z.number().describe("目标 ID"),
      new_state: z.enum(["candidate", "rejected", "superseded"]).describe("新信任状态（只能降级或纠正）"),
      reason: z.string().describe("状态变更原因（必填：为何改变信任状态）"),
    },
    async ({ target_type, target_id, new_state, reason }) => {
      const sourceCategory = (TRUST_TRANSITION_CATEGORY[new_state] ?? "correction") as SourceCategory;
      const ok = provenance.setTrustState(
        target_type,
        target_id,
        new_state as TrustState,
        sourceCategory,
        reason,
      );

      if (!ok) {
        return { content: [{ type: "text" as const, text: `未找到 ${target_type}#${target_id}` }] };
      }

      return { content: [{ type: "text" as const, text: `${target_type}#${target_id} 信任状态已更新为 ${new_state}` }] };
    },
  );

  server.tool(
    "confirm_evidence",
    "用户明确确认一条知识为可信事实。必须提供 confirmation_record_slug（vault 中已存在的页面）和 excerpt（该页面正文中必须包含的确认原文），系统会验证页面存在且 excerpt 出现在页面正文中。仅当用户在对话中明确表示认可时使用。",
    {
      target_type: z.enum(["link", "timeline"]).describe("目标类型"),
      target_id: z.number().describe("目标 ID"),
      confirmation_record_slug: z.string().describe("确认来源页面的 slug（必须存在于 vault 中，如对话记录页、笔记页）"),
      excerpt: z.string().min(10).describe("确认来源页面中的原文片段（至少10字，用于审计追踪）"),
      new_state: z.enum(["trusted", "user_thought"]).optional().default("trusted").describe("确认后的信任状态，默认 trusted"),
    },
    async ({ target_type, target_id, confirmation_record_slug, excerpt, new_state }) => {
      const recordPage = ctx.pages.getBySlug(confirmation_record_slug);
      if (!recordPage) {
        return { content: [{ type: "text" as const, text: `确认来源页面不存在: ${confirmation_record_slug}。confirm_evidence 要求引用 vault 中已存在的页面作为确认依据。` }] };
      }

      // Normalize whitespace/punctuation for robust matching
      if (!excerptInBody(recordPage.body, excerpt)) {
        return { content: [{ type: "text" as const, text: `确认原文未出现在页面 ${confirmation_record_slug} 正文中。excerpt 必须是该页面的真实内容片段。` }] };
      }

      const ok = provenance.setTrustState(
        target_type,
        target_id,
        new_state as TrustState,
        "user_confirmation",
        `确认来源: ${confirmation_record_slug}，原文: ${excerpt}`,
      );

      if (!ok) {
        return { content: [{ type: "text" as const, text: `未找到 ${target_type}#${target_id}` }] };
      }

      return { content: [{ type: "text" as const, text: `${target_type}#${target_id} 已确认为 ${new_state}（确认来源: ${confirmation_record_slug}）` }] };
    },
  );
}
