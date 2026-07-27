import { describe, test, expect } from "bun:test";
import {
  normalizeAuditJson,
  resolveDependencyPaths,
  isExactSemver,
  isValidVulnerableVersions,
} from "../../bin/lib/dependency-advisory-gate.js";

// =============================================================================
// Audit normalization
// =============================================================================

const AUDIT_VALID = {
  "package-a": [
    {
      id: "1001",
      severity: "high",
      vulnerable_versions: ">=1.0.0 <2.0.0",
      // additive — must be dropped, never leaked
      title: "leaky /Users/secret sk-abcdef",
      url: "https://example.com/leak",
      cwe: ["CWE-123"],
      cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N" },
    },
  ],
  "package-b": [
    { id: "1003", severity: "low", vulnerable_versions: "*" },
    { id: 1002, severity: "moderate", vulnerable_versions: "<3.0.0" }, // numeric id
  ],
} as const;

describe("normalizeAuditJson", () => {
  test("valid audit normalizes; numeric and string ids both become string advisory_id", () => {
    const { advisories, errors } = normalizeAuditJson(AUDIT_VALID);
    expect(errors).toEqual([]);
    expect(advisories).toHaveLength(3);
    expect(advisories.find((a) => a.advisory_id === "1001")).toEqual({
      advisory_id: "1001",
      severity: "high",
      package: "package-a",
      vulnerable_versions: ">=1.0.0 <2.0.0",
    });
    const num = advisories.find((a) => a.package === "package-b" && a.severity === "moderate")!;
    expect(num.advisory_id).toBe("1002");
    expect(typeof num.advisory_id).toBe("string");
  });

  test("real-shape numeric id 1124006 → decimal string '1124006'", () => {
    const { advisories, errors } = normalizeAuditJson({
      "package-a": [{ id: 1124006, severity: "moderate", vulnerable_versions: "<1.19.15" }],
    });
    expect(errors).toEqual([]);
    expect(advisories[0]?.advisory_id).toBe("1124006");
    expect(typeof advisories[0]?.advisory_id).toBe("string");
  });

  test("reject invalid numeric ids: NaN, ±Infinity, float, negative, zero", () => {
    for (const bad of [NaN, Infinity, -Infinity, 1.5, -1, 0]) {
      const { errors } = normalizeAuditJson({
        "package-a": [{ id: bad, severity: "high", vulnerable_versions: "*" }],
      });
      expect(errors.some((e) => e.reason === "missing_advisory_id")).toBe(true);
    }
  });

  test("invalid package names → invalid_package_name, raw value never echoed", () => {
    const evil: Record<string, unknown[]> = {
      "/Users/secret/token": [{ id: "1", severity: "high", vulnerable_versions: "*" }],
      "back\\slash": [{ id: "2", severity: "high", vulnerable_versions: "*" }],
      "control\x00char": [{ id: "3", severity: "high", vulnerable_versions: "*" }],
      "a//b": [{ id: "4", severity: "high", vulnerable_versions: "*" }],
      [`${"x".repeat(215)}`]: [{ id: "5", severity: "high", vulnerable_versions: "*" }],
      "good-pkg": [{ id: "6", severity: "high", vulnerable_versions: "*" }],
    };
    const { advisories, errors } = normalizeAuditJson(evil);
    expect(advisories.map((a) => a.advisory_id)).toEqual(["6"]);
    expect(errors.filter((e) => e.reason === "invalid_package_name")).toHaveLength(5);
    for (const e of errors) {
      if (e.reason === "invalid_package_name") expect(e.package).toBeNull();
    }
    const blob = JSON.stringify(errors);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("token");
    expect(blob).not.toContain("back");
    expect(blob).not.toContain("slash");
    expect(blob).not.toContain("x".repeat(50));
  });

  test("deterministic ordering: severity rank, then id, then package, then version", () => {
    const { advisories } = normalizeAuditJson(AUDIT_VALID);
    expect(advisories.map((a) => a.advisory_id)).toEqual(["1001", "1002", "1003"]);
  });

  test("additive fields (title/url/cwe/cvss) dropped and never leaked into errors", () => {
    const leaky = {
      "package-a": [
        {
          id: "1001",
          severity: "high",
          vulnerable_versions: "*",
          title: "leaky /Users/secret sk-abcdef",
          url: "https://example.com/x",
        },
        { id: "bad", severity: "bogus", vulnerable_versions: "*", title: "also-leaky" },
      ],
    };
    const { advisories, errors } = normalizeAuditJson(leaky);
    expect(advisories.map((a) => a.advisory_id)).toEqual(["1001"]);
    const blob = JSON.stringify({ advisories, errors });
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("sk-abcdef");
    expect(blob).not.toContain("example.com");
    expect(blob).not.toContain("leaky");
  });

  test("invalid top-level → invalid_top_level", () => {
    expect(normalizeAuditJson([]).errors.some((e) => e.reason === "invalid_top_level")).toBe(true);
  });

  test("missing required fields → structured errors", () => {
    expect(
      normalizeAuditJson({ "package-a": [{ severity: "high", vulnerable_versions: "*" }] })
        .errors.some((e) => e.reason === "missing_advisory_id"),
    ).toBe(true);
    expect(
      normalizeAuditJson({ "package-a": [{ id: "1", vulnerable_versions: "*" }] })
        .errors.some((e) => e.reason === "missing_severity"),
    ).toBe(true);
    expect(
      normalizeAuditJson({ "package-a": [{ id: "1", severity: "high" }] })
        .errors.some((e) => e.reason === "missing_vulnerable_versions"),
    ).toBe(true);
  });

  test("unknown severity → unknown_severity", () => {
    expect(
      normalizeAuditJson({ "package-a": [{ id: "1", severity: "bogus", vulnerable_versions: "*" }] })
        .errors.some((e) => e.reason === "unknown_severity"),
    ).toBe(true);
  });

  test("byte-identical normalization on repeat (stable serialization)", () => {
    const a = JSON.stringify(normalizeAuditJson(AUDIT_VALID));
    const b = JSON.stringify(normalizeAuditJson(AUDIT_VALID));
    expect(a).toBe(b);
  });
});

