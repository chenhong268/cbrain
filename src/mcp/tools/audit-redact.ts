// Redaction for the opt-in audit payload (#327 Phase 1). Spec §5.1 L1 invariant: credentials
// and absolute paths are NEVER output — including audit. slug/id/internal/debug ARE retained
// (audit exists so a reviewer can trace why). Therefore this strips ONLY credentials + paths,
// using the shared CREDENTIAL_PATH_UNSAFE_PATTERNS — it does NOT redeclare any regex (Codex
// HIGH 1: single rule source). Slug/internal stripping for the `data` field is a different
// layer (sanitizeUntrustedData in result-builder.ts, which uses the full DISPLAY_UNSAFE_PATTERNS).

import { CREDENTIAL_PATH_UNSAFE_PATTERNS } from "../../core/safety/display-safety.js";

const REDACTED = "[redacted]";

function isCredentialOrPath(value: string): boolean {
  return CREDENTIAL_PATH_UNSAFE_PATTERNS.some((p) => p.test(value));
}

/** Recursively strip credentials + absolute paths; retain slug/id/internal/debug. */
export function redactAudit(value: unknown): unknown {
  if (typeof value === "string") {
    return isCredentialOrPath(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactAudit);
  }
  if (value && typeof value === "object") {
    // Class-object leaves (Date/Map/Set/RegExp/...) have no enumerable own props —
    // Object.entries would yield {} and silently drop them. Timeline audit carries Date
    // timestamps that must be retained. They are not carriers that the credential/path
    // patterns would redact, so return as-is (JSON.stringify handles serialization).
    if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactAudit(v);
    }
    return out;
  }
  return value;
}
