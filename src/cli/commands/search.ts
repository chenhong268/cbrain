import type { Command } from "commander";
import { CBrainDB } from "../../storage/sqlite.js";
import { loadConfig, createDeps } from "../context.js";

export function register(program: Command) {
  program
    .command("query")
    .description("Search the brain")
    .option("-s, --strategy <strategy>", "搜索方式（默认 all 即可，一般不需要改）", "all")
    .option("-l, --limit <number>", "Max results", "10")
    .argument("<query>", "Search query")
    .action(async (query, opts) => {
      const config = loadConfig();
      const needsEmbedding = opts.strategy === "vector" || opts.strategy === "all";
      const deps = createDeps(config, needsEmbedding);
      if (needsEmbedding) await deps.lance.connect(config.lancePath);
      const { HybridSearch } = await import("../../core/search.js");
      const search = new HybridSearch(deps.db, deps.embedding, deps.lance);
      const results = await search.search(query, { strategy: opts.strategy, limit: parseInt(opts.limit, 10) });
      if (results.length === 0) { console.log("没有找到相关内容。"); } else {
        for (const r of results) {
          const slug = r.slug.replace(/^brain\//, "").replace(/^records\//, "");
          console.log(`${slug}`);
          if (r.snippet) console.log(`  ${r.snippet.slice(0, 120)}`);
          console.log();
        }
      }
      deps.db.close();
    });

  program
    .command("graph-query")
    .description("Query the knowledge graph")
    .option("-m, --mode <mode>", "Query mode: traverse|backlinks|related", "traverse")
    .option("-d, --depth <number>", "Max traversal depth", "2")
    .option("-l, --limit <number>", "Max results", "20")
    .argument("<slug>", "Seed entity slug")
    .action(async (slug, opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const { GraphManager } = await import("../../core/graph.js");
      const graph = new GraphManager(db);
      let result;
      switch (opts.mode) {
        case "backlinks": result = graph.getBacklinks(slug); break;
        case "related": result = graph.getRelatedEntities(slug, parseInt(opts.limit, 10)); break;
        default: result = graph.traverse(slug, { maxDepth: parseInt(opts.depth, 10), limit: parseInt(opts.limit, 10) });
      }
      console.log(JSON.stringify(result, null, 2));
      db.close();
    });
}
