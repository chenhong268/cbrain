import { describe, test, expect } from "bun:test";
import { redactAudit } from "../../src/mcp/tools/audit-redact.js";
import { CREDENTIAL_PATH_UNSAFE_PATTERNS } from "../../src/core/safety/display-safety.js";

describe("redactAudit (#327)", () => {
  test("strips credentials anywhere in the payload", () => {
    expect(redactAudit({
      token: "Bearer eyJhbGciOiJI.J9x8.signature1234",
      key: "sk-abcd1234efgh5678",
      aws: "AKIAIOSFODNN7EXAMPLE",
      gh: "ghp_0123456789abcdef0123456789abcdef01234567",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
      pw: "password=hunter2",
    })).toEqual({
      token: "[redacted]", key: "[redacted]", aws: "[redacted]",
      gh: "[redacted]", pem: "[redacted]", pw: "[redacted]",
    });
  });

  test("strips absolute paths (Unix + Windows + sensitive dirs)", () => {
    expect(redactAudit({
      home: "/Users/someone/secret.md",
      win: "C:\\Users\\someone\\secret.md",
      etc: "/etc/passwd",
      varlog: "/var/log/app/x.sqlite",
      library: "/Library/Application Support/secret.md",
      applications: "/Applications/Tool/config.json",
      bin: "/bin/private-tool",
    })).toEqual({
      home: "[redacted]", win: "[redacted]", etc: "[redacted]", varlog: "[redacted]",
      library: "[redacted]", applications: "[redacted]", bin: "[redacted]",
    });
    expect(redactAudit({ url: "https://example.test/path" })).toEqual({ url: "https://example.test/path" });
  });

  test("RETAINS slug / id / internal / debug — audit's purpose", () => {
    const raw = {
      slug: "entities/private", source_page_slug: "entities/private",
      id: 42, score: 0.82, trust_state: "candidate", debug: true,
      reason_codes: ["timeout"], degraded_reason: "search_timeout",
    };
    expect(redactAudit(raw)).toEqual(raw);
  });

  test("walks arrays and nested objects; passes non-string scalars through", () => {
    expect(redactAudit([
      { ok: "实体A", bad: "sk-abcd1234efgh5678" },
      [{ path: "/Users/x", fine: "score=0.9", n: 7 }],
      null,
    ])).toEqual([
      { ok: "实体A", bad: "[redacted]" },
      [{ path: "[redacted]", fine: "score=0.9", n: 7 }],
      null,
    ]);
  });

  test("keeps normal titles (negative — no over-redaction)", () => {
    for (const title of ["实体A", "ProjectAlphaSentinel", "PathLabelSentinel", "ScorecardSentinel"]) {
      expect(redactAudit({ title })).toEqual({ title });
    }
  });

  test("retains Date timestamp semantics as a JSON-safe ISO string", () => {
    const d = new Date("2025-01-01T00:00:00Z");
    const out = redactAudit({ created_at: d, updated_at: d }) as { created_at: unknown; updated_at: unknown };
    expect(out.created_at).toBe("2025-01-01T00:00:00.000Z");
    expect(out.updated_at).toBe("2025-01-01T00:00:00.000Z");
  });

  test("uses native Date serialization instead of an overridable instance method", () => {
    const date = new Date("2025-01-01T00:00:00Z");
    Object.defineProperty(date, "toISOString", {
      value: () => "/Users/private/DATE-SECRET.md",
    });
    expect(redactAudit({ date })).toEqual({ date: "2025-01-01T00:00:00.000Z" });
  });

  test("canonicalizes Map/Set and applies shared path redaction to RegExp strings", () => {
    const m = new Map([["k", "v"]]);
    const s = new Set([1, 2]);
    const r = /foo/i;
    const out = redactAudit({ m, s, r }) as { m: unknown; s: unknown; r: unknown };
    expect(out.m).toEqual([{ key: "k", value: "v" }]);
    expect(out.s).toEqual([1, 2]);
    expect(out.r).toBe("[redacted]");
  });

  test("uses the shared CREDENTIAL_PATH_UNSAFE_PATTERNS via redactAudit (no copied regex — Codex HIGH 1)", () => {
    // Behavioral lock: redactAudit must honor the shared CREDENTIAL_PATH_UNSAFE_PATTERNS,
    // not a local drift copy. Exercises redactAudit end-to-end with one fixture per attack
    // class and asserts the leaf is replaced with [redacted]. A no-op redactAudit would fail.
    const fixtures: Record<string, string> = {
      credential: "sk-abcd1234efgh5678",
      absolute_path: "/Users/someone/secret.md",
      sensitive_dir: "/etc/passwd",
    };
    for (const [, sample] of Object.entries(fixtures)) {
      // sanity: the shared pattern set actually classifies the fixture as unsafe
      expect(CREDENTIAL_PATH_UNSAFE_PATTERNS.some((p) => p.test(sample))).toBe(true);
      const out = redactAudit({ leaf: sample }) as { leaf: unknown };
      expect(out.leaf).toBe("[redacted]");
    }
  });
});
