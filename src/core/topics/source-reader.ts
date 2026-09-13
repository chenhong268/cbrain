import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { hashContent } from "../shared.js";
import {
  TopicBudgets,
  TopicSourceReadError,
  TopicSourceSnapshot,
  TopicUsableFact,
} from "./types.js";

/** Trust states that mark a link/timeline fact unusable for compilation.
 *  User corrections (rejected/superseded) win over any source-derived text;
 *  candidates and NER-derived rows are evidence, not live facts. */
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

/** True when a vault-relative DB file_path is safe to read: relative, no
 *  traversal, no backslash, and the resolved file stays inside the vault. */
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

/** Read a record source page straight from disk (never the PageManager cache)
 *  and capture its content + governance fingerprints. */
export function readRecordSource(
  db: CBrainDB,
  vaultPath: string,
  slug: string,
  budgets: TopicBudgets,
): TopicSourceSnapshot {
  const row = db.getPage(slug);
  if (!row || !row.file_path) throw new TopicSourceReadError("not_found", slug);
  if (row.type !== "record") throw new TopicSourceReadError("not_record", slug);

  const abs = resolveWithinVault(vaultPath, row.file_path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch {
    throw new TopicSourceReadError("not_found", slug);
  }

  const { body } = parseFrontmatter(raw);
  const tags = db.getTags(slug);
  const outgoing = db.getOutgoingLinks(slug, true);
  const incoming = db.getIncomingLinks(slug, true);
  const timeline = db.batchGetTimelineForSlugs([slug], true).get(slug) ?? [];
  const provenanceRow = db.getPageWriteProvenance(slug);

  const links = [...outgoing, ...incoming].map((l) => ({
    direction: l.from_slug === slug ? ("out" as const) : ("in" as const),
    otherSlug: l.from_slug === slug ? l.to_slug : l.from_slug,
    relation: l.relation,
    trustState: l.trust_state ?? null,
    sourceType: l.source_type ?? null,
    active: l.trust_state == null || !["rejected", "superseded"].includes(l.trust_state),
  }));
  const timelineRows = timeline.map((t) => ({
    id: t.id,
    eventDate: t.event_date ?? null,
    summary: t.summary,
    trustState: t.trust_state ?? null,
    source: t.source ?? null,
  }));

  const totalLinks = links.length;
  const totalTimeline = timelineRows.length;
  const cappedLinks = links.slice(0, budgets.maxGovernanceRowsPerSource);
  const cappedTimeline = timelineRows.slice(0, budgets.maxGovernanceRowsPerSource);
  const provenance = provenanceRow
    ? {
        writeMode: provenanceRow.write_mode,
        actorClass: provenanceRow.actor_class,
        creationReason: provenanceRow.creation_reason,
        originKind: provenanceRow.origin_kind ?? null,
      }
    : null;

  const governanceHash = governanceFingerprint({
    tags: [...tags].sort(),
    links: cappedLinks,
    timeline: cappedTimeline,
    provenance,
    totals: { links: totalLinks, timeline: totalTimeline },
  });

  const usableFacts: TopicUsableFact[] = [
    ...cappedLinks
      .filter(isUsableRow)
      .map((l) => ({
        kind: "link" as const,
        text: `${l.direction === "out" ? "→" : "←"} ${l.relation} ${l.otherSlug}`,
        eventDate: null,
        trustState: l.trustState,
      })),
    ...cappedTimeline
      .filter(isUsableRow)
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
    governance: {
      tags: [...tags].sort(),
      links: cappedLinks,
      timeline: cappedTimeline,
      provenance,
      totals: { links: totalLinks, timeline: totalTimeline },
    },
    usableFacts,
  };
}

/** Conservative usability gate: active trust state AND not machine-derived. */
function isUsableRow(row: { trustState: string | null; sourceType?: string | null; source?: string | null }): boolean {
  if (row.trustState != null && UNUSABLE_TRUST_STATES.has(row.trustState)) return false;
  const origin = row.sourceType ?? row.source;
  if (origin != null && DERIVED_FACT_SOURCES.has(origin)) return false;
  return true;
}

/** Cheap fingerprint-only recheck of one source (used immediately before
 *  commit and by freshness inspection). Returns null when identical. */
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

/** Join a slug to a vault path without leaking traversal outside it. */
export function topicFilePath(vaultPath: string, slug: string): string {
  return join(vaultPath, `${slug}.md`);
}
