import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/mcp/context.js";
import type { ToolProfile } from "../../src/mcp/tool-profiles.js";
import { registerProfileTools } from "../../src/mcp/tools/profile.js";
import { ProfileManager } from "../../src/profile/manager.js";
import {
  buildAgentVisibleStats,
  type ProfileUpdateInput,
  validateAgentProfileUpdate,
} from "../../src/mcp/tools/profile-policy.js";

const VALID_UPDATE: ProfileUpdateInput = {
  id: "response-length-short",
  type: "preference",
  category: "communication",
  scope: "open",
  content: "回复保持简洁",
  source: "explicit",
};

const PROFILE_YAML = `version: 1
user:
  id: test-user
entries:
  - id: scoped-existing
    type: context
    category: work
    scope: scoped
    agents:
      - trusted-agent
    content: scoped detail
    source: explicit
    updated_at: 2026-07-15
  - id: private-existing
    type: constraint
    category: general
    scope: private
    content: private detail
    source: explicit
    updated_at: 2026-07-15
`;

describe("daily Agent Profile policy", () => {
  let root: string;
  let profilePath: string;
  let profile: ProfileManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-profile-policy-"));
    profilePath = join(root, "profile.yaml");
    writeFileSync(profilePath, PROFILE_YAML, "utf-8");
    profile = new ProfileManager(root);
    profile.load();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts one explicit open update", () => {
    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE])).toBeNull();
  });

  test("rejects an absent or empty update batch", () => {
    expect(validateAgentProfileUpdate(profile, undefined)).toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [])).toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects non-explicit sources and non-open scopes", () => {
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, source: "observed" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, source: "inferred" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, source: undefined }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, scope: "scoped" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, scope: "private" }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects duplicate IDs within the same batch", () => {
    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE, { ...VALID_UPDATE }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects direct collisions with hidden existing IDs using only the generic code", () => {
    for (const id of ["scoped-existing", "private-existing"]) {
      expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, id }]))
        .toBe("PROFILE_UPDATE_INVALID");
    }
  });

  test("preflights the whole batch and has no write or in-memory side effects", () => {
    const bytesBefore = readFileSync(profilePath);
    const entriesBefore = profile.getEntries();
    const hiddenCollision = { ...VALID_UPDATE, id: "private-existing" };

    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE])).toBeNull();
    expect(validateAgentProfileUpdate(profile, [VALID_UPDATE, hiddenCollision]))
      .toBe("PROFILE_UPDATE_INVALID");

    expect(readFileSync(profilePath).equals(bytesBefore)).toBe(true);
    expect(profile.getEntries()).toEqual(entriesBefore);
    expect(profile.getEntry(VALID_UPDATE.id)).toBeUndefined();
  });

  test("rejects empty or whitespace-only IDs and content", () => {
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, id: "" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, id: " \t\n " }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, content: "" }]))
      .toBe("PROFILE_UPDATE_INVALID");
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, content: " \t\n " }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects invalid runtime enum values", () => {
    const invalidType = {
      ...VALID_UPDATE,
      type: "opinion",
    } as unknown as ProfileUpdateInput;

    expect(validateAgentProfileUpdate(profile, [invalidType])).toBe("PROFILE_UPDATE_INVALID");
  });

  test("rejects updates restricted to named agents", () => {
    expect(validateAgentProfileUpdate(profile, [{ ...VALID_UPDATE, agents: ["agent-a"] }]))
      .toBe("PROFILE_UPDATE_INVALID");
  });

  test("builds stats only from the supplied Agent-visible entries", () => {
    const entries = profile.getEntries();

    expect(buildAgentVisibleStats(entries)).toEqual({
      total: 2,
      byScope: { scoped: 1, private: 1 },
      byType: { context: 1, constraint: 1 },
      modules: 0,
    });
  });
});

