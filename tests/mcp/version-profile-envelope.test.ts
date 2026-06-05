import { describe, test, expect } from "bun:test";
import {
  formatVersionsEnvelope,
  formatRevertEnvelope,
  formatGetProfileEnvelope,
  formatUpdateProfileEnvelope,
  formatRemoveProfileEnvelope,
  formatReloadProfileEnvelope,
} from "../../src/mcp/tools/format-result.js";

const BANNED_IN_DISPLAY = [
  "slug", "score", "confidence", "source_type", "weight",
  "hops", "shared_neighbors", "raw", "debug",
  "/tmp", "runtime", ".json", "reportPath",
  "entities/", "concepts/", "records/", "insights/", "brain/",
  "threshold", "latency_ms", "duration_ms",
  "SQL", "stack", "trace",
  "dbPath", "vaultPath", "runtimePath",
  "filePath", "config", ".yaml", ".yml",
];

// ─── Version Envelopes ─────────────────────────────────────

describe("formatVersionsEnvelope", () => {
  test("empty versions returns natural language", () => {
    const result = formatVersionsEnvelope([], "entities/test", "测试页面");

    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("暂无版本");
    expect(result.display).toContain("测试页面");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("single version shows count and latest", () => {
    const result = formatVersionsEnvelope(
      [{ version: 3, created_at: "2026-06-05T10:00:00Z" }],
      "entities/a",
      "人物A",
    );

    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(1);
    expect(result.display).toContain("1 个版本");
    expect(result.display).toContain("v3");
    expect(result.display).toContain("人物A");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("multiple versions shows range", () => {
    const result = formatVersionsEnvelope(
      [
        { version: 5, created_at: "2026-06-05T10:00:00Z" },
        { version: 4, created_at: "2026-06-04T10:00:00Z" },
        { version: 1, created_at: "2026-06-01T10:00:00Z" },
      ],
      "entities/a",
      "人物A",
    );

    expect(result.summary.count).toBe(3);
    expect(result.display).toContain("3 个版本");
    expect(result.display).toContain("v5");
    expect(result.display).toContain("v1");
  });

  test("null title shows generic label", () => {
    const result = formatVersionsEnvelope(
      [{ version: 1, created_at: "2026-06-01T10:00:00Z" }],
      "entities/unknown",
      null,
    );

    expect(result.display).toContain("该页面");
    expect(result.display).not.toContain("entities/");
  });

  test("raw preserves full structure", () => {
    const versions = [
      { version: 2, created_at: "2026-06-05T10:00:00Z" },
      { version: 1, created_at: "2026-06-01T10:00:00Z" },
    ];
    const result = formatVersionsEnvelope(versions, "entities/a", "人物A");

    expect(result.raw.slug).toBe("entities/a");
    expect(result.raw.title).toBe("人物A");
    expect(result.raw.versions).toHaveLength(2);
    expect(result.raw.versions[0].version).toBe(2);
  });
});

describe("formatRevertEnvelope", () => {
  test("success shows clear message", () => {
    const result = formatRevertEnvelope(true, "entities/a", 3, "人物A");

    expect(result.summary.status).toBe("ok");
    expect(result.display).toContain("回滚");
    expect(result.display).toContain("版本 3");
    expect(result.display).toContain("人物A");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("failure shows error message", () => {
    const result = formatRevertEnvelope(false, "entities/a", 999, "人物A");

    expect(result.summary.status).toBe("error");
    expect(result.display).toContain("失败");
    expect(result.display).toContain("999");
  });

  test("null title uses generic label", () => {
    const result = formatRevertEnvelope(true, "entities/x", 1, null);

    expect(result.display).toContain("该页面");
    expect(result.display).not.toContain("entities/");
  });

  test("raw preserves slug, version, success", () => {
    const result = formatRevertEnvelope(true, "entities/a", 2, "人物A");

    expect(result.raw.slug).toBe("entities/a");
    expect(result.raw.version).toBe(2);
    expect(result.raw.success).toBe(true);
  });
});

// ─── Profile Envelopes ─────────────────────────────────────

const STATS = {
  total: 10,
  byScope: { open: 6, scoped: 3, private: 1 },
  byType: { preference: 5, constraint: 3, context: 2 },
  modules: 2,
};

const MODULES = [
  { name: "communication", enabled: true, count: 4 },
  { name: "work", enabled: true, count: 3 },
  { name: "disabled-mod", enabled: false, count: 0 },
];

describe("formatGetProfileEnvelope", () => {
  test("empty entries shows natural language", () => {
    const result = formatGetProfileEnvelope([], STATS, MODULES);

    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("暂无匹配");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("entries show count and type breakdown", () => {
    const entries = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "喜欢简洁的代码风格", updated_at: "2026-06-01" },
      { id: "p2", type: "constraint", category: "work", scope: "open", content: "不使用 var 关键字", updated_at: "2026-06-01" },
    ];
    const result = formatGetProfileEnvelope(entries, STATS, MODULES);

    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(2);
    expect(result.display).toContain("2 条偏好");
    expect(result.display).toContain("偏好");
    expect(result.display).toContain("约束");
  });

  test("truncates at 3 entries", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      type: "preference" as const,
      category: "general" as const,
      scope: "open" as const,
      content: `偏好内容 ${i}`,
      updated_at: "2026-06-01",
    }));
    const result = formatGetProfileEnvelope(entries, STATS, MODULES);

    expect(result.summary.truncated).toBe(true);
    expect(result.display).toContain("还有 2 条");
  });

  test("content preview truncated at 40 chars", () => {
    const longContent = "这是一个非常长的偏好内容描述，已经大大超过了四十个字符的限制，因此应该被截断显示才对，后面还有更多内容";
    const entries = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: longContent, updated_at: "2026-06-01" },
    ];
    const result = formatGetProfileEnvelope(entries, STATS, MODULES);

    expect(result.display).toContain("...");
    // Should not contain the full long content
    expect(result.display).not.toContain(longContent);
  });

  test("raw preserves entries and meta", () => {
    const entries = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "test", updated_at: "2026-06-01" },
    ];
    const result = formatGetProfileEnvelope(entries, STATS, MODULES);

    expect(result.raw.entries).toHaveLength(1);
    expect((result.raw.meta as Record<string, unknown>).total).toBe(10);
    expect((result.raw.meta as Record<string, unknown>).filtered).toBe(1);
  });

  test("filter params passed through to meta", () => {
    const entries = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "test", updated_at: "2026-06-01" },
    ];
    const result = formatGetProfileEnvelope(entries, STATS, MODULES, { scope: "open" });

    expect((result.raw.meta as Record<string, unknown>).scope).toBe("open");
  });
});

