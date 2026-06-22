import { describe, test, expect } from "bun:test";
import { OntologyLoader, OntologyRuntimeAssetMissingError } from "../loader.js";

describe("OntologyLoader missing asset (#220)", () => {
  test("missing ontology file throws OntologyRuntimeAssetMissingError, not raw ENOENT", () => {
    expect(() => new OntologyLoader("/nonexistent/path/ontology.yaml")).toThrow(
      OntologyRuntimeAssetMissingError,
    );
  });

  test("error message does not leak absolute path", () => {
    try {
      new OntologyLoader("/nonexistent/path/ontology.yaml");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OntologyRuntimeAssetMissingError);
      const msg = (e as Error).message;
      // 不泄露绝对路径片段
      expect(msg).not.toContain("/nonexistent");
      expect(msg).not.toContain("/tmp");
      expect(msg).not.toContain("$bunfs");
      // 含修复方向关键词
      expect(msg).toMatch(/source|install|runtime/);
    }
  });

  test("does not fall back to empty ontology (must throw, not return empty)", () => {
    expect(() => new OntologyLoader("/nonexistent/path/ontology.yaml")).toThrow();
  });
});
