#!/usr/bin/env bun
/**
 * Insight pipeline simulation.
 * Default: Phase 1+2 (candidate pool + scoring), no LLM.
 * --full: Phase 3 (LLM evaluation on top-N candidates). Does NOT create pages.
 */

import { join } from "node:path";
import { PageManager } from "../src/core/page.js";
import { Logger } from "../src/core/logger.js";
import { ReflectManager } from "../src/core/maintenance/reflect.js";
import { loadConfig, createDeps } from "../src/cli/context.js";

const full = process.argv.includes("--full");
const topN = parseInt(process.argv.find(a => a.startsWith("--top="))?.split("=")[1] ?? "5", 10);

const config = loadConfig();
const deps = createDeps(config);
await deps.lance.connect(config.lancePath);

const outputsDir = join(config.vaultPath, "outputs");
const logger = new Logger(outputsDir);
const pages = new PageManager(deps.db, config.vaultPath, logger);
const mgr = new ReflectManager(deps.db, pages, deps.llm, undefined, deps.embedding);

// ── Phase 1+2: Candidate Pool + Scoring ──────────────────────

console.log("══════════════════════════════════════════════════");
console.log("  Insight Pipeline Simulation");
console.log("══════════════════════════════════════════════════\n");

console.log("Phase 1: 候选生成\n");
const pool = await mgr.diagnoseCandidates();

console.log(`  间接对(A):    ${pool.bySource.indirect}`);
console.log(`  跨社区(B):    ${pool.bySource.crossCommunity}`);
console.log(`  随机远距(C):  ${pool.bySource.randomDistant}`);
console.log(`  ─────────────────────`);
console.log(`  去重后总计:   ${pool.poolSize}\n`);

console.log("Phase 2: 5维打分\n");
console.log("  权重: path=0.35 source=0.25 type=0.20 content=0.10 semantic=0.10\n");

console.log("  分数分布:");
for (const b of pool.scoreDistribution) {
  const bar = "█".repeat(Math.round(b.count / Math.max(1, pool.poolSize) * 40));
  console.log(`    ${b.bucket}: ${String(b.count).padEnd(4)} ${bar}`);
}

const avgDist = pool.topCandidates.reduce((s, c) => s + (c.dist > 0 ? c.dist : 0), 0) /
  Math.max(1, pool.topCandidates.filter(c => c.dist > 0).length);

console.log(`\n  Top-10 平均距离: ${avgDist.toFixed(1)} 跳`);
console.log(`  0.6+ 高分候选: ${pool.topCandidates.filter(c => c.score >= 0.6).length} 个`);
console.log(`  0.8+ 高分候选: ${pool.topCandidates.filter(c => c.score >= 0.8).length} 个\n`);

console.log("  Top-10 候选:");
console.log("  #   分数    距离    Jaccard 类型                    实体 A              实体 B");
console.log("  ---- ------- ------- ------- ---------------------- ------------------- -------------------");
for (const c of pool.topCandidates) {
  const distStr = c.dist === -1 ? "∞" : `${c.dist}跳`;
  console.log(`  ${String(c.rank).padEnd(4)} ${String(c.score).padEnd(7)} ${distStr.padEnd(7)} ${String(c.sourceJaccard).padEnd(7)} ${c.typeMix.padEnd(22)} ${c.entityA.slice(0, 18).padEnd(19)} ${c.entityB.slice(0, 18)}`);
}

// ── Phase 3: LLM Evaluation (--full only) ────────────────────

if (!full) {
  console.log("\n\n💡 加 --full 运行 Phase 3（LLM 评估）");
  deps.db.close();
  process.exit(0);
}

if (!deps.llm) {
  console.log("\n⚠️  未配置 LLM，无法运行 Phase 3");
  deps.db.close();
  process.exit(1);
}

console.log("\nPhase 3: LLM 评估 (K-Paths 路径评估模式)\n");
console.log(`  对 Top-${topN} 候选调 LLM，展示完整评估链\n`);

const report = await mgr.diagnoseFullPipeline(topN);

for (const c of report.candidates) {
  const labelA = c.pair[0];
  const labelB = c.pair[1];
  console.log(`#${c.rank} ${labelA} ↔ ${labelB} (score ${c.score})`);
  console.log(`  路径: ${c.path.join(" → ")}`);

  if (!c.parsed) {
    if (c.llmRaw) {
      console.log(`  LLM 原始返回: ${c.llmRaw.slice(0, 200)}`);
    } else {
      console.log(`  ⚠️  无上下文或 LLM 不可用`);
    }
    console.log();
    continue;
  }

  console.log(`  LLM → interestingness=${c.parsed.interestingness} type=${c.parsed.type}`);
  console.log(`  title: ${c.parsed.title}`);
  console.log(`  content: ${c.parsed.content.slice(0, 200)}${c.parsed.content.length > 200 ? "..." : ""}`);
  console.log(`  chain: ${c.parsed.reasoning_chain.join(" → ")}`);
  console.log(`  闸门: cite=${c.gates.citation ? "✅" : "❌"} bullshit=${c.gates.bullshit ? "✅" : "❌"} novelty=${c.gates.novelty ? "✅" : "❌"}`);
  console.log(`  结果: ${c.passed ? "✅ 通过" : "❌ 未通过"}`);
  console.log();
}

console.log(`统计: ${report.stats.llmCalls} 次 LLM, ${report.stats.insightsFound} 条 insight, ${report.stats.insightsPassed} 条通过`);

deps.db.close();
