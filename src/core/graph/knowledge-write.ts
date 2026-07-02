/**
 * Knowledge write orchestrator — structured fact/relation writing
 * without creating record pages.
 *
 * Composes existing atomic operations:
 *   setHierarchy, db.insertLink, pages.update, pipeline.embed
 *
 * Phase 1: structured input only (no NLP parsing).
 */

import type { CBrainDB } from "../../storage/sqlite.js";
import type { PageManager } from "../page.js";
import type { ContentPipeline } from "../ingestion/pipeline.js";
import type { GraphManager } from "./graph.js";
import {
  findEntitySlug,
  mapEntityType,
  normalizeRelation,
  getRelationStrength,
  getLayer,
} from "../shared.js";
import { setHierarchy } from "./hierarchy.js";
import { canonicalSlug, generateSlug } from "../../utils/slug.js";

// ─── Constants ──────────────────────────────────────────────

/** Reserved frontmatter fields that must NOT be overwritten by facts. */
const RESERVED_FIELDS = new Set([
  "slug", "type", "title", "file_path", "content_hash",
  "links", "reports_to", "tags",
  "created_at", "updated_at", "tier", "mention_count",
]);

/** Resolve a type hint, rejecting record/source-layer types. */
function safeEntityType(typeHint: string): string {
  const pageType = mapEntityType(typeHint);
  // Reject record and source-layer types — add_knowledge only creates entity stubs
  if (pageType === "record" || getLayer(pageType) === "source") {
    return mapEntityType("person"); // safe fallback
  }
  return pageType;
}

// ─── Types ──────────────────────────────────────────────────

export interface KnowledgeWriteDeps {
  db: CBrainDB;
  pages: PageManager;
  pipeline: ContentPipeline;
  graph: GraphManager;
}

export interface KnowledgeWriteInput {
  subject: string;
  subject_type?: string;
  facts?: Array<{ field: string; value: string }>;
  relations?: Array<{
    target: string;
    target_type?: string;
    relation: string;
  }>;
  hierarchy?: { reports_to: string; reports_to_type?: string };
  note?: string;
  evidence?: string;
  source_type?: "dialogue" | "agent";
  mode?: "apply" | "dry_run";
}

type ResolveAction = "resolved" | "stub_created" | "would_create_stub";

export interface ResolveResult {
  name: string;
  slug: string;
  action: ResolveAction;
}

export interface AppliedResult {
  type: "hierarchy" | "relation" | "field" | "note";
  success: boolean;
  detail: string;
  error?: string;
}

export interface KnowledgeWriteResult {
  mode: "apply" | "dry_run";
  subject: ResolveResult;
  resolved: ResolveResult[];
  applied: AppliedResult[];
  stubs_created: string[];
  summary: { total: number; succeeded: number; failed: number };
}

// ─── Core ───────────────────────────────────────────────────

