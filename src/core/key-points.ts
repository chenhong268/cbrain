/**
 * Deterministic key-point extraction from CBrain page bodies.
 * Pure regex — no LLM calls, no DB queries.
 * Used by deep_recall(detail="normal") to provide a "page skeleton" so
 * Hermes can answer content-recall questions without get_page.
 */

const DOSSIER_OPEN = "<!-- cbrain-dossier -->";
const DOSSIER_CLOSE = "<!-- /cbrain-dossier -->";

const SKIP_HEADINGS = new Set([
  "关联", "known relations", "下一步", "next steps",
  "讨论邀请", "参考", "references",
]);

export interface KeyPointsOptions {
  maxPoints?: number;
  maxLenPerPoint?: number;
}

export interface MemorySkeleton {
  key_points: string[];
  structure_terms: string[];
  why_relevant?: string;
}

export function extractKeyPoints(
  body: string | null | undefined,
  frontmatter?: Record<string, unknown> | null,
  opts?: KeyPointsOptions,
): string[] {
  const maxPoints = opts?.maxPoints ?? 6;
  const maxLen = opts?.maxLenPerPoint ?? 80;

  if (!body) {
    return frontmatter ? extractFrontmatterPoints(frontmatter, maxLen, maxPoints) : [];
  }

  const cleanBody = stripDossierBlock(body);
  if (!cleanBody.trim()) {
    return frontmatter ? extractFrontmatterPoints(frontmatter, maxLen, maxPoints) : [];
  }

  // Strategy 1: Entity pages — frontmatter has rich structured data
  if (frontmatter) {
    const fmPoints = extractFrontmatterPoints(frontmatter, maxLen, maxPoints);
    if (fmPoints.length >= 3) return fmPoints;
  }

  // Strategy 2: Heading + first-line context (record/insight pages)
  const headingPoints = extractHeadingPoints(cleanBody, maxLen, maxPoints);
  if (headingPoints.length >= 1) return headingPoints;

  // Strategy 3: Bold-prefixed list items
  const boldPoints = extractBoldListPoints(cleanBody, maxLen, maxPoints);
  if (boldPoints.length >= 1) return boldPoints;

  // Strategy 4: First N bullet points
  return extractBulletPoints(cleanBody, maxLen, maxPoints);
}

/**
 * Build a memory skeleton from page data + optional sealed L1 summary.
 */
export function buildMemorySkeleton(
  body: string | null | undefined,
  frontmatter?: Record<string, unknown> | null,
  l1Summary?: string | null,
): MemorySkeleton | undefined {
  const keyPoints = extractKeyPoints(body, frontmatter);
  if (keyPoints.length === 0 && !l1Summary) return undefined;

  // If L1 summary exists, prepend its sentences as key_points
  const finalPoints = l1Summary
    ? mergeL1Summary(keyPoints, l1Summary)
    : keyPoints;

  const structureTerms = extractStructureTerms(body, finalPoints);

  // Cap total length at 800 chars
  const capped = capTotalLength(finalPoints, 800);

  return {
    key_points: capped,
    structure_terms: structureTerms,
  };
}

// ── Internal helpers ──

