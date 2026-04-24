const CJK_RANGE = /[一-鿿㐀-䶿]/;

const PLURALS: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  event: "events",
  record: "records",
  source: "sources",
};

function pluralize(type: string): string {
  return PLURALS[type] ?? `${type}s`;
}

export function generateSlug(title: string, type: string): string {
  const dir = pluralize(type);

  const hasChinese = CJK_RANGE.test(title);
  if (hasChinese) {
    const cleaned = title
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    return `${dir}/${cleaned}`;
  }

  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return `${dir}/${cleaned}`;
}

export function extractSlugFromWikiLink(link: string): string {
  // [[张三]] → "张三"
  const match = link.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : link;
}

export function slugToFilePath(slug: string): string {
  return `${slug}.md`;
}
