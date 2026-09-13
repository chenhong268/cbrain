import { expect, test } from "bun:test";
import { chunkContent } from "../../src/core/shared.js";
import { renderTopicBody, topicSourceHref } from "../../src/core/topics/render.js";

test("a full source list remains chunkable without losing or shortening its links", () => {
  const sources = Array.from({ length: 128 }, (_, i) => ({
    slug: `records/记录甲关于主题乙的完整来源说明-${i}`,
    filePath: `records/记录甲关于主题乙的完整来源说明-${i}.md`,
  }));
  const claim = { text: "材料记录了主题乙的讨论。", kind: "observation" as const, sourceSlug: sources[0].slug, quote: "主题乙的讨论" };
  const body = renderTopicBody({ overview: [claim], observations: [claim], details: [], open_questions: [] }, sources);
  const chunks = chunkContent(body);
  // Generated link lists must not become a single oversized embedding input.
  // This is a local output budget, not a claim about a provider's token limit.
  expect(Math.max(...chunks.map((c) => c.content.length))).toBeLessThan(1_000);
  for (const source of sources) {
    const link = `[${source.slug}](${topicSourceHref(source.filePath)})`;
    expect(body).toContain(link);
    expect(chunks.some((c) => c.content.includes(link))).toBe(true);
  }
});
