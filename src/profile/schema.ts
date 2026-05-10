import { z } from "zod";

export const profileEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(["preference", "constraint", "context", "habit"]),
  category: z.enum(["communication", "work", "health", "finance", "interests", "general"]),
  scope: z.enum(["open", "scoped", "private"]),
  agents: z.array(z.string()).optional(),
  content: z.string().min(1),
  priority: z.enum(["high", "normal"]).optional(),
  source: z.enum(["explicit", "observed", "inferred"]).default("explicit"),
  confidence: z.number().min(0).max(1).default(1.0),
  tags: z.array(z.string()).optional().default([]),
  updated_at: z.string(),
  reinforced_at: z.string().optional(),
  stale: z.boolean().optional(),
});

export type ProfileEntry = z.infer<typeof profileEntrySchema>;

export type ProfileEntryType = ProfileEntry["type"];
export type ProfileScope = ProfileEntry["scope"];
export type ProfileCategory = ProfileEntry["category"];
export type ProfileSource = ProfileEntry["source"];

export interface ProfileFile {
  version: 1;
  user: { id: string; display_name?: string };
  entries: ProfileEntry[];
}

export interface ProfileModule extends ProfileFile {
  module: string;
  description?: string;
  enabled: boolean;
}

export interface ProfileFilter {
  scope?: ProfileScope;
  category?: ProfileCategory;
  type?: ProfileEntryType;
  tags?: string[];
  ids?: string[];
}
