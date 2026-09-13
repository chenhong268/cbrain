import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { hashContent } from "../shared.js";
import {
  TopicBudgets,
  TopicSourceReadError,
  TopicSourceSnapshot,
  TopicUsableFact,
} from "./types.js";

/** Trust states that disqualify an entire source from synthesis: the user
 *  has rejected/superseded a relevant fact of this record, so its raw body
 *  may restate a correction and must not be laundered back in as evidence. */
const DISQUALIFYING_TRUST_STATES = new Set(["rejected", "superseded"]);

/** Trust states that keep a row out of prompt material without
 *  disqualifying the source. */
const UNUSABLE_TRUST_STATES = new Set(["rejected", "superseded", "candidate"]);

/** Derivation sources whose facts must not become compile material. */
const DERIVED_FACT_SOURCES = new Set(["ner"]);

/** Deterministic JSON with recursively sorted keys — the canonical form for
 *  governance fingerprints. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function governanceFingerprint(canonical: unknown): string {
  return createHash("sha256").update(stableStringify(canonical), "utf-8").digest("hex").slice(0, 16);
}

function isNoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** True when a vault-relative DB file_path is safe to read: relative, no
 *  traversal, no backslash, and the resolved file stays inside the vault.
 *  ENOENT (source file removed before watcher sync) propagates so callers
 *  can map it to a determinate "not_found" reason instead of a raw crash. */
export function resolveWithinVault(vaultPath: string, relPath: string): string {
  if (!relPath || relPath.startsWith("..") || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("\0")) {
    throw new TopicSourceReadError("path_unsafe", relPath);
  }
  const vaultRoot = realpathSync(vaultPath);
  const abs = resolve(vaultPath, relPath);
  const real = realpathSync(abs);
  if (real !== vaultRoot && !real.startsWith(vaultRoot + sep)) {
    throw new TopicSourceReadError("path_unsafe", relPath);
  }
  return abs;
}

/**
 * Read a record source page straight from disk (never the PageManager cache)
 * and capture content + FULL governance fingerprints.
 *
 * Eligibility is fail-closed on both stores: the DB row must be type
 * `record` outside derived vault areas, AND the fresh disk frontmatter must
 * agree (a watcher-sync gap cannot pass a retyped page off as a record).
 * Legacy records without a provenance row remain eligible; actor=agent
 * explicit ingests remain eligible — origin_kind session/job is NOT a
 * derived marker. A relevant rejected/superseded governance row (endpoint
 * OR source_page_slug) disqualifies the whole source conservatively.
 */
