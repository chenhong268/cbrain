import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { TopicManager } from "../../src/core/topics/manager.js";
import { computeCatalogFingerprint, TopicMaintenance } from "../../src/core/topics/maintenance.js";
import { parseFrontmatter, stringifyFrontmatter } from "../../src/utils/frontmatter.js";
import { hashContent } from "../../src/core/shared.js";
import {
  createTopicReadAdmission,
  readCurrentTopic,
  verifyTopicForRead,
} from "../../src/core/topics/read.js";

/**
 * #511 Task 3 — narrow, provider-independent topic read snapshot and
 * freshness. The read helper depends only on db/vaultPath/budgets (never the
 * model, pipeline or Lance), returns the SAME verified read used for the
 * response, and fails closed on any missing validation dependency.
 */
describe("topic read snapshot and freshness (#511 Task 3)", () => {
  let root: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let ctx: ToolContext;
  let manager: TopicManager;
  let topic: string;
  let sourcePaths: string[];
  const markerA = "DERIVED_TOPIC_SENTINEL_A";
  const markerB = "DERIVED_TOPIC_SENTINEL_B";
  let topicText = markerA;
  let sources: string[];

  beforeEach(async () => {
    root = mkdtempSync("/tmp/cbrain-test-topic-read-");
    const vaultPath = join(root, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "brain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(root, "lance"));
    topicText = markerA;
    const bodies = [
      "原始材料0：主题D需要定期回顾行动进度。\n补充事项：深水航行需要双岗值守。",
      "原始材料1：主题D需要定期回顾行动进度。",
      "原始材料2：主题D需要定期回顾行动进度。",
    ];
    const llm = {
      name: "anonymous-topic-fixture",
      chat: async () =>
        JSON.stringify({
          overview: [{ text: topicText, kind: "observation", sourceSlug: sources[0], quote: "主题D需要定期回顾行动进度。" }],
          observations: [{ text: topicText, kind: "observation", sourceSlug: sources[1], quote: "主题D需要定期回顾行动进度。" }],
          details: [],
          open_questions: [],
        }),
    };
    ctx = buildContext({
      db,
      lance,
      embedding: new DeterministicEmbeddingProvider(),
      vaultPath,
      runtimePath: join(root, "runtime"),
      llm,
    });
    sources = [];
    for (let i = 0; i < 3; i++) {
      const page = ctx.pages.create({ title: `材料${i}`, type: "record", body: bodies[i] });
      sources.push(page.slug);
      const prepared = await ctx.pipeline.embed(bodies[i]);
      await ctx.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
    }
    sourcePaths = sources.map((s) => join(vaultPath, db.getPageFilePath(s)!));
    manager = new TopicManager({ db, lance, pages: ctx.pages, pipeline: ctx.pipeline, versions: ctx.versions, llm });
    const result = await manager.compile({ title: "主题D", sourceSlugs: sources });
    expect(result.status).toBe("created");
    topic = manager.resolveTopicSlug("主题D");
  });

  afterEach(async () => {
    ctx.jobs.stop();
    await lance.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("fresh direct compile verifies current and returns the same read it validated", () => {
    const v = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
    expect(v?.current).toBe(true);
    expect(v?.state).toBe("fresh");
    expect(v?.reasons).toEqual([]);
    const snap = readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic);
    expect(snap).not.toBeNull();
    const onDisk = readFileSync(join(ctx.vaultPath, db.getPageFilePath(topic)!), "utf-8");
    expect(snap!.raw).toBe(onDisk);
    expect(snap!.body).toBe(parseFrontmatter(onDisk).body);
    expect(snap!.sourceSlugs).toEqual(sources);
    expect(snap!.body).toContain(markerA);
    // Non-topic slugs are never topic reads.
    expect(verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, sources[0])).toBeNull();
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, sources[0])).toBeNull();
  });

  test("admission object exposes the same verdicts without model/pipeline deps", () => {
    const admission = createTopicReadAdmission({ db, vaultPath: ctx.vaultPath });
    expect(admission.isCurrentTopic(topic)).toBe(true);
    expect(admission.readCurrentTopic(topic)?.body).toContain(markerA);
    expect(admission.isCurrentTopic("records/missing")).toBe(false);
  });

  test("catalog membership preserves record endpoint, provenance and active-state rules", () => {
    const a = ctx.pages.create({ title: "实体A", type: "entity/person", body: "实体A" }).slug;
    const b = ctx.pages.create({ title: "实体B", type: "entity/person", body: "实体B" }).slug;
    const cases: Array<[string, string, string | null, string | null, boolean]> = [
      [sources[0], a, null, null, true],
      [a, sources[1], null, null, true],
      [a, b, sources[0], "trusted", true],
      [sources[0], sources[1], sources[2], null, true],
      [a, b, null, null, false],
      [a, b, a, "trusted", false],
      [sources[0], a, null, "rejected", false],
      [sources[0], a, null, "superseded", false],
      [a, b, sources[1], "candidate", true],
    ];
    for (const [i, [from, to, source, state, included]] of cases.entries()) {
      const before = computeCatalogFingerprint(db);
      const row = db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_page_slug, trust_state) VALUES (?, ?, ?, ?, ?) RETURNING id",
      ).get(from, to, `membership-${i}`, source, state) as { id: number };
      const after = computeCatalogFingerprint(db);
      expect(after !== before).toBe(included);
      // Deleting one row restores the exact attestation, including when
      // both endpoints and provenance all belong to records.
      db.rawDb.prepare("DELETE FROM links WHERE id = ?").run(row.id);
      expect(computeCatalogFingerprint(db)).toBe(before);
    }
  });

  test("disk edit of a selected source invalidates the read before any maintenance", () => {
    writeFileSync(sourcePaths[0], readFileSync(sourcePaths[0], "utf-8") + "\n用户更正：上述安排已经取消。");
    const v = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
    expect(v?.current).toBe(false);
    expect(v?.reasons).toContain(`source_hash_changed:${sources[0]}`);
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic)).toBeNull();
  });

  test("inspectFreshness keeps the Task 1 contract after delegation (fresh → stale reasons)", () => {
    expect(manager.inspectFreshness(topic)?.state).toBe("fresh");
    writeFileSync(sourcePaths[1], readFileSync(sourcePaths[1], "utf-8") + "\n用户更正：材料一的安排已经取消。");
    const report = manager.inspectFreshness(topic);
    expect(report?.state).toBe("stale");
    expect(report?.reasons).toContain(`source_hash_changed:${sources[1]}`);
    expect(report?.editedByUser).toBe(false);
  });

  test("attested catalog newcomer blocks reads until reconciliation; reattest restores", async () => {
    // A NEW direct compile auto-captures the current catalog, so every fresh
    // topic page carries a read proof from the start.
    expect(manager.readTopicManifest(topic)!.manifest!.catalog).toBe(computeCatalogFingerprint(db));
    expect(verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic)?.current).toBe(true);

    // A DB newcomer changes the record catalog: the read fails closed even
    // though every selected source is untouched.
    const page = ctx.pages.create({ title: "无关材料", type: "record", body: "无关材料：与任何主题无关的内容。" });
    const prepared = await ctx.pipeline.embed("无关材料：与任何主题无关的内容。");
    await ctx.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
    const blocked = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
    expect(blocked?.current).toBe(false);
    expect(blocked?.reasons).toContain("catalog_changed");
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic)).toBeNull();

    // Shared freshness facts stay non-stale for maintenance eligibility, and
    // Task 2 metadata reconciliation (no model) restores the read.
    expect(manager.inspectFreshness(topic)?.state).toBe("fresh");
    const reattest = manager.reattestCatalog(topic, computeCatalogFingerprint(db));
    expect(reattest?.status).toBe("reattested");
    expect(verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic)?.current).toBe(true);
  });

  test("missing catalog attestation is not a matching proof: read blocked until reattested", () => {
    // Published legacy shape: clean index proof, sources intact, catalog field absent.
    const filePath = join(ctx.vaultPath, db.getPageFilePath(topic)!);
    const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const { catalog: _catalog, ...topicWithoutCatalog } = frontmatter.topic as Record<string, unknown>;
    const raw = stringifyFrontmatter({ ...frontmatter, topic: topicWithoutCatalog }, body);
    writeFileSync(filePath, raw);
    db.updatePageHash(topic, hashContent(raw));

    const v = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
    expect(v?.current).toBe(false);
    expect(v?.reasons).toContain("catalog_missing");
    expect(v?.catalogAttested).toBe(false);
    // Source-only state stays fresh, so maintenance can reattest metadata-only.
    expect(manager.inspectFreshness(topic)?.state).toBe("fresh");
    expect(manager.reattestCatalog(topic, computeCatalogFingerprint(db))?.status).toBe("reattested");
    expect(verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic)?.current).toBe(true);
  });

  test("oversized manifest selection fails before resolving any source record", () => {
    const filePath = join(ctx.vaultPath, db.getPageFilePath(topic)!);
    const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const topicFm = frontmatter.topic as { sources: unknown[] };
    const original = topicFm.sources[0] as Record<string, unknown>;
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ ...original, slug: `records/over-budget-${i}` }));
    const raw = stringifyFrontmatter(
      { ...frontmatter, topic: { ...topicFm, sources: tooMany } },
      body,
    );
    writeFileSync(filePath, raw);
    db.updatePageHash(topic, hashContent(raw));

    let sourceLookups = 0;
    const realGetPage = db.getPage.bind(db);
    db.getPage = (slug: string) => {
      if (slug !== topic) sourceLookups++;
      return realGetPage(slug);
    };
    try {
      const v = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
      expect(v?.current).toBe(false);
      expect(v?.reasons).toContain("manifest_selection_invalid");
      expect(sourceLookups).toBe(0);
    } finally {
      db.getPage = realGetPage.bind(db);
    }
  });

  test("duplicate manifest selection is rejected before walking files", () => {
    const filePath = join(ctx.vaultPath, db.getPageFilePath(topic)!);
    const raw = readFileSync(filePath, "utf-8");
    const dup = raw.replace(`slug: ${sources[2]}`, `slug: ${sources[0]}`);
    expect(dup).not.toBe(raw);
    writeFileSync(filePath, dup);
    // Keep the committed hash consistent with the rewritten bytes so ONLY the
    // selection rule can fail this read.
    db.updatePageHash(topic, hashContent(dup));
    const v = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
    expect(v?.current).toBe(false);
    expect(v?.reasons).toContain("manifest_selection_invalid");
  });

  test("read keeps a refreshed topic with fewer than creation-minimum sources current", async () => {
    topicText = markerB;
    const result = await manager.compile({ title: "主题D", sourceSlugs: [sources[0], sources[1]] });
    expect(result.status).toBe("refreshed");
    const v = verifyTopicForRead({ db, vaultPath: ctx.vaultPath }, topic);
    expect(v?.current).toBe(true);
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic)?.body).toContain(markerB);
  });
});