// =============================================================================
// bun.lock path resolution — real Bun key structure fixtures (synthetic)
// =============================================================================

describe("resolveDependencyPaths — nested scope + lock-key identity", () => {
  test("a. nested @scope/node@25 chosen over top-level @scope/node@20 when parent scope has it", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-parent": "^1.0.0" } } },
      "packages": {
        "package-parent": ["package-parent@1.0.0", "", { "dependencies": { "@scope/node": "*" } }, "sha-pp"],
        "@scope/node": ["@scope/node@20.0.0", "", {}, "sha-top"],
        "package-parent/@scope/node": ["@scope/node@25.0.0", "", {}, "sha-nest"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "@scope/node");
    const node = r.paths[0]?.nodes.find((n) => n.name === "@scope/node");
    expect(node?.version).toBe("25.0.0"); // nearest parent scope wins
  });

  test("nearest-scope range_mismatch does NOT fall back to a satisfying top-level candidate", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-parent": "^1.0.0" } } },
      "packages": {
        "package-parent": ["package-parent@1.0.0", "", { "dependencies": { "package-x": "^1.0.0" } }, "sha"],
        "package-x": ["package-x@1.5.0", "", {}, "sha-top"],
        "package-parent/package-x": ["package-x@2.0.0", "", {}, "sha-nest"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-x");
    expect(r.paths).toEqual([]);
    expect(r.errors.some((e) => e.reason === "range_mismatch" && e.package === "package-x")).toBe(true);
  });

  test("b. two-level nested child resolution", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-parent": "^1.0.0" } } },
      "packages": {
        "package-parent": ["package-parent@1.0.0", "", { "dependencies": { "package-a": "^2.0.0" } }, "sha"],
        "package-parent/package-a": ["package-a@2.0.0", "", { "dependencies": { "package-b": "^2.0.0" } }, "sha"],
        "package-parent/package-a/package-b": ["package-b@2.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.nodes.map((n) => `${n.name}@${n.version}`)).toEqual([
      "package-parent@1.0.0",
      "package-a@2.0.0",
      "package-b@2.0.0",
    ]);
  });

  test("c. same name@version under different lock keys does not bleed metadata", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0", "package-b": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-x": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-a": "^1.0.0" } }, "sha"],
        "package-b/package-a": ["package-a@1.0.0", "", { "dependencies": { "package-y": "^1.0.0" } }, "sha"],
        "package-x": ["package-x@1.0.0", "", {}, "sha"],
        "package-y": ["package-y@1.0.0", "", {}, "sha"]
      }
    }`;
    const rx = resolveDependencyPaths(lock, "package-x");
    expect(rx.paths.some((p) => p.nodes.map((n) => n.name).includes("package-y"))).toBe(false);
    const ry = resolveDependencyPaths(lock, "package-y");
    expect(ry.paths[0]!.nodes.map((n) => `${n.name}@${n.version}`)).toEqual([
      "package-b@1.0.0",
      "package-a@1.0.0",
      "package-y@1.0.0",
    ]);
  });

  test("d. missing optionalPeer is skipped, no integrity error", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": { "@opt/peer": "^1.0.0" }, "optionalPeers": ["@opt/peer"] }, "sha"],
        "package-b": ["package-b@1.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.paths).toHaveLength(1);
    expect(r.errors.filter((e) => e.package === "@opt/peer")).toEqual([]);
  });

  test("optionalDependency installed but version mismatch → integrity error (not silently skipped)", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "optionalDependencies": { "package-c": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", {}, "sha"],
        "package-c": ["package-c@2.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.paths).toHaveLength(1);
    expect(r.errors.some((e) => e.reason === "range_mismatch" && e.package === "package-c")).toBe(true);
  });

  test("optionalPeer installed but version mismatch → integrity error", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": { "@opt/peer": "^1.0.0" }, "optionalPeers": ["@opt/peer"] }, "sha"],
        "package-b": ["package-b@1.0.0", "", {}, "sha"],
        "@opt/peer": ["@opt/peer@2.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.paths).toHaveLength(1);
    expect(r.errors.some((e) => e.reason === "range_mismatch" && e.package === "@opt/peer")).toBe(true);
  });

  test("e. missing required peer → missing_resolution", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": { "@req/peer": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", {}, "sha"]
      }
    }`;
    const { errors } = resolveDependencyPaths(lock, "package-b");
    expect(errors.some((e) => e.reason === "missing_resolution" && e.package === "@req/peer")).toBe(true);
  });

  test("f. required peer installed is NOT marked optional", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "peerDependencies": { "@req/peer": "^1.0.0" } }, "sha"],
        "@req/peer": ["@req/peer@1.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "@req/peer");
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.optional).toBe(false);
  });

  test("g. duplicate traversal does not produce duplicate paths", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0", "package-b": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"],
        "package-d": ["package-d@1.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-d");
    const serialized = r.paths.map((p) =>
      [p.root, p.optional ? "opt" : "req", ...p.nodes.map((n) => `${n.name}@${n.version}`)].join("|"),
    );
    expect(new Set(serialized).size).toBe(serialized.length);
    expect(r.paths).toHaveLength(2);
  });

  test("h. dependency cycle: exact single path, no spurious errors", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-a": "^1.0.0" } }, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.nodes.map((n) => `${n.name}@${n.version}`)).toEqual([
      "package-a@1.0.0",
      "package-b@1.0.0",
    ]);
    expect(r.errors).toEqual([]);
  });

  test("missing root workspace → fail closed (invalid_lock_json)", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "named": { "name": "x" } }, "packages": {} }`;
    const r = resolveDependencyPaths(lock, "package-a");
    expect(r.paths).toEqual([]);
    expect(r.errors.some((e) => e.reason === "invalid_lock_json")).toBe(true);
  });

  test("named-only workspace is NOT scanned (only root \"\" is consumed)", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } },
        "named": { "name": "other", "dependencies": { "package-z": "^1.0.0" } }
      },
      "packages": {
        "package-a": ["package-a@1.0.0", "", {}, "sha"],
        "package-z": ["package-z@1.0.0", "", {}, "sha"]
      }
    }`;
    const rz = resolveDependencyPaths(lock, "package-z");
    expect(rz.paths).toEqual([]);
    const ra = resolveDependencyPaths(lock, "package-a");
    expect(ra.paths).toHaveLength(1);
  });

  test("JSONC lock with trailing commas parses (no invalid_lock_json)", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0", } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0", } }, "sha"],
        "package-b": ["package-b@1.0.0", "", {}, "sha"],
      },
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.errors.some((e) => e.reason === "invalid_lock_json")).toBe(false);
    expect(r.paths).toHaveLength(1);
  });

  test("range mismatch (installed version outside edge range)", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^2.0.0" } } },
      "packages": { "package-a": ["package-a@1.0.0", "", {}, "sha"] }
    }`;
    expect(
      resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "range_mismatch"),
    ).toBe(true);
  });

  test("byte-identical path output on repeat (stable ordering)", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0", "package-b": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"],
        "package-d": ["package-d@1.0.0", "", {}, "sha"]
      }
    }`;
    const a = JSON.stringify(resolveDependencyPaths(lock, "package-d"));
    const b = JSON.stringify(resolveDependencyPaths(lock, "package-d"));
    expect(a).toBe(b);
  });
});

