// Display-text safety — neutral module shared by action-candidates
// (assertSafeActionDisplay hard guard) and the shadow verifier
// (discovery_display_private_raw observe-only check).
//
// Lives under core/safety/ so neither core/quality nor core/maintenance
// owns it — avoids a quality <-> maintenance circular import (#265).

export const DISPLAY_UNSAFE_PATTERNS = [
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
  /\/Users\//,
  /[A-Z]:\\/,
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
