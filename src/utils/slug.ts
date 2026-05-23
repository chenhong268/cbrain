import { getOntology } from "../ontology/loader.js";

const CJK_RANGE = /[一-鿿㐀-䶿]/;

function getTypePrefixMap(): Record<string, string> {
  const ontology = getOntology();
  const map: Record<string, string> = {};
  for (const type of ontology.getConcreteEntityTypes()) {
    map[type] = ontology.getVaultDir(type);
  }
  return map;
}

export function pluralize(type: string): string {
  const prefix = getOntology().getVaultDir(type);
  return prefix.split("/").pop() ?? `${type}s`;
}

export function canonicalSlug(slug: string, type: string): string {
  const prefix = getOntology().getVaultDir(type);
  if (!prefix) return slug;
  const name = slug.split("/").pop()!;
  return `${prefix}/${name}`;
}

export function generateSlug(title: string, type: string): string {
  const prefix = getOntology().getVaultDir(type) ?? "records";
  const hasChinese = CJK_RANGE.test(title);
  if (hasChinese) {
    const cleaned = title
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    return `${prefix}/${cleaned}`;
  }
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return `${prefix}/${cleaned}`;
}

export function extractSlugFromWikiLink(link: string): string {
  // [[张三]] → "张三"
  const match = link.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : link;
}

export function slugToFilePath(slug: string): string {
  return `${slug}.md`;
}
