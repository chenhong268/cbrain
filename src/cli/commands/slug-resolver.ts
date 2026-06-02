/**
 * Known slug prefixes used in CBrain.
 * Centralized here to avoid hardcoded strings scattered across CLI commands.
 */
export const SLUG_PREFIXES = ["brain/", "records/"] as const;

export interface SlugResolution {
  /** The resolved canonical slug */
  slug: string;
  /** If multiple candidates matched, list all matching slugs */
  ambiguous?: string[];
}

/**
 * Resolve a user-supplied slug to a canonical DB slug.
 *
 * Strategy:
 * 1. Empty/whitespace → reject immediately (no DB query)
 * 2. Exact match
 * 3. If input has no known prefix → try adding each prefix
 * 4. If input has a known prefix but no match → try swapping prefix
 * 5. Detect ambiguity when multiple candidates match
 *
 * @param input User-supplied slug (may be incomplete)
 * @param getBySlug Lookup function — returns truthy if slug exists
 * @returns Resolution result, or null if nothing found
 */
export function resolveUserSlug(
  input: string,
  getBySlug: (slug: string) => unknown | null,
): SlugResolution | null {
  if (!input.trim()) return null;

  const seen = new Set<string>();
  const candidates: string[] = [];

  const add = (slug: string) => {
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      candidates.push(slug);
    }
  };

  // 1. Exact match
  add(input);

  // 2. Detect if input already has a known prefix
  const matchedPrefix = SLUG_PREFIXES.find(p => input.startsWith(p));

  if (!matchedPrefix) {
    // No known prefix → try adding each prefix
    for (const prefix of SLUG_PREFIXES) {
      add(`${prefix}${input}`);
    }
  } else {
    // Has prefix but may be wrong → try swapping to other prefixes
    const rest = input.slice(matchedPrefix.length);
    if (rest) {
      for (const otherPrefix of SLUG_PREFIXES) {
        if (otherPrefix !== matchedPrefix) {
          add(`${otherPrefix}${rest}`);
        }
      }
    }
  }

  // Test each candidate — at most 3 DB queries for non-prefixed input
  const matches = candidates.filter(s => getBySlug(s) !== null);

  if (matches.length === 0) return null;
  if (matches.length === 1) return { slug: matches[0] };

  // Multiple matches — ambiguity detected
  return { slug: matches[0], ambiguous: matches };
}