// =============================================================================
// Hostile / malformed lock entries — fail closed, never echo raw input
// =============================================================================

describe("resolveDependencyPaths — hostile / malformed lock entries", () => {
  test("1. root dependency key /Users/secret/token → invalid_lock_entry, no path, no leak", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "/Users/secret/token": "^1.0.0" } } },
      "packages": { "good-pkg": ["good-pkg@1.0.0", "", {}, "sha"] }
    }`;
    const r = resolveDependencyPaths(lock, "good-pkg");
    expect(r.paths).toEqual([]);
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
    const blob = JSON.stringify(r.errors);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("token");
  });

  test("2. metadata dependency key with backslash / control char → invalid_lock_entry", () => {
    // JSONC "back\\slash" parses to back\slash; "" parses to BEL control char.
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "back\\\\slash": "^1.0.0", "ctrl\\u0007x": "^1.0.0", "good-b": "^1.0.0" } }, "sha"],
        "good-b": ["good-b@1.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "good-b");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
    expect(r.paths.some((p) => p.nodes.some((n) => n.name === "good-b"))).toBe(true);
    const blob = JSON.stringify(r.errors);
    expect(blob).not.toContain("back");
    expect(blob).not.toContain("slash");
  });

  test("3. lock key leaf != descriptor name → invalid_lock_entry", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" } }, "sha"],
        "package-b": ["other-name@1.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
    expect(r.paths).toEqual([]);
  });

  test("4. malformed package tuple (value not array) → invalid_lock_entry", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" } }, "sha"],
        "package-b": "not-an-array"
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("5. malformed resolved descriptor (no @version) → invalid_lock_entry", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" } }, "sha"],
        "package-b": ["no-at-sign-here", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("6. valid scoped and nested lock keys still pass", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-parent": "^1.0.0" } } },
      "packages": {
        "package-parent": ["package-parent@1.0.0", "", { "dependencies": { "@scope/node": "*" } }, "sha"],
        "@scope/node": ["@scope/node@2.0.0", "", {}, "sha"],
        "package-parent/@scope/node": ["@scope/node@2.5.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "@scope/node");
    expect(r.errors).toEqual([]);
    expect(r.paths[0]?.nodes.find((n) => n.name === "@scope/node")?.version).toBe("2.5.0");
  });
});

// =============================================================================
// Traversal budget — acyclic exponential path explosion is bounded
// =============================================================================

/** Synthesize a binary diamond DAG of `layers` layers (2 nodes each). */
function diamondLock(layers: number): string {
  const pkgs: string[] = [];
  const rootDeps: string[] = [];
  for (let i = 0; i < layers; i++) {
    for (const s of ["a", "b"]) {
      const name = `l${i}-${s}`;
      if (i === 0) rootDeps.push(name);
      const deps =
        i + 1 < layers ? `"l${i + 1}-a": "^1.0.0", "l${i + 1}-b": "^1.0.0"` : "";
      pkgs.push(`    "${name}": ["${name}@1.0.0", "", { "dependencies": { ${deps} } }, "sha"]`);
    }
  }
  return `{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "app", "dependencies": { ${rootDeps.map((d) => `"${d}": "^1.0.0"`).join(", ")} } } },
    "packages": {
${pkgs.join(",\n")}
    }
  }`;
}

describe("resolveDependencyPaths — traversal budget", () => {
  test("diamond DAG (12 layers) → traversal_limit_exceeded, paths dropped", () => {
    const lock = diamondLock(12);
    const r = resolveDependencyPaths(lock, "l11-a");
    expect(r.errors.some((e) => e.reason === "traversal_limit_exceeded")).toBe(true);
    expect(r.paths).toEqual([]); // never a truncated, silently-incomplete result
  });

  test("diamond budget error is byte-identical on repeat", () => {
    const lock = diamondLock(12);
    const a = JSON.stringify(resolveDependencyPaths(lock, "l11-a"));
    const b = JSON.stringify(resolveDependencyPaths(lock, "l11-a"));
    expect(a).toBe(b);
  });

  test("normal multi-path fixture does NOT trigger the budget", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0", "package-b": "^1.0.0" } } },
      "packages": {
        "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"],
        "package-b": ["package-b@1.0.0", "", { "dependencies": { "package-d": "^1.0.0" } }, "sha"],
        "package-d": ["package-d@1.0.0", "", {}, "sha"]
      }
    }`;
    const r = resolveDependencyPaths(lock, "package-d");
    expect(r.errors.some((e) => e.reason === "traversal_limit_exceeded")).toBe(false);
    expect(r.paths).toHaveLength(2);
  });
});

