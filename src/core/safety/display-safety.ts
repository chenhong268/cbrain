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
];

export function assertSafeActionDisplay(text: string): void {
  for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`unsafe display text for action candidate: ${pattern}`);
    }
  }
}
