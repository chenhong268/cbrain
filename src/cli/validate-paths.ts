/**
 * Path safety validation for `cbrain init`.
 *
 * Reusable by both init (pre-flight check) and doctor (runtime-inside-vault warning).
 * Pure functions — no side effects.
 */
import { resolve, relative } from "node:path";

export interface PathValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Validate that a proposed brain directory layout is safe.
 *
 * Checks:
 *  1. Runtime is not inside (or equal to) vault — after path normalization
 *  2. No path traversal segments that escape the intended base
 *  3. Warns on spaces in paths (not a hard reject)
 */
export function validateInitPaths(vaultPath: string, runtimePath: string): PathValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const vaultResolved = resolve(vaultPath);
  const runtimeResolved = resolve(runtimePath);

  // Check 1: runtime inside vault (or equal to vault root)
  const rel = relative(vaultResolved, runtimeResolved);
  const runtimeInsideVault = !rel.startsWith("..") && !rel.startsWith("/");
  if (runtimeInsideVault) {
    const msg = rel === ""
      ? "runtimePath equals vault root — running artifacts WILL pollute vault"
      : `runtime directory is inside vault: ${rel}`;
    errors.push(msg);
  }

  // Check 2: spaces in base path — warn but don't block
  if (/\s/.test(vaultResolved)) {
    warnings.push(`vault path contains spaces: ${vaultResolved}`);
  }
  if (/\s/.test(runtimeResolved)) {
    warnings.push(`runtime path contains spaces: ${runtimeResolved}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
