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
type WarnLogger = Pick<Logger, "warn">;
type Protocol = McpServer["server"];

type BoundaryState = {
  refs: number;
  previousDescriptor: PropertyDescriptor | undefined;
  logger: WarnLogger;
};

type ProtocolRequestHandlers = Map<string, UnknownRequestHandler>;

const installedBoundaries = new WeakMap<object, BoundaryState>();
const handlerInvocations = new WeakSet<object>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Record handler execution on the SDK's per-request extra context. */
export function markMcpHandlerInvocation(args: unknown[]): void {
  const extra = args.at(-1);
  if (extra !== null && typeof extra === "object") {
    handlerInvocations.add(extra as object);
  }
}

function clearHandlerInvocation(extra: unknown): void {
  if (extra !== null && typeof extra === "object") {
    handlerInvocations.delete(extra as object);
  }
}

function takeHandlerInvocation(extra: unknown): boolean {
  if (extra === null || typeof extra !== "object") return false;
  const invoked = handlerInvocations.has(extra as object);
  handlerInvocations.delete(extra as object);
  return invoked;
}

function isInputValidationResult(value: unknown, handlerInvoked: boolean): boolean {
  if (handlerInvoked) return false;
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

function warnInputInvalid(logger: WarnLogger, request?: unknown): void {
  const tool = request === undefined ? undefined : safeToolName(request);
  try {
    logger.warn("mcp", MCP_INPUT_INVALID_CODE, tool ? { tool } : undefined);
  } catch {
    // A logging failure must never restore the rejected validator detail.
  }
}

function restoreBoundary(protocol: Protocol, state: BoundaryState): void {
  state.refs -= 1;
  if (state.refs > 0) return;
  installedBoundaries.delete(protocol);
  if (state.previousDescriptor) {
    Object.defineProperty(protocol, "setRequestHandler", state.previousDescriptor);
  } else {
    delete (protocol as { setRequestHandler?: Protocol["setRequestHandler"] }).setRequestHandler;
  }
}

/**
 * Decorate the SDK's tools/call request handler while McpServer registers it.
 * The returned restore function removes the temporary registration hook; the
 * already-registered call handler keeps the privacy boundary in its closure.
 * Overlapping installs share one decorator and restore by reference count.
 */
export function installMcpValidationErrorBoundary(
  server: McpServer,
  logger: WarnLogger,
): () => void {
  const protocol = server.server;
  const existing = installedBoundaries.get(protocol);
  if (existing) {
    existing.refs += 1;
    existing.logger = logger;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      restoreBoundary(protocol, existing);
    };
  }

  const previousDescriptor = Object.getOwnPropertyDescriptor(protocol, "setRequestHandler");
  const originalMethod = protocol.setRequestHandler;
  const callOriginal = originalMethod.bind(protocol) as unknown as UnknownSetRequestHandler;
  let state: BoundaryState;

  const decorated = ((schema: unknown, handler: UnknownRequestHandler): void => {
    if (schema !== CallToolRequestSchema) {
      callOriginal(schema, handler);
      return;
    }
    const registrationLogger = state.logger;
    callOriginal(schema, handler);

    // SDK Server and Protocol each add validation outside the supplied handler.
    // Replace their final dispatch-map entry so canonical parsing happens before
    // either layer can turn validator diagnostics into a transport exception.
    const handlers = (protocol as unknown as { _requestHandlers?: ProtocolRequestHandlers })
      ._requestHandlers;
    const registered = handlers?.get("tools/call");
    if (!handlers || !registered) {
      throw new Error("MCP tools/call handler registration was not observable");
    }
    handlers.set("tools/call", async (rawRequest: unknown, extra: unknown): Promise<unknown> => {
      const parsed = await CallToolRequestSchema.safeParseAsync(rawRequest);
      if (!parsed.success) {
        // The outer envelope was invalid, so no unresolved identity is logged.
        warnInputInvalid(registrationLogger);
        return fixedInputValidationResult();
      }

      clearHandlerInvocation(extra);
      const result = await registered(rawRequest, extra);
      if (!isInputValidationResult(result, takeHandlerInvocation(extra))) return result;

      warnInputInvalid(registrationLogger, parsed.data);
      return fixedInputValidationResult();
    });
  }) as Protocol["setRequestHandler"];

  state = {
    refs: 1,
    previousDescriptor,
    logger,
  };
  installedBoundaries.set(protocol, state);

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
    restoreBoundary(protocol, state);
  };
}
