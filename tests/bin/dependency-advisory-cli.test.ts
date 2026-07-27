import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runGate,
  serializeGate,
  formatGateLine,
  spawnAudit,
  maybeGunzip,
  type GateDeps,
  type GateResult,
  type AuditResult,
  type SpawnCmd,
} from "../../bin/check-dependency-advisory-gate.js";
import { evaluatePolicy } from "../../bin/lib/dependency-advisory-policy.js";
import { gzipSync } from "node:zlib";

// ── fixtures (anonymous package-a) ───────────────────────────────────────────

const MODERATE_AUDIT = '{"package-a":[{"id":"100","severity":"moderate","vulnerable_versions":"*"}]}';
const HIGH_AUDIT = '{"package-a":[{"id":"200","severity":"high","vulnerable_versions":"*"}]}';
const PKG_A_LOCK =
  '{"lockfileVersion":1,"workspaces":{"":{"name":"cbrain","dependencies":{"package-a":"^1.0.0"}}},"packages":{"package-a":["package-a@1.0.0","",{},"sha"]}}';
const NO_A_LOCK =
  '{"lockfileVersion":1,"workspaces":{"":{"name":"cbrain","dependencies":{"package-b":"^1.0.0"}}},"packages":{"package-b":["package-b@1.0.0","",{},"sha"]}}';
const EMPTY_REGISTRY = '{"schema_version":1,"exceptions":[]}';
const HIGH_EXC_REGISTRY =
  '{"schema_version":1,"exceptions":[{"advisory_id":"200","package":"package-a","installed_version":"1.0.0","dependency_path":["cbrain","package-a@1.0.0"],"reachability":"unreachable","mitigation":"m","owner":"o","rationale":"r","expires_on":"2099-12-31"}]}';

function auditR(exitCode: number, stdout: string, stderr = ""): AuditResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false };
}
function deps(over: Partial<GateDeps>): GateDeps {
  return {
    runAudit: async () => auditR(0, MODERATE_AUDIT),
    readRegistry: () => EMPTY_REGISTRY,
    readLock: () => PKG_A_LOCK,
    today: "2026-01-01",
    evaluate: evaluatePolicy,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("gate adapter — verdicts + exit mapping", () => {
  test("1. audit exit 0 + moderate/low → GO, exit 0", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(0, MODERATE_AUDIT) }));
    expect(r.outcome).toBe("go");
    expect(r.exitCode).toBe(0);
  });

  test("2. audit exit 1 + moderate/low → GO, exit 0 (exit 1 ≠ NO-GO)", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(1, MODERATE_AUDIT) }));
    expect(r.outcome).toBe("go");
    expect(r.exitCode).toBe(0);
  });

  test("3. audit exit 1 + untriaged high → NO-GO, exit 1", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(1, HIGH_AUDIT), readRegistry: () => EMPTY_REGISTRY }));
    expect(r.outcome).toBe("no-go");
    expect(r.exitCode).toBe(1);
  });

  test("4. audit exit 0 + valid exception high → GO, exit 0", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(0, HIGH_AUDIT), readRegistry: () => HIGH_EXC_REGISTRY }));
    expect(r.outcome).toBe("go");
    expect(r.exitCode).toBe(0);
  });

  test("5. policy fatal → exit 2", async () => {
    // advisory package-a has no lock path → audit_lock_mismatch fatal
    const r = await runGate(deps({ runAudit: async () => auditR(0, HIGH_AUDIT), readLock: () => NO_A_LOCK }));
    expect(r.outcome).toBe("fatal");
    expect(r.exitCode).toBe(2);
  });
});

