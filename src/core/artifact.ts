import type { PipelineResult, PipelineStatus } from "./agentic/pipeline.js";
import type { Confidence } from "./grounded-answer.js";
import type { GroundedRecallResult } from "./grounded-answer.js";

// ─── Types ────────────────────────────────────────────────────

export type ArtifactInput =
  | { kind: "agentic"; data: PipelineResult }
  | { kind: "grounded"; data: GroundedRecallResult };

export interface RenderOptions {
  title: string;
  anonymize: boolean;
  includeSocialContext: boolean;
}

interface RenderedSection {
  id: string;
  title: string;
  items: string[];
}

// ─── Constants ────────────────────────────────────────────────

const MAX_CLAIMS = 10;
const MAX_EVIDENCE = 20;
const MAX_GAPS = 5;
const MAX_CLAIM_LENGTH = 100;
const MAX_EXCERPT_LENGTH = 200;

const BLOCKED_FIELDS = [
  "plan", "execution", "critic", "follow_up_execution", "follow_up_critic",
  "trace_summary", "budgetUsed", "budget", "steps", "passCount", "totalSteps",
  "totalMs", "degradedReason", "resolvedSlugs", "traceSessionId",
] as const;

// ─── HTML Escaping ────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

// ─── Anonymization ────────────────────────────────────────────

export class Anonymizer {
  private readonly map = new Map<string, string>();
  private entityIdx = 0;
  private sourceIdx = 0;

  label(slug: string): string {
    const existing = this.map.get(slug);
    if (existing) return existing;

    const label = slug.includes("/")
      ? `来源${this.nextLabel("source")}`
      : `实体${this.nextLabel("entity")}`;
    this.map.set(slug, label);
    return label;
  }

  private nextLabel(kind: "entity" | "source"): string {
    if (kind === "entity") {
      return String.fromCodePoint(0x41 + this.entityIdx++); // A, B, C...
    }
    return String.fromCodePoint(0x41 + this.sourceIdx++);
  }
}

// ─── Extraction ───────────────────────────────────────────────

