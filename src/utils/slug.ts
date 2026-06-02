import { getOntology } from "../ontology/loader.js";

const CJK_RANGE = /[一-鿿㐀-䶿]/;

/** Check if a slug's name segment (last path component) is valid. */
export function isValidSlugName(name: string): boolean {
  if (!name) return false;
  // Must contain at least one alphanumeric or CJK character
  return /[a-zA-Z0-9一-鿿㐀-䶿]/.test(name);
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
  let cleaned: string;
  if (hasChinese) {
    cleaned = title
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
  } else {
    cleaned = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }
  // Guard: if name segment is invalid (empty, only hyphens, only specials),
  // fall back to untitled with timestamp to avoid slugs like "records/-" or "records/"
  if (!isValidSlugName(cleaned)) {
    cleaned = `untitled-${Date.now()}`;
  }
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