describe("formatUpdateProfileEnvelope", () => {
  test("shows update count", () => {
    const updated = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "test", updated_at: "2026-06-01" },
      { id: "p2", type: "constraint", category: "work", scope: "open", content: "test", updated_at: "2026-06-01" },
    ];
    const result = formatUpdateProfileEnvelope(updated);

    expect(result.summary.status).toBe("ok");
    expect(result.display).toContain("2 条偏好");
    expect(result.display).toContain("更新");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("raw preserves updated ids", () => {
    const updated = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "test", updated_at: "2026-06-01" },
    ];
    const result = formatUpdateProfileEnvelope(updated);

    expect(result.raw.updated).toEqual(["p1"]);
    expect(result.raw.count).toBe(1);
  });
});

describe("formatRemoveProfileEnvelope", () => {
  test("removed entries shows count", () => {
    const result = formatRemoveProfileEnvelope(["p1", "p2"]);

    expect(result.summary.status).toBe("ok");
    expect(result.display).toContain("2 条偏好");
    expect(result.display).toContain("删除");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("no removed entries shows empty message", () => {
    const result = formatRemoveProfileEnvelope([]);

    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("未找到");
  });

  test("raw preserves removed ids", () => {
    const result = formatRemoveProfileEnvelope(["p1"]);

    expect(result.raw.removed).toEqual(["p1"]);
    expect(result.raw.count).toBe(1);
  });
});

describe("formatReloadProfileEnvelope", () => {
  test("shows reloaded stats", () => {
    const result = formatReloadProfileEnvelope(STATS, MODULES);

    expect(result.summary.status).toBe("ok");
    expect(result.display).toContain("重新加载");
    expect(result.display).toContain("10 条记录");
    expect(result.display).toContain("2 个模块");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("raw preserves full stats", () => {
    const result = formatReloadProfileEnvelope(STATS, MODULES);

    expect(result.raw.reloaded).toBe(true);
    expect(result.raw.total_entries).toBe(10);
    const mods = result.raw.modules as { name: string; enabled: boolean; entries: number }[];
    expect(mods).toHaveLength(3);
    expect(mods[0].name).toBe("communication");
  });

  test("no enabled modules omits module line", () => {
    const noMods: { name: string; enabled: boolean; count: number }[] = [];
    const result = formatReloadProfileEnvelope(
      { total: 0, byScope: {}, byType: {}, modules: 0 },
      noMods,
    );

    expect(result.display).not.toContain("模块：");
  });
});