const AGENT_PROFILE_YAML = `version: 1
user:
  id: test-agent-user
entries:
  - id: open-entry
    type: preference
    category: communication
    scope: open
    content: OPEN_CONTENT_SENTINEL
    source: explicit
    updated_at: 2026-07-15
  - id: private-entry
    type: constraint
    category: general
    scope: private
    content: PRIVATE_CONTENT_SENTINEL
    source: explicit
    updated_at: 2026-07-15
`;

const AGENT_PROFILE_MODULE = `version: 1
module: module-alpha
enabled: true
user:
  id: test-agent-user
entries:
  - id: module-open-entry
    type: habit
    category: work
    scope: open
    content: MODULE_OPEN_CONTENT_SENTINEL
    source: explicit
    updated_at: 2026-07-15
  - id: scoped-entry
    type: context
    category: work
    scope: scoped
    agents:
      - trusted-agent
    content: SCOPED_CONTENT_SENTINEL
    source: explicit
    updated_at: 2026-07-15
`;

const VALID_AGENT_UPDATE: ProfileUpdateInput = {
  id: "explicit-open-update",
  type: "preference",
  category: "communication",
  scope: "open",
  content: "EXPLICIT_OPEN_UPDATE_SENTINEL",
  source: "explicit",
};

const POLICY_MESSAGES = {
  PROFILE_ACTION_FORBIDDEN: "Daily Agent sessions cannot remove or reload Profile entries.",
  PROFILE_SCOPE_FORBIDDEN: "Daily Agent sessions can read open Profile entries only.",
  PROFILE_UPDATE_INVALID: "Daily Agent updates require a valid batch of explicit, open Profile entries.",
} as const;

function parseToolBody(result: { content: unknown[] }): Record<string, unknown> {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected first MCP content item to be text");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

type ListedProfileTool = {
  description?: string;
  inputSchema: {
    properties?: Record<string, {
      description?: string;
      default?: unknown;
      enum?: string[];
      items?: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }> };
    }>;
  };
};

async function listedProfileTool(client: Client): Promise<ListedProfileTool> {
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "profile");
  if (!tool) throw new Error("profile tool was not listed");
  return tool as ListedProfileTool;
}

