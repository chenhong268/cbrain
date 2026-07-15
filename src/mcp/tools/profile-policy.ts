import type { ProfileManager } from "../../profile/manager.js";
import { profileEntrySchema, type ProfileEntry } from "../../profile/schema.js";

export type AgentProfilePolicyCode =
  | "PROFILE_ACTION_FORBIDDEN"
  | "PROFILE_SCOPE_FORBIDDEN"
  | "PROFILE_UPDATE_INVALID";

export interface ProfileUpdateInput {
  id: string;
  type: "preference" | "constraint" | "context" | "habit";
  category: "communication" | "work" | "health" | "finance" | "interests" | "general";
  scope: "open" | "scoped" | "private";
  agents?: string[];
  content: string;
  priority?: "high" | "normal";
  source?: "explicit" | "observed" | "inferred";
  tags?: string[];
}

export interface AgentVisibleProfileStats {
  total: number;
  byScope: Record<string, number>;
  byType: Record<string, number>;
  modules: number;
}

export function validateAgentProfileUpdate(
  profile: ProfileManager,
  entries: ProfileUpdateInput[] | undefined,
): AgentProfilePolicyCode | null {
  if (!entries || entries.length === 0) return "PROFILE_UPDATE_INVALID";
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.source !== "explicit" || entry.scope !== "open") return "PROFILE_UPDATE_INVALID";
    if (entry.agents && entry.agents.length > 0) return "PROFILE_UPDATE_INVALID";
    if (typeof entry.id !== "string" || !entry.id.trim()) return "PROFILE_UPDATE_INVALID";
    if (typeof entry.content !== "string" || !entry.content.trim()) return "PROFILE_UPDATE_INVALID";
    if (ids.has(entry.id)) return "PROFILE_UPDATE_INVALID";
    ids.add(entry.id);
    const parsed = profileEntrySchema.safeParse({ ...entry, updated_at: "1970-01-01" });
    if (!parsed.success) return "PROFILE_UPDATE_INVALID";
    const existing = profile.getEntry(entry.id);
    if (existing && existing.scope !== "open") return "PROFILE_UPDATE_INVALID";
  }
  return null;
}

export function buildAgentVisibleStats(entries: ProfileEntry[]): AgentVisibleProfileStats {
  const byScope: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const entry of entries) {
    byScope[entry.scope] = (byScope[entry.scope] ?? 0) + 1;
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }
  return { total: entries.length, byScope, byType, modules: 0 };
}