interface ExtractedData {
  status: PipelineStatus | "ok";
  confidence: Confidence;
  claims: string[];
  facts: string[];
  userThoughts: string[];
  candidates: string[];
  conflicts: string[];
  gaps: string[];
  sources: string[];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function extractAgentic(result: PipelineResult): ExtractedData {
  const ctx = result.answer_context;
  const board = result.evidence_board;

  return {
    status: result.status,
    confidence: ctx.confidence,
    claims: ctx.topClaims.slice(0, MAX_CLAIMS).map((c) => truncate(c, MAX_CLAIM_LENGTH)),
    facts: board.facts.slice(0, MAX_EVIDENCE).map((f) => truncate(f.claim, MAX_EXCERPT_LENGTH)),
    userThoughts: board.user_thoughts.map((t) => truncate(t.claim, MAX_EXCERPT_LENGTH)),
    candidates: board.candidates.map((c) => truncate(c.claim, MAX_EXCERPT_LENGTH)),
    conflicts: board.conflicts.map((c) => truncate(c.claim, MAX_EXCERPT_LENGTH)),
    gaps: ctx.gaps.slice(0, MAX_GAPS).map((g) => truncate(g, MAX_EXCERPT_LENGTH)),
    sources: ctx.sourceSlugs.map((s) => s.slug),
  };
}

function extractGrounded(result: GroundedRecallResult): ExtractedData {
  return {
    status: "ok" as const,
    confidence: result.confidence,
    claims: result.answer ? [truncate(result.answer, MAX_CLAIM_LENGTH)] : [],
    facts: result.facts.slice(0, MAX_EVIDENCE).map((f) => truncate(f, MAX_EXCERPT_LENGTH)),
    userThoughts: result.user_thoughts,
    candidates: result.candidates,
    conflicts: result.conflicts,
    gaps: result.gaps.slice(0, MAX_GAPS).map((g) => truncate(g, MAX_EXCERPT_LENGTH)),
    sources: result.sources.map((s) => s.slug),
  };
}

// ─── Rendering ────────────────────────────────────────────────

function confidenceBadge(c: Confidence): string {
  const labels: Record<Confidence, string> = { high: "高", medium: "中", low: "低" };
  const colors: Record<Confidence, string> = {
    high: "#16a34a",
    medium: "#d97706",
    low: "#dc2626",
  };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;color:#fff;background:${colors[c]}">置信度：${labels[c]}</span>`;
}

function statusBadge(s: PipelineStatus | "ok"): string {
  const labels: Record<string, string> = {
    ok: "完整",
    partial: "部分",
    insufficient: "不足",
    degraded: "降级",
  };
  const colors: Record<string, string> = {
    ok: "#16a34a",
    partial: "#d97706",
    insufficient: "#dc2626",
    degraded: "#9333ea",
  };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;color:#fff;background:${colors[s] ?? "#6b7280"}">状态：${labels[s] ?? s}</span>`;
}

function renderSection(
  section: RenderedSection,
  esc: (s: string) => string,
  tag?: string,
): string {
  if (section.items.length === 0) return "";
  const itemHtml = section.items
    .map((item) => `<li>${esc(item)}</li>`)
    .join("\n");
  const badge = tag ? ` <span style="font-size:11px;color:#9333ea">${esc(tag)}</span>` : "";
  return `<h3>${esc(section.title)}${badge}</h3>\n<ul>${itemHtml}</ul>`;
}

export function renderArtifact(input: ArtifactInput, options: RenderOptions): string {
  const data: ExtractedData =
    input.kind === "agentic"
      ? extractAgentic(input.data)
      : extractGrounded(input.data);

  const anon = options.anonymize ? new Anonymizer() : null;

  const esc = (s: string): string => {
    let result = escapeHtml(s);
    if (anon) {
      // Replace slug-like patterns
      result = result.replace(/entities\/[\w-]+/g, (match) => anon.label(match));
      result = result.replace(/concepts\/[\w-]+/g, (match) => anon.label(match));
      result = result.replace(/records\/[\w-]+/g, (match) => anon.label(match));
    }
    return result;
  };

  // Anonymize source slugs
  const sourceLabels = data.sources.map((s) =>
    anon ? anon.label(s) : s.split("/").pop() ?? s,
  );

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  const sections: string[] = [];

  // 核心结论
  if (data.claims.length > 0) {
    sections.push(renderSection({ id: "claims", title: "核心结论", items: data.claims }, esc));
  }

  // 已验证证据
  sections.push(renderSection({ id: "facts", title: "已验证证据", items: data.facts }, esc));

  // 你的观点（社交情境）
  if (options.includeSocialContext && data.userThoughts.length > 0) {
    sections.push(
      renderSection(
        { id: "thoughts", title: "你的观点", items: data.userThoughts },
        esc,
        "社交情境",
      ),
    );
  }

  // 待确认
  if (data.candidates.length > 0) {
    sections.push(
      renderSection(
        { id: "candidates", title: "待确认", items: data.candidates },
        esc,
        "可能/待确认",
      ),
    );
  }

  // 矛盾点
  if (data.conflicts.length > 0) {
    sections.push(renderSection({ id: "conflicts", title: "矛盾点", items: data.conflicts }, esc));
  }

  // 尚未覆盖的角度
  if (data.gaps.length > 0) {
    sections.push(
      renderSection({ id: "gaps", title: "尚未覆盖的角度", items: data.gaps }, esc),
    );
  }

  const sourceLine =
    sourceLabels.length > 0 ? `<p style="color:#6b7280;font-size:12px">来源：${esc(sourceLabels.join("、"))}</p>` : "";

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(options.title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#1f2937;line-height:1.6}
h1{font-size:20px;border-bottom:1px solid #e5e7eb;padding-bottom:8px}
h3{font-size:16px;margin:20px 0 8px;color:#374151}
ul{padding-left:20px;margin:4px 0}
li{margin:4px 0;font-size:14px}
</style>
</head>
<body>
<h1>${esc(options.title)}</h1>
<p>${statusBadge(data.status)} ${confidenceBadge(data.confidence)}</p>
${sections.join("\n")}
${sourceLine}
<hr>
${anon ? '<p style="color:#d97706;font-size:11px">⚠️ 仅来源标识已匿名，正文内容可能包含可识别信息。分享前请确认。</p>' : ""}
<p style="color:#9ca3af;font-size:11px">Generated by CBrain · ${esc(now)}</p>
</body>
</html>`;

  return html;
}

// ─── Internal Field Verification ──────────────────────────────

export const BLOCKED_FIELD_PATTERNS = BLOCKED_FIELDS;
