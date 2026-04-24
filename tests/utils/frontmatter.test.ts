import { describe, test, expect } from "bun:test";
import {
  parseFrontmatter,
  stringifyFrontmatter,
} from "../../src/utils/frontmatter.js";

describe("frontmatter", () => {
  test("parses YAML frontmatter and body", () => {
    const content = `---
title: 测试页面
type: entity
slug: entities/test
tags:
  - 人物
  - 公司
---
# 测试页面

这是正文内容。`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.title).toBe("测试页面");
    expect(frontmatter.type).toBe("entity");
    expect(frontmatter.tags).toEqual(["人物", "公司"]);
    expect(body.trim()).toContain("这是正文内容");
  });

  test("stringifies frontmatter and body back to markdown", () => {
    const result = stringifyFrontmatter(
      { title: "测试", type: "concept", slug: "concepts/test" },
      "正文"
    );
    expect(result).toContain("title: 测试");
    expect(result).toContain("type: concept");
    expect(result).toContain("正文");
  });
});
