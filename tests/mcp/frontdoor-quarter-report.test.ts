import { expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import { getQuarterlyReportEvidence } from "../../src/core/retrieval/quarter-report-evidence.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";

const query = "实体甲 AliasB 地区丙仿制品 二季度 销售下滑 2026Q2 财报";
const report = `# 组织丙2026年第二季度业绩
## 核心产品
| 产品 | Q2销售额 | 固定汇率同比 | 官方披露的主要原因 |
|---|---|---|---|
| 实体甲 AliasB | 12单位 | -25% | 主要受地区丙仿制品竞争影响 |`;
const cases: Array<[string, string, string, boolean, ("drift" | "missing" | "entity")?]> = [
  ["source identity drift", query, report, false, "drift"],
  ["missing original", query, report, false, "missing"],
  ["non-record source", query, report, false, "entity"],
  ["bound report", query, report, true],
  ["report behind a long preamble", query, report.replace("## 核心产品", "实体甲的季度报告。".repeat(40) + "\n## 核心产品"), true],
  ["ascii period", query, report.replace("2026年第二季度", "Q2 2026"), true],
  ["nested quarter", query, report.replace("## 核心产品", "## Q3"), false],
  ["withdrawn heading", query, report.replace("## 核心产品", "## 已撤回数据"), false],
  ["unconfirmed heading", query, report.replace("## 核心产品", "## 原因未经确认"), false],
  ["speculative suffix", query, report.replace("竞争影响 |", "竞争影响；仅为假设 |"), false],
  ["later withdrawal section", query, report + "\n## 更正\n上述表格已撤回。", false],
  ["conflicting positive row", query, report + "\n| 实体甲 AliasB | 12单位 | +25% | 主要受地区丙仿制品竞争影响 |", false],
  ["conflicting denied row", query, report + "\n| 实体甲 AliasB | 12单位 | -25% | 并不受地区丙仿制品竞争影响 |", false],
  ["speculative heading", query, report.replace("## 核心产品", "## 待核实数据"), false],
  ["subject", query, report.replace("实体甲 AliasB", "实体乙 AliasB"), false],
  ["subject prefix", query, report.replace("实体甲 AliasB", "其他实体甲 AliasB"), false],
  ["alias", query, report.replace("AliasB", "AliasC"), false],
  ["scope", query, report.replace("地区丙仿制品", "地区丁仿制品"), false],
  ["query quarter", query.replace("二季度", "三季度"), report, false],
  ["query year", query.replace("2026Q2", "2025Q2"), report, false],
  ["report quarter", query, report.replace("第二季度", "第三季度"), false],
  ["report year", query, report.replace("2026年", "2025年"), false],
  ["nested period", query, report.replace("## 核心产品", "## 2025年第二季度"), false],
  ["table quarter", query, report.replace("Q2销售额", "Q3销售额"), false],
  ["change quarter", query, report.replace("固定汇率同比", "Q1同比"), false],
  ["growth", query, report.replace("-25%", "+25%"), false],
  ["zero change", query, report.replace("-25%", "-0%"), false],
  ["hypothetical column", query, report.replace("官方披露的主要原因", "假设原因"), false],
  ["table preface qualification", query, report.replace("| 产品 |", "该表的原因未经确认。\n| 产品 |"), false],
  ["root qualification", query, report.replace("## 核心产品", "以下内容仅是假设。\n## 核心产品"), false],
  ["table footer withdrawal", query, report + "\n该表已撤回。", false],
  ["negated cause", query, report.replace("主要受", "并不受"), false],
  ["uncertain cause", query, report.replace("主要受", "可能受"), false],
  ["question", query, report.replace("竞争影响 |", "竞争影响？ |"), false],
  ["unconfirmed cause", query, report.replace("主要受", "猜测受"), false],
  ["unrelated row cause", query, report.replace("主要受地区丙仿制品竞争影响", "未知") + "\n| 实体乙 AliasC | 9单位 | -25% | 主要受地区丙仿制品竞争影响 |", false],
];

for (const [label, question, body, accepted, sourceState] of cases) {
  test(`quarter report ${label}`, async () => {
    const db = new CBrainDB(":memory:");
    try {
      const slug = "records/report-a";
      db.upsertPage({ slug, title: "原始记录A", type: sourceState === "entity" ? "entity" : "record", filePath: `${slug}.md`, contentHash: "a" });
      // The title/period and product row live in different indexed chunks.
      const chunks = [body.split("\n")[0]!, body.split("\n").slice(1).join("\n"), body.split("\n").slice(1).join("\n")];
      for (const [index, chunk] of chunks.entries()) {
        db.insertChunkWithLevel(slug, index, chunk, 0, null);
        db.ftsInsert(slug, chunk);
      }
      const search = new HybridSearch(db, {
        dimensions: 2, embed: async () => ({ embedding: [1, 0], tokenCount: 0 }), embedBatch: async () => [],
      }, { search: async () => [] } as never, { multiQuery: false });
      let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
      let freshReads = 0;
      registerFrontdoorTools({
        registerTool(name: string, _definition: unknown, callback: typeof handler) {
          if (name === "cbrain_recall") handler = callback;
        },
      } as never, {
        outputMode: "legacy", db, search,
        pages: { getBySlug: () => ({ slug, title: "原始记录A", type: "record", body, expires_at: null }),
          getBySlugFresh: () => {
            freshReads++;
            if (sourceState === "missing") throw new Error("source unavailable");
            return { slug, title: "原始记录A", type: "record", body, expires_at: null,
              frontmatter: sourceState === "drift" ? { title: "其他记录" } : {} };
          } },
      } as never);
      const output = JSON.parse((await handler!({ query: question })).content[0].text);
      expect(output.summary.count).toBe(accepted ? 1 : 0);
      expect(freshReads).toBeLessThanOrEqual(1);
      if (!sourceState) expect(typeof getQuarterlyReportEvidence(question, body) === "string").toBe(accepted);
      if (accepted) {
        expect(output.summary.status).toBe("ok");
        expect(output.raw.entities[0].title).toBe("原始记录A");
        expect(output.raw.entities[0].snippet).toContain("-25%");
        expect(output.raw.entities[0].snippet).toContain("地区丙仿制品");
        expect(output.raw.entities[0].snippet).toContain("AliasB");
        expect(output.raw.entities[0].snippet).toContain("Q2销售额");
        const brief = JSON.parse((await handler!({ query: question, detail: "brief" })).content[0].text);
        expect(brief.summary.count).toBe(1);
        expect(brief.raw.entities[0].snippet).toBe(output.raw.entities[0].snippet);
      }
    } finally { db.close(); }
  });
}
