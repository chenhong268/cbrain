import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePolicy, type Exception } from "../../bin/lib/dependency-advisory-policy.js";
import type { Severity } from "../../bin/lib/dependency-advisory-gate.js";

// ── Synthetic fixture helpers (anonymous package-a/b names) ──────────────────

type Advisory = { id: string; severity: Severity; vulnerable_versions: string; [k: string]: unknown };
function adv(id: string, severity: Severity, vv: string): Advisory {
  return { id, severity, vulnerable_versions: vv };
}
function audit(...entries: Array<[string, Advisory[]]>): Record<string, unknown[]> {
  const o: Record<string, unknown[]> = {};
  for (const [pkg, list] of entries) o[pkg] = list;
  return o;
}
function lock(
  root: { deps?: Record<string, string>; dev?: Record<string, string>; opt?: Record<string, string> },
  pkgs: Record<
    string,
    {
      version?: string;
      deps?: Record<string, string>;
      opt?: Record<string, string>;
      peer?: Record<string, string>;
      optpeers?: string[];
    }
  >,
): string {
  const ws: string[] = [];
  if (root.deps) ws.push(`"dependencies": ${JSON.stringify(root.deps)}`);
  if (root.dev) ws.push(`"devDependencies": ${JSON.stringify(root.dev)}`);
  if (root.opt) ws.push(`"optionalDependencies": ${JSON.stringify(root.opt)}`);
  const pkgLines = Object.entries(pkgs).map(([k, v]) => {
    const version = v.version ?? "1.0.0";
    const meta: string[] = [];
    if (v.deps) meta.push(`"dependencies": ${JSON.stringify(v.deps)}`);
    if (v.opt) meta.push(`"optionalDependencies": ${JSON.stringify(v.opt)}`);
    if (v.peer) meta.push(`"peerDependencies": ${JSON.stringify(v.peer)}`);
    if (v.optpeers) meta.push(`"optionalPeers": ${JSON.stringify(v.optpeers)}`);
    const metaStr = meta.length ? `{ ${meta.join(", ")} }` : `{}`;
    return `    "${k}": ["${k}@${version}", "", ${metaStr}, "sha"]`;
  });
  return `{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "cbrain", ${ws.join(", ")} } },
    "packages": { ${pkgLines.join(",")} }
  }`;
}
function exc(
  fields: Partial<Exception> &
    Pick<Exception, "advisory_id" | "package" | "installed_version" | "dependency_path">,
): Exception {
  return {
    reachability: "unreachable",
    mitigation: "not reachable",
    owner: "team-a",
    rationale: "audited",
    expires_on: "2099-12-31",
    ...fields,
  };
}
const REG = (exceptions: Exception[] = []) => ({ schema_version: 1, exceptions });
const NO_AUDIT = audit();
const TODAY = "2026-01-01";

// ─────────────────────────────────────────────────────────────────────────────

