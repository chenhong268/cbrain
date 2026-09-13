import { TopicModelOutput, TopicClaim } from "./types.js";

const KIND_LABELS: Record<TopicClaim["kind"], string> = {
  observation: "[观察]",
  user_thought: "[用户想法]",
  candidate: "[待确认]",
};

/** One selected source of the topic page: its slug (identity/citation) and
 *  vault-relative file path (navigable href target). */
export interface TopicRenderSource {
  slug: string;
  filePath: string;
}

/** Relative href from a managed topic page (`brain/topics/<slug>.md`, depth 2
 *  below the vault root) to a vault-root-relative source file. Plain Markdown
 *  links are NOT wikilinks: the wikilink projector never parses them (no graph
 *  feed), and nothing rewrites them, so the body stays byte-stable when a
 *  source file is later deleted. */
export function topicSourceHref(filePath: string): string {
  const encoded = filePath.split("/").map((segment) =>
    encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
  ).join("/");
  return `../../${encoded}`;
}

function renderSourceRef(source: TopicRenderSource): string {
  const label = source.slug.replace(/([\\\[\]])/g, "\\$1");
  return `[${label}](${topicSourceHref(source.filePath)})`;
}

/** Flatten a quote for inline display without breaking the Markdown line. */
function excerpt(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

function renderClaim(claim: TopicClaim, sources: TopicRenderSource[], withLabel: boolean): string {
  const label = withLabel ? `${KIND_LABELS[claim.kind] ?? "[观察]"} ` : "";
  const text = excerpt(claim.text);
  const quote = excerpt(claim.quote);
  const source = sources.find((s) => s.slug === claim.sourceSlug);
  const ref = source ? renderSourceRef(source) : `\`${claim.sourceSlug}\``;
  return `- ${label}${text}（来源：${ref}「${quote}」）`;
}

/** Render the derived topic Markdown body. The short plain-Chinese notice
 *  marks the page as a derived reading aid whose details defer to the
 *  original records (exact-substring quote validation stays internal to the
 *  compiler — it is not page copy).
 *
 *  Source references are navigable RELATIVE Markdown links (not wikilinks):
 *  they open the original record from the topic page in any Markdown reader,
 *  never feed the wikilink graph, and keep the body byte-stable when a source
 *  is deleted (no dead-link rewriting marks the page user-edited). */
export function renderTopicBody(output: TopicModelOutput, sources: TopicRenderSource[]): string {
  const lines: string[] = [
    `> 本页由 CBrain 从 ${sources.length} 条原始记录自动整理生成，仅供快速浏览。`,
    "> 本页不是独立依据：细节和时间以原始记录为准；你的更正优先于本页内容。",
    "",
    "## 概览",
    "",
    ...output.overview.map((claim) => renderClaim(claim, sources, true)),
    "",
    "## 主要观察",
    "",
    ...output.observations.map((claim) => renderClaim(claim, sources, true)),
    "",
    "## 细节",
    "",
    ...(output.details.length > 0 ? output.details.map((claim) => renderClaim(claim, sources, true)) : ["（无）"]),
    "",
    "## 分歧与开放问题",
    "",
    ...(output.open_questions.length > 0 ? output.open_questions.map((claim) => renderClaim(claim, sources, true)) : ["（无）"]),
    "",
    "## 来源",
    "",
    ...sources.map((source) => `- ${renderSourceRef(source)}`),
  ];
  return lines.join("\n").trim();
}
