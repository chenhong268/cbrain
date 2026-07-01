import type { Command } from "commander";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, createDeps } from "../context.js";
import { analyzeKnowledgeMap } from "../../core/knowledge-map/index.js";
import { buildKnowledgeMapReport } from "../../core/knowledge-map/report.js";

/**
 * `cbrain knowledge-map` — generate a user-facing Knowledge Map report (#241).
 *
 * Read-only: runs the #240 analyzer and writes a Markdown report under the
 * runtime/output area (never the vault or brain pages). Prints the output path
 * and a one-sentence summary. `--debug` appends a raw appendix; `--json` prints
 * the raw analysis instead of a report.
 */
export function register(program: Command): void {
  program
    .command("knowledge-map")
    .description("生成知识图谱报告（只读）：领域、成熟度、桥接节点、孤立/弱连接条目。不写 vault。")
    .option("--debug", "在报告末尾追加原始/调试附录（含 slug、权重等内部数据）")
    .option("--json", "输出原始 JSON 分析，而非 Markdown 报告")
    .action((opts: { debug?: boolean; json?: boolean }) => {
      const config = loadConfig();
      // requireEmbedding=false: the analyzer only reads the graph, no embedding needed.
      const { db, runtimePath } = createDeps(config, false);
      try {
        const analysis = analyzeKnowledgeMap(db);

        if (opts.json) {
          console.log(JSON.stringify(analysis, null, 2));
          return;
        }

        const report = buildKnowledgeMapReport(analysis, { includeDebug: opts.debug === true });
        const dir = join(runtimePath, "knowledge-map");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `knowledge-map-${new Date().toISOString().slice(0, 10)}.md`);
        writeFileSync(file, report.markdown, "utf-8");

        console.log(report.summary);
        console.log(`报告已写入：${file}`);
      } finally {
        try {
          db.close();
        } catch {
          /* best effort */
        }
      }
    });
}