describe("evaluatePolicy — verdicts", () => {
  test("1. empty registry + moderate/low only → GO", () => {
    const a = audit(["package-a", [adv("100", "moderate", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const r = evaluatePolicy(REG(), a, l, TODAY);
    expect(r.outcome).toBe("go");
    expect(r.counts.moderate).toBe(1);
    expect(r.findings[0]?.status).toBe("informational");
  });

  test("2. production high no exception → NO-GO (untriaged)", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const r = evaluatePolicy(REG(), a, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.findings.some((f) => f.reason_code === "untriaged")).toBe(true);
  });

  test("3. dev-only high no exception → NO-GO (dev is not auto-ignored)", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ dev: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const r = evaluatePolicy(REG(), a, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.findings.some((f) => f.reason_code === "untriaged")).toBe(true);
  });

  test("4. dev-only high + exact unreachable exception → GO", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ dev: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      reachability: "unreachable",
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    expect(r.outcome).toBe("go");
    expect(r.findings[0]?.status).toBe("excepted");
  });

  test("5. production high + exact mitigated exception → GO", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      reachability: "mitigated",
      mitigation: "WAF rule blocks exploit",
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    expect(r.outcome).toBe("go");
    expect(r.findings[0]?.status).toBe("excepted");
  });

  test("6. expiry same day is still valid (today == expires_on)", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      expires_on: "2026-01-01",
    });
    const r = evaluatePolicy(REG([e]), a, l, "2026-01-01");
    expect(r.outcome).toBe("go");
  });

  test("7. expiry next day → exception_expired NO-GO", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      expires_on: "2026-01-01",
    });
    const r = evaluatePolicy(REG([e]), a, l, "2026-01-02");
    expect(r.outcome).toBe("no-go");
    const f = r.findings[0];
    expect(f?.status).toBe("untriaged");
    expect(f?.reason_code).toBe("exception_expired");
    expect(f?.expires_on).toBe("2026-01-01");
    expect(r.errors.some((e) => e.reason === "exception_expired")).toBe(true);
  });

  test("8. installed version changed → exception_stale_version", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-a": "^2.0.0" } }, { "package-a": { version: "2.0.0" } });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.errors.some((er) => er.reason === "exception_stale_version")).toBe(true);
  });

  test("9. dependency path changed → exception_stale_path", () => {
    const a = audit(["package-d", [adv("100", "high", "*")]]);
    const l = lock(
      { deps: { "package-a": "^1.0.0", "package-b": "^1.0.0" } },
      {
        "package-a": { deps: { "package-d": "^1.0.0" } },
        "package-b": { deps: { "package-d": "^1.0.0" } },
        "package-d": {},
      },
    );
    // actual paths: cbrain→package-a→package-d AND cbrain→package-b→package-d
    // exception path via package-c no longer exists → stale_path
    const e = exc({
      advisory_id: "100",
      package: "package-d",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-c@1.0.0", "package-d@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.errors.some((er) => er.reason === "exception_stale_path")).toBe(true);
  });

  test("10. advisory resolved but exception remains → exception_obsolete", () => {
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), NO_AUDIT, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.errors.some((er) => er.reason === "exception_obsolete")).toBe(true);
  });

  test("11. moderate/low with exception → exception_unnecessary", () => {
    const a = audit(["package-a", [adv("100", "moderate", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.errors.some((er) => er.reason === "exception_unnecessary")).toBe(true);
  });

  test("12. same advisory two paths, only one covered → NO-GO (untriaged)", () => {
    const a = audit(["package-d", [adv("100", "high", "*")]]);
    const l = lock(
      { deps: { "package-a": "^1.0.0", "package-b": "^1.0.0" } },
      {
        "package-a": { deps: { "package-d": "^1.0.0" } },
        "package-b": { deps: { "package-d": "^1.0.0" } },
        "package-d": {},
      },
    );
    const e = exc({
      advisory_id: "100",
      package: "package-d",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0", "package-d@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.findings.some((f) => f.reason_code === "untriaged")).toBe(true);
  });

  test("13. two paths both covered → GO", () => {
    const a = audit(["package-d", [adv("100", "high", "*")]]);
    const l = lock(
      { deps: { "package-a": "^1.0.0", "package-b": "^1.0.0" } },
      {
        "package-a": { deps: { "package-d": "^1.0.0" } },
        "package-b": { deps: { "package-d": "^1.0.0" } },
        "package-d": {},
      },
    );
    const e1 = exc({
      advisory_id: "100",
      package: "package-d",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0", "package-d@1.0.0"],
    });
    const e2 = exc({
      advisory_id: "100",
      package: "package-d",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-b@1.0.0", "package-d@1.0.0"],
    });
    const r = evaluatePolicy(REG([e1, e2]), a, l, TODAY);
    expect(r.outcome).toBe("go");
  });
});

describe("evaluatePolicy — registry/config fatal", () => {
  const A = audit(["package-a", [adv("100", "high", "*")]]);
  const L = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });

  test("14a. unknown top-level field → fatal", () => {
    const r = evaluatePolicy({ schema_version: 1, exceptions: [], extra: 1 }, A, L, TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.errors.some((e) => e.reason === "invalid_registry_schema")).toBe(true);
  });

  test("14b. unknown exception field → fatal", () => {
    const r = evaluatePolicy(
      REG([
        { ...exc({ advisory_id: "100", package: "package-a", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@1.0.0"] }), extra: 1 } as unknown as Exception,
      ]),
      A,
      L,
      TODAY,
    );
    expect(r.errors.some((e) => e.reason === "invalid_exception_field")).toBe(true);
  });

  test("14c. missing exception field → fatal", () => {
    const r = evaluatePolicy(
      REG([{ advisory_id: "100" } as unknown as Exception]),
      A,
      L,
      TODAY,
    );
    expect(r.errors.some((e) => e.reason === "invalid_exception_field")).toBe(true);
  });

  test("14d. duplicate exact key → fatal", () => {
    const e1 = exc({ advisory_id: "100", package: "package-a", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@1.0.0"] });
    const r = evaluatePolicy(REG([e1, e1]), A, L, TODAY);
    expect(r.errors.some((e) => e.reason === "duplicate_exception_key")).toBe(true);
  });

  test("14e. wildcard advisory_id → fatal (no wildcard matching)", () => {
    const r = evaluatePolicy(
      REG([exc({ advisory_id: "*", package: "package-a", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@1.0.0"] })]),
      A,
      L,
      TODAY,
    );
    expect(r.errors.some((e) => e.reason === "invalid_exception_field")).toBe(true);
  });

  test("15. invalid Gregorian date 2026-02-30 → fatal", () => {
    const r = evaluatePolicy(
      REG([exc({ advisory_id: "100", package: "package-a", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@1.0.0"], expires_on: "2026-02-30" })]),
      A,
      L,
      TODAY,
    );
    expect(r.errors.some((e) => e.reason === "invalid_date")).toBe(true);
  });

  test("16a. dependency_path root != cbrain → fatal", () => {
    const r = evaluatePolicy(
      REG([exc({ advisory_id: "100", package: "package-a", installed_version: "1.0.0", dependency_path: ["not-cbrain", "package-a@1.0.0"] })]),
      A,
      L,
      TODAY,
    );
    expect(r.errors.some((e) => e.reason === "invalid_dependency_path")).toBe(true);
  });

  test("16b. dependency_path last node != package@installed_version → fatal", () => {
    const r = evaluatePolicy(
      REG([exc({ advisory_id: "100", package: "package-a", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@2.0.0"] })]),
      A,
      L,
      TODAY,
    );
    expect(r.errors.some((e) => e.reason === "invalid_dependency_path")).toBe(true);
  });

  test("schema_version != 1 → fatal", () => {
    const r = evaluatePolicy({ schema_version: 2, exceptions: [] }, A, L, TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.errors.some((e) => e.reason === "invalid_registry_schema")).toBe(true);
  });
});

describe("evaluatePolicy — audit/lock mismatch fatal", () => {
  test("17. audit package with no lock path → fatal (audit_lock_mismatch)", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    // package-a is in lock but unreachable from root (root only package-b)
    const l = lock({ deps: { "package-b": "^1.0.0" } }, { "package-a": {}, "package-b": {} });
    const r = evaluatePolicy(REG(), a, l, TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    expect(r.errors.some((e) => e.reason === "audit_lock_mismatch")).toBe(true);
  });

  test("18. no installed version satisfies vulnerable_versions → fatal", () => {
    const a = audit(["package-a", [adv("100", "high", ">=2.0.0")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": { version: "1.0.0" } });
    const r = evaluatePolicy(REG(), a, l, TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    expect(r.errors.some((e) => e.reason === "audit_lock_mismatch")).toBe(true);
  });

  test("19. Stage 1 lock integrity error passthrough → fatal", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    // root declares ^2.0.0 but installed 1.0.0 → Stage 1 range_mismatch
    const l = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "cbrain", "dependencies": { "package-a": "^2.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", {}, "sha"] } }`;
    const r = evaluatePolicy(REG(), a, l, TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    expect(r.errors.some((e) => e.reason === "lock_integrity")).toBe(true);
  });
});

describe("evaluatePolicy — privacy + stability", () => {
  test("20. hostile text in registry/audit never reaches output", () => {
    const a = audit([
      "package-a",
      [
        {
          id: "100",
          severity: "high",
          vulnerable_versions: "*",
          title: "leaky /Users/secret sk-xyz",
          url: "https://reg.example/x",
        },
      ],
    ]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    const e = exc({
      advisory_id: "100",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      mitigation: "/Users/secret sk-xyz",
      owner: "root@host",
      rationale: "leaky detail",
    });
    const r = evaluatePolicy(REG([e]), a, l, TODAY);
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("sk-xyz");
    expect(blob).not.toContain("reg.example");
    expect(blob).not.toContain("leaky");
    expect(blob).not.toContain("root@host");
  });

  test("21. same input + today → byte-identical output", () => {
    const a = audit(["package-d", [adv("100", "high", "*")]]);
    const l = lock(
      { deps: { "package-a": "^1.0.0", "package-b": "^1.0.0" } },
      {
        "package-a": { deps: { "package-d": "^1.0.0" } },
        "package-b": { deps: { "package-d": "^1.0.0" } },
        "package-d": {},
      },
    );
    const e1 = exc({ advisory_id: "100", package: "package-d", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@1.0.0", "package-d@1.0.0"] });
    const e2 = exc({ advisory_id: "100", package: "package-d", installed_version: "1.0.0", dependency_path: ["cbrain", "package-b@1.0.0", "package-d@1.0.0"] });
    const r1 = JSON.stringify(evaluatePolicy(REG([e1, e2]), a, l, TODAY));
    const r2 = JSON.stringify(evaluatePolicy(REG([e1, e2]), a, l, TODAY));
    expect(r1).toBe(r2);
  });

  test("22. current empty registry file is schema-valid (parses, no registry errors)", () => {
    const reg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../config/dependency-advisory-exceptions.json"), "utf-8"),
    );
    const r = evaluatePolicy(reg, NO_AUDIT, lock({}, {}), TODAY);
    const registryReasons = [
      "invalid_registry_schema",
      "invalid_exception_field",
      "duplicate_exception_key",
      "invalid_dependency_path",
      "invalid_date",
    ];
    expect(r.errors.filter((e) => registryReasons.includes(e.reason)).length).toBe(0);
    expect(r.outcome).toBe("go");
  });
});

// =============================================================================
// #380 Stage 2 round-2 — policy honesty / exactness
// =============================================================================

describe("evaluatePolicy — today validation (fail-closed)", () => {
  test("invalid today → fatal, findings=[], evaluated_on=null, no leak", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} });
    for (const bad of ["/Users/secret", "2026-02-30", "", "not-a-date", "2026-13-40"]) {
      const r = evaluatePolicy(REG(), a, l, bad);
      expect(r.outcome).toBe("fatal");
      expect(r.findings).toEqual([]);
      expect(r.evaluated_on).toBeNull();
      expect(r.errors.some((e) => e.reason === "invalid_evaluation_date")).toBe(true);
      const blob = JSON.stringify(r);
      expect(blob).not.toContain("/Users/");
      expect(blob).not.toContain("secret");
    }
  });

  test("non-string today (unknown boundary) → fatal", () => {
    const r = evaluatePolicy(REG(), audit(), lock({}, {}), 123 as unknown as string);
    expect(r.outcome).toBe("fatal");
    expect(r.errors.some((e) => e.reason === "invalid_evaluation_date")).toBe(true);
  });
});

describe("evaluatePolicy — fatal honesty + exactness", () => {
  test("invalid audit input → fatal + invalid_audit_input, findings=[], counts=0", () => {
    const r = evaluatePolicy(REG(), [], lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }), TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    expect(r.errors.some((e) => e.reason === "invalid_audit_input")).toBe(true);
    expect(r.counts).toEqual({ critical: 0, high: 0, moderate: 0, low: 0 });
  });

  test("exception installed_version is a range → fatal (invalid_exception_field)", () => {
    const r = evaluatePolicy(
      REG([exc({ advisory_id: "100", package: "package-a", installed_version: "^1.0.0", dependency_path: ["cbrain", "package-a@1.0.0"] })]),
      audit(["package-a", [adv("100", "high", "*")]]),
      lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }),
      TODAY,
    );
    expect(r.outcome).toBe("fatal");
    expect(r.errors.some((e) => e.reason === "invalid_exception_field")).toBe(true);
  });

  test("dependency_path node version is a range → invalid_dependency_path", () => {
    const r = evaluatePolicy(
      REG([exc({ advisory_id: "100", package: "package-a", installed_version: "1.0.0", dependency_path: ["cbrain", "package-a@^1.0.0"] })]),
      audit(["package-a", [adv("100", "high", "*")]]),
      lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }),
      TODAY,
    );
    expect(r.outcome).toBe("fatal");
    expect(r.errors.some((e) => e.reason === "invalid_dependency_path")).toBe(true);
  });

  test("hostile advisory id → fatal (audit normalize rejects), no leak", () => {
    const r = evaluatePolicy(
      REG(),
      audit(["package-a", [{ id: "/Users/secret", severity: "high", vulnerable_versions: "*" }]]),
      lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }),
      TODAY,
    );
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("secret");
  });

  test("fatal output is byte-identical for the same input", () => {
    const a = audit(["package-a", [adv("100", "high", "*")]]);
    const l = lock({ deps: { "package-b": "^1.0.0" } }, { "package-b": {} }); // package-a unreachable → audit_lock_mismatch
    const r1 = JSON.stringify(evaluatePolicy(REG(), a, l, TODAY));
    const r2 = JSON.stringify(evaluatePolicy(REG(), a, l, TODAY));
    expect(r1).toBe(r2);
  });
});

// =============================================================================
// #380 P1 round — malicious version rejection + multi-version lifecycle
// =============================================================================

describe("evaluatePolicy — malicious version + multi-version lifecycle (#380 P1)", () => {
  test("malformed version 1.2.3, in lock AND exact exception + high → fatal (never GO/excepted)", () => {
    const lockBad = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "cbrain", "dependencies": { "package-a": "^1.2.3" } } }, "packages": { "package-a": ["package-a@1.2.3,", "", {}, "sha"] } }`;
    const e = {
      advisory_id: "200",
      package: "package-a",
      installed_version: "1.2.3,",
      dependency_path: ["cbrain", "package-a@1.2.3,"],
      reachability: "mitigated",
      mitigation: "m",
      owner: "o",
      rationale: "r",
      expires_on: "2099-12-31",
    } as unknown as Exception;
    const r = evaluatePolicy(REG([e]), audit(["package-a", [adv("200", "high", "*")]]), lockBad, TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    expect(r.errors.some((er) => er.reason === "invalid_exception_field" || er.reason === "invalid_dependency_path")).toBe(true);
  });

  test("leading-zero version 01.2.3 in exception → fatal (never GO)", () => {
    const e = {
      advisory_id: "200",
      package: "package-a",
      installed_version: "01.2.3",
      dependency_path: ["cbrain", "package-a@01.2.3"],
      reachability: "mitigated",
      mitigation: "m",
      owner: "o",
      rationale: "r",
      expires_on: "2099-12-31",
    } as unknown as Exception;
    const r = evaluatePolicy(REG([e]), audit(["package-a", [adv("200", "high", "*")]]), lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }), TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
  });

  test("multi-version: exception target installed but no longer vulnerable → exception_obsolete + untriaged high + NO-GO", () => {
    // package-d reachable as 1.0.0 (via package-a) AND 2.0.0 (via package-b).
    // Advisory 100 affects only >=2.0.0, so 1.0.0 is installed-but-not-vulnerable.
    // Exception targets 1.0.0 (still installed) → must be exception_obsolete
    // (NOT exception_stale_version); the 2.0.0 finding stays untriaged → NO-GO.
    const lockMV = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "cbrain", "dependencies": { "package-a": "^1.0.0", "package-b": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"], "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-d": "^2.0.0" } }, "sha"], "package-a/package-d": ["package-d@1.0.0", "", {}, "sha"], "package-b/package-d": ["package-d@2.0.0", "", {}, "sha"] } }`;
    const e = exc({
      advisory_id: "100",
      package: "package-d",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0", "package-d@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), audit(["package-d", [adv("100", "high", ">=2.0.0")]]), lockMV, TODAY);
    expect(r.outcome).toBe("no-go");
    expect(r.errors.some((er) => er.reason === "exception_obsolete")).toBe(true);
    expect(r.errors.some((er) => er.reason === "exception_stale_version")).toBe(false);
    expect(r.findings.some((f) => f.installed_version === "2.0.0" && f.status === "untriaged" && f.reason_code === "untriaged")).toBe(true);
  });

  test("multi-version regression guard: version genuinely removed still reports exception_stale_version", () => {
    // Only 2.0.0 installed; exception targets 1.0.0 (not installed at all).
    const lockMV2 = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "cbrain", "dependencies": { "package-b": "^1.0.0" } } }, "packages": { "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-d": "^2.0.0" } }, "sha"], "package-b/package-d": ["package-d@2.0.0", "", {}, "sha"] } }`;
    const e = exc({
      advisory_id: "100",
      package: "package-d",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-b@1.0.0", "package-d@1.0.0"],
    });
    const r = evaluatePolicy(REG([e]), audit(["package-d", [adv("100", "high", "*")]]), lockMV2, TODAY);
    expect(r.errors.some((er) => er.reason === "exception_stale_version")).toBe(true);
    expect(r.errors.some((er) => er.reason === "exception_obsolete")).toBe(false);
  });
});

// =============================================================================
// #380 P1b — malformed vulnerable_versions fail-open (range validation)
// =============================================================================

describe("evaluatePolicy — malformed vulnerable_versions (#380 P1b)", () => {
  test("high + exact exception + malformed range → fatal, findings=[], never GO/excepted", () => {
    const e = exc({
      advisory_id: "200",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      reachability: "mitigated",
      mitigation: "covered",
    });
    for (const vv of ["", "garbage", ",", "not-a-semver-range"]) {
      const r = evaluatePolicy(REG([e]), audit(["package-a", [adv("200", "high", vv)]]), lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }), TODAY);
      expect(r.outcome).toBe("fatal");
      expect(r.findings).toEqual([]);
      expect(r.errors.some((er) => er.reason === "invalid_audit_input")).toBe(true);
    }
  });

  test("valid range with the same high + exception still GO (regression)", () => {
    const e = exc({
      advisory_id: "200",
      package: "package-a",
      installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"],
      reachability: "mitigated",
      mitigation: "covered",
    });
    const r = evaluatePolicy(REG([e]), audit(["package-a", [adv("200", "high", ">=1.0.0 <2.0.0")]]), lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }), TODAY);
    expect(r.outcome).toBe("go");
    expect(r.findings[0]?.status).toBe("excepted");
  });
});

// =============================================================================
// #380 P1c — huge numeric range + '=' comparator
// =============================================================================

describe("evaluatePolicy — huge numeric range + '=' comparator (#380 P1c)", () => {
  test("high + exact exception + huge vulnerable_versions → fatal, never GO", () => {
    const e = exc({
      advisory_id: "200", package: "package-a", installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"], reachability: "mitigated", mitigation: "covered",
    });
    const r = evaluatePolicy(REG([e]), audit(["package-a", [adv("200", "high", ">99999999999999999999.0.0")]]), lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }), TODAY);
    expect(r.outcome).toBe("fatal");
    expect(r.findings).toEqual([]);
    expect(r.errors.some((er) => er.reason === "invalid_audit_input")).toBe(true);
  });

  test("'=1.0.0' high + exact exception → GO (regression for = comparator)", () => {
    const e = exc({
      advisory_id: "200", package: "package-a", installed_version: "1.0.0",
      dependency_path: ["cbrain", "package-a@1.0.0"], reachability: "mitigated", mitigation: "covered",
    });
    const r = evaluatePolicy(REG([e]), audit(["package-a", [adv("200", "high", "=1.0.0")]]), lock({ deps: { "package-a": "^1.0.0" } }, { "package-a": {} }), TODAY);
    expect(r.outcome).toBe("go");
    expect(r.findings[0]?.status).toBe("excepted");
  });
});
