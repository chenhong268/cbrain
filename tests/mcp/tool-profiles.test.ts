import { describe, test, expect } from "bun:test";
import {
  TOOL_PROFILES,
  TOOL_PROFILE_ALLOWLISTS,
  resolveToolProfile,
  parseToolProfile,
  isToolAllowedForProfile,
} from "../../src/mcp/tool-profiles";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

describe("resolveToolProfile (env only)", () => {
  test("env value resolves", () => {
    expect(resolveToolProfile("agent")).toBe("agent");
    expect(resolveToolProfile("maintenance")).toBe("maintenance");
    expect(resolveToolProfile("debug")).toBe("debug");
    expect(resolveToolProfile("full")).toBe("full");
  });
  test("absent / empty / whitespace defaults to full", () => {
    expect(resolveToolProfile(undefined)).toBe("full");
    expect(resolveToolProfile("")).toBe("full");
    expect(resolveToolProfile("   ")).toBe("full");
  });
  test("trims + lowercases", () => {
    expect(resolveToolProfile("  AGENT ")).toBe("agent");
  });
  test("invalid fails fast with the env var name in the message", () => {
    expect(() => resolveToolProfile("garbage")).toThrow(/CBRAIN_MCP_TOOL_PROFILE/);
  });
  test("every member of TOOL_PROFILES resolves", () => {
    for (const p of TOOL_PROFILES) expect(resolveToolProfile(p)).toBe(p);
  });
});

