import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectState {
  updated_at?: string;
  active_work?: string[];
  decisions?: string[];
  blockers?: string[];
  release?: string;
  maintenance?: string;
  notes?: string[];
}

export interface ProjectStateSummary {
  status: "ok" | "empty";
  count: number;
  truncated: boolean;
  message: string;
}

export interface ProjectStateEnvelope {
  display: string;
  summary: ProjectStateSummary;
  result_summary: string;
  raw?: {
    updated_at: string | null;
    state: ProjectState;
  };
}

const DEFAULT_MAX_CHARS = 2000;
const PROJECT_STATE_DIR = "project-state";
const PROJECT_STATE_FILE = "state.json";

export function getProjectStatePath(runtimePath: string): string {
  return join(runtimePath, PROJECT_STATE_DIR, PROJECT_STATE_FILE);
}

export function readProjectState(runtimePath: string): ProjectState | null {
  const path = getProjectStatePath(runtimePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeProjectState(parsed);
  } catch {
    return {
      blockers: ["项目状态记录无法读取，请用 `cbrain project-state --set state.json` 重新写入。"],
    };
  }
}

export function writeProjectState(runtimePath: string, state: ProjectState): void {
  const path = getProjectStatePath(runtimePath);
  mkdirSync(join(runtimePath, PROJECT_STATE_DIR), { recursive: true });
  const normalized = normalizeProjectState({
    ...state,
    updated_at: state.updated_at ?? new Date().toISOString(),
  });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

export function renderProjectStateEnvelope(
  state: ProjectState | null,
  opts: { maxChars?: number; includeRaw?: boolean } = {},
): ProjectStateEnvelope {
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_MAX_CHARS);
  if (!state) {
    const display = "暂无项目状态记录。可以用 `cbrain project-state --set state.json` 显式写入。";
    return {
      display: clamp(display, maxChars),
      summary: { status: "empty", count: 0, truncated: false, message: "暂无项目状态记录" },
      result_summary: "暂无项目状态记录",
    };
  }

  const normalized = normalizeProjectState(state);
  const sections: string[] = [];
  sections.push("CBrain 项目状态");
  if (normalized.updated_at) sections.push(`更新时间：${sanitizeText(normalized.updated_at)}`);
  pushList(sections, "当前工作", normalized.active_work);
  pushList(sections, "近期决策", normalized.decisions);
  pushList(sections, "阻塞/关注", normalized.blockers);
  if (normalized.release) sections.push(`发布状态：${sanitizeText(normalized.release)}`);
  if (normalized.maintenance) sections.push(`维护状态：${sanitizeText(normalized.maintenance)}`);
  pushList(sections, "备注", normalized.notes);

  const fullDisplay = sections.join("\n").trim();
  const display = clamp(fullDisplay, maxChars);
  const truncated = display.length < fullDisplay.length;
  const count = [
    normalized.active_work,
    normalized.decisions,
    normalized.blockers,
    normalized.notes,
  ].reduce((sum, list) => sum + (list?.length ?? 0), 0);

  const envelope: ProjectStateEnvelope = {
    display,
    summary: {
      status: "ok",
      count,
      truncated,
      message: count > 0 ? `${count} 条项目状态信号` : "项目状态记录为空",
    },
    result_summary: count > 0 ? `${count} 条项目状态信号` : "项目状态记录为空",
  };
  if (opts.includeRaw) {
    envelope.raw = { updated_at: normalized.updated_at ?? null, state: normalized };
  }
  return envelope;
}

function pushList(lines: string[], title: string, items?: string[]): void {
  const cleaned = (items ?? []).map(sanitizeText).filter(Boolean).slice(0, 8);
  if (cleaned.length === 0) return;
  lines.push(`\n${title}`);
  for (const item of cleaned) lines.push(`- ${item}`);
}

function normalizeProjectState(input: unknown): ProjectState {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  return {
    updated_at: asString(obj.updated_at),
    active_work: asStringArray(obj.active_work),
    decisions: asStringArray(obj.decisions),
    blockers: asStringArray(obj.blockers),
    release: asString(obj.release),
    maintenance: asString(obj.maintenance),
    notes: asStringArray(obj.notes),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(asString).filter((item): item is string => item !== undefined);
  return out.length ? out.slice(0, 50) : undefined;
}

function sanitizeText(text: string): string {
  return text
    .replace(/\/Users\/[^\s,，。)）]+/g, "[path]")
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/g, "[secret]")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, 300);
}

function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n…已截断";
  return text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix;
}