// =============================================================================
// Malformed lock schema — fail closed, never silently ignore
// =============================================================================

describe("resolveDependencyPaths — malformed schema (fail-closed)", () => {
  test("1. root dependency range is a number → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": 999 } } }, "packages": { "package-a": ["package-a@1.0.0", "", {}, "sha"] } }`;
    const r = resolveDependencyPaths(lock, "package-a");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
    expect(r.paths).toEqual([]);
  });

  test("2. metadata dependency range is a number → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": 999 } }, "sha"], "package-b": ["package-b@1.0.0", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-b").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("3. optional dependency range is null → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "optionalDependencies": { "package-c": null } }, "sha"], "package-b": ["package-b@1.0.0", "", {}, "sha"], "package-c": ["package-c@1.0.0", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-b").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("4. peerDependencies section is an array (not object) → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": ["@x/y"] }, "sha"], "package-b": ["package-b@1.0.0", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-b").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("5a. package tuple metadata is a string → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", "meta-string", "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("5b. package tuple metadata is an array → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", ["meta"], "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("6. optionalPeers is not an array → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": { "@req/p": "^1.0.0" }, "optionalPeers": "@req/p" }, "sha"], "package-b": ["package-b@1.0.0", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-b").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("7. optionalPeers contains an invalid name → invalid_lock_entry, no leak", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": { "@req/p": "^1.0.0", "/Users/x": "^1.0.0" }, "optionalPeers": ["/Users/x"] }, "sha"], "package-b": ["package-b@1.0.0", "", {}, "sha"] } }`;
    const r = resolveDependencyPaths(lock, "package-b");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("/Users/");
  });

  test("8. optionalPeers references an undeclared peer → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": { "package-b": "^1.0.0" }, "peerDependencies": { "@req/p": "^1.0.0" }, "optionalPeers": ["@not/declared"] }, "sha"], "package-b": ["package-b@1.0.0", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-b").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("9. descriptor version is empty → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("lock.packages present but not an object → invalid_lock_json", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": "not-an-object" }`;
    const r = resolveDependencyPaths(lock, "package-a");
    expect(r.paths).toEqual([]);
    expect(r.errors.some((e) => e.reason === "invalid_lock_json")).toBe(true);
  });
});

