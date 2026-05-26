#!/usr/bin/env bun
/**
 * Reclassify concept entities:
 *   framework/ + theory/ → model/
 *   concept/concept/ → pharma | psychology | stays
 *
 * Usage: bun run src/cli/reclassify-concepts.ts [--dry-run]
 */
import * as fs from "fs";
import * as path from "path";

const VAULT =
  process.env.CBRAIN_VAULT ??
  "/Users/chenhong/Library/Mobile Documents/iCloud~md~obsidian/Documents/CBrain/vault";
const CONCEPTS = path.join(VAULT, "brain/concepts");
const DRY = process.argv.includes("--dry-run");

// ── Keywords ──────────────────────────────────────────────────

const PHARMA = [
  "集采","国采","医保","飞检","DRG","DIP","CSO","cso","挂网",
  "前列腺","乳腺癌","血[脂管]","健康[信清隐]","免疫系统","神经肌肉",
  "药品","慢病","中成药","非集采","短缺药","医药","合规","带金",
  "国办","接续","双通道","创新药","利钠肽","招采","中选","红黄标",
  "核药","医疗","两票制","鲲鹏","全渠道","学术推广","首发价",
  "三不明","价值导向","追溯码","试验数据","商业贿赂","断食","168轻",
  "网上药店","国际药企","rcm","国办发","780亿","反垄断","承责点",
];

const PSYCH = [
  "认知","心理安全","情绪","斯多葛","反脆弱","意义疗法","心流",
  "达克效应","幸存者偏差","锚定效应","锚定心理","光环效应","羊群效应",
  "证实倾向","从众心理","乐观偏见","虚假一致性","俄罗斯方块",
  "lollapalooza","沃伦哈丁","证伪思维","完美主义",
  "自我效能","自我验证","自我沉溺","自我决定",
  "注意力","内在动机","动机研究","微习惯","原子习惯",
  "课题分离","共同体感觉","同理心地图","防御式思维","角色思维",
  "范式转移","现象主义","意识哲学","感觉材料",
  "分析心理学","个体心理学","逻辑实证","辩证法","正反合",
  "道术结合","费曼","后结构","行为设计","钝感力",
  "斯普特尼克","黑天鹅","知识的诅咒","不确定性","期权思维",
  "多巴胺","神经科学","神经可塑性","多头潜在","罗素",
  "跨域推理","微小行动","数据视角","来访者为中心","无条件的积极",
  "竞争型","融合型","道德经与反脆弱","中国文明",
  "反毒物兴奋","主观活力","能动性","简单的逻辑","生活风格",
  "责任感","脆弱","小国寡民","logotherapy","目的论",
  "绩效前测","计划谬误","规划谬误","lencioni",
  "理性","情感","虚荣","复利效应",
];

function classify(title: string, hadFT: boolean): string {
  const low = title.toLowerCase();
  if (PHARMA.some((kw) => low.includes(kw.toLowerCase()))) return "pharma";
  if (PSYCH.some((kw) => low.includes(kw.toLowerCase()))) return "psychology";
  if (hadFT) return "model";
  return "concept";
}

function patchFrontmatter(content: string, dir: string, title: string): string {
  return content
    .replace(/^(type:\s*).*$/m, `$1concept/${dir}`)
    .replace(/^(slug:\s*).*$/m, `$1brain/concepts/${dir}/${title}`);
}

// ── Collect files ─────────────────────────────────────────────

interface F { dir: string; path: string; content: string; size: number }

const byTitle = new Map<string, F[]>();

for (const dir of ["concept", "framework", "theory"]) {
  const dp = path.join(CONCEPTS, dir);
  if (!fs.existsSync(dp)) continue;
  for (const f of fs.readdirSync(dp).filter((x) => x.endsWith(".md"))) {
    const title = f.replace(/\.md$/, "");
    const fp = path.join(dp, f);
    const content = fs.readFileSync(fp, "utf-8");
    const arr = byTitle.get(title) ?? [];
    arr.push({ dir, path: fp, content, size: content.length });
    byTitle.set(title, arr);
  }
}

// ── Classify & move ───────────────────────────────────────────

const counts: Record<string, number> = { pharma: 0, psychology: 0, model: 0 };
const dupes: string[] = [];

for (const [title, files] of byTitle) {
  const best = files.sort((a, b) => b.size - a.size)[0];
  const hadFT = files.some((f) => f.dir === "framework" || f.dir === "theory");
  const target = classify(title, hadFT);

  // stays in concept/ with no cross-dir duplicates → skip
  if (target === "concept" && files.length === 1 && files[0].dir === "concept") continue;

  const dst = path.join(CONCEPTS, target, `${title}.md`);
  const patched = patchFrontmatter(best.content, target, title);

  if (!DRY) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, patched);
    for (const f of files) {
      if (f.path !== dst) fs.unlinkSync(f.path);
    }
  }

  if (files.length > 1) dupes.push(title);
  if (target !== "concept") {
    counts[target]++;
    console.log(`  ${target.padEnd(10)} ${files.map((f) => f.dir).join("+")} → ${target}/${title}`);
  } else {
    console.log(`  ${"concept".padEnd(10)} ${files.map((f) => f.dir).join("+")} → deduped, stays concept/${title}`);
  }
}

// ── Report ────────────────────────────────────────────────────

console.log(`\n=== Result ===`);
console.log(`  pharma:     ${counts.pharma}`);
console.log(`  psychology: ${counts.psychology}`);
console.log(`  model:      ${counts.model}`);
console.log(`  duplicates: ${dupes.length} resolved`);
if (DRY) console.log("\n  (DRY RUN)");