function mergeL1Summary(points: string[], l1Summary: string): string[] {
  const sentences = splitSentences(l1Summary)
    .map((s) => truncatePoint(s, 80))
    .filter((s) => s.length >= 10);
  // L1 sentences first, then body-extracted points, up to 6 total
  const merged = [...sentences.slice(0, 2)];
  for (const p of points) {
    if (merged.length >= 6) break;
    if (!merged.some((e) => e === p)) merged.push(p);
  }
  return merged;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, "。")
    .split(/[。！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
}

function capTotalLength(points: string[], maxTotal: number): string[] {
  let total = 0;
  const result: string[] = [];
  for (const p of points) {
    if (total + p.length > maxTotal) break;
    result.push(p);
    total += p.length;
  }
  return result;
}

function extractStructureTerms(
  body: string | null | undefined,
  keyPoints: string[],
): string[] {
  const terms = new Set<string>();
  const combined = keyPoints.join(" ");

  // Extract heading titles (part before ：in key_points)
  for (const p of keyPoints) {
    const colonIdx = p.indexOf("：");
    if (colonIdx > 0 && colonIdx <= 12) {
      terms.add(p.slice(0, colonIdx));
    }
  }

  // Extract English technical terms (capitalized, 2+ chars)
  const engRe = /\b([A-Z][a-zA-Z]{1,20})\b/g;
  let engMatch: RegExpExecArray | null = engRe.exec(combined);
  while (engMatch !== null) {
    const word = engMatch[1]!;
    if (word.length >= 3 && !isCommonEnglish(word)) {
      terms.add(word);
    }
    engMatch = engRe.exec(combined);
  }

  // Extract Chinese compound nouns from headings (4-6 char segments)
  const cnRe = /[一-鿿]{2,6}/g;
  if (body) {
    const cleanBody = stripDossierBlock(body);
    const headingLines = cleanBody.split("\n").filter((l) => /^#{2,3}\s+/.test(l));
    for (const hl of headingLines) {
      const title = hl.replace(/^#{2,3}\s+/, "").trim();
      let cnMatch: RegExpExecArray | null = cnRe.exec(stripMarkdown(title));
      while (cnMatch !== null) {
        const term = cnMatch[0]!;
        if (!isNoiseHeading(term) && term.length >= 3) {
          terms.add(term);
        }
        cnMatch = cnRe.exec(stripMarkdown(title));
      }
    }
  }

  return [...terms].slice(0, 10);
}

const COMMON_ENGLISH = new Set([
  "The", "This", "That", "Then", "When", "Where", "What", "Which",
  "With", "From", "Into", "For", "And", "Not", "But", "Are", "Has",
  "Was", "All", "Can", "Will", "May", "Its",
]);

function isCommonEnglish(word: string): boolean {
  return COMMON_ENGLISH.has(word);
}

function stripDossierBlock(body: string): string {
  const openIdx = body.indexOf(DOSSIER_OPEN);
  if (openIdx === -1) return body;
  const closeIdx = body.indexOf(DOSSIER_CLOSE, openIdx);
  if (closeIdx === -1) return body;
  return body.slice(0, openIdx) + body.slice(closeIdx + DOSSIER_CLOSE.length);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2") // [[target|display]] → display
    .replace(/\[\[([^\]]+)\]\]/g, "$1")             // [[target]] → target
    .replace(/\*\*(.+?)\*\*/g, "$1")                // **bold** → bold
    .replace(/`(.+?)`/g, "$1")                      // `code` → code
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")             // [text](url) → text
    .trim();
}

function truncatePoint(text: string, maxLen: number): string {
  const clean = stripMarkdown(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  // Try to cut at a sentence boundary
  const cut = clean.lastIndexOf("。", maxLen);
  if (cut > maxLen * 0.5) return clean.slice(0, cut + 1);
  const cut2 = clean.lastIndexOf("，", maxLen);
  if (cut2 > maxLen * 0.5) return clean.slice(0, cut2);
  return clean.slice(0, maxLen - 1) + "…";
}

function isNoiseHeading(title: string): boolean {
  const lower = title.toLowerCase().trim();
  for (const skip of SKIP_HEADINGS) {
    if (lower === skip || lower.startsWith(skip)) return true;
  }
  // Skip pure number-only headings like "十、"
  if (/^[一二三四五六七八九十]+、$/.test(title.trim())) return true;
  return false;
}

function extractHeadingPoints(body: string, maxLen: number, maxPoints: number): string[] {
  const lines = body.split("\n");
  const points: string[] = [];

  for (let i = 0; i < lines.length && points.length < maxPoints; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (!headingMatch) continue;

    const rawTitle = headingMatch[2]!.trim();
    const title = stripMarkdown(rawTitle);
    if (isNoiseHeading(title)) continue;

    // Look ahead for first non-empty, non-heading line
    let context = "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const nextLine = lines[j]!.trim();
      if (!nextLine) continue;
      if (nextLine.match(/^#{1,3}\s+/)) break; // next heading
      if (nextLine.startsWith("|")) break;       // table row
      if (nextLine.startsWith("```")) break;      // code block
      context = nextLine;
      break;
    }

    if (context) {
      points.push(truncatePoint(`${title}：${context}`, maxLen));
    } else {
      points.push(truncatePoint(title, maxLen));
    }
  }

  return points;
}

function extractBoldListPoints(body: string, maxLen: number, maxPoints: number): string[] {
  const re = /^[-*]\s+\*\*(.+?)\*\*[：:]\s*(.+)$/gm;
  const points: string[] = [];
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null && points.length < maxPoints) {
    const key = stripMarkdown(match[1]!);
    const value = stripMarkdown(match[2]!);
    points.push(truncatePoint(`${key}：${value}`, maxLen));
    match = re.exec(body);
  }
  return points;
}

function extractBulletPoints(body: string, maxLen: number, maxPoints: number): string[] {
  const re = /^[-*]\s+(.+)$/gm;
  const points: string[] = [];
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null && points.length < maxPoints) {
    const text = match[1]!.trim();
    match = re.exec(body);
    if (text.length < 4) continue; // skip very short bullets
    if (text.startsWith("|")) continue; // skip table rows
    points.push(truncatePoint(text, maxLen));
  }
  return points;
}

function extractFrontmatterPoints(
  frontmatter: Record<string, unknown>,
  maxLen: number,
  maxPoints: number,
): string[] {
  const points: string[] = [];

  // person_card.summary
  const personCard = frontmatter.person_card as Record<string, unknown> | undefined;
  if (personCard && typeof personCard === "object") {
    const summary = personCard.summary as string | undefined;
    if (summary) {
      points.push(truncatePoint(summary, maxLen));
    }
    const askFor = personCard.ask_for as string[] | undefined;
    if (askFor && Array.isArray(askFor)) {
      points.push(truncatePoint(`擅长领域：${askFor.slice(0, 5).join("、")}`, maxLen));
    }
  }

  // Direct fields
  const org = frontmatter.organization as string | undefined;
  if (org) points.push(truncatePoint(`组织：${org}`, maxLen));

  const title = frontmatter.current_title as string | undefined;
  if (title) points.push(truncatePoint(`职位：${title}`, maxLen));

  const reportsTo = frontmatter.reports_to as string | undefined;
  if (reportsTo) points.push(truncatePoint(`汇报给：${reportsTo}`, maxLen));

  return points.slice(0, maxPoints);
}
