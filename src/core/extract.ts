// ─── Zero-LLM entity/term extraction (regex engine) ───────────
// Inspired by GBrain's link-extraction.ts. Runs alongside NER as a deterministic
// fallback — catches wiki-links, English abbreviations, and Chinese relation
// patterns that LLM-based extraction may miss.

// ─── Code block stripping ───────────────────────────────────────

function stripCodeBlocks(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("```", i)) {
      const end = content.indexOf("```", i + 3);
      if (end === -1) { out += " ".repeat(content.length - i); break; }
      out += " ".repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    if (content[i] === "`") {
      const end = content.indexOf("`", i + 1);
      if (end === -1 || content.slice(i + 1, end).includes("\n")) {
        out += content[i]; i++; continue;
      }
      out += " ".repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i]; i++;
  }
  return out;
}

// ─── Wiki-link extraction ───────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]]*?)?(?:\|([^\]]+?))?\]\]/g;

export interface WikiLink {
  target: string;     // raw slug text, e.g. "brain/entities/王强" or "王强"
  display?: string;   // display text after pipe
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
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({ target, display: m[2]?.trim() });
  }
  return links;
}

// ─── Markdown link extraction ───────────────────────────────────

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

export interface MdLink {
  display: string;
  target: string;
}

export function extractMarkdownLinks(content: string): MdLink[] {
  const seen = new Set<string>();
  const links: MdLink[] = [];
  const stripped = stripCodeBlocks(content);
  const re = new RegExp(MD_LINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const target = m[2].trim();
    if (target.includes("://") || target.endsWith(".md")) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({ display: m[1].trim(), target });
  }
  return links;
}

// ─── English tech term extraction (3+ uppercase, known patterns) ─

const KNOWN_TERMS = new Set([
  // AI / ML
  "AI", "ML", "DL", "NLP", "CV", "RL", "GAN",
  "LLM", "RAG", "LoRA", "GPU", "TPU", "API", "SDK", "CLI",
  "BERT", "GPT", "LSTM", "CNN", "RNN", "MoE", "RLHF", "SFT",
  // Benchmarks
  "MMLU", "BLEU", "ROUGE", "GLUE", "SuperGLUE",
  // Protocols / formats
  "HTTP", "HTTPS", "REST", "gRPC", "SQL", "JSON", "YAML", "CSV", "XML",
  "MCP", "SSE", "OAuth", "JWT", "CORS", "CQRS",
  // Infrastructure
  "AWS", "GCP", "CDN", "DNS", "CI", "CD", "K8s",
  // Tech patterns: 3+ uppercase letters that are real acronyms
]);

const TECH_TERM_RE = /\b([A-Z]{3,}(?:-[A-Za-z0-9]+)?)\b/g;

export function extractEnglishTerms(content: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const stripped = stripCodeBlocks(content);
  const re = new RegExp(TECH_TERM_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const term = m[1];
    if (seen.has(term)) continue;
    // Filter: must be a known term OR look like a real acronym (not all-vowels, not generic)
    if (KNOWN_TERMS.has(term) || (term.length >= 3 && /[^AEIOU]/.test(term))) {
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

// ─── Chinese relation extraction ─────────────────────────────────

export interface ChineseRelation {
  from: string;
  to: string;
  relation: string;
  context: string;
}

const RELATION_PATTERNS: Array<{ pattern: RegExp; relation: string }> = [
  // 任职于: X在Y工作 / X任职于Y / X是Y的(职位)
  { pattern: /([^\s，。,.]{2,6})\s*在\s*([^\s，。,.]{2,20})\s*(?:工作|任职|上班)/g, relation: "任职于" },
  { pattern: /([^\s，。,.]{2,6})\s*(?:任职于|就职于)\s*([^\s，。,.]{2,20})/g, relation: "任职于" },
  { pattern: /([^\s，。,.]{2,6})\s*是\s*([^\s，。,.]{2,20})\s*的\s*(?:CEO|CTO|CFO|CMO|总裁|总监|经理|工程师|负责人|代表|主管)/g, relation: "任职于" },
  // 创立了: X创立了Y / X创办了Y
  { pattern: /([^\s，。,.]{2,6})\s*(?:创立了|创办了|创建了|建立了|成立了)\s*([^\s，。,.]{2,20})/g, relation: "创立了" },
  // 投资了: X投资了Y
  { pattern: /([^\s，。,.]{2,20})\s*(?:投资了|参投了|领投了|投了)\s*([^\s，。,.]{2,20})/g, relation: "投资了" },
  // 认识: X认识Y
  { pattern: /([^\s，。,.]{2,6})\s*认识\s*([^\s，。,.]{2,6})/g, relation: "认识" },
  // 指导: X指导Y / X是Y的导师
  { pattern: /([^\s，。,.]{2,6})\s*(?:指导|带了)\s*([^\s，。,.]{2,6})/g, relation: "指导" },
  { pattern: /([^\s，。,.]{2,6})\s*是\s*([^\s，。,.]{2,6})\s*的\s*(?:导师|师傅|mentor)/g, relation: "指导" },
  // 成员: X是Y的成员 / X属于Y
  { pattern: /([^\s，。,.]{2,6})\s*是\s*([^\s，。,.]{2,10}(?:团队|部门|组|公司))\s*的\s*(?:成员|一员)/g, relation: "成员" },
  { pattern: /([^\s，。,.]{2,6})\s*(?:属于|归属于)\s*([^\s，。,.]{2,20})/g, relation: "成员" },
];

export function extractChineseRelations(content: string): ChineseRelation[] {
  const seen = new Set<string>();
  const relations: ChineseRelation[] = [];
  const stripped = stripCodeBlocks(content);

  for (const { pattern, relation } of RELATION_PATTERNS) {
    const re = new RegExp(pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const from = m[1].trim();
      const to = m[2].trim();
      if (from === to) continue;
      const key = `${from}\x00${to}\x00${relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = Math.max(0, m.index - 10);
      const end = Math.min(stripped.length, m.index + m[0].length + 20);
      relations.push({
        from, to, relation,
        context: stripped.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return relations;
}

// ─── Combined extraction ────────────────────────────────────────

export interface ExtractionResult {
  wikiLinks: WikiLink[];
  englishTerms: string[];
  chineseRelations: ChineseRelation[];
}

export function extractAll(content: string): ExtractionResult {
  return {
    wikiLinks: extractWikiLinks(content),
    englishTerms: extractEnglishTerms(content),
    chineseRelations: extractChineseRelations(content),
  };
}
