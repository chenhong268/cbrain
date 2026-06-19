import { describe, test, expect } from "bun:test";
import {
  generateSlug,
  extractSlugFromWikiLink,
} from "../../src/utils/slug.js";

describe("slug", () => {
  test("generates Chinese entity slug with brain prefix", () => {
    expect(generateSlug("实体A", "entity")).toBe("brain/entities/实体a");
  });

  test("generates English concept slug with brain prefix", () => {
    expect(generateSlug("First Principles", "concept")).toBe(
      "brain/concepts/first-principles"
    );
  });

  test("generates record slug at root level", () => {
    expect(generateSlug("Weekly Sync", "record")).toBe(
      "records/weekly-sync"
    );
  });

  test("generates record slug with records prefix", () => {
    expect(generateSlug("Meeting Notes", "record")).toBe(
      "records/meeting-notes"
    );
  });

  test("handles mixed content entity", () => {
    const slug = generateSlug("产品A v1", "entity");
    expect(slug).toMatch(/^brain\/(entities|concepts)\//);
  });

  test("extracts slug from wiki link", () => {
    expect(extractSlugFromWikiLink("[[实体A]]")).toBe("实体A");
    expect(extractSlugFromWikiLink("[[概念A]]")).toBe("概念A");
  });
});

describe("generateSlug: 中文标点与文件名一致 (#201)", () => {
  test("中文冒号替换为连字符，不静默删除", () => {
    // 占位示例：标题「主题A：记录B」
    // 旧逻辑删冒号 → records/主题a记录b（与 vault 文件名 主题a-记录b.md 不一致 → 去重失效）
    // 新逻辑冒号→- → records/主题a-记录b（slug basename = 文件名 basename）
    expect(generateSlug("主题A：记录B", "record")).toBe("records/主题a-记录b");
  });

  test("中文逗号/感叹号替换为连字符并合并", () => {
    expect(generateSlug("术语A，术语B！", "record")).toBe("records/术语a-术语b");
  });

  test("中文括号替换为连字符", () => {
    expect(generateSlug("阶段A（阶段B）总结", "record")).toBe("records/阶段a-阶段b-总结");
  });

  test("连续标点合并为单个连字符", () => {
    expect(generateSlug("词A：：词B", "record")).toBe("records/词a-词b");
  });

  test("slug 不残留任何中文标点", () => {
    for (const title of ["主题A：记录B", "术语A，术语B！", "阶段A（阶段B）总结", "问题A？答案B。"]) {
      const slug = generateSlug(title, "record");
      expect(slug).not.toMatch(/[：，。！？、；（）【】《》]/u);
    }
  });

  test("slug basename 等于 vault 文件名 basename", () => {
    // slugToFilePath(slug) 去掉 .md 必须等于 slug 末段 — 标点已统一转 -，
    // 不再有「删标点的 slug」与「转标点的文件名」分裂。
    const slug = generateSlug("主题A：记录B", "record");
    expect(slug.split("/").pop()).toBe("主题a-记录b");
  });

  test("无汉字但含中文标点也转连字符", () => {
    // (#201 重新修复) 初次修复只在 hasChinese 分支处理标点，无汉字标题
    // (如 TopicA：v1) 走英文分支，中文标点仍被删除 → 与 vault 文件名 (Topica-v1.md) 不一致。
    expect(generateSlug("TopicA：v1", "record")).toBe("records/topica-v1");
    expect(generateSlug("TermA，TermB", "record")).toBe("records/terma-termb");
  });

  test("ASCII 标点转连字符（英文标题无空格）", () => {
    expect(generateSlug("TermA:TermB", "record")).toBe("records/terma-termb");
  });

  test("纯中文标题不受影响（回归保护）", () => {
    expect(generateSlug("实体A", "entity")).toBe("brain/entities/实体a");
    expect(generateSlug("概念A", "concept")).toBe("brain/concepts/概念a");
  });

  test("验收#3: watcher 文件路径派生的 slug 与 ingest generateSlug 一致", () => {
    // 双入口根因（issue 修正后的 body）：Hermes write_file 把标题标点→- 写成文件名，
    // watcher.ts 从 relPath 派生 slug（relPath.replace(/\.md$/,"")，无标点处理）；
    // ingest 用 generateSlug。两者必须同 slug，否则 ON CONFLICT(slug) 匹配不到 → 重复记录。
    // hermesRelPath = Hermes 会写入 vault 的文件相对路径（标点→- basename）。
    const cases: Array<[string, string, string]> = [
      ["主题A：记录B", "record", "records/主题a-记录b.md"],
      ["术语A，术语B", "record", "records/术语a-术语b.md"],
      ["阶段A（阶段B）总结", "record", "records/阶段a-阶段b-总结.md"],
    ];
    for (const [title, type, hermesRelPath] of cases) {
      const watcherSlug = hermesRelPath.replace(/\.md$/, ""); // watcher.ts:254 / sync.ts:132
      const ingestSlug = generateSlug(title, type);
      expect(ingestSlug).toBe(watcherSlug);
    }
  });
});
