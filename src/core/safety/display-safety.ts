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
  /\bentity\/[^\s]+/i,
  /\bconcept\/[^\s]+/i,
  /\brecords?\//i,
  /\/Users\//,
  /[A-Z]:\\/,
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
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

export function assertSafeActionDisplay(text: string): void {
  for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`unsafe display text for action candidate: ${pattern}`);
    }
  }
}
