import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import type { ProfileCategory, ProfileEntryType, ProfileScope } from "../../profile/schema.js";
import {
  formatGetProfileEnvelope,
  formatUpdateProfileEnvelope,
  formatRemoveProfileEnvelope,
  formatReloadProfileEnvelope,
} from "./format-result.js";
import {
  buildAgentVisibleStats,
  validateAgentProfileUpdate,
  type AgentProfilePolicyCode,
  type ProfileUpdateInput,
} from "./profile-policy.js";

type ProfileAction = "get" | "update" | "remove" | "reload";

const AGENT_MESSAGES: Record<AgentProfilePolicyCode, string> = {
  PROFILE_ACTION_FORBIDDEN: "Daily Agent sessions cannot remove or reload Profile entries.",
  PROFILE_SCOPE_FORBIDDEN: "Daily Agent sessions can read open Profile entries only.",
  PROFILE_UPDATE_INVALID: "Daily Agent updates require a valid batch of explicit, open Profile entries.",
};

interface ProfileFilterInput {
  scope?: ProfileScope;
  category?: ProfileCategory;
  type?: ProfileEntryType;
  tags?: string[];
  ids?: string[];
}

function textResult(envelope: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}

function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function policyError(code: AgentProfilePolicyCode) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: { code, message: AGENT_MESSAGES[code] } }),
    }],
    isError: true,
  };
}

function getProfile(ctx: ToolContext, filter: ProfileFilterInput) {
  const entries = ctx.profile.getEntries(filter);
  const stats = ctx.profile.getStats();
  const modules = ctx.profile.getModules();
  return textResult(formatGetProfileEnvelope(entries, stats, modules, filter as Record<string, unknown>));
}

function updateProfile(ctx: ToolContext, entries: ProfileUpdateInput[]) {
  const updated = ctx.profile.updateEntries(entries.map(entry => ({ ...entry })));
  return textResult(formatUpdateProfileEnvelope(updated));
}

function removeProfile(ctx: ToolContext, ids: string[]) {
  const removed = ctx.profile.removeEntries(ids);
  return textResult(formatRemoveProfileEnvelope(removed));
}

function reloadProfile(ctx: ToolContext) {
  ctx.profile.reload();
  const stats = ctx.profile.getStats();
  const modules = ctx.profile.getModules();
  return textResult(formatReloadProfileEnvelope(stats, modules));
}

function runProfileAction(
  ctx: ToolContext,
  action: ProfileAction,
  args: {
    scope?: ProfileScope;
    category?: ProfileCategory;
    type?: ProfileEntryType;
    tags?: string[];
    ids?: string[];
    entries?: ProfileUpdateInput[];
  },
) {
  if (ctx.toolProfile === "agent") {
    if (action === "remove" || action === "reload") {
      return policyError("PROFILE_ACTION_FORBIDDEN");
    }
    if (action === "get") {
      if (args.scope && args.scope !== "open") {
        return policyError("PROFILE_SCOPE_FORBIDDEN");
      }
      const { category, type, tags, ids } = args;
      const filter: ProfileFilterInput = { scope: "open", category, type, tags, ids };
      const entries = ctx.profile.getEntries(filter);
      return textResult(formatGetProfileEnvelope(
        entries,
        buildAgentVisibleStats(entries),
        [],
        filter as Record<string, unknown>,
      ));
    }
    const policyCode = validateAgentProfileUpdate(ctx.profile, args.entries);
    if (policyCode) return policyError(policyCode);
    return updateProfile(ctx, args.entries!);
  }

  if (action === "get") {
    const { scope, category, type, tags, ids } = args;
    return getProfile(ctx, { scope, category, type, tags, ids });
  }
  if (action === "update") {
    if (!args.entries) return errorResult("entries is required for action: update");
    return updateProfile(ctx, args.entries);
  }
  if (action === "remove") {
    if (!args.ids) return errorResult("ids is required for action: remove");
    return removeProfile(ctx, args.ids);
  }
  return reloadProfile(ctx);
}

