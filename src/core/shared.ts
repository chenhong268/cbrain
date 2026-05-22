import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { CBrainDB } from "../storage/sqlite.js";
import { getOntology } from "../ontology/loader.js";

/**
 * Shared utilities used by SyncManager, IngestManager, and PageManager.
 * Single source of truth for chunking, hashing, NER helpers, etc.
 */

// ─── Constants ───────────────────────────────────────────────

export const DEFAULT_CHUNK_SIZE = 500;

// ─── Content Hashing ─────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─── File Collection ─────────────────────────────────────────

export async function collectMarkdownFiles(dir: string, excludeDirs?: Set<string>): Promise<string[]> {
  const results: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "EACCES") {
        console.error(`[shared] readdir 失败: ${d}`, e);
      }
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (excludeDirs?.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { await walk(p); }
      else if (extname(e.name).toLowerCase() === ".md") { results.push(p); }
    }
  };
  await walk(dir);
  return results;
}

// ─── Chunking ────────────────────────────────────────────────

export function chunkContent(
  body: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Array<{ index: number; content: string }> {
  if (!body.trim()) return [];

  const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: Array<{ index: number; content: string }> = [];
  let current = "";
  let index = 0;

  for (const para of paragraphs) {
    if (current.length + para.length > chunkSize && current.length > 0) {
      chunks.push({ index, content: current.trim() });
      index++;
      current = para;
    } else {
      current = current.length > 0 ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) {
    chunks.push({ index, content: current.trim() });
  }

  return chunks;
}

// ─── NER Helpers ─────────────────────────────────────────────

export function mapEntityType(type: string): string {
  return getOntology().resolvePageType(type);
}

export type PageType = string;
export type PageLayer = "source" | "derived";

export function normalizePageType(type: string): PageType {
  const ontology = getOntology();
  if (ontology.getEntityType(type) && !ontology.isAbstract(type)) return type;
  // 兼容旧格式: abstract type → return as-is
  if (ontology.getEntityType(type)) return type;
  return "record";
}

export function getLayer(type: string): PageLayer {
  if (type === "record") return "source";
  return "derived";
}

export function canMerge(typeA: string, typeB: string): boolean {
  return getLayer(typeA) === getLayer(typeB);
}

// ─── Vault Wiki-Link Rewriting ───────────────────────────────

function getVaultDirs(): string[] {
  const ontology = getOntology();
  const dirs = new Set<string>();
  for (const type of ontology.getConcreteEntityTypes()) {
    dirs.add(ontology.getVaultDir(type));
  }
  return [...dirs];
}

export interface VaultLinkOp {
  oldSlug: string;
  newSlug?: string;
}

/**
 * Rewrite wiki-links across vault files.
 * - newSlug present → replace `[[old]]` → `[[new]]`  (merge)
 * - newSlug absent  → strip `[[]]`, keep plain text   (delete)
 *
 * When `db` is provided, uses chunks_fts to find only candidate files.
 * Falls back to full vault scan when `db` is omitted.
 */
export function rewriteVaultLinks(vaultPath: string, operations: VaultLinkOp[], db?: CBrainDB): number {
  type Replacement = { from: string; to: string };
  const replacements: Replacement[] = [];
  const searchPatterns: string[] = [];

  for (const op of operations) {
    const oldShort = op.oldSlug.split("/").pop()!;
    searchPatterns.push(`[[${op.oldSlug}]]`, `[[${oldShort}]]`);
    if (op.newSlug) {
      const newShort = op.newSlug.split("/").pop()!;
      replacements.push({ from: `[[${op.oldSlug}]]`, to: `[[${newShort}]]` });
      if (oldShort !== op.oldSlug) {
        replacements.push({ from: `[[${oldShort}]]`, to: `[[${newShort}]]` });
      }
    } else {
      replacements.push({ from: `[[${op.oldSlug}]]`, to: oldShort });
      if (oldShort !== op.oldSlug) {
        replacements.push({ from: `[[${oldShort}]]`, to: oldShort });
      }
    }
  }

  let totalRewritten = 0;

  // Collect candidate file paths
  const candidateFiles = new Set<string>();

  if (db) {
    const slugs = db.findSlugsByText(searchPatterns);
    for (const slug of slugs) {
      const fp = db.getPageFilePath(slug);
      if (fp) candidateFiles.add(join(vaultPath, fp));
    }
  } else {
    for (const dir of getVaultDirs()) {
      const absDir = join(vaultPath, dir);
      if (!existsSync(absDir)) continue;
      for (const file of readdirSync(absDir)) {
        if (!file.endsWith(".md")) continue;
        candidateFiles.add(join(absDir, file));
      }
    }
  }

  for (const filePath of candidateFiles) {
    let content: string;
    try { content = readFileSync(filePath, "utf-8"); } catch { continue; }

    let updated = content;
    let changed = false;
    for (const { from, to } of replacements) {
      if (updated.includes(from)) {
        updated = updated.replaceAll(from, to);
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(filePath, updated, "utf-8");
      totalRewritten++;
    }
  }

  return totalRewritten;
}

// ─── Canonical relation types ──────────────────────────────

const CANONICAL_RELATIONS: Record<string, string> = {
  // ─── Entity Relations (9) ───────────────────────────────────

  // 1. 认识 (person ↔ person)
  "knows": "认识", "认识": "认识",
  "同事": "认识", "同行": "认识", "师承": "认识", "前同事": "认识",
  "同学": "认识", "聚会": "认识", "聚餐": "认识", "参会": "参会",
  "参赛": "认识", "同行旅行": "认识", "同行参赛": "认识",
  "师徒": "认识", "同学/好友": "认识", "师生后决裂": "认识",
  "妻子": "认识", "父子": "认识", "师承与发展": "认识",

  // 2. 提及 (default fallback)
  "提及": "提及", "mentions": "提及", "announced": "提及", "发布了": "提及",
  "about": "提及", "涉及": "提及", "收录": "提及", "参考": "提及",
  "引用": "提及", "金句": "提及", "主讲人": "提及", "主题演讲": "提及",
  "分析对象": "提及", "机制解释": "提及", "影响": "提及",
  "心理机制": "提及", "提出者": "提及", "补充说明": "提及",
  "解决方案参考": "提及", "诊断对象": "提及", "药理靶点": "提及",
  "Harness实例": "提及", "Memory外化实现": "提及",
  "产品获批": "提及", "人才标准": "提及", "会议讨论": "提及",
  "作者": "提及", "决策补充": "提及", "分析依据": "提及",
  "分类框架": "提及", "参考工作原则": "提及", "详细定义": "提及",
  "详细说明": "提及", "认知方法参考": "提及", "跟进": "提及",
  "收录于": "提及", "政策文件": "提及", "数据平台": "提及",
  "技术基础设施": "提及", "框架整合": "提及", "映射": "提及",
  "方法论": "提及", "微观机制": "提及", "认知机制": "提及",
  "配套政策": "提及", "著作": "提及", "条件拆解": "提及",
  "经济背景": "提及", "环境丰容极致": "提及", "整合": "提及",
  "方法补充": "提及", "理论解释": "提及", "差距分析基于": "提及",
  "思维补充": "提及", "拮抗系统": "提及", "术语参照": "提及",
  "类型参照": "提及", "认知丰容实践": "提及", "演示者": "提及",
  "演讲": "提及",
  // English singletons
  "applies_to": "提及", "characterized_by": "提及", "focus_of": "提及",
  "methodology": "提及", "studied_in": "提及",

  // 3. 任职 (person → org)
  "works_at": "任职", "joined": "任职", "任职于": "任职", "works_on": "任职",
  "负责T1": "任职", "负责产品": "任职",
  "董事长": "任职", "员工": "任职", "前雇主": "任职",
  "曾任": "任职", "曾任总经理": "任职", "现任总经理": "任职",
  "副总经理": "任职", "助理": "任职", "升职到": "任职",
  "汇报给": "上级", "党委书记、常务副总经理": "任职",
  "副总经理（江苏康缘医药有限公司）": "任职",
  "鲲鹏项目总对接人": "任职", "主导开发": "任职",
  "负责核药": "任职", "负责区域": "任职",

  // 4. 创立 (person → org)
  "founded": "创立", "founded_by": "创立", "founder_of": "创立", "创立了": "创立",
  "创始人": "创立",

  // 5. 归属 (org → org)
  "subsidiary_of": "归属", "part_of": "归属", "same_company": "归属", "company": "归属",
  "子公司": "归属", "同属一家公司": "归属", "同公司": "归属", "公司": "归属",
  "下属": "下属", "belongs_to": "归属", "归属于": "归属",
  "上级": "上级", "领导": "上级", "直属领导": "上级", "直属上级": "上级", "boss": "上级",
  "总部位于": "归属", "belongs_to_bu": "归属", "开发并所有": "归属",

  // 6. 合作
  "partnered_with": "合作", "合作": "合作",
  "业务合作": "合作", "战略合作": "合作",

  // 7. 竞争
  "competitor": "竞争", "竞争对手": "竞争", "竞品": "竞争",

  // 8. 资本
  "invested_in": "资本", "投资了": "资本", "acquired": "资本", "收购了": "资本",

  // 9. 制造
  "manufactured_by": "制造", "developed_by": "制造", "contains": "制造",
  "contained_in": "制造", "成分": "制造", "uses": "制造", "implemented_by": "制造",
  "targets": "竞争", "requires": "制造",
  "wrote": "制造", "implemented": "制造",

  // ─── Concept Relations (6) ──────────────────────────────────

  // 关联 (general semantic connection)
  "关联": "关联", "呼应": "关联", "桥接": "关联", "同源": "关联",
  "并提": "关联", "并立": "关联", "主题关联": "关联", "理论关联": "关联",
  "方法论关联": "关联", "方法关联": "关联", "同义互证": "关联",
  "同源分流": "关联", "同源呼应": "关联", "跨体系呼应": "关联",
  "相关概念": "关联", "相关知识": "关联", "关联案例": "关联",
  "关联分析": "关联", "同一体系": "关联", "领航者对话访谈": "关联",
  "理论呼应": "关联", "共鸣": "关联", "跨时空共鸣": "关联",
  "互为因果": "关联", "互相验证": "关联", "案例对应": "关联",
  "层次对应": "关联", "素材支撑": "关联", "条件递进": "关联",
  "解决方案关联": "关联", "支撑": "关联", "类比": "关联",
  "参考桥接": "关联",
  "交叉——\"事前剖析\"与反脆弱的试错逻辑一致": "关联",
  "对应——\"我愿意被视为无知吗\"直指达克效应的解药": "关联",
  "思想共鸣：自性化与意义追寻": "关联",
  "陷阱1\"现状的吸引\"就是损失厌恶——韩焱书里详述": "关联",
  "陷阱3\"对自己预测过于自信\"就是达克效应的表现": "关联",
  "哲学共鸣——提问的本质是改变看法，而非改变事物": "关联",
  "底层概念交叉——元无知、防御式大脑、自我验证理论": "关联",

  // 互补 (perspective/methodology complement)
  "互补": "互补", "互补视角": "互补", "互补解释": "互补",
  "方法论互补": "互补", "方法论共鸣": "互补", "方法论参照": "互补",
  "视角互补": "互补", "对比互补": "互补", "互补维度": "互补",
  "认知框架互补": "互补", "同源互补": "互补",
  "互补——前者约束认知，后者解释为何需要约束": "互补",
  "互补——提问清单是实操工具，好问题价值是理论支撑": "互补",
  "理论补充——解释提问清单为何有效": "互补",
  "方法论互补——拆解整合与约束排除": "互补",

  // 延伸 (extension/elaboration)
  "延伸": "延伸", "展开论述": "延伸", "续接": "延伸",
  "细化": "延伸", "衍生": "延伸", "方法论延伸": "延伸",
  "理论延伸为MBTI": "延伸", "延伸补充": "延伸", "后续衔接": "延伸",
  "系列文章": "延伸", "同系列文章": "延伸", "同系列模型": "延伸",
  "更新版本": "延伸", "哲学版": "延伸",

  // 基础 (theoretical foundation/source)
  "底层逻辑一致": "基础", "底层逻辑": "基础", "哲学基础": "基础",
  "思想源头": "基础", "理论基础": "基础", "理论基础源自": "基础",
  "理论源自": "基础", "出处": "基础", "来源": "基础", "来源记录": "基础",
  "核心思想": "基础", "思想来源": "基础", "思想基础": "基础",
  "思维框架来源": "基础", "底层原理": "基础", "底层心法": "基础",
  "语言学根源": "基础", "素材来源": "基础", "数据来源": "基础",
  "心理基础": "基础", "生物学基础": "基础", "社会丰容基础": "基础",
  "沟通基础": "基础", "提炼自": "基础", "基于": "基础",

  // 对比 (contrast/opposition)
  "对比": "对比", "反面论证": "对比", "反面案例": "对比", "反面注脚": "对比",
  "反面画像": "对比", "对抗工具": "对比", "对治": "对比",
  "对治方法": "对比", "正反对比": "对比", "对比模型": "对比",
  "反熵策略": "对比", "反熵方法": "对比", "反面思考应用": "对比",
  "范式转移案例": "对比", "范式转移起点": "对比", "范式共存案例": "对比",
  "预警案例": "对比", "证伪思维": "对比", "微妙对照": "对比",
  "替代": "对比", "反熵最优路径": "对比", "范式案例": "对比",
  "学派对比：意义意志 vs 快乐意志": "对比",
  "学派对比：意义意志 vs 权力意志": "对比",

  // 应用 (application/instance)
  "应用思维模型": "应用", "应用场景": "应用", "应用案例": "应用",
  "案例": "应用", "实践方法": "应用", "实践验证": "应用",
  "实践框架": "应用", "操作方法": "应用", "操作落地": "应用",
  "工具实践": "应用", "组织层面应用": "应用", "认知层面应用": "应用",
  "认知偏差实例": "应用", "认知偏差体现": "应用", "实操案例": "应用",
  "管理实践": "应用", "管理方法论": "应用", "管理框架": "应用",
  "管理映射": "应用", "管理智慧": "应用", "行为经济学解释": "应用",
  "应用验证": "应用", "科学验证": "应用", "方法验证": "应用",
  "概念实现": "应用", "正向实践": "应用",

  // ─── Legacy → 提及 ──────────────────────────────────────────
  "间接关系": "提及", "间接连接": "提及", "间接关联": "提及",
  "evolves_to": "提及", "triggered_by": "提及", "has": "归属",
};

export function normalizeRelation(rel: string): string {
  const ontology = getOntology();
  if (ontology.isValidRelation(rel)) return rel;
  // 保留原有 alias 映射作为 fallback
  return CANONICAL_RELATIONS[rel] ?? "提及";
}

export function getCanonicalRelationTypes(): Set<string> {
  return new Set(Object.keys(getOntology().getAllRelationTypes()));
}

/** @deprecated Use getCanonicalRelationTypes() instead */
export const CANONICAL_RELATION_TYPES = new Set<string>([]);

// 初始化时填充 CANONICAL_RELATION_TYPES 以兼容旧代码
try {
  for (const r of Object.keys(getOntology().getAllRelationTypes())) {
    CANONICAL_RELATION_TYPES.add(r);
  }
} catch {}

export function getReverseRelation(rel: string): string | undefined {
  return getOntology().getReverseRelation(rel);
}

/** @deprecated Use getReverseRelation() instead */
export const REVERSE_RELATIONS: Record<string, string> = {};

// 初始化时填充 REVERSE_RELATIONS 以兼容旧代码（sqlite.ts 等直接索引此对象）
try {
  for (const [name, def] of Object.entries(getOntology().getAllRelationTypes())) {
    if (def.reverse) {
      REVERSE_RELATIONS[name] = def.reverse;
    }
  }
} catch {}

export const HIERARCHY_RELATIONS = new Set(["reports_to"]);

export function isValidRelation(r: string): boolean {
  return getOntology().isValidRelation(r) || HIERARCHY_RELATIONS.has(r);
}

/** @deprecated Use getRelationStrength() which delegates to ontology */
const DEFAULT_WEIGHTS: Record<string, { strength: string; weight: number }> = {};

export function getRelationStrength(relation: string): { strength: string; weight: number } {
  return getOntology().getRelationStrength(relation);
}

export function buildStubBody(
  name: string,
  rels: Array<{ from: string; to: string; relation: string }>,
  sourceSlug: string
): string {
  const lines = [
    `> Auto-extracted from [[${sourceSlug}]]`,
    "",
    `## Known Relations`,
    "",
  ];
  for (const rel of rels) {
    if (rel.from === name) {
      lines.push(`- ${rel.relation} → [[${rel.to}]]`);
    } else {
      lines.push(`- ← ${rel.relation} from [[${rel.from}]]`);
    }
  }
  return lines.join("\n");
}

/**
 * Look up an entity slug by exact title match in DB.
 * Only matches entity/concept pages — raw files and records are source material,
 * not valid targets for wikilinks.
 */
export function findEntitySlug(
  db: CBrainDB,
  name: string
): string | null {
  return db.getEntitySlugByTitle(name) ?? db.getSlugByAlias(name);
}

/** @deprecated Use EntityResolver.resolveAll() instead */
export function buildLowercaseIndex(entitySlugMap: Map<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [key, slug] of entitySlugMap) {
    idx.set(key.toLowerCase(), slug);
  }
  return idx;
}

/** @deprecated Use EntityResolver.resolveAll() instead */
export function resolveEntityName(
  name: string,
  entitySlugMap: Map<string, string>,
  db: CBrainDB,
  lowerIndex?: Map<string, string>
): string | null {
  // 1. Exact
  const exact = entitySlugMap.get(name);
  if (exact) return exact;

  // 2. Case-insensitive (O(1) with prebuilt index)
  const lower = name.toLowerCase();
  const ciResult = lowerIndex?.get(lower);
  if (ciResult) return ciResult;
  if (!lowerIndex) {
    for (const [key, slug] of entitySlugMap) {
      if (key.toLowerCase() === lower) return slug;
    }
  }

  // 3. Strip parenthetical suffix
  const stripped = name.replace(/[（(].+?[）)]$/, "").trim();
  if (stripped !== name) {
    const s = entitySlugMap.get(stripped);
    if (s) return s;
    const strippedLower = stripped.toLowerCase();
    const ciStripped = lowerIndex?.get(strippedLower);
    if (ciStripped) return ciStripped;
    if (!lowerIndex) {
      for (const [key, slug] of entitySlugMap) {
        if (key.toLowerCase() === strippedLower) return slug;
      }
    }
    for (const [key, slug] of entitySlugMap) {
      if (key.startsWith(stripped) || stripped.startsWith(key)) return slug;
    }
  }

  // 4. DB fallback
  return findEntitySlug(db, name) ?? findEntitySlug(db, stripped);
}

