import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { assembleEvidencePack } from "../../src/core/retrieval/evidence-completion.js";

const TEST_DIR = "/tmp/cbrain-test-evidence-completion";
const dbPath = join(TEST_DIR, "t.sqlite");

function seedRich(slug: string, title: string, opts: { timeline: number; chunks: number; linkTo?: string; sealed?: boolean } = { timeline: 5, chunks: 4 }) {
  db.rawDb.prepare(
    "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
  ).run(slug, title, `${slug}.md`, `h-${slug}`);
  for (let i = 0; i < opts.timeline; i++) {
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, ?, ?)",
    ).run(slug, `${title}的事件${i}`, `2026-01-0${(i % 9) + 1}`, "dialogue", "trusted");
  }
  for (let i = 0; i < opts.chunks; i++) {
    db.rawDb.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)",
    ).run(slug, i, `${title}的原始片段${i}，包含当时设计的关键决策细节`);
  }
  if (opts.sealed) {
    db.rawDb.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, -1, ?, 1)",
    ).run(slug, `${title}的L1摘要`, );
  }
  if (opts.linkTo) {
    // links.to_slug has an FK → pages.slug; ensure the target exists first.
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run(opts.linkTo, opts.linkTo, `${opts.linkTo}.md`, `h-${opts.linkTo}`);
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(slug, opts.linkTo, "合作", "wikilink", "trusted", 0.9);
  }
}

let db: CBrainDB;
beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new CBrainDB(dbPath);
});
afterEach(() => {
  db.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("assembleEvidencePack (#232)", () => {
  test("collects bounded timeline/links/chunks/summaries for a rich slug", () => {
    seedRich("entity/a", "实体A", { timeline: 5, chunks: 4, linkTo: "entity/b" });
    seedRich("entity/b", "实体B", { timeline: 0, chunks: 0 });
    const pack = assembleEvidencePack(db, ["entity/a"], "实体A 上次的活动");
    // timeline capped at 3/slug
    expect(pack.timeline.length).toBe(3);
    expect(pack.timeline[0]).toHaveProperty("summary");
    expect(pack.timeline[0]).toHaveProperty("event_date");
    // links capped at 5/slug (only 1 outgoing seeded)
    expect(pack.links.length).toBeGreaterThanOrEqual(1);
    expect(pack.links[0]).toHaveProperty("from");
    expect(pack.links[0]).toHaveProperty("relation");
    // chunks capped at 3/slug (4 seeded)
    expect(pack.chunks.length).toBe(3);
    expect(pack.chunks[0]).toHaveProperty("excerpt");
    // summary carries title
    expect(pack.summaries[0].title).toBe("实体A");
  });

  test("coverage_status = sufficient when timeline + chunks/links present", () => {
    seedRich("entity/a", "实体A", { timeline: 3, chunks: 2, linkTo: "entity/b" });
    const pack = assembleEvidencePack(db, ["entity/a"], "q");
    expect(pack.coverage.coverage_status).toBe("sufficient");
    expect(pack.coverage.timeline_hits).toBeGreaterThan(0);
    expect(pack.coverage.chunk_hits).toBeGreaterThan(0);
  });

  test("coverage_status = insufficient when slug has no evidence", () => {
    seedRich("entity/empty", "空实体", { timeline: 0, chunks: 0 });
    const pack = assembleEvidencePack(db, ["entity/empty"], "q");
    expect(pack.coverage.coverage_status).toBe("insufficient");
    expect(pack.coverage.timeline_hits).toBe(0);
    expect(pack.coverage.chunk_hits).toBe(0);
    expect(pack.coverage.link_hits).toBe(0);
  });

  test("coverage_status = partial when only one source present", () => {
    seedRich("entity/tl-only", "仅时间线", { timeline: 2, chunks: 0 });
    const pack = assembleEvidencePack(db, ["entity/tl-only"], "q");
    expect(pack.coverage.coverage_status).toBe("partial");
  });

  test("sealed page surfaces raw chunks with sealed:true", () => {
    seedRich("entity/sealed", "已归档实体", { timeline: 1, chunks: 2, sealed: true });
    const pack = assembleEvidencePack(db, ["entity/sealed"], "当时为什么这么定");
    expect(pack.chunks.length).toBeGreaterThan(0);
    expect(pack.chunks.every((c) => c.sealed === true)).toBe(true);
  });

  test("excerpt is bounded (no unbounded raw chunk leaked)", () => {
    const long = "细节".repeat(500);
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', '长实体', ?, ?)").run("entity/long", "l.md", "h");
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)").run("entity/long", long);
    const pack = assembleEvidencePack(db, ["entity/long"], "q");
    expect((pack.chunks[0].excerpt as string).length).toBeLessThanOrEqual(200);
  });

  test("#232 amend: query-aware chunk selection — target term in chunk 4 is surfaced, not just the first N", () => {
    // Detail the query asks for lives BEYOND the first-3 default; first-N would miss it.
    const slug = "entity/query-aware";
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', '查询感知实体', ?, ?)").run(slug, `${slug}.md`, `h-${slug}`);
    for (let i = 0; i < 4; i++) {
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)").run(slug, i, `普通片段${i}无关内容`);
    }
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 4, ?, 0)").run(slug, "独特的目标决策细节内容");
    const pack = assembleEvidencePack(db, [slug], "独特的目标决策细节");
    expect(pack.chunks.length).toBeGreaterThan(0);
    expect(pack.chunks.some((c) => c.excerpt.includes("决策细节"))).toBe(true);
    // generic early chunks must not crowd out the matching later chunk
    expect(pack.chunks.every((c) => c.excerpt.includes("普通片段"))).toBe(false);
  });

  test("#232 amend: falls back to first-N chunks when no query term matches", () => {
    const slug = "entity/no-terms";
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', '无词实体', ?, ?)").run(slug, `${slug}.md`, `h-${slug}`);
    for (let i = 0; i < 3; i++) {
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)").run(slug, i, `普通片段${i}`);
    }
    // Query has no overlap with any chunk — fallback must still return the first N.
    const pack = assembleEvidencePack(db, [slug], "完全无关的查询词XYZ");
    expect(pack.chunks.length).toBeGreaterThan(0);
  });
});
