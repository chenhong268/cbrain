import { expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import { computeRootLexicalCoverage } from "../../src/core/retrieval/retrieval-support.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";

const query = "实体甲 季度二 收入 下滑 原因";
const cases: Array<[string, string, boolean]> = [
  [query, "实体甲在季度二收入下滑，原因为竞争加剧。", true],
  ["组织丙 年度三 成本 上升 原因", "组织丙的年度三成本上升，原因是原料涨价。", true],
  [query, "实体乙在季度二收入下滑，原因为竞争加剧。", false],
  [query, "实体甲在季度三收入下滑，原因为竞争加剧。", false],
  [query, "实体甲在季度二收入未下滑，原因为竞争减弱。", false],
  [query, "实体甲在季度二收入下滑，原因尚不明确。", false],
  [query, "实体甲在季度二收入下滑，原因为未知。", false],
  [query, "实体甲在季度二收入下滑，原因为：无。", false],
  [query, "实体甲在季度二收入下滑，原因为“无”。", false],
  [query, "实体甲在季度二收入下滑，原因是竞争加剧吗，仍待调查。", false],
  [query, "实体甲在季度二收入下滑，原因为目前尚未查明。", false],
  [query, "实体甲在季度二收入下滑，原因是竞争加剧，尚未证实。", false],
  [query, "实体甲在季度二收入下滑，原因是什么？", false],
  [query, "实体甲在季度二收入下滑，原因为竞争加剧？", false],
  [query, "实体甲在季度二收入下滑，原因为竞争加剧！？", false],
  [query, "实体甲在季度二收入下滑，原因为竞争加剧。？", false],
  [query, "实体甲在季度二收入下滑，原因为竞争加剧吗。", false],
  [query, "实体甲在季度二收入下滑。实体乙的原因为竞争加剧。", false],
  [query, "实体甲在季度二收入下滑，原因", false],
  [query, "实体甲在季度二收入下滑，原因为", false],
  [query, "实体甲在季度二收入下滑，原因不是竞争加剧。", false],
  [query, "其他实体甲在季度二收入下滑，原因为竞争加剧。", false],
  ["实体甲 系统 恢复 边界", "实体乙 系统 恢复 边界", false],
  ["四季度 年度 目标 方案", "三季度 年度 目标 方案", false],
  ["系统 不允许 自动 覆盖 文件", "系统 允许 自动 覆盖 文件", false],
  ["RFC7231 系统 恢复 规范", "RFC7232 系统 恢复 规范", false],
  ["系统 自动 覆盖 文件 原因", "系统自动覆盖部分文件，原因为配置变更。", false],
  ["实体甲 V2 收入 下滑 原因", "实体甲在V3收入下滑，原因为竞争加剧。", false],
];

for (const [question, body, accepted] of cases) {
  test(`keyword causal evidence ${accepted ? "admits" : "rejects"}: ${body}`, async () => {
    const db = new CBrainDB(":memory:");
    try {
      const slug = "records/source-a";
      db.upsertPage({ slug, title: "原始记录A", type: "record", filePath: `${slug}.md`, contentHash: "a" });
      db.insertChunkWithLevel(slug, 0, body, 0, null);
      db.ftsInsert(slug, body);
      const search = new HybridSearch(db, {
        dimensions: 2, embed: async () => ({ embedding: [1, 0], tokenCount: 0 }), embedBatch: async () => [],
      }, { search: async () => [] } as never, { multiQuery: false });
      let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
      registerFrontdoorTools({
        registerTool(name: string, _definition: unknown, callback: typeof handler) {
          if (name === "cbrain_recall") handler = callback;
        },
      } as never, {
        outputMode: "legacy", db, search,
        pages: { getBySlug: () => ({ slug, title: "原始记录A", type: "record", body, expires_at: null }) },
      } as never);
      const response = await handler!({ query: question });
      const output = JSON.parse(response.content[0].text);
      expect(output.summary.count).toBe(accepted ? 1 : 0);
      expect(computeRootLexicalCoverage(question, body) >= 0.6).toBe(accepted);
      if (accepted) {
        expect(output.summary.status).toBe("ok");
        expect(output.raw.entities[0].title).toBe("原始记录A");
        expect(output.raw.entities[0].snippet).toBe(body);
      }
    } finally { db.close(); }
  });
}