export function registerProfileTools(server: McpServer, ctx: ToolContext): void {
  const isAgent = ctx.toolProfile === "agent";
  const sourceSchema = isAgent
    ? z.enum(["explicit", "observed", "inferred"])
        .describe("Daily Agent sessions allow explicit only; observed/inferred fail closed")
    : z.enum(["explicit", "observed", "inferred"])
        .default("observed")
        .describe("How this was learned");

  server.registerTool("profile", {
    description: isAgent
      ? "Daily Agent Profile operations: get reads open entries; update accepts explicit, open entries only; remove/reload are unavailable."
      : "Unified profile operations. Use action=get/update/remove/reload. " +
        "Compatibility aliases get_profile/update_profile/remove_profile/reload_profile remain available.",
    inputSchema: {
      action: z.enum(["get", "update", "remove", "reload"]).describe(isAgent
        ? "Daily Agent operation; remove/reload are unavailable"
        : "Profile operation"),
      scope: z.enum(["open", "scoped", "private"]).optional().describe(isAgent
        ? "Daily Agent get allows open only; scoped/private fail closed"
        : "Privacy scope filter for action=get"),
      category: z.enum(["communication", "work", "health", "finance", "interests", "general"]).optional().describe("Category filter for action=get"),
      type: z.enum(["preference", "constraint", "context", "habit"]).optional().describe("Entry type filter for action=get"),
      tags: z.array(z.string().max(200)).optional().describe("Tag filter for action=get"),
      ids: z.array(z.string().max(200)).optional().describe("Entry IDs for action=get/remove"),
      entries: z.array(z.object({
        id: z.string().max(200).describe("Unique entry identifier (kebab-case)"),
        type: z.enum(["preference", "constraint", "context", "habit"]).describe("Entry type"),
        category: z.enum(["communication", "work", "health", "finance", "interests", "general"]).describe("Category"),
        scope: z.enum(["open", "scoped", "private"]).describe("Privacy scope"),
        agents: z.array(z.string().max(200)).optional().describe("Visible agents (for scoped entries)"),
        content: z.string().max(50_000).describe("The profile content"),
        priority: z.enum(["high", "normal"]).optional().describe("Priority (mainly for constraints)"),
        source: sourceSchema,
        tags: z.array(z.string().max(200)).optional().describe("Tags for categorization"),
      })).optional().describe("Entries for action=update"),
    },
  }, async ({ action, scope, category, type, tags, ids, entries }) =>
    runProfileAction(ctx, action, { scope, category, type, tags, ids, entries }));

  server.registerTool("get_profile", {
    description:
      "Query personalized profile entries — preferences, constraints, habits, and context " +
      "specific to the user. Filter by scope, category, type, tags, or ids. " +
      "Use this to understand user preferences before taking action.",
    inputSchema: {
      scope: z.enum(["open", "scoped", "private"]).optional().describe("Privacy scope filter"),
      category: z.enum(["communication", "work", "health", "finance", "interests", "general"]).optional().describe("Category filter"),
      type: z.enum(["preference", "constraint", "context", "habit"]).optional().describe("Entry type filter"),
      tags: z.array(z.string().max(200)).optional().describe("Tag filter (entries matching any tag)"),
      ids: z.array(z.string().max(200)).optional().describe("Specific entry IDs to retrieve"),
    },
  }, async ({ scope, category, type, tags, ids }) => getProfile(ctx, { scope, category, type, tags, ids }));

  server.registerTool("update_profile", {
    description:
      "Create or update profile entries. Use this when the user explicitly states a preference, " +
      "constraint, or habit, or when you observe one through repeated interaction. " +
      "Automatically sets updated_at timestamp.",
    inputSchema: {
      entries: z.array(z.object({
        id: z.string().max(200).describe("Unique entry identifier (kebab-case)"),
        type: z.enum(["preference", "constraint", "context", "habit"]).describe("Entry type"),
        category: z.enum(["communication", "work", "health", "finance", "interests", "general"]).describe("Category"),
        scope: z.enum(["open", "scoped", "private"]).describe("Privacy scope"),
        agents: z.array(z.string().max(200)).optional().describe("Visible agents (for scoped entries)"),
        content: z.string().max(50_000).describe("The profile content"),
        priority: z.enum(["high", "normal"]).optional().describe("Priority (mainly for constraints)"),
        source: z.enum(["explicit", "observed", "inferred"]).default("observed").describe("How this was learned"),
        tags: z.array(z.string().max(200)).optional().describe("Tags for categorization"),
      })).describe("Entries to create or update"),
    },
  }, async ({ entries }) => updateProfile(ctx, entries));

  server.registerTool("remove_profile", {
    description:
      "Remove profile entries by ID. Use when the user explicitly asks to remove a preference " +
      "or when an entry is confirmed outdated.",
    inputSchema: {
      ids: z.array(z.string().max(200)).describe("Entry IDs to remove"),
    },
  }, async ({ ids }) => removeProfile(ctx, ids));

  server.registerTool("reload_profile", {
    description:
      "Reload profile data from YAML files. Use after profile files are manually edited " +
      "to pick up changes without restarting the server.",
    inputSchema: {},
  }, async () => reloadProfile(ctx));
}
