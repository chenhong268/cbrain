import { TopicModelOutput, TopicClaim } from "./types.js";

const KIND_LABELS: Record<TopicClaim["kind"], string> = {
  observation: "[观察]",
  user_thought: "[用户想法]",
  candidate: "[候选]",
};

/** Flatten a quote for inline display without breaking the Markdown line. */
function excerpt(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

function renderClaim(claim: TopicClaim, withLabel: boolean): string {
  const label = withLabel ? `${KIND_LABELS[claim.kind] ?? "[观察]"} ` : "";
  const text = excerpt(claim.text);
  const quote = excerpt(claim.quote);
  return `- ${label}${text}（来源：\`${claim.sourceSlug}\`「${quote}」）`;
}

/** Render the derived topic Markdown body. The provenance disclaimer marks
 *  the page as a reading aid — never independent factual evidence, and the
 *  exact excerpt is a location pointer, not a proof of semantic entailment.
 *
 *  Source references are backticked slugs, NOT wikilinks: a generated page
 *  must stay byte-stable when a source is deleted (dead-link rewriting would
 *  otherwise mark the topic body as user-edited and wedge every refresh),
 *  and must never feed the wikilink graph. */
export function renderTopicBody(output: TopicModelOutput, sourceSlugs: string[]): string {
  const lines: string[] = [
    `> 本页由 CBrain 从 ${sourceSlugs.length} 条原始记录自动编译生成，仅供阅读导航。`,
    "> 本页不构成独立证据：细节、时间与结论以原始记录为准；用户修正优先于本页内容。",
    "> 「」内摘录为原文精确子串（定位用），不证明语义蕴含；本页不提升任何信任状态。",
    "",
    "## 概览",
    "",
    ...output.overview.map((claim) => renderClaim(claim, false)),
    "",
    "## 主要观察",
    "",
    ...output.observations.map((claim) => renderClaim(claim, true)),
    "",
    "## 细节",
    "",
    ...(output.details.length > 0 ? output.details.map((claim) => renderClaim(claim, true)) : ["（无）"]),
    "",
    "## 分歧与开放问题",
    "",
    ...(output.open_questions.length > 0 ? output.open_questions.map((claim) => renderClaim(claim, true)) : ["（无）"]),
    "",
    "## 来源",
    "",
    ...sourceSlugs.map((slug) => `- \`${slug}\``),
  ];
  return lines.join("\n").trim();
}
