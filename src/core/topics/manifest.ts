import {
  TOPIC_SCHEMA_VERSION,
  TopicManifest,
  TopicManifestSource,
  TopicSourceSnapshot,
  TopicRetiredSource,
} from "./types.js";
import { snapshotId } from "./source-reader.js";

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
 *  of a known schema version (freshness reports `invalid`). */
export function parseTopicManifest(value: unknown): { ok: true; manifest: TopicManifest } | { ok: false } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return { ok: false };
  const v = value as Record<string, unknown>;
  if (v.schema_version !== TOPIC_SCHEMA_VERSION) return { ok: false };
  if (typeof v.title !== "string" || typeof v.generated_at !== "string" || typeof v.output_hash !== "string") {
    return { ok: false };
  }
  if (!Array.isArray(v.sources) || !v.sources.every(isManifestSource)) return { ok: false };
  const retiredRaw = Array.isArray(v.retired_sources) ? v.retired_sources : [];
  const retired: TopicRetiredSource[] = [];
  for (const r of retiredRaw) {
    if (!isManifestSource(r) || typeof (r as { retired_at?: unknown }).retired_at !== "string") return { ok: false };
    retired.push(r as TopicRetiredSource);
  }
  return {
    ok: true,
    manifest: {
      schema_version: TOPIC_SCHEMA_VERSION,
      title: v.title,
      generated_at: v.generated_at,
      output_hash: v.output_hash,
      sources: v.sources,
      retired_sources: retired,
    },
  };
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
    sources,
    retired_sources: retired,
  };
}
