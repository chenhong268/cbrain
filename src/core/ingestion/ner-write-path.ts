import type { DeferredNerSubmitter } from "./ner-backfill.js";
import { isTopicManagedPath } from "../shared.js";

export type NerMode = "sync" | "defer" | "off";
export type NerAction = "none" | "sync" | "defer";

export function resolveNerAction(
  skipNer: boolean | undefined,
  mode: NerMode,
  submitter?: DeferredNerSubmitter,
): NerAction {
  if (skipNer) return "none";
  if (mode === "off") return "none";
  if (mode === "defer") {
    if (!submitter) {
      throw new Error("nerMode='defer' requires a deferredNerSubmitter");
    }
    return "defer";
  }
  return "sync";
}

export function shouldProcessNerForWritePath(body: string, pageType: string, filePath?: string | null): boolean {
  if (!body.trim()) return false;
  // #510: bare `topic` (generated source-backed pages) must be excluded here —
  // syncAll/syncFile/page tools run this admission BEFORE ContentPipeline's
  // ontology gate, so without it every topic sync queues NER model work.
  // The reserved brain/topics path bars generated material even when the
  // file's frontmatter/DB type still claims `record` (syncAll admission runs
  // before extractBatch; the deferred submit sites share this gate).
  if (pageType === "topic" || isTopicManagedPath(filePath)) return false;
  return !pageType.startsWith("entity/") &&
    !pageType.startsWith("concept/") &&
    !pageType.startsWith("insight/");
}

export function submitDeferredNerForWritePath(
  submitter: DeferredNerSubmitter,
  input: { slug: string; pageType: string; contentHash?: string; kind?: "ner" | "entity_facts" },
): boolean {
  return submitter.submitDeferredNer({
    slug: input.slug,
    pageType: input.pageType,
    contentHash: input.contentHash,
    kind: input.kind,
  }).pending;
}