describe("isToolAllowedForProfile", () => {
  test("full allows everything", () => {
    expect(isToolAllowedForProfile("anything", "full")).toBe(true);
    expect(isToolAllowedForProfile("query", "full")).toBe(true);
  });
  test("agent excludes low-level/admin tools", () => {
    for (const t of ["query", "get_chunks", "dream", "dream_status", "dream_reset", "sync", "health",
      "job_submit", "job_list", "job_status", "job_cancel", "job_retry", "relation_audit",
      "watcher_quarantine", "get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(isToolAllowedForProfile(t, "agent")).toBe(false);
    }
  });
  test("agent includes the documented user-facing surface", () => {
    for (const t of ["cbrain_recall", "deep_recall", "ingest", "get_page", "put_page",
      "merge_entities", "get_org_tree", "status"]) {
      expect(isToolAllowedForProfile(t, "agent")).toBe(true);
    }
  });
  test("maintenance includes dream + job_* + sync + health + relation_audit", () => {
    for (const t of ["dream", "dream_status", "dream_reset", "sync", "health", "relation_audit",
      "job_submit", "job_list", "job_status", "job_cancel", "job_retry", "status", "wakeup_diff"]) {
      expect(isToolAllowedForProfile(t, "maintenance")).toBe(true);
    }
  });
  test("debug includes query + get_chunks + list_pages + provenance", () => {
    for (const t of ["query", "get_chunks", "list_pages", "get_links", "get_tags", "tag",
      "get_versions", "get_ingest_log", "get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(isToolAllowedForProfile(t, "debug")).toBe(true);
    }
  });

  test("agent does not expose unified tag tool in the first consolidation slice (#286)", () => {
    expect(isToolAllowedForProfile("tag", "agent")).toBe(false);
  });

  // #264: raw `ingest` stays in the agent surface BY DESIGN. Removing it would
  // force daily Agents onto `put_page` (skips NER → no entity minting → degraded
  // memory). The 300s client-poison failure mode is cured two layers out of
  // ingest's reach: (1) the agent profile already excludes the guaranteed-slow
  // tools (sync/dream — locked above), and (2) a bounded client timeout on the
  // HTTP config (docs/hermes-integration.md) makes any single slow ingest fail
  // fast instead of hanging the whole MCP client. ingest's synchronous NER is
  // bounded by its 500k content cap + per-call timeout/fail-open
  // (src/core/ingestion/ner.ts NER_DEFAULT_TIMEOUT_MS); large captures should use
  // `nerMode: "defer"` to skip synchronous NER entirely. This test locks the
  // keep-decision against accidental removal.
  test("ingest remains in agent by design (#264) — poison cure is profile + client timeout, not ingest removal", () => {
    expect(isToolAllowedForProfile("ingest", "agent")).toBe(true);
    // And the guaranteed-slow maintenance path that actually caused the poison
    // stays excluded from agent:
    expect(isToolAllowedForProfile("sync", "agent")).toBe(false);
    expect(isToolAllowedForProfile("dream", "agent")).toBe(false);
  });
});

describe("allowlist shape", () => {
  test("only agent/maintenance/debug have allowlists (not full)", () => {
    expect(TOOL_PROFILE_ALLOWLISTS.agent).toBeInstanceOf(Array);
    expect(TOOL_PROFILE_ALLOWLISTS.maintenance).toBeInstanceOf(Array);
    expect(TOOL_PROFILE_ALLOWLISTS.debug).toBeInstanceOf(Array);
    expect((TOOL_PROFILE_ALLOWLISTS as Record<string, unknown>).full).toBeUndefined();
  });
  test("agent allowlist is bounded <= 20", () => {
    expect(TOOL_PROFILE_ALLOWLISTS.agent.length).toBeLessThanOrEqual(20);
  });
  test("no duplicate names within an allowlist", () => {
    for (const p of ["agent", "maintenance", "debug"] as const) {
      const names = TOOL_PROFILE_ALLOWLISTS[p];
      expect(new Set(names).size).toBe(names.length);
    }
  });
  test("every allowlist entry is a non-empty trimmed string", () => {
    for (const p of ["agent", "maintenance", "debug"] as const) {
      for (const n of TOOL_PROFILE_ALLOWLISTS[p]) {
        expect(typeof n).toBe("string");
        expect(n.length).toBeGreaterThan(0);
        expect(n).toBe(n.trim());
      }
    }
  });
});

describe("allowlist validity vs real inventory", () => {
  const all = collectRegisteredToolNames();
  test("inventory is non-empty and unique", () => {
    expect(all.length).toBeGreaterThan(40);
    expect(new Set(all).size).toBe(all.length);
  });
  test("every allowlisted name exists in the full inventory", () => {
    for (const p of ["agent", "maintenance", "debug"] as const) {
      for (const name of TOOL_PROFILE_ALLOWLISTS[p]) {
        expect(all, `profile ${p} references unknown tool ${name}`).toContain(name);
      }
    }
  });
  test("full inventory includes tools excluded from agent", () => {
    for (const t of ["query", "get_chunks", "dream", "sync", "health", "job_submit"]) {
      expect(all).toContain(t);
    }
  });
});

describe("parseToolProfile (three-state, #260)", () => {
  test("absent for undefined / null / empty / whitespace", () => {
    expect(parseToolProfile(undefined)).toEqual({ kind: "absent" });
    expect(parseToolProfile(null)).toEqual({ kind: "absent" });
    expect(parseToolProfile("")).toEqual({ kind: "absent" });
    expect(parseToolProfile("   ")).toEqual({ kind: "absent" });
  });
  test("ok for valid profiles, trimmed + lowercased", () => {
    for (const p of TOOL_PROFILES) {
      expect(parseToolProfile(p)).toEqual({ kind: "ok", profile: p });
    }
    expect(parseToolProfile("  AGENT ")).toEqual({ kind: "ok", profile: "agent" });
  });
  test("invalid for garbage, raw is the normalized value", () => {
    const r = parseToolProfile("Garbage");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.raw).toBe("garbage");
  });
  test("invalid distinct from absent (fail-fast contract)", () => {
    expect(parseToolProfile(undefined).kind).toBe("absent");
    expect(parseToolProfile("nope").kind).toBe("invalid");
  });
});
