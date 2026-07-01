import { z } from "zod";
import type { ToolContext } from "../mcp/context.js";
// registerAllTools backs the REST /tools listing only; MCP sessions reuse attachMcpTools
// below — so MCP has a single tool-registration semantics across stdio + HTTP.
import { registerAllTools } from "../mcp/register.js";
import { attachMcpTools } from "../mcp/server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveSessionProfile } from "./session-profile.js";
import type { ToolProfile } from "../mcp/tool-profiles.js";
import { version } from "../version.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema?: z.ZodType;
  handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function createToolRegistry(ctx: ToolContext): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();

  const collector = {
    registerTool(name: string, config: { description?: string; inputSchema?: unknown }, handler: (args: unknown) => Promise<unknown>) {
      tools.set(name, {
        name,
        description: config.description ?? "",
        inputSchema: config.inputSchema instanceof z.ZodType ? config.inputSchema : undefined,
        handler: handler as ToolDef["handler"],
      });
    },
    tool(name: string, descOrSchema: unknown, schemaOrHandler?: unknown, handler?: (args: unknown) => Promise<unknown>) {
      if (handler) {
        this.registerTool(name, { description: descOrSchema as string, inputSchema: schemaOrHandler }, handler);
      } else {
        this.registerTool(name, { inputSchema: descOrSchema }, schemaOrHandler as (args: unknown) => Promise<unknown>);
      }
    },
  };

  registerAllTools(collector as never, ctx);

  return tools;
}

/** Idle-session TTL: a session not touched for this long is swept on the next /mcp request. */
const MCP_SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard cap on live sessions — defense against a burst of client initializations (#213 review). */
const MAX_MCP_SESSIONS = 64;

/** One MCP-over-HTTP client session (issue #213): its own server + transport, sharing the single ctx. */
interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
  /** #260: per-session resolved profile (observability; not used in dispatch). */
  profile: ToolProfile;
  source: "header" | "metadata" | "default";
}

export function createHttpServer(ctx: ToolContext) {
  const tools = createToolRegistry(ctx);

  // Per-client MCP sessions. Each session gets its own McpServer + transport, but every
  // server attaches tools via the SAME attachMcpTools path and shares this one ctx — so
  // there is still exactly one DB/LanceDB/watcher/jobs owner (issue #213, honors #208 gate).
  const sessions = new Map<string, McpSession>();

  /** Lazy cleanup: drop idle sessions so the map cannot grow unbounded (#213 review). */
  function sweepStaleSessions(now: number): void {
    for (const [sid, s] of sessions) {
      if (now - s.lastSeen > MCP_SESSION_TTL_MS) {
        s.server.close().catch(() => { /* best effort */ });
        sessions.delete(sid);
      }
    }
  }

  async function handleMcp(req: Request): Promise<Response> {
    sweepStaleSessions(Date.now());

    const sessionId = req.headers.get("mcp-session-id");

    // DELETE → explicit session teardown
    if (req.method === "DELETE") {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (session) {
        await session.server.close().catch(() => { /* best effort */ });
        sessions.delete(sessionId as string);
      }
      return new Response(null, { status: 200 });
    }

    // Existing session — route to its own transport, refresh lastSeen
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId) as McpSession;
      session.lastSeen = Date.now();
      return session.transport.handleRequest(req);
    }

    // New session (initialize: no sessionId header yet)
    if (!sessionId) {
      if (sessions.size >= MAX_MCP_SESSIONS) {
        return new Response("too many concurrent MCP sessions", { status: 503 });
      }

      // #260: resolve this client's tool profile ONCE at session creation. Header
      // X-CBrain-Tool-Profile > initialize _meta/metadata > ctx default. An explicit
      // invalid signal → 400 (no session, no silent fallback to full). Existing-session
      // requests above never reach here, so a session's profile is fixed for its life.
      const resolved = await resolveSessionProfile(req, ctx.toolProfile);
      if ("error" in resolved) {
        return new Response(JSON.stringify({ error: resolved.error }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      // Derived ctx — never mutate the shared ctx. attachMcpTools reads ctx.toolProfile.
      const sessionCtx: ToolContext = { ...ctx, toolProfile: resolved.profile };

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessionclosed: (sid) => { sessions.delete(sid); },
      });
      const mcpServer = new McpServer({ name: "cbrain", version });
      attachMcpTools(mcpServer, sessionCtx); // identical registration path, per-session profile
      try {
        await mcpServer.connect(transport);
        const response = await transport.handleRequest(req);
        if (transport.sessionId) {
          sessions.set(transport.sessionId, {
            server: mcpServer, transport, lastSeen: Date.now(),
            profile: resolved.profile, source: resolved.source,
          });
          console.error(
            `> /mcp session ${transport.sessionId} profile=${resolved.profile} source=${resolved.source}`,
          );
        } else {
          // initialize did not establish a session — don't leak the half-built server
          await mcpServer.close().catch(() => { /* best effort */ });
        }
        return response;
      } catch (e) {
        // initialize/connect failed — clean up, never retain a broken session
        await mcpServer.close().catch(() => { /* best effort */ });
        console.error("> /mcp session init failed:", e instanceof Error ? e.message : String(e));
        return new Response("MCP session init failed", { status: 500 });
      }
    }

    // sessionId present but unknown — stale/confused client
    return new Response("session not found", { status: 404 });
  }

  return {
    start(port: number) {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        // sync / large-file ingest triggers re-indexing (embedding + NER +
        // LanceDB writes) that can run well past Bun's default idleTimeout (10s),
        // which kills the in-flight connection → Hermes MCP client sees
        // RemoteDisconnected → "unavailable". Bun caps positive idleTimeout at
        // 255s, still too short for big batches, so disable it here — requests
        // are legitimately long and session cleanup is handled at the app layer.
        idleTimeout: 0,
        async fetch(req) {
          const url = new URL(req.url);

          // MCP-over-HTTP (issue #213)
          if (url.pathname === "/mcp") {
            return handleMcp(req);
          }

          // GET /health
          if (req.method === "GET" && url.pathname === "/health") {
            return Response.json({ ok: true, tools: tools.size });
          }

          // GET /tools — list all tools
          if (req.method === "GET" && url.pathname === "/tools") {
            const list = [...tools.values()].map((t) => ({ name: t.name, description: t.description }));
            return Response.json(list);
          }

          // POST /tools/:name — call a tool
          if (req.method === "POST" && url.pathname.startsWith("/tools/")) {
            const name = url.pathname.slice("/tools/".length);
            const tool = tools.get(name);
            if (!tool) {
              return Response.json({ error: `Tool not found: ${name}` }, { status: 404 });
            }

            let args: unknown;
            try {
              args = await req.json();
            } catch {
              return Response.json({ error: "Invalid JSON body" }, { status: 400 });
            }

            if (tool.inputSchema) {
              const parsed = tool.inputSchema.safeParse(args);
              if (!parsed.success) {
                return Response.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
              }
              args = parsed.data;
            }

            try {
              const result = await tool.handler(args);
              return Response.json(result, { status: result.isError ? 400 : 200 });
            } catch {
              return Response.json({ error: "Internal server error" }, { status: 500 });
            }
          }

          return Response.json({ error: "Not found" }, { status: 404 });
        },
      });

      console.error(`> ${tools.size} tools registered (REST)`);
      console.error("> MCP-over-HTTP → /mcp");
      return server;
    },
  };
}