/**
 * Maintenance reconciliation must keep working when reads unify catalog
 * freshness (#511): an unrelated catalog newcomer blocks reads, the next
 * refresh reattests WITHOUT the model, a relevant new tagged record joins the
 * membership WITH the model, and reads track both outcomes.
 */
describe("topic read × maintenance reconciliation (#511 Task 3)", () => {
  let root: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let ctx: ToolContext;
  let manager: TopicManager;
  let topic: string;
  let modelCalls: number;
  const marker = "DERIVED_MAINT_SENTINEL";
  const execute = { signal: new AbortController().signal, checkCancelled: () => {} };

  const record = async (name: string, tagged: boolean): Promise<string> => {
    const body = `原始记录${name}：主题D需要回顾行动进度。`;
    const page = ctx.pages.create({ title: name, type: "record", body, tags: tagged ? ["主题D"] : [] });
    const prepared = await ctx.pipeline.embed(body);
    await ctx.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
    return page.slug;
  };

  beforeEach(async () => {
    root = mkdtempSync("/tmp/cbrain-test-topic-read-maint-");
    const vaultPath = join(root, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "brain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(root, "lance"));
    modelCalls = 0;
    const llm = {
      name: "anonymous-topic-fixture",
      chat: async (messages: Array<{ content: string }>) => {
        modelCalls++;
        // Parse the actual compile prompt so claims always cite a SELECTED
        // source (guessing from DB order breaks when unrelated records sort
        // first) — same discipline as the parent's independent probe.
        const listed = [...messages[1].content.matchAll(/### SOURCE ([^\n]+)\n([^\n]+)/g)];
        const claim = (i: number) => ({
          text: marker,
          kind: "observation",
          sourceSlug: listed[i][1],
          quote: listed[i][2],
        });
        return JSON.stringify({
          overview: [claim(0)],
          observations: [claim(1)],
          details: [],
          open_questions: [],
        });
      },
    };
    ctx = buildContext({
      db,
      lance,
      embedding: new DeterministicEmbeddingProvider(),
      vaultPath,
      runtimePath: join(root, "runtime"),
      llm,
    });
    for (let i = 0; i < 3; i++) await record(`材料${i}`, true);
    manager = new TopicManager({ db, lance, pages: ctx.pages, pipeline: ctx.pipeline, versions: ctx.versions, llm });
    const maintenance = new TopicMaintenance({ db, jobs: ctx.jobs, manager, vaultPath });
    maintenance.register();
    db.setConfig("topic.enabled", "true");
    db.setConfig("topic.selection_mode", "explicit");
    const result = await manager.compile({
      title: "主题D（主题）",
      sourceSlugs: db.listPageSlugs({ type: "record" }).filter((s) => s.startsWith("records/")).sort(),
      seed: { kind: "tag", key: "tag:主题D" },
      catalogFingerprint: computeCatalogFingerprint(db),
    });
    expect(result.status).toBe("created");
    topic = manager.resolveTopicSlug("主题D（主题）");
    expect(readCurrentTopic({ db, vaultPath }, topic)?.body).toContain(marker);
  });

  afterEach(async () => {
    ctx.jobs.stop();
    await lance.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("unrelated newcomer: read blocks, refresh reattests with zero model; relevant newcomer joins", async () => {
    const maintenance = new TopicMaintenance({ db, jobs: ctx.jobs, manager, vaultPath: ctx.vaultPath });
    await record("无关材料", false);
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic)).toBeNull();

    const beforeReattest = modelCalls;
    const receipt = (await maintenance.handle({ action: "refresh" }, 0, execute)) as {
      counts: { reattested: number };
    };
    expect(receipt.counts.reattested).toBe(1);
    expect(modelCalls).toBe(beforeReattest);
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic)?.body).toContain(marker);

    const newcomer = await record("相关第四条材料", true);
    const beforeMembership = modelCalls;
    await maintenance.handle({ action: "refresh" }, 0, execute);
    const manifest = manager.readTopicManifest(topic)!.manifest!;
    expect(manifest.sources.some((s) => s.slug === newcomer)).toBe(true);
    expect(manifest.sources.length).toBe(4);
    expect(modelCalls).toBeGreaterThan(beforeMembership);
    expect(readCurrentTopic({ db, vaultPath: ctx.vaultPath }, topic)?.body).toContain(marker);
  });
});
