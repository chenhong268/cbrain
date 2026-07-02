/**
 * Deterministic content classifier for the ingest pipeline.
 *
 * Decides whether content should be treated as markdown (with frontmatter)
 * or plain text, without any LLM calls. Reuses the project's parseFrontmatter
 * for robust YAML/frontmatter handling.
 */

import { parseFrontmatter } from "../../utils/frontmatter.js";

const SUPPORTED_FM_FIELDS = new Set(["title", "type", "slug", "tags"]);

const SEMANTIC_CHAR_RE = /[\p{Script=Han}\p{L}\d]/u;

/**
 * Determine whether content should be treated as markdown or plain text.
 *
 * Rules:
 *   - Explicit type is always respected
 *   - No explicit type + content starts with `---` AND parseFrontmatter
 *     yields at least one supported field (title/type/slug/tags) → markdown
 *   - Everything else → text
 */
export function classifyContentType(
  content: string,
  explicitType?: "markdown" | "text",
): "markdown" | "text" {
  if (explicitType) return explicitType;

  if (!content.startsWith("---")) return "text";

  try {
    const { frontmatter } = parseFrontmatter(content);
    // frontmatter must be a non-null object (gray-matter returns {} for empty FM)
    if (!frontmatter || typeof frontmatter !== "object") return "text";

    for (const field of SUPPORTED_FM_FIELDS) {
      const value = (frontmatter as Record<string, unknown>)[field];
      if (value !== undefined && value !== null) return "markdown";
    }
  } catch {
    // Malformed frontmatter → treat as text
    return "text";
  }

  return "text";
}

/**
 * Check if a string has any semantic content (letters, CJK characters, or digits).
 * Used to reject pure-punctuation or empty input before any file/DB writes.
 */
export function hasSemanticContent(text: string): boolean {
  return SEMANTIC_CHAR_RE.test(text);
}