// =============================================================================
// Literal null is NOT absent — explicit null fails closed
// =============================================================================

describe("resolveDependencyPaths — literal null vs absent (fail-closed)", () => {
  test("packages: null → invalid_lock_json", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": null }`;
    const r = resolveDependencyPaths(lock, "package-a");
    expect(r.errors.some((e) => e.reason === "invalid_lock_json")).toBe(true);
    expect(r.paths).toEqual([]);
  });

  test("tuple metadata: null → invalid_lock_entry, no successful path", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", null, "sha"] } }`;
    const r = resolveDependencyPaths(lock, "package-a");
    expect(r.errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
    expect(r.paths).toEqual([]);
  });

  test("tuple metadata: missing → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", ""] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("root dependencies: null → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": null } }, "packages": {} }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("metadata dependencies: null → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "dependencies": null }, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("optionalDependencies: null → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "optionalDependencies": null }, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("peerDependencies: null → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "peerDependencies": null }, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });

  test("optionalPeers: null → invalid_lock_entry", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.0.0" } } }, "packages": { "package-a": ["package-a@1.0.0", "", { "peerDependencies": { "@req/p": "^1.0.0" }, "optionalPeers": null }, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });
});

// =============================================================================
// isExactSemver — strict SemVer 2.0 (#380 P1: malicious / malformed rejection)
// =============================================================================

