import { describe, test, expect } from "bun:test";
import { resolveSessionProfile } from "../../src/http/session-profile";
import type { ToolProfile } from "../../src/mcp/tool-profiles";

const URL = "http://127.0.0.1/mcp";

function req(opts: { header?: string; body?: unknown }): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.header !== undefined) headers["x-cbrain-tool-profile"] = opts.header;
  return new Request(URL, {
    method: "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function init(params: Record<string, unknown> = {}): unknown {
  return {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" }, ...params },
  };
}

const FB: ToolProfile = "full";

describe("resolveSessionProfile (#260)", () => {
  test("header valid → ok, source=header (short-circuits metadata)", async () => {
    const r = await resolveSessionProfile(req({ header: "agent", body: init({ _meta: { cbrainToolProfile: "debug" } }) }), FB);
    expect(r).toEqual({ profile: "agent", source: "header" });
  });
  test("header trims + lowercases", async () => {
    const r = await resolveSessionProfile(req({ header: "  Maintenance " }), FB);
    expect(r).toEqual({ profile: "maintenance", source: "header" });
  });
  test("header invalid → error (no session, no fallback)", async () => {
    const r = await resolveSessionProfile(req({ header: "bogus" }), FB);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/X-CBrain-Tool-Profile/);
  });
  test("metadata _meta valid (header absent) → ok, source=metadata", async () => {
    const r = await resolveSessionProfile(req({ body: init({ _meta: { cbrainToolProfile: "debug" } }) }), FB);
    expect(r).toEqual({ profile: "debug", source: "metadata" });
  });
  test("metadata.metadata path also accepted (compat, non-spec)", async () => {
    const r = await resolveSessionProfile(req({ body: init({ metadata: { cbrainToolProfile: "agent" } }) }), FB);
    expect(r).toEqual({ profile: "agent", source: "metadata" });
  });
  test("_meta takes precedence over metadata when both present", async () => {
    const r = await resolveSessionProfile(req({ body: init({ _meta: { cbrainToolProfile: "debug" }, metadata: { cbrainToolProfile: "agent" } }) }), FB);
    expect(r).toEqual({ profile: "debug", source: "metadata" });
  });
  test("metadata invalid → error (no fallback to full)", async () => {
    const r = await resolveSessionProfile(req({ body: init({ _meta: { cbrainToolProfile: "nope" } }) }), FB);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/cbrainToolProfile/);
  });
  test("both absent → fallback (default)", async () => {
    const r = await resolveSessionProfile(req({ body: init() }), FB);
    expect(r).toEqual({ profile: "full", source: "default" });
  });
  test("non-JSON body → metadata absent, falls back (does not throw)", async () => {
    const r = await resolveSessionProfile(new Request(URL, { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }), "agent");
    expect(r).toEqual({ profile: "agent", source: "default" });
  });
  test("non-initialize-shaped body (no params) → metadata absent, falls back", async () => {
    const r = await resolveSessionProfile(req({ body: { jsonrpc: "2.0", method: "tools/call", params: { name: "x" } } }), FB);
    expect(r).toEqual({ profile: "full", source: "default" });
  });
  test("fallback honors server default (e.g. env-set agent)", async () => {
    const r = await resolveSessionProfile(req({ body: init() }), "maintenance");
    expect(r).toEqual({ profile: "maintenance", source: "default" });
  });
});