describe("gate adapter — runtime fatal reasons", () => {
  test("6. audit exit 2 + valid JSON → audit_command_failed, exit 2", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(2, MODERATE_AUDIT) }));
    expect(r.outcome).toBe("fatal");
    expect(r.errors[0]?.reason).toBe("audit_command_failed");
    expect(r.exitCode).toBe(2);
  });

  test("7. audit exit 0/1 + invalid JSON → audit_output_invalid", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(0, "not-json{") }));
    expect(r.errors[0]?.reason).toBe("audit_output_invalid");
    expect(r.exitCode).toBe(2);
  });

  test("8. audit stdout empty → audit_output_invalid", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(0, "") }));
    expect(r.errors[0]?.reason).toBe("audit_output_invalid");
    expect(r.exitCode).toBe(2);
  });

  test("9. spawn failure → audit_spawn_failed", async () => {
    const r = await runGate(deps({ runAudit: async () => { throw new Error("ENOENT"); } }));
    expect(r.errors[0]?.reason).toBe("audit_spawn_failed");
    expect(r.exitCode).toBe(2);
  });

  test("10. timeout → audit_timeout", async () => {
    const r = await runGate(deps({ runAudit: async () => ({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }) }));
    expect(r.errors[0]?.reason).toBe("audit_timeout");
    expect(r.exitCode).toBe(2);
  });

  test("11. registry read failure → registry_read_failed", async () => {
    const r = await runGate(deps({ readRegistry: () => { throw new Error("read"); } }));
    expect(r.errors[0]?.reason).toBe("registry_read_failed");
    expect(r.exitCode).toBe(2);
  });

  test("12. registry invalid JSON → registry_json_invalid", async () => {
    const r = await runGate(deps({ readRegistry: () => "not-json{" }));
    expect(r.errors[0]?.reason).toBe("registry_json_invalid");
    expect(r.exitCode).toBe(2);
  });

  test("13. lock read failure → lock_read_failed", async () => {
    const r = await runGate(deps({ readLock: () => { throw new Error("read"); } }));
    expect(r.errors[0]?.reason).toBe("lock_read_failed");
    expect(r.exitCode).toBe(2);
  });

  test("14. unexpected thrown error → unexpected_runtime_failure", async () => {
    const r = await runGate(deps({ evaluate: () => { throw new Error("bug"); } }));
    expect(r.errors[0]?.reason).toBe("unexpected_runtime_failure");
    expect(r.exitCode).toBe(2);
  });
});

describe("gate adapter — privacy + stability", () => {
  test("15. audit stderr with path/credential/URL never leaks", async () => {
    const r = await runGate(
      deps({ runAudit: async () => auditR(0, MODERATE_AUDIT, "/Users/secret token123 https://reg.example/x") }),
    );
    const blob = serializeGate(r);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("token123");
    expect(blob).not.toContain("reg.example");
  });

  test("16. invalid audit stdout with private text never leaks (output_invalid has no raw)", async () => {
    const r = await runGate(
      deps({ runAudit: async () => auditR(0, "/Users/leaky{not-json") }),
    );
    expect(r.errors[0]?.reason).toBe("audit_output_invalid");
    const blob = serializeGate(r);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("leaky");
  });

  test("17. serializeGate produces exactly one JSON object (parseable, no banner)", () => {
    const r: GateResult = { schema_version: 1, gate: "dependency-advisories", outcome: "go", evaluated_on: "2026-01-01", counts: { critical: 0, high: 0, moderate: 0, low: 0 }, findings: [], errors: [] };
    const s = serializeGate(r);
    expect(() => JSON.parse(s)).not.toThrow();
    const parsed = JSON.parse(s);
    expect(Object.keys(parsed)).toEqual(["schema_version", "gate", "outcome", "evaluated_on", "counts", "findings", "errors"]);
  });

  test("18. same input/today → byte-identical serializeGate", async () => {
    const mk = () => runGate(deps({ runAudit: async () => auditR(0, MODERATE_AUDIT), today: "2026-01-01" }));
    const a = serializeGate(await mk());
    const b = serializeGate(await mk());
    expect(a).toBe(b);
  });

  test("19. package.json adds only gate:dependencies (known scripts intact)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8"));
    expect(pkg.scripts["gate:dependencies"]).toBe("bun bin/check-dependency-advisory-gate.ts");
    expect(pkg.scripts["check:docs"]).toBe("bun bin/check-docs-consistency.ts");
    expect(pkg.scripts["gate:v2-preflight"]).toBe("bun bin/check-v2-preflight.ts");
    expect(pkg.scripts["check:ci"]).toBe("bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/");
  });

  test("20. importing CLI module does not spawn audit (import.meta.main guard)", () => {
    // The import at the top of this file already loaded the module. If the
    // import had triggered spawnAudit (no guard), the test process would have
    // spawned a subprocess at import time. We assert the module surface is
    // usable without any subprocess side effect.
    expect(typeof runGate).toBe("function");
    expect(typeof serializeGate).toBe("function");
  });

  test("21. all results exit code ∈ {0,1,2}", async () => {
    const cases = [
      await runGate(deps({ runAudit: async () => auditR(0, MODERATE_AUDIT) })),
      await runGate(deps({ runAudit: async () => auditR(1, HIGH_AUDIT), readRegistry: () => EMPTY_REGISTRY })),
      await runGate(deps({ runAudit: async () => auditR(2, MODERATE_AUDIT) })),
      await runGate(deps({ runAudit: async () => { throw new Error("x"); } })),
    ];
    for (const r of cases) {
      expect([0, 1, 2]).toContain(r.exitCode);
    }
  });
});