export async function addKnowledge(
  input: KnowledgeWriteInput,
  deps: KnowledgeWriteDeps,
): Promise<KnowledgeWriteResult> {
  const mode = input.mode ?? "apply";
  const sourceType = input.source_type ?? "agent";
  const isDryRun = mode === "dry_run";

  // 1. Resolve subject
  const subjectResult = resolveOrCreate(
    input.subject,
    input.subject_type ?? "person",
    deps,
    isDryRun,
  );

  // 2. Resolve all targets
  const byName = new Map<string, ResolveResult>();
  byName.set(input.subject, subjectResult);

  for (const rel of input.relations ?? []) {
    if (!byName.has(rel.target)) {
      byName.set(rel.target, resolveOrCreate(rel.target, rel.target_type ?? "person", deps, isDryRun));
    }
  }

  if (input.hierarchy) {
    if (!byName.has(input.hierarchy.reports_to)) {
      byName.set(
        input.hierarchy.reports_to,
        resolveOrCreate(input.hierarchy.reports_to, input.hierarchy.reports_to_type ?? "person", deps, isDryRun),
      );
    }
  }

  // 3. Dry run — return plan without writing
  if (isDryRun) {
    return buildDryRunResult(input, subjectResult, byName);
  }

  // 4. Apply: hierarchy → fields → relations → note
  const applied: AppliedResult[] = [];
  const stubsCreated = [...byName.values()]
    .filter(r => r.action === "stub_created")
    .map(r => r.slug);

  // Hierarchy
  if (input.hierarchy) {
    const targetResult = byName.get(input.hierarchy.reports_to);
    if (targetResult) {
      applied.push(applyHierarchy(subjectResult.slug, targetResult.slug, deps));
    }
  }

  // Fields
  for (const fact of input.facts ?? []) {
    applied.push(applyField(subjectResult.slug, fact.field, fact.value, deps));
  }

  // Relations
  for (const rel of input.relations ?? []) {
    const targetResult = byName.get(rel.target);
    if (targetResult) {
      applied.push(
        applyRelation(subjectResult.slug, targetResult.slug, rel.relation, sourceType, input.evidence, deps),
      );
    }
  }

  // Note
  if (input.note) {
    applied.push(await applyNote(subjectResult.slug, input.note, deps));
  }

  // Sync markdown for all affected slugs
  for (const r of byName.values()) {
    try {
      deps.pages.syncLinksToMarkdown(r.slug);
    } catch {
      /* non-critical */
    }
  }

  const succeeded = applied.filter(a => a.success).length;
  return {
    mode,
    subject: subjectResult,
    resolved: [...byName.values()],
    applied,
    stubs_created: stubsCreated,
    summary: { total: applied.length, succeeded, failed: applied.length - succeeded },
  };
}

// ─── Entity Resolution ──────────────────────────────────────

export function resolveOrCreate(
  name: string,
  typeHint: string,
  deps: KnowledgeWriteDeps,
  dryRun: boolean,
): ResolveResult {
  // 1. Exact slug match
  const existingBySlug = deps.pages.getBySlug(name);
  if (existingBySlug) {
    return { name, slug: name, action: "resolved" };
  }

  // 2. Title + alias lookup
  const existingByTitle = findEntitySlug(deps.db, name);
  if (existingByTitle) {
    return { name, slug: existingByTitle, action: "resolved" };
  }

  // 3. Dry run — predict slug without creating
  if (dryRun) {
    const pageType = safeEntityType(typeHint);
    const predictedSlug = canonicalSlug(generateSlug(name, pageType), pageType);
    return { name, slug: predictedSlug, action: "would_create_stub" };
  }

  // 4. Create stub entity
  const pageType = safeEntityType(typeHint);
  try {
    const page = deps.pages.create({
      title: name,
      type: pageType,
      body: "",
      tags: [],
    });
    return { name, slug: page.slug, action: "stub_created" };
  } catch {
    // Title collision from concurrent creation — re-query
    const retrySlug = findEntitySlug(deps.db, name);
    if (retrySlug) {
      return { name, slug: retrySlug, action: "resolved" };
    }
    throw new Error(`Failed to create or resolve entity: ${name}`);
  }
}

// ─── Apply Functions ────────────────────────────────────────

