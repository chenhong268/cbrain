import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export function register(program: Command) {
  program
    .command("check-resolvable")
    .description("Validate skills/RESOLVER.md for coverage, overlap, orphan detection")
    .action(async () => {
      const { ResolverChecker } = await import("../../core/resolver.js");
      let resolverPath = resolvePath(process.cwd(), "skills", "RESOLVER.md");
      if (!existsSync(resolverPath)) {
        let dir = process.cwd();
        for (let i = 0; i < 5; i++) {
          if (existsSync(resolvePath(dir, "package.json"))) { resolverPath = resolvePath(dir, "skills", "RESOLVER.md"); break; }
          const parent = resolvePath(dir, "..");
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (!existsSync(resolverPath)) { console.error("Error: skills/RESOLVER.md not found."); process.exit(1); }
      const checker = new ResolverChecker(resolverPath);
      const report = checker.check();
      console.log("\n  Skills Resolver Check\n");
      console.log(`  Rules:        ${report.rules}`);
      console.log(`  Categories:   ${report.coverage.length}`);
      console.log(`  Skills ref'd: ${report.skillsReferenced.length} (on disk: ${report.skillsOnDisk.length})`);
      if (report.orphans.length > 0) { console.log(`\n  Orphan skills (not routed):`); for (const o of report.orphans) console.log(`    ❌ skills/${o}`); }
      if (report.missingFiles.length > 0) { console.log(`\n  Missing files (routed but not on disk):`); for (const m of report.missingFiles) console.log(`    ❌ skills/${m}`); }
      if (report.overlaps.length > 0) { console.log(`\n  Overlapping patterns:`); for (const o of report.overlaps) console.log(`    ⚠️  "${o.pattern}" → ${o.skills.join(", ")}`); }
      console.log(`\n  Categories:`);
      for (const c of report.coverage) console.log(`    ${c.rules} rules → ${c.category}`);
      if (report.valid) console.log(`\n  ✅ All checks passed — ${report.skillsReferenced.length} skills routed, no overlaps, no orphans`);
      else { console.log(`\n  ❌ ${report.issues.length} issue(s) found`); for (const issue of report.issues) console.log(`    - ${issue}`); }
      process.exit(report.valid ? 0 : 1);
    });

  program
    .command("routing-eval")
    .description("Test skill routing accuracy against fixtures (routing-eval.jsonl)")
    .action(async () => {
      const { runEval } = await import("../../core/routing-eval.js");
      let resolverPath = resolvePath(process.cwd(), "skills", "RESOLVER.md");
      if (!existsSync(resolverPath)) {
        let dir = process.cwd();
        for (let i = 0; i < 5; i++) {
          if (existsSync(resolvePath(dir, "package.json"))) { resolverPath = resolvePath(dir, "skills", "RESOLVER.md"); break; }
          const parent = resolvePath(dir, "..");
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (!existsSync(resolverPath)) { console.error("Error: skills/RESOLVER.md not found."); process.exit(1); }
      const report = runEval(resolverPath);
      if (report.total === 0) { console.log("No routing-eval fixtures found."); process.exit(0); }
      console.log(`\n  Routing Eval — ${report.total} fixtures\n`);
      for (const r of report.results) {
        const icon = r.pass ? "✅" : "❌";
        console.log(`  ${icon} "${r.intent}"`);
        console.log(`     期望: ${r.expected}  →  匹配: ${r.matched ?? "(无)"}${r.ambiguous ? " ⚠️ 歧义" : ""}`);
      }
      console.log(`\n  ${report.pass}/${report.total} passed`);
      process.exit(report.fail > 0 ? 1 : 0);
    });
}
