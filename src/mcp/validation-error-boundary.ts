import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../core/logger.js";

export const MCP_INPUT_INVALID_CODE = "MCP_INPUT_INVALID" as const;
export const MCP_INPUT_INVALID_TEXT = "Invalid tool arguments." as const;

const INPUT_VALIDATION_PREFIXES = [
  "Input validation error:",
  "MCP error -32602: Input validation error:",
] as const;

const SAFE_TOOL_NAME = /^[a-z0-9_]{1,64}$/;

type UnknownRequestHandler = (request: unknown, extra: unknown) => unknown | Promise<unknown>;
type UnknownSetRequestHandler = (schema: unknown, handler: UnknownRequestHandler) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isInputValidationResult(value: unknown): boolean {
  const result = asRecord(value);
  if (result?.isError !== true || !Array.isArray(result.content)) return false;
  const firstText = result.content
    .map(asRecord)
    .find((item) => item?.type === "text" && typeof item.text === "string");
  const text = firstText?.text;
  if (typeof text !== "string") return false;
  return INPUT_VALIDATION_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function fixedInputValidationResult(): CallToolResult {
  return {
    content: [{ type: "text", text: MCP_INPUT_INVALID_TEXT }],
    isError: true,
  };
}

function safeToolName(request: unknown): string | undefined {
  const params = asRecord(asRecord(request)?.params);
  const name = params?.name;
  return typeof name === "string" && SAFE_TOOL_NAME.test(name) ? name : undefined;
}

/**
 * Decorate the SDK's tools/call request handler while McpServer registers it.
 * The returned restore function removes the temporary registration hook; the
 * already-registered call handler keeps the privacy boundary in its closure.
 */
export function installMcpValidationErrorBoundary(
  server: McpServer,
  logger: Pick<Logger, "warn">,
): () => void {
  const protocol = server.server;
  const previousDescriptor = Object.getOwnPropertyDescriptor(protocol, "setRequestHandler");
  const originalMethod = protocol.setRequestHandler;
  const callOriginal = originalMethod.bind(protocol) as unknown as UnknownSetRequestHandler;

  const decorated = ((schema: unknown, handler: UnknownRequestHandler): void => {
    if (schema !== CallToolRequestSchema) {
      callOriginal(schema, handler);
      return;
    }
    callOriginal(schema, async (request: unknown, extra: unknown): Promise<unknown> => {
      const result = await handler(request, extra);
      if (!isInputValidationResult(result)) return result;

      const tool = safeToolName(request);
      try {
        logger.warn("mcp", MCP_INPUT_INVALID_CODE, tool ? { tool } : undefined);
      } catch {
        // A logging failure must never restore the rejected validator detail.
      }
      return fixedInputValidationResult();
    });
  }) as typeof protocol.setRequestHandler;

  Object.defineProperty(protocol, "setRequestHandler", {
    configurable: true,
    enumerable: previousDescriptor?.enumerable ?? false,
    writable: true,
    value: decorated,
  });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previousDescriptor) {
      Object.defineProperty(protocol, "setRequestHandler", previousDescriptor);
    } else {
      delete (protocol as { setRequestHandler?: typeof originalMethod }).setRequestHandler;
    }
  };
}