describe("isExactSemver — strict SemVer 2.0", () => {
  test("accepts valid release versions", () => {
    for (const v of ["1.2.3", "0.0.0", "0.1.0", "1.0.0", "10.20.30", "2026.7.27"]) {
      expect(isExactSemver(v)).toBe(true);
    }
  });

  test("accepts valid SemVer 2.0 prerelease / build metadata", () => {
    expect(isExactSemver("1.2.3-alpha")).toBe(true);
    expect(isExactSemver("1.2.3-beta.1")).toBe(true);
    expect(isExactSemver("1.0.0-rc.1+build.5")).toBe(true);
  });

  test("rejects leading zeros in any numeric part (SemVer 2.0 §2)", () => {
    expect(isExactSemver("01.2.3")).toBe(false);
    expect(isExactSemver("1.02.3")).toBe(false);
    expect(isExactSemver("1.2.03")).toBe(false);
    expect(isExactSemver("00.0.0")).toBe(false);
  });

  test("rejects wrong part count", () => {
    expect(isExactSemver("1.2.3.4")).toBe(false);
    expect(isExactSemver("1.2")).toBe(false);
    expect(isExactSemver("1")).toBe(false);
    expect(isExactSemver("1.2.3.4.5")).toBe(false);
  });

  test("rejects trailing garbage / injection characters (#380 P1)", () => {
    expect(isExactSemver("1.2.3,")).toBe(false);
    expect(isExactSemver("1.2.3;rm -rf /")).toBe(false);
    expect(isExactSemver("1.2.3 ")).toBe(false);
    expect(isExactSemver(" 1.2.3")).toBe(false);
    expect(isExactSemver("1.2.3\n")).toBe(false);
    expect(isExactSemver("1.2.3\t")).toBe(false);
    expect(isExactSemver("1.2.3'||true")).toBe(false);
    expect(isExactSemver("1.2.3\"")).toBe(false);
    expect(isExactSemver("1.2.3\x00")).toBe(false);
  });

  test("rejects range operators and wildcards (exact only)", () => {
    expect(isExactSemver("^1.2.3")).toBe(false);
    expect(isExactSemver("~1.2.3")).toBe(false);
    expect(isExactSemver(">=1.2.3")).toBe(false);
    expect(isExactSemver("<=1.2.3")).toBe(false);
    expect(isExactSemver(">1.2.3")).toBe(false);
    expect(isExactSemver("<1.2.3")).toBe(false);
    expect(isExactSemver("1.2.*")).toBe(false);
    expect(isExactSemver("*")).toBe(false);
    expect(isExactSemver("1.x")).toBe(false);
    expect(isExactSemver("||1.2.3")).toBe(false);
  });

  test("rejects prefixes / non-numeric", () => {
    expect(isExactSemver("")).toBe(false);
    expect(isExactSemver("v1.2.3")).toBe(false);
    expect(isExactSemver("a.b.c")).toBe(false);
    expect(isExactSemver("1.2.3-")).toBe(false); // empty prerelease identifier
    expect(isExactSemver("1.2.3+")).toBe(false); // empty build identifier
  });

  test("lock descriptor with malformed version → invalid_lock_entry (lock-side fail-closed)", () => {
    const lock = `{ "lockfileVersion": 1, "workspaces": { "": { "name": "app", "dependencies": { "package-a": "^1.2.3" } } }, "packages": { "package-a": ["package-a@1.2.3,", "", {}, "sha"] } }`;
    expect(resolveDependencyPaths(lock, "package-a").errors.some((e) => e.reason === "invalid_lock_entry")).toBe(true);
  });
});

