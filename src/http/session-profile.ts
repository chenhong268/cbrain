/**
 * HTTP /mcp per-session tool profile resolution (#260, #251 Phase 2).
 *
 * Same runtime, different tool surfaces per client. Profile is resolved ONCE at
 * new-session initialize and fixed for the session's lifetime (existing-session
 * requests in http/server.ts never call this). Precedence: first explicit signal
 * wins; an explicit-but-invalid signal → 400 (never silently fall back to full,
 * so a typo cannot expose the whole surface).
 *
 *   1. header  X-CBrain-Tool-Profile               (curl / any client that can set headers)
 *   2. initialize params._meta.cbrainToolProfile   (MCP spec _meta — primary metadata path)
 *      initialize params.metadata.cbrainToolProfile (non-spec, hand-written client compat)
 *   3. fallback = server ctx.toolProfile           (env CBRAIN_MCP_TOOL_PROFILE, default "full")
 *
 * NOT an authz boundary — any local trusted client may request "full". Profile is a
 * UX/tool-routing selector only (see spec §6.4, hard-constraint #4).
 */
import { parseToolProfile, TOOL_PROFILES } from "../mcp/tool-profiles.js";
import type { ToolProfile } from "../mcp/tool-profiles.js";

export type SessionProfileResolution =
  | { profile: ToolProfile; source: "header" | "metadata" | "default" }
  | { error: string };

const HEADER_NAME = "x-cbrain-tool-profile";
const META_KEY = "cbrainToolProfile";
const VALID_LIST = TOOL_PROFILES.join(", ");

function invalidError(field: string, raw: string): string {
  return `Invalid ${field}=${JSON.stringify(raw)}. Expected one of: ${VALID_LIST}.`;
}

/**
 * Read the profile signal from the initialize request body.
 * Clones the request so the original body stays consumable by transport.handleRequest.
 * Returns undefined for: non-JSON, non-initialize shape, or missing field. Never throws.
 */
async function readInitMetaProfile(req: Request): Promise<string | undefined> {
  try {
    const body = (await req.clone().json()) as { params?: unknown };
    const params = body?.params;
    if (params && typeof params === "object") {
      const p = params as { _meta?: Record<string, unknown>; metadata?: Record<string, unknown> };
      const raw = p._meta?.[META_KEY] ?? p.metadata?.[META_KEY];
      if (typeof raw === "string") return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function resolveSessionProfile(
  req: Request,
  fallback: ToolProfile,
): Promise<SessionProfileResolution> {
  const header = parseToolProfile(req.headers.get(HEADER_NAME));
  if (header.kind === "invalid") {
    return { error: invalidError("X-CBrain-Tool-Profile", header.raw) };
  }
  if (header.kind === "ok") {
    return { profile: header.profile, source: "header" };
  }

  // header absent → consult initialize metadata
  const meta = parseToolProfile(await readInitMetaProfile(req));
  if (meta.kind === "invalid") {
    return { error: invalidError(`initialize metadata ${META_KEY}`, meta.raw) };
  }
  if (meta.kind === "ok") {
    return { profile: meta.profile, source: "metadata" };
  }

  return { profile: fallback, source: "default" };
}
