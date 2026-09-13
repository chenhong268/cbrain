import {
  TOPIC_SCHEMA_VERSION,
  TopicManifest,
  TopicManifestSource,
  TopicPublicationState,
  TopicSeed,
  TopicSourceSnapshot,
  TopicRetiredSource,
} from "./types.js";
import { snapshotId } from "./source-reader.js";
import { parseFrontmatter, stringifyFrontmatter, type PageFrontmatter } from "../../utils/frontmatter.js";

/** Build the manifest source entry for a fresh snapshot. */
export function manifestSourceFromSnapshot(snapshot: TopicSourceSnapshot): TopicManifestSource {
  return {
    slug: snapshot.slug,
    title: snapshot.title,
    snapshot_id: snapshotId(snapshot.slug, snapshot.contentHash, snapshot.governanceHash),
    content_hash: snapshot.contentHash,
    body_hash: snapshot.bodyHash,
    governance_hash: snapshot.governanceHash,
  };
}

function isManifestSource(value: unknown): value is TopicManifestSource {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string"
    && typeof v.title === "string"
    && typeof v.snapshot_id === "string"
    && typeof v.content_hash === "string"
    && typeof v.body_hash === "string"
    && typeof v.governance_hash === "string";
}

/** Strictly parse a persisted frontmatter `topic` manifest. Returns null when
 *  absent, and an object with ok=false when present but not a valid manifest
 *  of a known schema version (freshness reports `invalid`). Optional Task 2
 *  fields (seed, catalog) are additive: their absence stays valid. */
export function parseTopicManifest(value: unknown): { ok: true; manifest: TopicManifest } | { ok: false } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return { ok: false };
  const v = value as Record<string, unknown>;
  if (v.schema_version !== TOPIC_SCHEMA_VERSION) return { ok: false };
  if (typeof v.title !== "string" || typeof v.generated_at !== "string" || typeof v.output_hash !== "string") {
    return { ok: false };
  }
  // Publication state: absent (legacy/corrupt) parses as pending — a topic
  // without an explicit committed marker is never treated as published.
  if (v.state !== undefined && v.state !== "committed" && v.state !== "pending") return { ok: false };
  const state: TopicPublicationState = v.state === "committed" ? "committed" : "pending";
  if (!Array.isArray(v.sources) || !v.sources.every(isManifestSource)) return { ok: false };
  const retiredRaw = Array.isArray(v.retired_sources) ? v.retired_sources : [];
  const retired: TopicRetiredSource[] = [];
  for (const r of retiredRaw) {
    if (!isManifestSource(r) || typeof (r as { retired_at?: unknown }).retired_at !== "string") return { ok: false };
    retired.push(r as TopicRetiredSource);
  }
  // Task 2 seed identity: when present it must be well-formed.
  let seed: TopicSeed | undefined;
  if (v.seed !== undefined) {
    const s = v.seed as Record<string, unknown>;
    if (
      typeof s !== "object" || s === null || Array.isArray(s)
      || (s.kind !== "tag" && s.kind !== "entity")
      || typeof s.key !== "string" || !s.key
    ) {
      return { ok: false };
    }
    seed = { kind: s.kind, key: s.key };
  }
  if (v.catalog !== undefined && typeof v.catalog !== "string") return { ok: false };
  return {
    ok: true,
    manifest: {
      schema_version: TOPIC_SCHEMA_VERSION,
      title: v.title,
      generated_at: v.generated_at,
      output_hash: v.output_hash,
      state,
      sources: v.sources,
      retired_sources: retired,
      ...(seed ? { seed } : {}),
      ...(typeof v.catalog === "string" ? { catalog: v.catalog } : {}),
    },
  };
}

/** Synchronously rewrite a topic page's manifest publication state in its
 *  raw bytes (frontmatter only — the indexed body is untouched, so indexed
 *  body consistency is retained). Used by the compile's final, fully
 *  synchronous publication step.
 *
 *  NEVER mutate the frontmatter object returned by parseFrontmatter —
 *  gray-matter caches parsed data per input string, so mutating it would
 *  corrupt every later re-parse of the SAME raw bytes (e.g. flipping the
 *  cached parse of the pre-finalize pending bytes to committed). Build a
 *  fresh object instead. */
export function withManifestState(raw: string, state: TopicPublicationState): string {
  const { frontmatter, body } = parseFrontmatter(raw);
  const topic = frontmatter.topic;
  if (topic === null || typeof topic !== "object" || Array.isArray(topic)) {
    throw new Error("TOPIC_FINALIZE_NO_MANIFEST");
  }
  return stringifyFrontmatter(
    { ...frontmatter, topic: { ...(topic as Record<string, unknown>), state } } as PageFrontmatter,
    body,
  );
}

/** Synchronously rewrite a topic page's manifest catalog attestation in its
 *  raw bytes (frontmatter only — the indexed body is untouched). Same
 *  fresh-object discipline as withManifestState: NEVER mutate the object
 *  returned by parseFrontmatter (gray-matter caches per input string). */
export function withManifestCatalog(raw: string, catalogFingerprint: string): string {
  const { frontmatter, body } = parseFrontmatter(raw);
  const topic = frontmatter.topic;
  if (topic === null || typeof topic !== "object" || Array.isArray(topic)) {
    throw new Error("TOPIC_FINALIZE_NO_MANIFEST");
  }
  return stringifyFrontmatter(
    { ...frontmatter, topic: { ...(topic as Record<string, unknown>), catalog: catalogFingerprint } } as PageFrontmatter,
    body,
  );
}

/** Compute the next manifest for a refresh: new selection first, then every
 *  previous source that left the selection is RETIRED, not dropped — its last
 *  known snapshot stays recoverable for reconciliation. */
export function buildManifest(params: {
  title: string;
  generatedAt: string;
  outputHash: string;
  snapshots: TopicSourceSnapshot[];
  previous: TopicManifest | null;
  seed?: TopicSeed;
  catalogFingerprint?: string;
}): TopicManifest {
  const sources = params.snapshots.map(manifestSourceFromSnapshot);
  const selected = new Set(sources.map((s) => s.slug));
  const retired: TopicRetiredSource[] = [];
  if (params.previous) {
    for (const old of params.previous.sources) {
      if (!selected.has(old.slug)) retired.push({ ...old, retired_at: params.generatedAt });
    }
    const stillRetired = new Set(retired.map((r) => r.slug));
    for (const old of params.previous.retired_sources) {
      if (!selected.has(old.slug) && !stillRetired.has(old.slug)) retired.push(old);
    }
  }
  return {
    schema_version: TOPIC_SCHEMA_VERSION,
    title: params.title,
    generated_at: params.generatedAt,
    output_hash: params.outputHash,
    state: "pending" as const,
    sources,
    retired_sources: retired,
    ...(params.seed ? { seed: params.seed } : {}),
    ...(params.catalogFingerprint ? { catalog: params.catalogFingerprint } : {}),
  };
}
