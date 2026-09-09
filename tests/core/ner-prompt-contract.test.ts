import { describe, it, expect } from "bun:test";
import { buildRelationPrompt } from "../../src/ontology/ner-prompt.js";
import { OntologyLoader } from "../../src/ontology/loader.js";

// #458: 真实模型在 relation prompt 缺完整 JSON 输出合同时，把关系类型放进
// "type" 字段，NerEngine.parseRelationResponse 只读 "relation"，导致关系
// 静默丢失为 0。这里锁定 prompt 对 LLM 的输出说明，与解析器合同保持对齐。
// （放在 tests/core/ 以进入 check:ci 的 bun test 范围；src/ontology/__tests__
// 不在 CI 执行范围内。）
describe("Relation prompt JSON output contract (#458)", () => {
  const loader = new OntologyLoader();

  it("documents a non-empty output example with exactly from/to/relation/context keys", () => {
    const prompt = buildRelationPrompt(loader, ["实体A", "组织C"]);
    const exampleLine = prompt.split("\n").find((l) => l.trimStart().startsWith('{"relations"'));
    expect(exampleLine).toBeDefined();
    const example = JSON.parse(exampleLine!) as { relations: Array<Record<string, unknown>> };
    expect(example.relations.length).toBeGreaterThan(0);
    expect(Object.keys(example.relations[0]).sort()).toEqual(["context", "from", "relation", "to"]);
  });

  it("forbids type as the relation field name", () => {
    const prompt = buildRelationPrompt(loader, ["实体A", "组织C"]);
    expect(prompt).toContain('do NOT use "type"');
  });

  it("pins relation values to the listed ontology relation types", () => {
    const prompt = buildRelationPrompt(loader, ["实体A", "组织C"]);
    expect(prompt).toContain("relation types listed above");
  });
});
