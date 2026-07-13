// Display-text safety — neutral module shared by action-candidates
// (assertSafeActionDisplay hard guard) and the shadow verifier
// (discovery_display_private_raw observe-only check).
//
// Lives under core/safety/ so neither core/quality nor core/maintenance
// owns it — avoids a quality <-> maintenance circular import (#265).

// Internal identifier / slug / SQL leakage. Shared subset of DISPLAY_UNSAFE_PATTERNS.
export const INTERNAL_IDENTIFIER_UNSAFE_PATTERNS: readonly RegExp[] = [
  /\bscore\b/i,
  /\bdedup_key\b/i,
  /\bdebug\b/i,
  /\bmetadata\b/i,
  /\bsql\b/i,
  /\bselect\s+\*\s+from\b/i,
  // #311 secrecy hardening — destructive SQL (DROP/DELETE/INSERT/UPDATE/TRUNCATE/ALTER)
  // was NOT caught by the SELECT-only pattern; a hostile page title like "DROP TABLE x; --"
  // leaked via safeTitle into a proactive card.
  /\b(?:drop|delete|insert|update|truncate|alter)\s+(?:table|from|into|index)\b/i,
  /\bentity\/[^\s]+/i,
  /\bconcept\/[^\s]+/i,
  /\brecords?\//i,
];

// Credentials + absolute paths. Shared by the L1 display guard and the opt-in audit redactor
// so there is a single rule source (no duplicated regex — #327 Codex HIGH 1).
export const CREDENTIAL_PATH_UNSAFE_PATTERNS: readonly RegExp[] = [
  /\/Users\//,
  /[A-Z]:\\/,
  // Any POSIX absolute path, including /Library, /Applications, /bin, and
  // single-segment roots. The boundary plus (?!\/) deliberately excludes
  // URL schemes such as https://example.test/path.
  /(?:^|[\s"'`(])\/(?!\/)[^/\s"'`()]+(?:\/[^\s"'`)]*)?/,
  // #311 secrecy hardening — sensitive Unix absolute paths (/etc/passwd, /root/.ssh, ...)
  // were NOT caught by the /Users/-only pattern.
  /\/(?:etc|root|var|proc|sys|home|tmp|opt|usr|private|mnt|srv|boot|dev)\//i,
  // Secret / credential class. #309 review fix — display-safety was originally blind to
  // these (designed only for slug/path/score/SQL). project-state.ts:146 already established
  // the in-repo precedent that sk-/Bearer are secrets that must be redacted; this brings
  // the display guard to parity. Without these, a corrupted persisted discovery row could
  // echo Bearer/sk-/password/PEM/AKIA/ghp_/JWT verbatim into display + items[].
  /\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/i,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // #311 secrecy hardening (pre-existing #309 gap surfaced by adversarial review) — the
  // old {8,}-on-first-segment regex missed common short-header JWTs. First segment only
  // needs 1+ post-eyJ chars; require non-trivial payload + signature segments.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/,
];

// L1 display guard — sole deterministic rule source for what must not reach display/data.
// Composed from the two subsets above; exact order is locked by
// tests/mcp/safety-rule-source.test.ts. Do not add patterns here without amending the spec.
export const DISPLAY_UNSAFE_PATTERNS: readonly RegExp[] = [
  ...INTERNAL_IDENTIFIER_UNSAFE_PATTERNS,
  ...CREDENTIAL_PATH_UNSAFE_PATTERNS,
];

export function assertSafeActionDisplay(text: string): void {
  for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`unsafe display text for action candidate: ${pattern}`);
    }
  }
}

// Non-throwing variant for display builders that compose user-facing text from
// partially-external fields (e.g. proactive-review-bridge assembling evidence
// dateRange from a discovery eventDate). Returns the fallback on the first
// unsafe match instead of throwing, so a single bad field cannot sink the whole
// candidate render. Shares DISPLAY_UNSAFE_PATTERNS as the single source of truth.
export function sanitizeDisplayText(text: string, fallback: string): string {
  for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
    if (pattern.test(text)) return fallback;
  }
  return text;
}

// ─── Shared structured-text normalizer (spec §7.1 slug-value + Unicode-control rows) ───
// Consumed ONLY by sanitizeUntrustedData (structured `data`). It does not alter legacy control
// flow; the absolute-path rule above intentionally hardens all safety consumers.

// C0/C1 control (\p{Cc}) + format/bidi controls (\p{Cf} — incl. U+00AD SOFT HYPHEN, U+061C ARABIC
// LETTER MARK, U+180E MONGOLIAN VOWEL SEPARATOR, U+200B-200F, U+202A-202E bidi, U+2060-2064 invisible
// function controls, U+2066-2069 isolates, U+FEFF) — STRIPPED, surrounding text kept (spec §7.1).
// NFKC does NOT remove these, so this is an explicit strip. Defined by Unicode CLASS, not a hand-
// maintained code-point list (a list would miss e.g. U+00AD/U+061C/U+180E/U+2060 — Codex 4th review).
// Deliberately excludes \p{Zl}/\p{Zp} (U+2028/U+2029) — spec §7.1 names Cc/Cf only. The `u` flag
// enables Unicode property escapes (runtime supports them — format-result.ts already uses \p{Cf}).
export const UNICODE_CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;

// Slug-path VALUE detection — covers the plural "entities/..." real slugs use plus the
// "brain/" prefix, which DISPLAY_UNSAFE_PATTERNS' singular entity/concept/records miss.
export const SLUG_VALUE_RE = /(?:brain\/)?(?:entities|concepts|insights|records|events)\/[^\s/]+/i;

/**
 * Shared structured-text normalizer for untrusted `data` string leaves (spec §7.1).
 *  1. strip \p{Cc}/\p{Cf} (control + format/bidi classes) control chars (surrounding text kept — NOT whole-leaf redact);
 *  2. NFKC normalize (full-width ｓｃｏｒｅ → score);
 *  3. credential/path/internal (DISPLAY_UNSAFE_PATTERNS) or slug-value (SLUG_VALUE_RE) match
 *     → `fallback` (whole-leaf replace).
 * NL injection is retained (CBrain does not delete on the host's behalf — §7.3).
 *
 * UNICODE_CONTROL_RE + SLUG_VALUE_RE are NEW, but they live in this single rule source and
 * do not modify DISPLAY_UNSAFE_PATTERNS / sanitizeDisplayText, so main display behavior is
 * unchanged (legacy byte-compat). Only structured `data` is affected.
 */
export function sanitizeStructuredText(text: string, fallback: string): string {
  const stripped = text.replace(UNICODE_CONTROL_RE, "");
  const normalized = stripped.normalize("NFKC");
  if (DISPLAY_UNSAFE_PATTERNS.some((p) => p.test(normalized))) return fallback;
  if (SLUG_VALUE_RE.test(normalized)) return fallback;
  return normalized;
}
