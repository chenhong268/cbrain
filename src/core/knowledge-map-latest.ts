import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPORT_DIR_NAME = "knowledge-map";
const REPORT_DATE_RE = /^knowledge-map-(\d{4}-\d{2}-\d{2})\.md$/;

export interface LatestKnowledgeMapReport {
  /** Report date parsed from the filename (YYYY-MM-DD). */
  date: string;
  /** Filename, e.g. knowledge-map-2026-06-28.md. */
  filename: string;
  /** Full UTF-8 Markdown content. */
  markdown: string;
}

/**
 * #243 — find and read the newest generated Knowledge Map report under
 * `<outputsDir>/knowledge-map/`. Newest is chosen by the filename date
 * (deterministic), not mtime. Returns null when the directory is missing, no
 * dated report exists, or the file is unreadable — callers surface a graceful
 * empty/degraded envelope.
 */
export function readLatestKnowledgeMap(outputsDir: string): LatestKnowledgeMapReport | null {
  const dir = join(outputsDir, REPORT_DIR_NAME);
  if (!existsSync(dir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const dated: Array<{ filename: string; date: string }> = [];
  for (const f of entries) {
    const m = f.match(REPORT_DATE_RE);
    if (m) dated.push({ filename: f, date: m[1] });
  }
  if (dated.length === 0) return null;

  // Sort newest first by date string (YYYY-MM-DD compares lexicographically).
  dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const newest = dated[0];

  let markdown: string;
  try {
    markdown = readFileSync(join(dir, newest.filename), "utf-8");
  } catch {
    return null;
  }

  return { date: newest.date, filename: newest.filename, markdown };
}