function applyHierarchy(
  subjectSlug: string,
  reportsToSlug: string,
  deps: KnowledgeWriteDeps,
): AppliedResult {
  try {
    setHierarchy(subjectSlug, reportsToSlug, {
      pages: deps.pages,
      graph: deps.graph,
    });
    return {
      type: "hierarchy",
      success: true,
      detail: `${subjectSlug} → reports_to → ${reportsToSlug}`,
    };
  } catch (e) {
    return {
      type: "hierarchy",
      success: false,
      detail: "setHierarchy failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function applyRelation(
  fromSlug: string,
  toSlug: string,
  relation: string,
  sourceType: string,
  evidence: string | undefined,
  deps: KnowledgeWriteDeps,
): AppliedResult {
  if (fromSlug === toSlug) {
    return {
      type: "relation",
      success: false,
      detail: "self-reference",
      error: "Cannot create self-referencing relation",
    };
  }

  try {
    const normalized = normalizeRelation(relation);
    const { weight, strength } = getRelationStrength(normalized);

    deps.db.insertLink(
      fromSlug,
      toSlug,
      normalized,
      null,
      weight,
      strength,
      sourceType,
      0.9,
      false,
      { evidence },
    );

    deps.pages.incrementMention(toSlug);

    return {
      type: "relation",
      success: true,
      detail: `${fromSlug} --[${normalized}]--> ${toSlug}`,
    };
  } catch (e) {
    return {
      type: "relation",
      success: false,
      detail: `relation write failed: ${fromSlug} --[${relation}]--> ${toSlug}`,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function applyField(
  slug: string,
  field: string,
  value: string,
  deps: KnowledgeWriteDeps,
): AppliedResult {
  if (RESERVED_FIELDS.has(field)) {
    return {
      type: "field",
      success: false,
      detail: `reserved field: ${field}`,
      error: `Field "${field}" is reserved and cannot be set via add_knowledge`,
    };
  }

  const page = deps.pages.getBySlug(slug);
  if (!page) {
    return {
      type: "field",
      success: false,
      detail: `page not found: ${slug}`,
      error: "Page not found",
    };
  }

  const current = (page.frontmatter as Record<string, unknown>)[field];
  if (current !== undefined && current !== null && current !== "") {
    return {
      type: "field",
      success: false,
      detail: `${slug}.${field} conflict`,
      error: `Field "${field}" already has value: ${String(current)}`,
    };
  }

  deps.pages.update(slug, { extra: { [field]: value } });
  return {
    type: "field",
    success: true,
    detail: `${slug}.${field} = ${value}`,
  };
}

async function applyNote(
  slug: string,
  content: string,
  deps: KnowledgeWriteDeps,
): Promise<AppliedResult> {
  const page = deps.pages.getBySlug(slug);
  if (!page) {
    return {
      type: "note",
      success: false,
      detail: `page not found: ${slug}`,
      error: "Page not found",
    };
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const noteLine = `\n> [${timestamp}] ${content}`;
  const newBody = (page.body || "").trimEnd() + noteLine;

  deps.pages.update(slug, { body: newBody });

  // Re-index
  try {
    const { chunks, embedResults } = await deps.pipeline.embed(newBody);
    await deps.pipeline.writeIndexes(slug, chunks, embedResults);
  } catch {
    /* non-critical — page updated, index stale until next sync */
  }

  return {
    type: "note",
    success: true,
    detail: `note appended to ${slug}`,
  };
}

// ─── Dry Run ────────────────────────────────────────────────

function buildDryRunResult(
  input: KnowledgeWriteInput,
  subject: ResolveResult,
  byName: Map<string, ResolveResult>,
): KnowledgeWriteResult {
  const planned: AppliedResult[] = [];

  if (input.hierarchy) {
    const target = byName.get(input.hierarchy.reports_to);
    planned.push({
      type: "hierarchy",
      success: true,
      detail: `${subject.slug} → reports_to → ${target?.slug ?? "?"}`,
    });
  }

  for (const fact of input.facts ?? []) {
    const isReserved = RESERVED_FIELDS.has(fact.field);
    planned.push({
      type: "field",
      success: !isReserved,
      detail: `${subject.slug}.${fact.field} = ${fact.value}`,
      ...(isReserved ? { error: `Field "${fact.field}" is reserved and cannot be set via add_knowledge` } : {}),
    });
  }

  for (const rel of input.relations ?? []) {
    const target = byName.get(rel.target);
    planned.push({
      type: "relation",
      success: true,
      detail: `${subject.slug} --[${rel.relation}]--> ${target?.slug ?? "?"}`,
    });
  }

  if (input.note) {
    planned.push({
      type: "note",
      success: true,
      detail: `note to ${subject.slug}: "${input.note.slice(0, 50)}"`,
    });
  }

  const succeeded = planned.filter(a => a.success).length;
  return {
    mode: "dry_run",
    subject,
    resolved: [...byName.values()],
    applied: planned,
    stubs_created: [],
    summary: { total: planned.length, succeeded, failed: planned.length - succeeded },
  };
}