// =============================================================================
// isValidVulnerableVersions — strict npm range (#380 P1: malformed range fail-open)
// =============================================================================

describe("isValidVulnerableVersions — strict npm range", () => {
  test("accepts real Bun audit range forms", () => {
    for (const r of ["<2.0.5", "<=10.1.0", ">=2.0.0 <2.3.0", ">=6.11.1 <=6.15.1"]) {
      expect(isValidVulnerableVersions(r)).toBe(true);
    }
  });

  test("accepts *, exact, single comparators, unions, prerelease/build", () => {
    const ok = [
      "*",
      "1.2.3",
      "0.0.0",
      "<2.0.5",
      "<=10.1.0",
      ">=2.0.0",
      ">1.0.0",
      ">=1.0.0 <2.0.0",
      "=1.0.0",
      "=2.0.0",
      "=1.0.0 <2.0.0",
      "<1.0.0 || >=2.0.0",
      ">=1.0.0 <2.0.0 || >=3.0.0 <4.0.0",
      "1.2.3-alpha",
      "1.0.0-rc.1+build.5",
      "  *  ",
      ">=1.0.0  <2.0.0",
    ];
    for (const r of ok) expect(isValidVulnerableVersions(r)).toBe(true);
  });

  test("rejects empty / garbage / trailing garbage (#380 P1)", () => {
    for (const r of ["", "garbage", ",", "not-a-semver-range", ">=1.0.0,", "1.2.3,", ">= ", " >="]) {
      expect(isValidVulnerableVersions(r)).toBe(false);
    }
  });

  test("rejects lone operators / partials / x-ranges / unsupported operators (conservative)", () => {
    for (const r of [">=", "<", "||", ">=1.0.0 ||", "|| >=1.0.0", "1.x", "1.2", "1", "^1.2.3", "~1.2.3", "1.2.3.4", ">=1.0.0 <"]) {
      expect(isValidVulnerableVersions(r)).toBe(false);
    }
  });

  test("rejects whitespace-only / newline injection", () => {
    expect(isValidVulnerableVersions(" ")).toBe(false);
    expect(isValidVulnerableVersions("\n")).toBe(false);
    expect(isValidVulnerableVersions(">=1.0.0\n<2.0.0;rm")).toBe(false);
  });
});

