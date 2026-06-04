import type { IngestResult } from "../../core/ingest.js";
import type { DialogueIngestResult } from "../../core/dialogue.js";

// ─── Types ──────────────────────────────────────────────────

export interface CaptureEnvelope<T> {
  display: string;
  summary: {
    status: "recorded" | "skipped" | "needs_review";
    title: string | null;
    captured: { entities: number; relations: number; events: number } | null;
    message: string;
  };
  raw: T;
}

// ─── Ingest ─────────────────────────────────────────────────

export function formatIngestResult(
  result: IngestResult,
  effectiveTitle: string,
): CaptureEnvelope<IngestResult> {
  const action = result.created ? "已记住" : "已更新";
  const hasNer = result.ner != null;
  const entities = result.ner?.entities ?? 0;
  const relations = result.ner?.relations ?? 0;
  const events = result.ner?.events ?? 0;

  // Build display — only include non-zero NER counts
  const parts: string[] = [`${action}：${effectiveTitle}。`];

  if (hasNer) {
    const nerParts: string[] = [];
    if (entities > 0) nerParts.push(`${entities} 个实体`);
    if (relations > 0) nerParts.push(`${relations} 条关系`);
    if (events > 0) nerParts.push(`${events} 个事件`);
    if (nerParts.length > 0) parts.push(`提取了${nerParts.join("、")}。`);
  } else if (result.linksExtracted > 0) {
    parts.push(`提取了 ${result.linksExtracted} 个链接。`);
  }

  const display = parts.join("");

  return {
    display,
    summary: {
      status: "recorded",
      title: effectiveTitle,
      captured: hasNer ? { entities, relations, events } : null,
      message: display,
    },
    raw: result,
  };
}

// ─── Dialogue ───────────────────────────────────────────────

const SKIP_REASON_LABELS: Record<string, string> = {
  "empty input": "输入为空",
  "llm error": "暂时没能完成记录，稍后可以再试",
  "parse failed": "暂时没能完成记录，稍后可以再试",
  "no actionable facts": "这段对话没有需要长期记住的新事实",
};

export function formatDialogueResult(
  result: DialogueIngestResult,
): CaptureEnvelope<DialogueIngestResult> {
  if (result.decision === "recorded") {
    const parts: string[] = ["已记住对话中的信息。"];
    const detailParts: string[] = [];
    if (result.newEntities > 0) detailParts.push(`${result.newEntities} 个新实体`);
    if (result.newRelations > 0) detailParts.push(`${result.newRelations} 条新关系`);
    if (result.newEvents > 0) detailParts.push(`${result.newEvents} 个新事件`);
    if (detailParts.length > 0) parts.push(detailParts.join("、") + "。");

    const display = parts.join("");
    return {
      display,
      summary: {
        status: "recorded",
        title: null,
        captured: {
          entities: result.newEntities,
          relations: result.newRelations,
          events: result.newEvents,
        },
        message: display,
      },
      raw: result,
    };
  }

  if (result.decision === "needs_review") {
    const display = "对话内容需要进一步确认。";
    return {
      display,
      summary: {
        status: "needs_review",
        title: null,
        captured: { entities: 0, relations: 0, events: 0 },
        message: display,
      },
      raw: result,
    };
  }

  // decision === "skipped"
  const reasonLabel = SKIP_REASON_LABELS[result.reason ?? ""] ?? "内容已跳过";
  const display = `对话未记录：${reasonLabel}。`;
  return {
    display,
    summary: {
      status: "skipped",
      title: null,
      captured: {
        entities: result.newEntities,
        relations: result.newRelations,
        events: result.newEvents,
      },
      message: display,
    },
    raw: result,
  };
}
