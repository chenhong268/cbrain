import { describe, test, expect } from "bun:test";
import {
  classifyContentType,
  hasSemanticContent,
  hasSufficientRecordContent,
  MIN_RECORD_CONTENT_CHARS,
} from "../../src/core/ingestion/content-classifier.js";

describe("classifyContentType", () => {
  // ── Explicit type is always respected ──

  test("explicit markdown overrides content detection", () => {
    expect(classifyContentType("plain text", "markdown")).toBe("markdown");
  });

  test("explicit text overrides frontmatter detection", () => {
    const md = "---\ntitle: Hello\n---\nbody";
    expect(classifyContentType(md, "text")).toBe("text");
  });

  // ── Auto-detect markdown from frontmatter ──

  test("content with title frontmatter → markdown", () => {
    const content = "---\ntitle: Test Page\n---\nbody text";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("content with type frontmatter → markdown", () => {
    const content = "---\ntype: record\n---\nbody";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("content with tags frontmatter → markdown", () => {
    const content = "---\ntags:\n  - test\n---\nbody";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("content with slug frontmatter → markdown", () => {
    const content = "---\nslug: records/test\n---\nbody";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("content with multiple supported fields → markdown", () => {
    const content = "---\ntitle: Test\ntype: record\ntags:\n  - a\n---\nbody";
    expect(classifyContentType(content)).toBe("markdown");
  });

  // ── Auto-detect text (no valid frontmatter) ──

  test("incomplete frontmatter (no closing ---) → text", () => {
    const content = "---\ntitle: Hello\nno closing delimiter";
    expect(classifyContentType(content)).toBe("text");
  });

  test("frontmatter with only unknown fields → text", () => {
    const content = "---\ncustom_field: value\nanother: 123\n---\nbody";
    expect(classifyContentType(content)).toBe("text");
  });

  test("plain text not starting with --- → text", () => {
    expect(classifyContentType("Just a plain text note")).toBe("text");
  });

  test("empty string → text", () => {
    expect(classifyContentType("")).toBe("text");
  });

  test("only whitespace → text", () => {
    expect(classifyContentType("   \n  \n  ")).toBe("text");
  });

  test("content starting with --- but single line → text", () => {
    expect(classifyContentType("---")).toBe("text");
  });

  test("literal --- alone on multiple lines → text", () => {
    expect(classifyContentType("---\n---\nbody")).toBe("text");
  });

  test("content with leading whitespace before --- → text", () => {
    const content = "  ---\ntitle: Test\n---\nbody";
    expect(classifyContentType(content)).toBe("text");
  });

  // ── CJK content ──

  test("CJK title frontmatter → markdown", () => {
    const content = "---\ntitle: 人物笔记\n---\n正文内容";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("CJK plain text → text", () => {
    expect(classifyContentType("这是一段纯文本笔记")).toBe("text");
  });

  // ── Edge cases: CRLF, EOF, nested fields ──

  test("CRLF line endings with title → markdown", () => {
    const content = "---\r\ntitle: CRLF Test\r\n---\r\nbody";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("closing delimiter at EOF (no trailing newline) → markdown", () => {
    const content = "---\ntitle: EOF Test\n---";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("nested field (tags with items) → markdown", () => {
    const content = "---\ntags:\n  - a\n  - b\n---\nbody";
    expect(classifyContentType(content)).toBe("markdown");
  });

  test("only unknown nested fields → text", () => {
    const content = "---\ncustom:\n  nested: value\n---\nbody";
    expect(classifyContentType(content)).toBe("text");
  });
});

describe("hasSemanticContent", () => {
  test("letters → true", () => {
    expect(hasSemanticContent("hello")).toBe(true);
  });

  test("CJK characters → true", () => {
    expect(hasSemanticContent("中文")).toBe(true);
  });

  test("digits → true", () => {
    expect(hasSemanticContent("123")).toBe(true);
  });

  test("mixed letters and digits → true", () => {
    expect(hasSemanticContent("abc123")).toBe(true);
  });

  test("pure punctuation !!!... → false", () => {
    expect(hasSemanticContent("!!! ??? --- ...")).toBe(false);
  });

  test("empty string → false", () => {
    expect(hasSemanticContent("")).toBe(false);
  });

  test("whitespace only → false", () => {
    expect(hasSemanticContent("   \n\t  ")).toBe(false);
  });

  test("mixed punctuation and letters → true", () => {
    expect(hasSemanticContent("hello!!!")).toBe(true);
  });

  test("lone --- → false", () => {
    expect(hasSemanticContent("---")).toBe(false);
  });

  test("single Chinese character → true", () => {
    expect(hasSemanticContent("好")).toBe(true);
  });
});

describe("hasSufficientRecordContent", () => {
  test("rejects URL plus a short placeholder", () => {
    expect(hasSufficientRecordContent("https://example.invalid/source\n待解析")).toBe(false);
  });

  test("ignores frontmatter and accepts enough substantive content", () => {
    const body = "有效研究内容".repeat(Math.ceil(MIN_RECORD_CONTENT_CHARS / 6));
    expect(hasSufficientRecordContent(`---\ntitle: ${"元数据".repeat(30)}\n---\n${body}`)).toBe(true);
  });

  test("does not count frontmatter-only content as a valid record", () => {
    expect(hasSufficientRecordContent(`---\ntitle: ${"元数据".repeat(30)}\ntype: record\n---\n待补充`)).toBe(false);
  });
});