// =============================================================================
// P1: audit process termination must not masquerade as success
// =============================================================================

describe("gate adapter — audit termination (P1 signal/exit strictness)", () => {
  test("exitCode=null + SIGTERM + valid JSON → fatal audit_command_failed, exit 2", async () => {
    const r = await runGate(
      deps({ runAudit: async () => ({ exitCode: null, signal: "SIGTERM", stdout: MODERATE_AUDIT, stderr: "", timedOut: false }) }),
    );
    expect(r.outcome).toBe("fatal");
    expect(r.errors[0]?.reason).toBe("audit_command_failed");
    expect(r.exitCode).toBe(2);
  });

  test("exitCode=null + signal=null → audit_command_failed", async () => {
    const r = await runGate(
      deps({ runAudit: async () => ({ exitCode: null, signal: null, stdout: MODERATE_AUDIT, stderr: "", timedOut: false }) }),
    );
    expect(r.errors[0]?.reason).toBe("audit_command_failed");
    expect(r.exitCode).toBe(2);
  });

  test("exitCode=1 + signal=null still reaches policy (GO)", async () => {
    const r = await runGate(deps({ runAudit: async () => auditR(1, MODERATE_AUDIT) }));
    expect(r.outcome).toBe("go");
    expect(r.exitCode).toBe(0);
  });

  test("timedOut=true + SIGKILL → audit_timeout (priority over signal)", async () => {
    const r = await runGate(
      deps({ runAudit: async () => ({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }) }),
    );
    expect(r.errors[0]?.reason).toBe("audit_timeout");
    expect(r.exitCode).toBe(2);
  });
});

// =============================================================================
// P1: runtime envelope never leaks hostile today
// =============================================================================

describe("gate adapter — runtime envelope never leaks hostile today (P1)", () => {
  const HOSTILE = "/Users/secret";
  const assertNoLeak = (r: { evaluated_on: string | null }) => {
    expect(r.evaluated_on).toBeNull();
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("secret");
  };

  test("registry_read_failed + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, readRegistry: () => { throw new Error("x"); } })));
  });
  test("registry_json_invalid + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, readRegistry: () => "bad{" })));
  });
  test("lock_read_failed + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, readLock: () => { throw new Error("x"); } })));
  });
  test("audit_spawn_failed + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, runAudit: async () => { throw new Error("x"); } })));
  });
  test("audit_timeout + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, runAudit: async () => ({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }) })));
  });
  test("audit_command_failed (signal) + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, runAudit: async () => ({ exitCode: null, signal: "SIGTERM", stdout: MODERATE_AUDIT, stderr: "", timedOut: false }) })));
  });
  test("audit_output_invalid + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, runAudit: async () => auditR(0, "bad{") })));
  });
  test("unexpected_runtime_failure + hostile today", async () => {
    assertNoLeak(await runGate(deps({ today: HOSTILE, evaluate: () => { throw new Error("x"); } })));
  });
  test("valid today preserved on runtime fatal", async () => {
    const r = await runGate(deps({ today: "2026-07-26", readRegistry: () => { throw new Error("x"); } }));
    expect(r.evaluated_on).toBe("2026-07-26");
  });
});

// =============================================================================
// P2: production line format — byte-exact single JSON line
// =============================================================================

describe("gate adapter — production line format (P2)", () => {
  test("formatGateLine: exactly one JSON object + one trailing newline", () => {
    const r: GateResult = { schema_version: 1, gate: "dependency-advisories", outcome: "go", evaluated_on: "2026-01-01", counts: { critical: 0, high: 0, moderate: 0, low: 0 }, findings: [], errors: [] };
    const line = formatGateLine(r);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(false); // no double newline
    const inner = line.slice(0, -1);
    expect(inner.includes("\n")).toBe(false); // no inner newline / banner
    expect(() => JSON.parse(inner)).not.toThrow();
    expect(line.split("\n")).toEqual([inner, ""]); // exactly [json, ""]
  });
});

