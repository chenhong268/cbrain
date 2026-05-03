const CJK_RANGE = /[一-鿿㐀-䶿]/;

const PLURALS: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  event: "events",
  record: "records",
  source: "sources",
  insight: "insights",
};

const GENERATED_TYPES = new Set(["entity", "concept", "record", "event", "source", "insight"]);
const GENERATED_PREFIX = "brain/";
const RAW_PREFIX = "raw/";

export function pluralize(type: string): string {
  return PLURALS[type] ?? `${type}s`;
}

/** Correct the directory prefix of a slug to match its type (e.g. brain/entities/X with type=concept → brain/concepts/X). */
export function canonicalSlug(slug: string, type: string): string {
  const dir = pluralize(type);
  return slug.replace(/^([^/]+)\/[^/]+/, `$1/${dir}`);
}

export function generateSlug(title: string, type: string): string {
  const dir = pluralize(type);
  const prefix = GENERATED_TYPES.has(type) ? GENERATED_PREFIX : RAW_PREFIX;

  const hasChinese = CJK_RANGE.test(title);
  if (hasChinese) {
    const cleaned = title
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    return `${prefix}${dir}/${cleaned}`;
  }

  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return `${prefix}${dir}/${cleaned}`;
}

export function extractSlugFromWikiLink(link: string): string {
  // [[张三]] → "张三"
  const match = link.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : link;
}

export function slugToFilePath(slug: string): string {
  return `${slug}.md`;
}
