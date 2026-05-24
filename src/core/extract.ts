// ─── Section stripping ─────────────────────────────────────────

/** Remove `## Known Relations` section (and everything after it) from body.
 *  KR is generated FROM the links table by syncLinksToMarkdown — parsing it
 *  back would create circular writes. */
export function stripKnownRelationsSection(body: string): string {
  return body.replace(/\n## Known Relations\n[\s\S]*$/, "");
}

// ─── Wiki-link extraction (deterministic) ───────────────────────
// Only regex-based extraction in CBrain. wikilinks are explicit user intent,
// not machine guesswork — they must be parsed deterministically.

export function stripCodeBlocks(content: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("```", i)) {
      const end = content.indexOf("```", i + 3);
      if (end === -1) { parts.push(" ".repeat(content.length - i)); break; }
      parts.push(" ".repeat(end + 3 - i));
      i = end + 3;
      continue;
    }
    if (content[i] === "`") {
      const end = content.indexOf("`", i + 1);
      if (end === -1 || content.slice(i + 1, end).includes("\n")) {
        parts.push(content[i]); i++; continue;
      }
      parts.push(" ".repeat(end + 1 - i));
      i = end + 1;
      continue;
    }
    parts.push(content[i]); i++;
  }
  return parts.join("");
}

// (?<!!) prevents matching image/attachment embeds (![[...]])
const WIKILINK_RE = /(?<!!)\[\[([^\]|#]+?)(?:#[^\]]*?)?(?:\|([^\]]+?))?\]\]/g;

export interface WikiLink {
  target: string;
  display?: string;
}

export function extractWikiLinks(content: string): WikiLink[] {
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  const stripped = stripCodeBlocks(content);
  const re = new RegExp(WIKILINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const target = m[1].trim();
    if (!target || target.includes("://")) continue;
    if (/\.(png|jpe?g|gif|svg|webp|mp4|mov|pdf|mp3|wav|zip)$/i.test(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({ target, display: m[2]?.trim() });
  }
  return links;
}

// ─── Entity name quality validation ─────────────────────────────

const FRAGMENT_ENDINGS = /(?:下个|上个|这个|那个|什么|如何|怎么|怎样|的话|的人|的事)$/;
const PARTICLE_ENDINGS = /[的了就完或吧吗呢啊嘛及与把会被]$/;
const VERB_STARTS = /^(?:用|把|被|让|从|在|对|跟|和|考虑|想着|假定|需要|应该|可以|能够|不会|不要|别|就不要|不能|可能|已经|还是|只是|就是|都是|还要|也要|就会|就能|才能|还会|还能|也可|也可|也不|也没|都|就|也|还|又|再|才|只|没)$/;
const GENERIC_STARTS = /^(?:一家|某个|某些|那些|这些|自己的|别人的|所有|每个|任何|什么|怎么|某种|各种|一些|全部|整个)$/;
const PURE_FUNCTION = /^(?:必须|一定|当然|确实|真的|非常|很|太|更|最|比较|有些|一点|一下|一会|一直|经常|总是|从来|从不|已经|将要|正在|暂时|永久|永远|马上|立刻|突然|终于|最后|还是|还|也|都)$/;

/**
 * Filter out sentence fragments and function words that regex extraction
 * might capture as entity names. Returns true if the name looks like a
 * plausible entity (person, org, location, product, concept, etc.).
 */
export function isValidEntityName(name: string): boolean {
  const n = name.trim();
  if (n.length < 2 || n.length > 30) return false;

  // Pure ASCII short strings (1-2 chars) are rarely entities
  if (/^[A-Za-z]{1,2}$/.test(n)) return false;

  // Sentence fragments
  if (FRAGMENT_ENDINGS.test(n)) return false;
  if (PARTICLE_ENDINGS.test(n)) return false;

  // Verb/conjunction starts
  if (VERB_STARTS.test(n)) return false;

  // Generic quantity/pronoun starts
  if (GENERIC_STARTS.test(n)) return false;

  // Pure function words (2-3 chars, no noun content)
  if (PURE_FUNCTION.test(n)) return false;

  // Looks like a Chinese question or command fragment
  if (/^(?:如何|怎么|怎样|什么|哪个|哪里|为什么|是否|能否|可否|要不要|能不能|是不是)/.test(n)) return false;
  if (/^(?:不要|别|请|必须|应该|需要)../.test(n)) return false; // commands

  // Ends abruptly — likely a truncated phrase
  if (/[把被让给对跟和与]$/.test(n)) return false;

  // Article titles (contain Chinese colon, or very long)
  if (/[：]/.test(n)) return false;
  if (n.length > 18) return false;

  return true;
}