describe("normalizeAuditJson — invalid_vulnerable_versions", () => {
  test("malformed vulnerable_versions → invalid_vulnerable_versions, advisory dropped", () => {
    const r = normalizeAuditJson({ "package-a": [{ id: "100", severity: "high", vulnerable_versions: "garbage" }] });
    expect(r.advisories).toEqual([]);
    expect(r.errors.some((e) => e.reason === "invalid_vulnerable_versions")).toBe(true);
  });

  test("all four P1 malformed ranges are rejected", () => {
    for (const vv of ["", "garbage", ",", "not-a-semver-range"]) {
      const r = normalizeAuditJson({ "package-a": [{ id: "100", severity: "high", vulnerable_versions: vv }] });
      expect(r.errors.some((e) => e.reason === "invalid_vulnerable_versions")).toBe(true);
      expect(r.advisories).toEqual([]);
    }
  });

  test("valid ranges still normalize (regression)", () => {
    const r = normalizeAuditJson({
      "package-a": [
        { id: "100", severity: "high", vulnerable_versions: ">=1.0.0 <2.0.0" },
        { id: "101", severity: "moderate", vulnerable_versions: "*" },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.advisories.length).toBe(2);
  });

  test("hostile malformed range never echoed in errors", () => {
    const hostile = "/Users/secret sk-xyz https://reg.example/x";
    const r = normalizeAuditJson({ "package-a": [{ id: "100", severity: "high", vulnerable_versions: hostile }] });
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("sk-xyz");
    expect(blob).not.toContain("reg.example");
    expect(r.errors.some((e) => e.reason === "invalid_vulnerable_versions")).toBe(true);
  });
});

// =============================================================================
// isValidVulnerableVersions / isExactSemver — "=" comparator + numeric bounds (#380 P1c)
// =============================================================================

describe("isValidVulnerableVersions — '=' comparator", () => {
  test("accepts single '=' comparator and intersections/unions", () => {
    for (const r of ["=1.0.0", "=0.0.0", "=1.2.3-alpha", "=1.0.0 <2.0.0", ">=1.0.0 =1.5.0", "=1.0.0 || >=2.0.0"]) {
      expect(isValidVulnerableVersions(r)).toBe(true);
    }
  });
  test("rejects bare '=', '==', '===', '=garbage', partial, trailing garbage", () => {
    for (const r of ["=", "==1.0.0", "===1.0.0", "=garbage", "=1.2", "=1", "=1.x", "=1.2.3,", "=1.2.3.4", ">=1.0.0 ="]) {
      expect(isValidVulnerableVersions(r)).toBe(false);
    }
  });
});

describe("isExactSemver / isValidVulnerableVersions — numeric component bounds", () => {
  const MAX = "9007199254740991"; // Number.MAX_SAFE_INTEGER
  const OVER = "9007199254740992"; // MAX_SAFE_INTEGER + 1
  test("isExactSemver rejects components > MAX_SAFE_INTEGER", () => {
    expect(isExactSemver(`${MAX}.0.0`)).toBe(true);
    expect(isExactSemver(`0.${MAX}.0`)).toBe(true);
    expect(isExactSemver(`0.0.${MAX}`)).toBe(true);
    expect(isExactSemver(`${OVER}.0.0`)).toBe(false);
    expect(isExactSemver(`0.${OVER}.0`)).toBe(false);
    expect(isExactSemver(`0.0.${OVER}`)).toBe(false);
    expect(isExactSemver("99999999999999999999.0.0")).toBe(false);
  });
  test("isValidVulnerableVersions rejects huge components in any comparator", () => {
    expect(isValidVulnerableVersions(`>${MAX}.0.0`)).toBe(true);
    expect(isValidVulnerableVersions(`>${OVER}.0.0`)).toBe(false);
    expect(isValidVulnerableVersions(">99999999999999999999.0.0")).toBe(false);
    expect(isValidVulnerableVersions(`<2.0.5 || >${OVER}.0.0`)).toBe(false);
    expect(isValidVulnerableVersions(">=1.0.0 <99999999999999999999.0.0")).toBe(false);
  });
});