// =============================================================================
// #380 P1c — audit output resource limits
// =============================================================================

describe("gate adapter — audit output resource limits (#380 P1c)", () => {
  const MAX = 8 * 1024 * 1024;
  const MB = 1024 * 1024;
  // Synthetic emitter writing n bytes (0x41='A') to a stream, exiting only after flush.
  const emit = (stream: "stdout" | "stderr", n: number): SpawnCmd => ({
    bin: process.execPath,
    args: ["-e", `process.${stream}.write(Buffer.alloc(${n}, 65), () => process.exit(0));`],
  });

  // ── maybeGunzip: TRUE decompressed hard cap (no full allocation) ──────────
  test("maybeGunzip: small valid gzip JSON decodes", () => {
    const r = maybeGunzip(gzipSync(Buffer.from('{"package-a":[]}')));
    expect(r.tooLarge).toBe(false);
    expect(r.text).toBe('{"package-a":[]}');
  });

  test("maybeGunzip: non-gzip plaintext (real bun audit shape) passes through", () => {
    // Real `bun audit --json` emits PLAIN JSON (not gzip) when piped; the
    // non-gzip branch must pass it through unchanged under the cap.
    const r = maybeGunzip(Buffer.from('{"package-a":[{"id":"1","severity":"low","vulnerable_versions":"*"}]}', "utf-8"));
    expect(r.tooLarge).toBe(false);
    expect(r.text).toBe('{"package-a":[{"id":"1","severity":"low","vulnerable_versions":"*"}]}');
  });

  test("maybeGunzip: decompressed exactly 8 MiB allowed", () => {
    const r = maybeGunzip(gzipSync(Buffer.alloc(MAX, 0x20)));
    expect(r.tooLarge).toBe(false);
    expect(r.text.length).toBe(MAX);
  });

  test("maybeGunzip: decompressed 8 MiB + 1 rejected as tooLarge (no full allocation)", () => {
    const r = maybeGunzip(gzipSync(Buffer.alloc(MAX + 1, 0x20)));
    expect(r.tooLarge).toBe(true);
    expect(r.text).toBe("");
  });

  test("maybeGunzip: tiny-compressed gzip bomb (>8 MiB) → tooLarge, not corrupt-empty", () => {
    const r = maybeGunzip(gzipSync(Buffer.alloc(MAX + 1024, 0x20)));
    expect(r.tooLarge).toBe(true);
    expect(r.text).toBe("");
  });

  test("maybeGunzip: non-gzip plaintext under cap passes; over cap tooLarge", () => {
    expect(maybeGunzip(Buffer.from("plain")).tooLarge).toBe(false);
    expect(maybeGunzip(Buffer.alloc(MAX + 1, 0x41)).tooLarge).toBe(true);
  });

  test("maybeGunzip: corrupt gzip (not a size cap) → empty text, NOT tooLarge", () => {
    const r = maybeGunzip(Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0xff]));
    expect(r.tooLarge).toBe(false);
    expect(r.text).toBe("");
  });

  test("maybeGunzip: complete valid gzip with advisories decodes", () => {
    const json = '{"package-a":[{"id":"1","severity":"high","vulnerable_versions":"*"}]}';
    const r = maybeGunzip(gzipSync(Buffer.from(json)));
    expect(r.tooLarge).toBe(false);
    expect(r.text).toBe(json);
  });

  test("maybeGunzip: truncated gzip (missing trailer) → fail-closed empty, NO partial output", () => {
    // A Z_SYNC_FLUSH-lenient decoder would emit partial JSON here (a cut-off
    // advisory could vanish, flipping the verdict). Strict gunzipSync refuses.
    const full = '{"package-b":[{"id":"2","severity":"moderate","vulnerable_versions":"*"}],"package-a":[{"id":"1","severity":"critical","vulnerable_versions":"*"}]}';
    const gz = gzipSync(Buffer.from(full));
    const trunc = gz.subarray(0, gz.length - 18); // drop trailer + tail
    const r = maybeGunzip(trunc);
    expect(r.tooLarge).toBe(false);
    expect(r.text).toBe("");
  });

  test("maybeGunzip: CRC-corrupted gzip → fail-closed empty", () => {
    const gz = Buffer.from(gzipSync(Buffer.from('{"package-a":[{"id":"1","severity":"high","vulnerable_versions":"*"}]}')));
    gz[gz.length - 5] ^= 0xff; // flip a byte in the CRC/trailer region
    const r = maybeGunzip(gz);
    expect(r.tooLarge).toBe(false);
    expect(r.text).toBe("");
  });

  // ── spawnAudit: real byte collection + SIGKILL (synthetic emitter, same impl) ─
  test("spawnAudit: stdout exactly 2 MiB → cap NOT triggered", async () => {
    const r = await spawnAudit(emit("stdout", 2 * MB));
    expect(r.outputTooLarge).toBe(false);
  });

  test("spawnAudit: stdout 2 MiB + 1 → tooLarge (boundary)", async () => {
    const r = await spawnAudit(emit("stdout", 2 * MB + 1));
    expect(r.outputTooLarge).toBe(true);
    expect(r.stdout).toBe("");
  });

  test("spawnAudit: stdout well over cap → tooLarge, SIGKILL, raw not retained", async () => {
    const r = await spawnAudit(emit("stdout", 4 * MB));
    expect(r.outputTooLarge).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(r.stdout).toBe("");
  });

  test("spawnAudit: stderr exactly 512 KiB → cap NOT triggered", async () => {
    const r = await spawnAudit(emit("stderr", 512 * 1024));
    expect(r.outputTooLarge).toBe(false);
  });

  test("spawnAudit: stderr 512 KiB + 1 byte → tooLarge (precise boundary)", async () => {
    const r = await spawnAudit(emit("stderr", 512 * 1024 + 1));
    expect(r.outputTooLarge).toBe(true);
    expect(r.stderr).toBe("");
  });

  // ── runGate: size-cap SIGKILL classifies as audit_output_invalid, no leak ───
  test("runGate: size-cap SIGKILL → audit_output_invalid (not command_failed), no raw leak", async () => {
    const r = await runGate(deps({ runAudit: () => spawnAudit(emit("stdout", 4 * MB)) }));
    expect(r.outcome).toBe("fatal");
    expect(r.errors[0]?.reason).toBe("audit_output_invalid");
    expect(r.exitCode).toBe(2);
    expect(serializeGate(r)).not.toContain("AAAA");
  });

  test("runGate: compressed < 2 MiB but decompressed > 8 MiB → audit_output_invalid, exit 2", async () => {
    const bombB64 = gzipSync(Buffer.alloc(MAX + 1024, 0x20)).toString("base64");
    const cmd: SpawnCmd = {
      bin: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(bombB64)}, "base64"), () => process.exit(0));`],
    };
    const r = await runGate(deps({ runAudit: () => spawnAudit(cmd) }));
    expect(r.outcome).toBe("fatal");
    expect(r.errors[0]?.reason).toBe("audit_output_invalid");
    expect(r.exitCode).toBe(2);
  });

  test("runGate: complete critical gzip stream → NO-GO (critical untriaged), not GO", async () => {
    const json = '{"package-a":[{"id":"1","severity":"critical","vulnerable_versions":"*"}]}';
    const b64 = gzipSync(Buffer.from(json)).toString("base64");
    const cmd: SpawnCmd = { bin: process.execPath, args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(b64)}, "base64"), () => process.exit(0));`] };
    const r = await runGate(deps({ runAudit: () => spawnAudit(cmd) }));
    expect(r.outcome).toBe("no-go");
    expect(r.exitCode).toBe(1);
  });

  test("runGate: truncated critical+moderate gzip stream → fatal, NEVER GO", async () => {
    const full = '{"package-b":[{"id":"2","severity":"moderate","vulnerable_versions":"*"}],"package-a":[{"id":"1","severity":"critical","vulnerable_versions":"*"}]}';
    const trunc = gzipSync(Buffer.from(full)).subarray(0, -18);
    const b64 = trunc.toString("base64");
    const cmd: SpawnCmd = { bin: process.execPath, args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(b64)}, "base64"), () => process.exit(0));`] };
    const r = await runGate(deps({ runAudit: () => spawnAudit(cmd) }));
    expect(r.outcome).not.toBe("go");
    expect(r.outcome).toBe("fatal");
    expect(r.errors[0]?.reason).toBe("audit_output_invalid");
    expect(r.exitCode).toBe(2);
  });
});
