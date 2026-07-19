import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { buildContext } from "../../src/mcp/context.js";
import { attachMcpTools } from "../../src/mcp/server.js";
import { installMcpValidationErrorBoundary } from "../../src/mcp/validation-error-boundary.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const SENSITIVE_SENTINEL =
  "api_key=sk-anonymous0000000000000000 /private/fixture/credential.txt";
const FIXED_INPUT_ERROR = {
  content: [{ type: "text" as const, text: "Invalid tool arguments." }],
  isError: true,
} satisfies CallToolResult;

type Fixture = {
  root: string;
  db: CBrainDB;
  server: McpServer;
  client: Client;
};

const roots = new Set<string>();

async function createFixture(
  configure?: (ctx: ReturnType<typeof buildContext>) => void,
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "cbrain-validation-boundary-"));
  roots.add(root);
  const vaultPath = join(root, "vault");
  const runtimePath = join(root, "runtime");
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(runtimePath, { recursive: true });
  const db = new CBrainDB(join(root, "brain.sqlite"));
  const ctx = buildContext({
    db,
    embedding: new DeterministicEmbeddingProvider(),
    lance: new LanceDBManager(),
    vaultPath,
    runtimePath,
  });
  configure?.(ctx);
  const server = new McpServer({ name: "validation-boundary-test", version: "0.0.0" });
  attachMcpTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "validation-boundary-client", version: "0.0.0" });
  await client.connect(clientSide);
  return { root, db, server, client };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  try {
    await fixture.client.close();
  } finally {
    try {
      await fixture.server.close();
    } finally {
      fixture.db.close();
    }
  }
}

