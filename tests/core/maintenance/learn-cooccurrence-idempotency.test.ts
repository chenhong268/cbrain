import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { LearnManager } from "../../../src/core/maintenance/learn.js";

// #437 — Dream 共现学习幂等性：同一历史 query log 证据不得随运行次数重复累加
// 关系权重。期望值全部由手工字面量推导（boost = 0.1 × 跨 session 合计共现次数），
// 不复用被测实现的计算结果。

const testDir = "/tmp/cbrain-test-learn-cooccurrence-idempotency";
const dbPath = join(testDir, "test.sqlite");
const WATERMARK_KEY = "learn.cooccurrence_watermark_id";

function seedPage(db: CBrainDB, slug: string): void {
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count, hotness_score, created_at, updated_at) VALUES (?, 'entity/person', ?, ?, null, 1, 0, 0, datetime('now'), datetime('now'))",
    )
    .run(slug, slug, `${slug}.md`);
}

function seedLink(db: CBrainDB, from: string, to: string): void {
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'mentions')")
    .run(from, to); // weight 默认 1.0
}

function seedQueryLog(db: CBrainDB, sessionId: string, resultSlugs: string[]): void {
  db.rawDb
    .prepare(
      "INSERT INTO query_log (tool, query, result_slugs, result_count, session_id) VALUES ('recall', 'q', ?, ?, ?)",
    )
    .run(JSON.stringify(resultSlugs), resultSlugs.length, sessionId);
}

function linkWeight(db: CBrainDB, from: string, to: string): number {
  const row = db.rawDb
    .prepare("SELECT weight FROM links WHERE from_slug = ? AND to_slug = ?")
    .get(from, to) as { weight: number };
  return row.weight;
}

function linkCount(db: CBrainDB): number {
  return (db.rawDb.prepare("SELECT COUNT(*) AS count FROM links").get() as { count: number }).count;
}

function activityWeight(db: CBrainDB, slug: string): number {
  return (db.rawDb.prepare("SELECT activity_weight FROM pages WHERE slug = ?").get(slug) as { activity_weight: number }).activity_weight;
}

let db: CBrainDB;

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new CBrainDB(dbPath);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("LearnManager 共现累加幂等性 (#437)", () => {
  it("treats every cbrain_recall route as recall value while retaining legacy and unknown weights", () => {
    for (const slug of ["entity-frontdoor", "entity-legacy", "entity-query", "entity-unknown"]) seedPage(db, slug);
    const insert = db.rawDb.prepare(
      "INSERT INTO query_log (tool, query, result_slugs, result_count) VALUES (?, ?, ?, 1)",
    );
    insert.run("cbrain_recall.content_recall", "匿名前门", JSON.stringify(["entity-frontdoor"]));
    insert.run("recall", "匿名旧 recall", JSON.stringify(["entity-legacy"]));
    insert.run("query", "匿名旧 query", JSON.stringify(["entity-query"]));
    insert.run("unrecognized_tool", "匿名未知工具", JSON.stringify(["entity-unknown"]));
    db.setConfig(WATERMARK_KEY, "0");

    new LearnManager(db).recomputeAll();

    const frontdoor = activityWeight(db, "entity-frontdoor");
    expect(frontdoor).toBeGreaterThan(0);
    expect(frontdoor).toBeCloseTo(activityWeight(db, "entity-legacy"), 10);
    expect(frontdoor).toBeCloseTo(activityWeight(db, "entity-query"), 10);
    expect(activityWeight(db, "entity-unknown")).toBeCloseTo(frontdoor * 0.5, 10);
  });

  it("跨 session 历史日志：首跑计入一次，无新日志重复运行权重不变", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    seedQueryLog(db, "session-2", ["entity-a", "entity-b"]);
    // 显式水位 0 = 从零学习合同；缺失水位的 fail-closed 行为见下方边界用例
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    // 手工推导：session-1 计 1 次共现 + session-2 计 1 次 = 合计 2 → 1.0 + 0.1×2
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.2, 10);

    // 无新日志：再跑两次都不变（旧行为会 1.4、1.6 膨胀）
    learn.recomputeAll();
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.2, 10);
    expect(db.getConfig(WATERMARK_KEY)).not.toBeNull();
  });

  it("同 session 历史日志：session 内两条日志按出现次数计入一次，重跑不变", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    // 手工推导：同一 session 内 A 出现 2 次 × B 出现 2 次 = 4 次共现 → 1.0 + 0.1×4
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.4, 10);

    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.4, 10);
  });

  it("新增一条合格日志后只增加一次，重试同一批次不再增加", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);

    // 新增一条新 session 的合格日志：只按新增证据 +0.1（旧行为重算全量 → +0.2）
    seedQueryLog(db, "session-2", ["entity-a", "entity-b"]);
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.2, 10);

    // 同一批次重跑：不变
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.2, 10);
  });

  it("只 boost 已存在的 link，共现不创建新 link", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedPage(db, "entity-c"); // 无 link
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b", "entity-c"]);
    db.setConfig(WATERMARK_KEY, "0");

    new LearnManager(db).recomputeAll();

    // (a,b) +0.1；(a,c)(b,c) 无 link → 不创建
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
    expect(linkCount(db)).toBe(1);
  });

  it("权重写入失败：整体回滚，不出现水位前移但权重未更新", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    const original = db.boostLinkWeight.bind(db);
    db.boostLinkWeight = () => {
      throw new Error("simulated boost failure");
    };
    expect(() => learn.recomputeAll()).toThrow();
    db.boostLinkWeight = original;


    // 权重未变，水位未前移
    expect(db.getConfig(WATERMARK_KEY)).toBe("0");

    // 重试成功：恰好计入一次
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
    expect(db.getConfig(WATERMARK_KEY)).not.toBeNull();
  });

  it("水位写入失败：已 boost 的权重一并回滚，重试不二次累加", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    const originalSet = db.setConfig.bind(db);
    db.setConfig = (key: string, value: string) => {
      if (key === WATERMARK_KEY) throw new Error("simulated watermark failure");
      return originalSet(key, value);
    };
    expect(() => learn.recomputeAll()).toThrow();
    db.setConfig = originalSet;

    // 权重与水位同回滚：不得出现权重已更新但水位未前移
    expect(db.getConfig(WATERMARK_KEY)).toBe("0");

    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
  });
});

