import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/mcp/context";
import { registerAllTools } from "../../src/mcp/register";

/** A chainable no-op Proxy: any property read or call returns itself.
 *  Mirrors makeNoopChain in bin/check-docs-consistency.ts so registerAllTools can
 *  dereference ctx fields it reads up front (e.g. `const provenance = ctx.provenance`)
 *  without touching a real DB. */
function makeNoopChain(): unknown {
  const proxy: unknown = new Proxy(function noop() { /* chain */ }, {
    get: () => proxy,
    apply: () => proxy,
  });
  return proxy;
}

/**
 * Test/docs inventory helper: feed a spy server + noop ctx to the REAL
 * registerAllTools, return every tool name that would be registered under `full`
 * (both registerTool and legacy server.tool). Used by profile allowlist tests and
 * the consolidation audit test. NOT a production API — deliberately lives under
 * tests/ so src/ cannot grow a dependency on it.
 */
export function collectRegisteredToolNames(): string[] {
  const names: string[] = [];
  const spy = {
    registerTool(name: string): unknown {
      names.push(name);
      return {};
    },
    tool(name: string): unknown {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  const noopCtx = makeNoopChain() as ToolContext;
  registerAllTools(spy, noopCtx);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