function persistedLogs(root: string): string {
  const logDir = join(root, "runtime", "logs");
  return readdirSync(logDir)
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("\n");
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("MCP validation error boundary (#353)", () => {
  test("redacts a rejected value before transport and logs only the bounded operator code", async () => {
    const fixture = await createFixture();
    let handlerCalls = 0;
    fixture.server.registerTool(
      "validation_boundary_probe",
      { inputSchema: { strategy: z.enum(["fts", "vector"]) } },
      async () => {
        handlerCalls += 1;
        return { content: [{ type: "text" as const, text: "handler-ran" }] };
      },
    );

    try {
      const result = await fixture.client.callTool({
        name: "validation_boundary_probe",
        arguments: { strategy: SENSITIVE_SENTINEL },
      });
      const resultText = JSON.stringify(result);

      expect(result).toEqual(FIXED_INPUT_ERROR);
      expect(handlerCalls).toBe(0);
      expect(resultText).not.toContain(SENSITIVE_SENTINEL);
      expect(resultText).not.toContain("Input validation error");
      expect(resultText).not.toContain("invalid_enum_value");
      expect(resultText).not.toMatch(/stack trace|Traceback|\n\s+at\s+/i);

      const logs = persistedLogs(fixture.root);
      expect(logs).toContain("MCP_INPUT_INVALID");
      expect(logs).toContain("validation_boundary_probe");
      expect(logs).not.toContain(SENSITIVE_SENTINEL);
      expect(logs).not.toContain("Input validation error");
      expect(logs).not.toContain("invalid_enum_value");
      expect(logs).not.toContain(fixture.root);
    } finally {
      await closeFixture(fixture);
    }
  });

  test("redacts nested, Unicode, multiline, and long rejected values", async () => {
    const fixture = await createFixture();
    let handlerCalls = 0;
    fixture.server.registerTool(
      "validation_mutation_probe",
      {
        inputSchema: {
          payload: z.object({
            items: z.array(z.object({ strategy: z.enum(["fts", "vector"]) })),
          }),
        },
      },
      async () => {
        handlerCalls += 1;
        return { content: [{ type: "text" as const, text: "handler-ran" }] };
      },
    );
    const mutations = [
      `嵌套🔒\n${SENSITIVE_SENTINEL}`,
      `${SENSITIVE_SENTINEL}:${"x".repeat(8_192)}`,
    ];

    try {
      for (const mutation of mutations) {
        const result = await fixture.client.callTool({
          name: "validation_mutation_probe",
          arguments: { payload: { items: [{ strategy: mutation }] } },
        });
        expect(result).toEqual(FIXED_INPUT_ERROR);
        expect(JSON.stringify(result)).not.toContain(mutation);
      }
      expect(handlerCalls).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  test("remains closed for a bounded-out tool identity when operator logging throws", async () => {
    // Protocol-valid, but intentionally outside the bounded logging grammar.
    const unsafeName = "validation-probe.with-dash";
    const fixture = await createFixture((ctx) => {
      ctx.logger.warn = () => { throw new Error(`logger failed at ${SENSITIVE_SENTINEL}`); };
    });
    fixture.server.registerTool(
      unsafeName,
      { inputSchema: { strategy: z.enum(["fts", "vector"]) } },
      async () => ({ content: [{ type: "text" as const, text: "handler-ran" }] }),
    );

    try {
      const result = await fixture.client.callTool({
        name: unsafeName,
        arguments: { strategy: SENSITIVE_SENTINEL },
      });
      expect(result).toEqual(FIXED_INPUT_ERROR);
      expect(JSON.stringify(result)).not.toContain(SENSITIVE_SENTINEL);
    } finally {
      await closeFixture(fixture);
    }
  });

  test("passes successful, explicit-error, thrown-error, and unknown-tool results through", async () => {
    const fixture = await createFixture();
    fixture.server.registerTool("validation_normal_probe", {}, async () => ({
      content: [{ type: "text" as const, text: "normal-result" }],
    }));
    fixture.server.registerTool("validation_explicit_error_probe", {}, async () => ({
      content: [{ type: "text" as const, text: "domain-error" }],
      isError: true,
    }));
    fixture.server.registerTool("validation_thrown_error_probe", {}, async () => {
      throw new Error("SQLite: no such table: fixture at /private/fixture/database.sqlite3");
    });

    try {
      expect(
        await fixture.client.callTool({ name: "validation_normal_probe", arguments: {} }),
      ).toEqual({ content: [{ type: "text", text: "normal-result" }] });
      expect(
        await fixture.client.callTool({ name: "validation_explicit_error_probe", arguments: {} }),
      ).toEqual({ content: [{ type: "text", text: "domain-error" }], isError: true });

      const thrown = await fixture.client.callTool({
        name: "validation_thrown_error_probe",
        arguments: {},
      });
      expect(thrown).toEqual({
        content: [{ type: "text", text: JSON.stringify({ error: "[db-error]" }) }],
        isError: true,
      });

      const unknown = await fixture.client.callTool({
        name: "validation_unknown_probe",
        arguments: {},
      });
      expect(unknown).not.toEqual(FIXED_INPUT_ERROR);
      expect(JSON.stringify(unknown)).toContain("not found");
    } finally {
      await closeFixture(fixture);
    }
  });

  test("redacts malformed outer tools/call envelopes before SDK validator details escape", async () => {
    const fixture = await createFixture();
    let handlerCalls = 0;
    fixture.server.registerTool("validation_outer_probe", {}, async () => {
      handlerCalls += 1;
      return { content: [{ type: "text" as const, text: "handler-ran" }] };
    });

    try {
      const malformedCalls = [
        { name: "validation_outer_probe", arguments: [SENSITIVE_SENTINEL] },
        { name: { value: SENSITIVE_SENTINEL }, arguments: {} },
        { name: "validation_outer_probe", arguments: null },
      ];
      for (const call of malformedCalls) {
        const result = await fixture.client.callTool(call as never);
        const resultText = JSON.stringify(result);

        expect(result).toEqual(FIXED_INPUT_ERROR);
        expect(resultText).not.toContain(SENSITIVE_SENTINEL);
        expect(resultText).not.toMatch(/invalid_type|expected|received|path/i);
      }
      expect(handlerCalls).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  test("does not rewrite handler-owned errors that resemble either SDK validation prefix", async () => {
    const fixture = await createFixture();
    const messages = [
      "Input validation error: domain policy rejected the operation",
      "MCP error -32602: Input validation error: domain policy rejected the operation",
    ];
    for (const [index, message] of messages.entries()) {
      fixture.server.registerTool(`validation_domain_prefix_${index}`, {}, async () => ({
        content: [
          { type: "text" as const, text: message },
          { type: "text" as const, text: "second-domain-detail" },
        ],
        isError: true,
      }));
    }

    try {
      for (const [index, message] of messages.entries()) {
        expect(
          await fixture.client.callTool({
            name: `validation_domain_prefix_${index}`,
            arguments: {},
          }),
        ).toEqual({
          content: [
            { type: "text", text: message },
            { type: "text", text: "second-domain-detail" },
          ],
          isError: true,
        });
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  test("does not classify output-schema failures as input validation failures", async () => {
    const fixture = await createFixture();
    fixture.server.registerTool(
      "validation_output_probe",
      { outputSchema: { value: z.string() } },
      async () => ({
        content: [{ type: "text" as const, text: "output-domain-result" }],
        structuredContent: { value: 42 },
      }),
    );

    try {
      const result = await fixture.client.callTool({
        name: "validation_output_probe",
        arguments: {},
      });
      expect(result).not.toEqual(FIXED_INPUT_ERROR);
      expect(JSON.stringify(result)).toContain("Output validation error");
    } finally {
      await closeFixture(fixture);
    }
  });

  test("restores the original registration method after overlapping installs restore out of order", () => {
    const server = new McpServer({ name: "validation-overlap-test", version: "0.0.0" });
    const original = server.server.setRequestHandler;
    const restoreA = installMcpValidationErrorBoundary(server, { warn() {} });
    const decorated = server.server.setRequestHandler;
    const restoreB = installMcpValidationErrorBoundary(server, { warn() {} });

    expect(decorated).not.toBe(original);
    expect(server.server.setRequestHandler).toBe(decorated);
    restoreA();
    expect(server.server.setRequestHandler).toBe(decorated);
    restoreB();
    expect(server.server.setRequestHandler).toBe(original);

    // Restore functions remain idempotent after the shared decorator is gone.
    restoreA();
    restoreB();
    expect(server.server.setRequestHandler).toBe(original);
  });

  test("the installed low-level handler still uses the canonical call schema semantics", () => {
    expect(CallToolRequestSchema.safeParse({
      method: "tools/call",
      params: { name: "validation_probe", arguments: {} },
    }).success).toBe(true);
  });

  test("restores the low-level registration method when tool registration throws", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-validation-restore-"));
    roots.add(root);
    const vaultPath = join(root, "vault");
    const runtimePath = join(root, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(runtimePath, { recursive: true });
    const db = new CBrainDB(join(root, "brain.sqlite"));
    const ctx = buildContext({
      db,
      embedding: new DeterministicEmbeddingProvider(),
      lance: new LanceDBManager(),
      vaultPath,
      runtimePath,
    });
    const server = new McpServer({ name: "validation-restore-test", version: "0.0.0" });
    const originalSetRequestHandler = server.server.setRequestHandler;
    server.registerTool = (() => {
      throw new Error("synthetic registration failure");
    }) as typeof server.registerTool;

    try {
      expect(() => attachMcpTools(server, ctx)).toThrow("synthetic registration failure");
      expect(server.server.setRequestHandler).toBe(originalSetRequestHandler);
    } finally {
      db.close();
    }
  });
});
