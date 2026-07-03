import type { DeferredNerSubmitter } from "./ner-backfill.js";

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

export function shouldProcessNerForWritePath(body: string, pageType: string): boolean {
  if (!body.trim()) return false;
  return !pageType.startsWith("entity/") &&
    !pageType.startsWith("concept/") &&
    !pageType.startsWith("insight/");
}

export function submitDeferredNerForWritePath(
  submitter: DeferredNerSubmitter,
  input: { slug: string; pageType: string; contentHash?: string },
): boolean {
  submitter.submitDeferredNer({
    slug: input.slug,
    pageType: input.pageType,
    contentHash: input.contentHash,
  });
  return true;
}
