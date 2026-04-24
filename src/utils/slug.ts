const CJK_RANGE = /[一-鿿㐀-䶿]/;

export function generateSlug(title: string, type: string): string {
  // If title has CJK characters, use pinyin approximation + hash fallback
  const hasChinese = CJK_RANGE.test(title);

  if (hasChinese) {
    // For Chinese: transliterate to simplified form
    // Keep Chinese chars but remove special chars, use as-is
    // This preserves readability for Chinese users
    const cleaned = title
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    return `${type}s/${cleaned}`;
  }

  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return `${type}s/${cleaned}`;
}

export function extractSlugFromWikiLink(link: string): string {
  // [[张三]] → "张三"
  const match = link.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : link;
}

export function slugToFilePath(slug: string): string {
  return `${slug}.md`;
}
