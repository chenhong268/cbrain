import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the phone-number privacy scan in
 * bin/check-resolver-pilot.sh (section 8c).
 *
 * The scan runs `grep -E "$PHONE_PATTERN"` over tests/skills/docs. The ERE
 * used to be `1[3-9][0-9]{9}` with no digit boundary, so grep would slice an
 * 11-digit window out of a longer run of digits and false-positive on large
 * integer literals in the test suite (e.g. a canonical-integer validation
 * fixture). This test pins the boundary semantics by exercising the REAL
 * pattern through the system `grep -E`, never a JavaScript RegExp stand-in.
 *
 * Privacy: every phone-shaped value below is assembled at runtime from short
 * fragments, and every large integer is generated at runtime, so this source
 * file (and therefore the scan target) contains no continuous phone-shaped or
 * credential-shaped value.
 */
const SCRIPT_PATH = join(import.meta.dir, "..", "..", "bin", "check-resolver-pilot.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf-8");

/** The phone ERE the script actually scans with. Throws if the variable is missing. */
function readPhonePattern(): string {
  const match = SCRIPT.match(/^PHONE_PATTERN=['"]([^'"]+)['"]/m);
  if (!match) {
    throw new Error("PHONE_PATTERN variable not found in bin/check-resolver-pilot.sh");
  }
  return match[1];
}

/**
 * Run the system `grep -E` against a single line of input and report whether
 * it matches. Mirrors the script's own `grep -E "$PHONE_PATTERN"` semantics.
 * Exit 1 means "no match" (normal); any other non-zero status is re-thrown so
 * a malformed pattern surfaces instead of looking like a clean non-match.
 */
function grepEMatches(pattern: string, input: string): boolean {
  try {
    const out = execFileSync("grep", ["-E", "--", pattern], {
      input: `${input}\n`,
      encoding: "utf-8",
    });
    return out.length > 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return false;
    throw err;
  }
}

describe("check-resolver-pilot phone privacy pattern", () => {
  test("script defines PHONE_PATTERN and the PHONE_HITS scan consumes it", () => {
    // The constant under test must be the one the real scan uses, otherwise the
    // pattern exercised below could drift from the pattern that gates releases.
    expect(SCRIPT).toMatch(/^PHONE_PATTERN=['"]/m);
    expect(SCRIPT).toMatch(/PHONE_HITS=.*\$\{?PHONE_PATTERN\}?/);
  });

  // Synthetic 11-digit CN mobile candidate. Fragments are each far below the
  // 11-digit candidate length, so the source holds no continuous phone value.
  const PHONE_CANDIDATE = ["139", "1234", "5678"].join("");
  // Large-integer boundary values, generated at runtime (no literal long digit
  // run in source). These are the shape of input that used to false-positive.
  const HUGE_INT = String(Number.MAX_SAFE_INTEGER);
  const HUGE_INT_PLUS_ONE = String(Number.MAX_SAFE_INTEGER + 1);

  test("synthetic candidate is 11 digits with second digit in [3-9]", () => {
    // Fixture sanity only — the production pattern is exercised via system
    // grep -E below. Guards against assembling the fixture wrong.
    expect(PHONE_CANDIDATE).toHaveLength(11);
    const second = Number(PHONE_CANDIDATE[1]);
    expect(second).toBeGreaterThanOrEqual(3);
    expect(second).toBeLessThanOrEqual(9);
  });

  test("standalone candidate is detected", () => {
    expect(grepEMatches(readPhonePattern(), PHONE_CANDIDATE)).toBe(true);
  });

  test("punctuation-wrapped candidate is detected", () => {
    expect(grepEMatches(readPhonePattern(), `(${PHONE_CANDIDATE})`)).toBe(true);
  });

  test("digit-prefixed candidate is NOT detected", () => {
    expect(grepEMatches(readPhonePattern(), `9${PHONE_CANDIDATE}`)).toBe(false);
  });

  test("digit-suffixed candidate is NOT detected", () => {
    expect(grepEMatches(readPhonePattern(), `${PHONE_CANDIDATE}0`)).toBe(false);
  });

  test("candidate flanked by digits on both sides is NOT detected", () => {
    expect(grepEMatches(readPhonePattern(), `9${PHONE_CANDIDATE}0`)).toBe(false);
  });

  test("huge integer (MAX_SAFE_INTEGER) is NOT detected", () => {
    expect(grepEMatches(readPhonePattern(), HUGE_INT)).toBe(false);
  });

  test("huge integer (MAX_SAFE_INTEGER + 1) is NOT detected", () => {
    expect(grepEMatches(readPhonePattern(), HUGE_INT_PLUS_ONE)).toBe(false);
  });

  test("unrelated 11-digit value not starting with 1[3-9] is NOT detected", () => {
    // Keeps the body rule honest: not every 11-digit run is a candidate, only
    // one beginning with 1[3-9]. Second digit here is 0 (outside [3-9]).
    const unrelated = `1${"0".repeat(10)}`;
    expect(unrelated).toHaveLength(11);
    expect(grepEMatches(readPhonePattern(), unrelated)).toBe(false);
  });
});
