// CBRAIN_OUTPUT_BOUNDARY selects how pilot tools serialize results:
//   "legacy"     — byte-compatible with main ({display, summary, raw}). Rollout default.
//                  Time-boxed grayscale/rollback channel; does NOT satisfy the structured
//                  redaction contract (raw is still in text). Spec §5.2/§6.
//   "structured" — fixed-template display + sanitized data text + structuredContent mirror;
//                  raw only via explicit include_raw (redacted audit).
// Spec §0/§3.2: NEITHER mode isolates vault data from model context — Hermes merges
// content + structuredContent. "structured" is labeling + raw shrink, NOT a prompt-injection
// boundary. Real isolation needs G1 (Hermes host-side contract, cross-repo).

export type OutputMode = "legacy" | "structured";

export const OUTPUT_MODE_ENV = "CBRAIN_OUTPUT_BOUNDARY";

const VALID_OUTPUT_MODES: ReadonlySet<OutputMode> = new Set(["legacy", "structured"]);

/** Env wins when valid; anything else falls back to "legacy" (rollout default, spec §5.2). */
export function resolveOutputMode(env?: string): OutputMode {
  const v = env?.trim().toLowerCase();
  if (v && VALID_OUTPUT_MODES.has(v as OutputMode)) return v as OutputMode;
  return "legacy";
}
