import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { buildContext } from "../../src/mcp/context.js";
import { TopicManager } from "../../src/core/topics/manager.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");

/**
 * #511 Task 3 — the existing `cbrain show` fallback read applies the same
 * current-topic guard: a verified current topic prints its derived notice and
 * the verified body; an invalidated topic hides the body entirely. This path
 * never needs model/embedding configuration.
 */
describe("CLI show — generated topic page guard (#511 Task 3)", () => {
  let testDir: string;
  let brainDir: string;
  let vaultPath: string;
  let topicSlug: string;
  let sourcePath: string;
  const marker = "DERIVED_CLI_SENTINEL";
  const slugs: string[] = [];

  beforeEach(async () => {
    testDir = mkdtempSync("/tmp/cbrain-test-topic-show-");
    brainDir = join(testDir, "mybrain");
    execSync(`bun run ${join(PROJECT_DIR, "src/cli/index.ts")} init --dir ${brainDir}`, { encoding: "utf-8" });
    vaultPath = join(brainDir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    const db = new CBrainDB(join(brainDir, "brain.sqlite"));
    const lance = new LanceDBManager();
    await lance.connect(join(brainDir, "lancedb"));
    const llm = {
      name: "anonymous-topic-fixture",
      chat: async () =>
        JSON.stringify({
          overview: [{ text: marker, kind: "observation", sourceSlug: slugs[0], quote: "主题D需要回顾行动进度。" }],
          observations: [{ text: marker, kind: "observation", sourceSlug: slugs[1], quote: "主题D需要回顾行动进度。" }],
          details: [],
          open_questions: [],
        }),
    };
    const ctx = buildContext({
      db,
      lance,
      embedding: new DeterministicEmbeddingProvider(),
      vaultPath,
      runtimePath: join(brainDir, "runtime"),
      llm,
    });
    try {
      const bodies = [
        "原始材料0：主题D需要回顾行动进度。",
        "原始材料1：主题D需要回顾行动进度。",
        "原始材料2：主题D需要回顾行动进度。",
      ];
      for (let i = 0; i < 3; i++) {
        const page = ctx.pages.create({ title: `材料${i}`, type: "record", body: bodies[i] });
        slugs.push(page.slug);
        const prepared = await ctx.pipeline.embed(bodies[i]);
        await ctx.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
      }
      const manager = new TopicManager({ db, lance, pages: ctx.pages, pipeline: ctx.pipeline, versions: ctx.versions, llm });
      const result = await manager.compile({ title: "主题D", sourceSlugs: [...slugs] });
      expect(result.status).toBe("created");
      topicSlug = manager.resolveTopicSlug("主题D");
      sourcePath = join(vaultPath, db.getPageFilePath(slugs[0])!);
    } finally {
      ctx.jobs.stop();
      await lance.close();
      db.close();
    }
  });

  afterEach(() => {
    slugs.length = 0;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function show(slug: string): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "show", slug], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
  }

  test("current topic shows the derived notice and verified body", () => {
    const result = show(topicSlug);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("派生主题页");
    expect(result.stdout).toContain(marker);
    expect(result.stdout).toContain(`sources:    ${slugs[0]}`);
  });

  test("invalidated topic hides the body behind a status notice", () => {
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf-8") + "\n用户更正：安排已取消。");
    const result = show(topicSlug);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("派生主题页");
    expect(result.stdout).not.toContain(marker);
    expect(result.stdout).toContain("不可用");
  });
});
