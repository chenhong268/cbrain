import { z } from "zod";
import type { ToolContext } from "../mcp/context.js";
import { registerAllTools } from "../mcp/register.js";

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
  };

  registerAllTools(collector as never, ctx);

  return tools;
}

export function createHttpServer(ctx: ToolContext) {
  const tools = createToolRegistry(ctx);

  return {
    start(port: number) {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);

          // GET /health
          if (req.method === "GET" && url.pathname === "/health") {
            return Response.json({ ok: true, tools: tools.size });
          }

          // GET /tools — list all tools
          if (req.method === "GET" && url.pathname === "/tools") {
            const list = [...tools.values()].map(t => ({ name: t.name, description: t.description }));
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

      console.error(`> ${tools.size} tools registered`);
      return server;
    },
  };
}
