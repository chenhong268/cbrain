import { getOntology } from "../ontology/loader.js";

const CJK_RANGE = /[一-鿿㐀-䶿]/;

/** Check if a slug's name segment (last path component) is valid. */
export function isValidSlugName(name: string): boolean {
  if (!name) return false;
  // Must contain at least one alphanumeric or CJK character
  return /[a-zA-Z0-9一-鿿㐀-䶿]/.test(name);
}

/**
 * True ONLY for inputs that look like a real filesystem path (#190):
 *   - absolute POSIX (`/Users/...`, `/tmp/...`) or home (`~/...`)
 *   - any backslash (Windows drive `C:\...`, UNC `\\server\share`)
 *   - a relative path with a trailing file extension (`foo/bar.md`, `a/b.txt`)
 *
 * Normal slash titles — `A/B 测试`, `风险/收益`, `MCP/CLI 对比`, `Q1/Q2 review` —
 * are NOT paths and must pass through. Single source of truth for generateSlug +
 * ingest validation.
 */
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^(\/|~\/)/.test(t)) return true;                            // /abs or ~/home
  if (/\\/.test(t)) return true;                                    // any backslash (Windows / UNC)
  if (t.includes("/") && /\.[a-z]{2,5}$/i.test(t)) return true;    // relative + file ext (foo/bar.md)
  return false;
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

/**
 * 中英文标点统一替换为连字符 (#201)。与 vault 文件名 sanitize 对齐：标点变 -，
 * 不再静默删除——否则 slug basename 与文件名 basename 分裂、去重失效。
 * 不含 / _ - （这些由各分支的字符白名单处理）。提到 hasChinese 分支之前，
 * 覆盖「无汉字但含中文标点」(如 TopicA：v1) 与英文标点 (如 TermA:TermB) 的情况。
 */
const PUNCTUATION_TO_HYPHEN = /[：，。！？、；·…—～“”‘’（）()【】《》〈〉「」『』.,!?;:"']/g;

export function generateSlug(title: string, type: string): string {
  const prefix = getOntology().getVaultDir(type) ?? "records";
  // (#190) Never derive a slug name from a path-like title. Real paths only
  // (looksLikePath) — normal slash titles like "A/B 测试" still produce a real slug.
  if (looksLikePath(title)) {
    return `${prefix}/untitled-${Date.now()}`;
  }
  const hasChinese = CJK_RANGE.test(title);
  // (#201) 标点→- 在分支前统一，不再静默删除。
  const dePuncted = title.replace(PUNCTUATION_TO_HYPHEN, "-");
  let cleaned: string;
  if (hasChinese) {
    cleaned = dePuncted
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
  } else {
    cleaned = dePuncted
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
  // Guard: if name segment is invalid (empty, only hyphens, only specials),
  // fall back to untitled with timestamp to avoid slugs like "records/-" or "records/"
  if (!isValidSlugName(cleaned)) {
    cleaned = `untitled-${Date.now()}`;
  }
  return `${prefix}/${cleaned}`;
}

export function extractSlugFromWikiLink(link: string): string {
  // [[实体A]] → "实体A"
  const match = link.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : link;
}

export function slugToFilePath(slug: string): string {
  return `${slug}.md`;
}