describe("LearnManager 增量共现边界 (#437)", () => {
  it("缺失水位：fail-closed bootstrap，不重放已学习的存量窗口", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    // 模拟生产库：存量窗口已被旧 Dream 累加过（weight ≠ 默认 1.0）
    db.rawDb.prepare("UPDATE links SET weight = 1.1").run();

    new LearnManager(db).recomputeAll();

    // 部署后第一次运行不得把同一 backlog 再累加一次
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
    // 水位同事务前移到当前 max id，之后新增日志才计入
    expect(db.getConfig(WATERMARK_KEY)).toBe("1");
  });

  it("bootstrap 后新增日志正常计入增量", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);

    const learn = new LearnManager(db);
    learn.recomputeAll(); // bootstrap：本轮不 boost，水位 → max
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.0, 10);

    seedQueryLog(db, "session-2", ["entity-a", "entity-b"]);
    learn.recomputeAll(); // 新 session 全新证据 → +0.1
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
  });

  it("同 session 新旧日志交叉共现计入：新查询延伸已处理 session", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    learn.recomputeAll(); // 单实体无 pair → 1.0
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.0, 10);

    seedQueryLog(db, "session-1", ["entity-b"]);
    learn.recomputeAll();

    // session 池现为 {A(旧), B(新)}：本轮新增 A×B 共现 1 次 → +0.1
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
  });

  it("历史同 session 对因新出现增长：全量次数 1→2 只计增量 1", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    learn.recomputeAll(); // 全量 A×B = 1 → 1.1
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);

    seedQueryLog(db, "session-1", ["entity-a"]);
    learn.recomputeAll();

    // session 池 {A(旧), B(旧), A(新)}：A×B 全量从 1 → 2，增量 = 1 → +0.1
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.2, 10);
    learn.recomputeAll();
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.2, 10);
  });

  it("旧时间但高 id 的日志行不算本轮新证据", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    seedQueryLog(db, "session-1", ["entity-a"]);
    db.setConfig(WATERMARK_KEY, "0");

    const learn = new LearnManager(db);
    learn.recomputeAll(); // 水位 → 1

    seedQueryLog(db, "session-1", ["entity-b"]); // id = 2
    db.rawDb
      .prepare("UPDATE query_log SET created_at = datetime('now', '-100 days') WHERE id = 2")
      .run();
    learn.recomputeAll();

    // id 高于水位但 created_at 早于窗口：非本轮新证据，session 无合格新日志 → 不 boost
    expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.0, 10);
  });

  it("水位在权重事务内读取：交错执行不重复 boost 已提交批次", () => {
    seedPage(db, "entity-a");
    seedPage(db, "entity-b");
    seedLink(db, "entity-a", "entity-b");
    db.setConfig(WATERMARK_KEY, "0");

    const learn1 = new LearnManager(db);
    learn1.recomputeAll(); // 空日志：建立水位，不 boost
    seedQueryLog(db, "session-1", ["entity-a", "entity-b"]);

    // 第二个连接在 learn1 的权重事务开启前抢先提交同一批次
    const db2 = new CBrainDB(dbPath);
    const learn2 = new LearnManager(db2);
    const originalRun = db.runInTransaction.bind(db);
    let interleaved = false;
    db.runInTransaction = <T>(fn: () => T): T => {
      if (!interleaved) {
        interleaved = true;
        learn2.recomputeAll(); // 先提交：+0.1，水位 → max
      }
      return originalRun(fn);
    };

    try {
      learn1.recomputeAll();
      // learn1 的事务体必须读到 learn2 已前移的水位 → 不得重复 boost
      expect(linkWeight(db, "entity-a", "entity-b")).toBeCloseTo(1.1, 10);
    } finally {
      db.runInTransaction = originalRun;
      db2.close();
    }
  });
});