describe.serial("daily Agent Profile real MCP handler", () => {
  let root: string;
  let profilePath: string;
  let modulePath: string;
  let profile: ProfileManager;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cbrain-profile-handler-policy-"));
    profilePath = join(root, "profile.yaml");
    modulePath = join(root, "profile.d", "module-alpha.yaml");
    mkdirSync(join(root, "profile.d"), { recursive: true });
    writeFileSync(profilePath, AGENT_PROFILE_YAML, "utf-8");
    writeFileSync(modulePath, AGENT_PROFILE_MODULE, "utf-8");
    profile = new ProfileManager(root);
    profile.load();

    server = new McpServer({ name: "profile-policy-test", version: "0.0.0" });
    registerProfileTools(server, {
      profile,
      toolProfile: "agent",
    } as ToolContext);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "profile-policy-client", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    try {
      await client.close();
    } finally {
      try {
        await server.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("tools/list requires Agent update source without changing the source enum", async () => {
    const tool = await listedProfileTool(client);
    const properties = tool.inputSchema.properties ?? {};
    const sourceSchema = properties.entries?.items?.properties?.source;

    expect(sourceSchema?.enum).toEqual(["explicit", "observed", "inferred"]);
    expect(sourceSchema?.default).toBeUndefined();
    expect(sourceSchema?.description).toContain("explicit");
  });

  test("tools/list truthfully describes the governed Agent actions and scopes", async () => {
    const tool = await listedProfileTool(client);
    const properties = tool.inputSchema.properties ?? {};

    expect(tool.description).toContain("open");
    expect(tool.description).toContain("explicit");
    expect(tool.description).toContain("unavailable");
    expect(tool.description?.toLowerCase()).not.toContain("aliases");
    expect(properties.action?.enum).toEqual(["get", "update", "remove", "reload"]);
    expect(properties.action?.description).toContain("unavailable");
    expect(properties.scope?.enum).toEqual(["open", "scoped", "private"]);
    expect(properties.scope?.description).toContain("open");
  });

  test("get returns only open entries and privacy-safe envelope metadata", async () => {
    const result = await client.callTool({ name: "profile", arguments: { action: "get" } });
    const body = parseToolBody(result as { content: unknown[] }) as {
      display: string;
      summary: { status: string; count: number; message: string };
      raw: { entries: Array<{ id: string }>; meta: Record<string, unknown> };
    };

    expect(result.isError).toBeFalsy();
    expect(body.raw.entries.map((entry) => entry.id)).toEqual(["open-entry", "module-open-entry"]);
    expect(body.raw.meta).toEqual({
      total: 2,
      filtered: 2,
      loaded_modules: [],
      scope: "open",
    });
    expect(body.summary).toMatchObject({ status: "ok", count: 2 });
    expect(body.display).toContain("共 2 条");

    const serialized = JSON.stringify(body);
    for (const hidden of [
      "private-entry",
      "PRIVATE_CONTENT_SENTINEL",
      "scoped-entry",
      "SCOPED_CONTENT_SENTINEL",
      "module-alpha",
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  test("update accepts one explicit open entry through the real handler", async () => {
    const result = await client.callTool({
      name: "profile",
      arguments: { action: "update", entries: [VALID_AGENT_UPDATE] },
    });
    const body = parseToolBody(result as { content: unknown[] }) as {
      raw: { updated: string[]; count: number };
    };

    expect(result.isError).toBeFalsy();
    expect(body.raw).toEqual({ updated: [VALID_AGENT_UPDATE.id], count: 1 });
    expect(profile.getEntry(VALID_AGENT_UPDATE.id)).toMatchObject(VALID_AGENT_UPDATE);
    expect(readFileSync(profilePath, "utf-8")).toContain(VALID_AGENT_UPDATE.id);
  });

  test("updates an existing open module entry without leaking its module provenance", async () => {
    const mainBefore = readFileSync(profilePath);
    const moduleBefore = readFileSync(modulePath, "utf-8");
    const update = {
      id: "module-open-entry",
      type: "habit" as const,
      category: "work" as const,
      scope: "open" as const,
      content: "UPDATED_MODULE_OPEN_CONTENT_SENTINEL",
      source: "explicit" as const,
    };

    const result = await client.callTool({
      name: "profile",
      arguments: { action: "update", entries: [update] },
    });
    const body = parseToolBody(result as { content: unknown[] }) as {
      raw: { updated: string[]; count: number };
    };

    expect(result.isError).toBeFalsy();
    expect(body.raw).toEqual({ updated: [update.id], count: 1 });
    expect(profile.getEntry(update.id)).toMatchObject(update);
    expect(readFileSync(modulePath, "utf-8")).toContain(update.content);
    expect(readFileSync(modulePath, "utf-8")).not.toBe(moduleBefore);
    expect(readFileSync(profilePath).equals(mainBefore)).toBe(true);

    const serialized = JSON.stringify(result);
    for (const hidden of ["module-alpha", root, modulePath]) {
      expect(serialized).not.toContain(hidden);
    }
    const moduleAfterUpdate = readFileSync(modulePath);

    const rejected = await client.callTool({
      name: "profile",
      arguments: {
        action: "update",
        entries: [{ ...update, source: "observed" }],
      },
    });
    const rejectedBody = parseToolBody(rejected as { content: unknown[] });
    expect(rejected.isError).toBe(true);
    for (const hidden of ["module-alpha", root, modulePath]) {
      expect(JSON.stringify(rejected)).not.toContain(hidden);
    }
    expect(rejectedBody).toEqual({
      error: {
        code: "PROFILE_UPDATE_INVALID",
        message: POLICY_MESSAGES.PROFILE_UPDATE_INVALID,
      },
    });
    expect(readFileSync(modulePath).equals(moduleAfterUpdate)).toBe(true);
    expect(readFileSync(profilePath).equals(mainBefore)).toBe(true);
  });

  test("persists one explicit open batch covering all four Profile entry types", async () => {
    const entries = [
      {
        id: "batch-preference",
        type: "preference" as const,
        category: "communication" as const,
        scope: "open" as const,
        content: "BATCH_PREFERENCE_SENTINEL",
        source: "explicit" as const,
      },
      {
        id: "batch-constraint",
        type: "constraint" as const,
        category: "general" as const,
        scope: "open" as const,
        content: "BATCH_CONSTRAINT_SENTINEL",
        source: "explicit" as const,
      },
      {
        id: "batch-context",
        type: "context" as const,
        category: "work" as const,
        scope: "open" as const,
        content: "BATCH_CONTEXT_SENTINEL",
        source: "explicit" as const,
      },
      {
        id: "batch-habit",
        type: "habit" as const,
        category: "interests" as const,
        scope: "open" as const,
        content: "BATCH_HABIT_SENTINEL",
        source: "explicit" as const,
      },
    ];

    const result = await client.callTool({
      name: "profile",
      arguments: { action: "update", entries },
    });
    const body = parseToolBody(result as { content: unknown[] }) as {
      raw: { updated: string[]; count: number };
    };

    expect(result.isError).toBeFalsy();
    expect(body.raw).toEqual({ updated: entries.map((entry) => entry.id), count: 4 });
    for (const entry of entries) expect(profile.getEntry(entry.id)).toMatchObject(entry);

    const persisted = new ProfileManager(root);
    persisted.load();
    for (const entry of entries) expect(persisted.getEntry(entry.id)).toMatchObject(entry);
  });

  test("rejects forbidden actions and invalid updates with stable errors and zero side effects", async () => {
    const yamlBefore = readFileSync(profilePath);
    const moduleBefore = readFileSync(modulePath);
    const entriesBefore = profile.getEntries();
    const forbiddenOutput = [
      root,
      profilePath,
      modulePath,
      "private-entry",
      "PRIVATE_CONTENT_SENTINEL",
      "scoped-entry",
      "SCOPED_CONTENT_SENTINEL",
      "module-alpha",
      "MODULE_OPEN_CONTENT_SENTINEL",
      "REJECTED_UPDATE_SENTINEL",
    ];

    const assertRejected = async (
      args: Record<string, unknown>,
      code: keyof typeof POLICY_MESSAGES,
    ): Promise<void> => {
      const result = await client.callTool({ name: "profile", arguments: args });
      const body = parseToolBody(result as { content: unknown[] });

      expect(result.isError).toBe(true);
      expect(body).toEqual({ error: { code, message: POLICY_MESSAGES[code] } });
      const serialized = JSON.stringify(body);
      for (const forbidden of forbiddenOutput) expect(serialized).not.toContain(forbidden);
      expect(readFileSync(profilePath).equals(yamlBefore)).toBe(true);
      expect(readFileSync(modulePath).equals(moduleBefore)).toBe(true);
      expect(profile.getEntries()).toEqual(entriesBefore);
      expect(profile.getEntry(VALID_AGENT_UPDATE.id)).toBeUndefined();
    };

    await assertRejected({ action: "get", scope: "scoped" }, "PROFILE_SCOPE_FORBIDDEN");
    await assertRejected({ action: "get", scope: "private" }, "PROFILE_SCOPE_FORBIDDEN");
    await assertRejected({
      action: "update",
      entries: [{ ...VALID_AGENT_UPDATE, content: "REJECTED_UPDATE_SENTINEL", source: "observed" }],
    }, "PROFILE_UPDATE_INVALID");
    await assertRejected({
      action: "update",
      entries: [{ ...VALID_AGENT_UPDATE, content: "REJECTED_UPDATE_SENTINEL", source: "inferred" }],
    }, "PROFILE_UPDATE_INVALID");
    await assertRejected({ action: "update", entries: [] }, "PROFILE_UPDATE_INVALID");
    await assertRejected({
      action: "update",
      entries: [{ ...VALID_AGENT_UPDATE, id: "private-entry", content: "REJECTED_UPDATE_SENTINEL" }],
    }, "PROFILE_UPDATE_INVALID");
    await assertRejected({
      action: "update",
      entries: [
        VALID_AGENT_UPDATE,
        { ...VALID_AGENT_UPDATE, id: "private-entry", content: "REJECTED_UPDATE_SENTINEL" },
      ],
    }, "PROFILE_UPDATE_INVALID");
    await assertRejected({ action: "remove", ids: ["private-entry"] }, "PROFILE_ACTION_FORBIDDEN");
    await assertRejected({ action: "reload" }, "PROFILE_ACTION_FORBIDDEN");
  });

  test("missing update source fails MCP Invalid Params before the handler with zero writes", async () => {
    const yamlBefore = readFileSync(profilePath);
    const moduleBefore = readFileSync(modulePath);
    const entriesBefore = profile.getEntries();
    const { source: _source, ...missingSource } = VALID_AGENT_UPDATE;

    const result = await client.callTool({
      name: "profile",
      arguments: { action: "update", entries: [missingSource] },
    });
    const typedResult = result as { content: unknown[]; isError?: boolean };
    const first = typedResult.content[0] as { type?: string; text?: string } | undefined;

    expect(typedResult.isError).toBe(true);
    expect(first?.type).toBe("text");
    expect(first?.text).toContain("MCP error -32602");
    expect(first?.text).toContain("Input validation error");
    expect(first?.text).not.toContain("PROFILE_UPDATE_INVALID");

    expect(readFileSync(profilePath).equals(yamlBefore)).toBe(true);
    expect(readFileSync(modulePath).equals(moduleBefore)).toBe(true);
    expect(profile.getEntries()).toEqual(entriesBefore);
    expect(profile.getEntry(VALID_AGENT_UPDATE.id)).toBeUndefined();
  });
});

describe.serial("full/debug Profile schema compatibility", () => {
  for (const toolProfile of ["full", "debug"] as const satisfies readonly ToolProfile[]) {
    test(`${toolProfile} keeps observed default and unrestricted private observed updates`, async () => {
      const root = mkdtempSync(join(tmpdir(), `cbrain-profile-${toolProfile}-`));
      const profilePath = join(root, "profile.yaml");
      writeFileSync(profilePath, AGENT_PROFILE_YAML, "utf-8");
      const profile = new ProfileManager(root);
      profile.load();
      const server = new McpServer({ name: `profile-${toolProfile}-test`, version: "0.0.0" });
      registerProfileTools(server, { profile, toolProfile } as ToolContext);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: `profile-${toolProfile}-client`, version: "0.0.0" });
      await client.connect(clientSide);

      try {
        const tool = await listedProfileTool(client);
        const sourceSchema = tool.inputSchema.properties?.entries?.items?.properties?.source;
        expect(sourceSchema?.default).toBe("observed");
        expect(tool.description).toContain("Compatibility aliases");

        const entry = {
          ...VALID_AGENT_UPDATE,
          id: `${toolProfile}-observed-private`,
          scope: "private" as const,
          source: "observed" as const,
        };
        const result = await client.callTool({
          name: "profile",
          arguments: { action: "update", entries: [entry] },
        });

        expect(result.isError).toBeFalsy();
        expect(profile.getEntry(entry.id)).toMatchObject(entry);
        expect(readFileSync(profilePath, "utf-8")).toContain(entry.id);
      } finally {
        try {
          await client.close();
        } finally {
          try {
            await server.close();
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }
      }
    });
  }
});
