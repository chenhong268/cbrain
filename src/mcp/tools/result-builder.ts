// Single result serializer for the Phase 1 pilot (#327). Spec §2.1/§5.2/§6.
//
// NOT a prompt-injection boundary (spec §3.2): Hermes merges content + structuredContent.
// "structured" shrinks raw exposure and labels fields; real isolation is G1.
//
// Two redaction layers, both reusing the single rule source in core/safety/display-safety.ts:
//   - sanitizeUntrustedData(data): key projection (SAFE_DATA_KEYS) + string leaves run through
//     sanitizeStructuredText (strip \p{Cc}/\p{Cf} (control + format/bidi classes) → NFKC → DISPLAY_UNSAFE_PATTERNS → SLUG_VALUE_RE).
//     Control chars stripped; cred/path/slug/internal values replaced; NL injection retained (§7.3).
//   - redactAudit(raw): string leaves run against CREDENTIAL_PATH_UNSAFE_PATTERNS only
//     (creds/paths stripped; slug/internal retained — audit's purpose).

import type { ToolSummary } from "./format-result.js";
import type { OutputMode } from "../output-mode.js";
import { sanitizeStructuredText } from "../../core/safety/display-safety.js";
import { redactAudit } from "./audit-redact.js";

export const OUTPUT_SCHEMA_VERSION = 1;
const REMOVED = "[removed]";

/**
 * Structural key allowlist for pilot `data` objects. Keys outside this set are dropped before
 * the value is examined, so internal field names (score / reasonCodes / latencyMs /
 * degraded_reason / …) never appear in structured data (spec §7.1 snake_case/camelCase rows).
 * This is projection by the tool-defined output shape, NOT a regex term list — value content
 * is governed separately by `sanitizeStructuredText` (the shared normalizer). It therefore does
 * not drift against the L1 guard and is not a second rule source (Codex HIGH 2).
 */
const SAFE_DATA_KEYS: ReadonlySet<string> = new Set([
  "from", "to", "hops", "links", "title", "relation", "context",
  "events", "date", "summary", "source",
]);

/** Deep-walk `data`: drop non-allowlist keys; pass string leaves through the shared normalizer. */
export function sanitizeUntrustedData(value: unknown): unknown {
  if (typeof value === "string") {
    // shared normalizer: strip \p{Cc}/\p{Cf} (control + format/bidi classes) + NFKC + L1(credential/path/internal) + slug-value
    return sanitizeStructuredText(value, REMOVED);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeUntrustedData);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SAFE_DATA_KEYS.has(k)) continue; // drop internal/unexpected keys (spec §7.1 snake/camelCase)
      out[k] = sanitizeUntrustedData(v);
    }
    return out;
  }
  return value;
}

export interface BuildToolResultInput {
  mode: OutputMode;
  /** Legacy display (main behavior, may contain vault titles). */
  display: string;
  summary: ToolSummary;
  /** Fixed-template display with NO vault-derived text (used in structured mode). */
  displayStructured: string;
  /** Whitelisted structured summary (status/count/truncated/message + safe enums/numbers only; NO fromTitle/toTitle or other vault-derived fields). Used as-is in structured mode — the builder does NOT spread legacy `summary` (Codex HIGH 1). */
  summaryStructured: ToolSummary;
  /** Untrusted vault-derived structured fields. Sanitized in structured mode. */
  data: Record<string, unknown>;
  /** Full payload — audit source. */
  raw: unknown;
  includeRaw: boolean;
  /** Reproduce main's per-call-site JSON indent for byte-compatible legacy output. */
  legacyIndent?: 0 | 2;
}

type TextContent = { type: "text"; text: string };
export type BuiltToolResult = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function buildToolResult(input: BuildToolResultInput): BuiltToolResult {
  const { mode, display, summary, displayStructured, summaryStructured, data, raw, includeRaw } = input;
  const indent = input.legacyIndent ?? 2;

  if (mode === "legacy") {
    // Byte-compatible with main: {display, summary(legacy), raw}. summaryStructured is ignored.
    const text = JSON.stringify({ display, summary, raw }, null, indent);
    return { content: [{ type: "text", text }] };
  }

  // structured mode: use the whitelisted summaryStructured directly — NOT legacy `summary`,
  // which for graph shortest_path carries fromTitle/toTitle (vault-derived) (Codex HIGH 1).
  const sanitizedData = sanitizeUntrustedData(data) as Record<string, unknown>;
  const redactedRaw = includeRaw ? redactAudit(raw) : null;
  const audit = redactedRaw !== null ? { audit: { raw: redactedRaw } } : {};

  const text = JSON.stringify(
    { schema_version: OUTPUT_SCHEMA_VERSION, display: displayStructured, summary: summaryStructured, data: sanitizedData, ...audit },
    null,
    2,
  );
  const structuredContent: Record<string, unknown> = {
    schema_version: OUTPUT_SCHEMA_VERSION,
    summary: summaryStructured,
    data: sanitizedData,
    ...audit,
  };
  return { content: [{ type: "text", text }], structuredContent };
}