export function readRecordSource(
  db: CBrainDB,
  vaultPath: string,
  slug: string,
  budgets: TopicBudgets,
): TopicSourceSnapshot {
  const row = db.getPage(slug);
  if (!row || !row.file_path) throw new TopicSourceReadError("not_found", slug);
  if (row.type !== "record") throw new TopicSourceReadError("not_record", slug);
  if (row.file_path.startsWith("brain/")) throw new TopicSourceReadError("not_record", slug);

  let abs: string;
  try {
    abs = resolveWithinVault(vaultPath, row.file_path);
  } catch (e) {
    if (isNoent(e)) throw new TopicSourceReadError("not_found", slug);
    throw e;
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (e) {
    if (isNoent(e)) throw new TopicSourceReadError("not_found", slug);
    throw e;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  if (frontmatter.type !== "record") throw new TopicSourceReadError("not_record", slug);

  const tags = db.getTags(slug);
  const provenanceRow = db.getPageWriteProvenance(slug);
  const provenance = provenanceRow
    ? {
        writeMode: provenanceRow.write_mode,
        actorClass: provenanceRow.actor_class,
        creationReason: provenanceRow.creation_reason,
        originKind: provenanceRow.origin_kind ?? null,
      }
    : null;

  // Every relevant row: endpoint OR provenance origin, full and unsorted-
  // untruncated for the fingerprint (SQL orders by stable id).
  const links = db.getGovernanceLinksTouchingSource(slug).map((l) => ({
    id: l.id,
    direction: l.from_slug === slug
      ? ("out" as const)
      : l.to_slug === slug
        ? ("in" as const)
        : ("provenance" as const),
    fromSlug: l.from_slug,
    toSlug: l.to_slug,
    relation: l.relation,
    trustState: l.trust_state ?? null,
    sourceType: l.source_type ?? null,
    sourcePageSlug: l.source_page_slug ?? null,
    evidence: l.evidence ?? null,
    context: l.context ?? null,
    confidence: l.confidence,
    active: l.trust_state == null || !DISQUALIFYING_TRUST_STATES.has(l.trust_state),
  }));
  const timeline = db.getGovernanceTimelineTouchingSource(slug).map((t) => ({
    id: t.id,
    eventDate: t.event_date ?? null,
    summary: t.summary,
    trustState: t.trust_state ?? null,
    source: t.source ?? null,
    sourcePageSlug: t.source_page_slug ?? null,
    evidence: t.evidence ?? null,
  }));

  const disqualified =
    links.some((l) => l.trustState != null && DISQUALIFYING_TRUST_STATES.has(l.trustState)) ||
    timeline.some((t) => t.trustState != null && DISQUALIFYING_TRUST_STATES.has(t.trustState))
      ? "governance_rejected"
      : null;

  const governanceHash = governanceFingerprint({
    tags: [...tags].sort(),
    links,
    timeline,
    provenance,
  });

  // Prompt facts: usable rows only, capped per source — the cap bounds the
  // prompt, never the fingerprint above.
  const usableFacts: TopicUsableFact[] = [
    ...links
      .filter(isUsableLink)
      .slice(0, budgets.maxPromptFactsPerSource)
      .map((l) => ({
        kind: "link" as const,
        text: l.direction === "out"
          ? `→ ${l.relation} ${l.toSlug}`
          : l.direction === "in"
            ? `← ${l.relation} ${l.fromSlug}`
            : `⇢ ${l.relation} ${l.fromSlug}→${l.toSlug}（出自本记录）`,
        eventDate: null as string | null,
        trustState: l.trustState,
      })),
    ...timeline
      .filter(isUsableTimeline)
      .slice(0, budgets.maxPromptFactsPerSource)
      .map((t) => ({
        kind: "timeline" as const,
        text: t.summary,
        eventDate: t.eventDate,
        trustState: t.trustState,
      })),
  ];

  return {
    slug,
    title: row.title,
    filePath: row.file_path,
    contentHash: hashContent(raw),
    bodyHash: hashContent(body),
    body,
    governanceHash,
    governance: { tags: [...tags].sort(), links, timeline, provenance },
    usableFacts,
    disqualified,
  };
}

/** Conservative usability gate: active trust state AND not machine-derived. */
function isUsableLink(l: { trustState: string | null; sourceType: string | null }): boolean {
  if (l.trustState != null && UNUSABLE_TRUST_STATES.has(l.trustState)) return false;
  if (l.sourceType != null && DERIVED_FACT_SOURCES.has(l.sourceType)) return false;
  return true;
}

function isUsableTimeline(t: { trustState: string | null; source: string | null }): boolean {
  if (t.trustState != null && UNUSABLE_TRUST_STATES.has(t.trustState)) return false;
  if (t.source != null && DERIVED_FACT_SOURCES.has(t.source)) return false;
  return true;
}

/** Cheap fingerprint-only recheck of one source (used immediately before
 *  commit and after indexing). Returns null when identical. */
export function sourceFingerprintMismatch(
  db: CBrainDB,
  vaultPath: string,
  slug: string,
  expected: { contentHash: string; governanceHash: string },
  budgets: TopicBudgets,
): "not_found" | "not_record" | "path_unsafe" | "content" | "governance" | null {
  let snapshot: TopicSourceSnapshot;
  try {
    snapshot = readRecordSource(db, vaultPath, slug, budgets);
  } catch (e) {
    if (e instanceof TopicSourceReadError) return e.code;
    throw e;
  }
  if (snapshot.contentHash !== expected.contentHash) return "content";
  if (snapshot.governanceHash !== expected.governanceHash) return "governance";
  return null;
}

export function snapshotId(slug: string, contentHash: string, governanceHash: string): string {
  return createHash("sha256").update(`${slug}\x00${contentHash}\x00${governanceHash}`, "utf-8").digest("hex").slice(0, 16);
}
