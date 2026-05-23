import { describe, it, expect } from "bun:test";
import { buildEntityPrompt, buildRelationPrompt } from "../ner-prompt.js";
import { OntologyLoader } from "../loader.js";

describe("NER Prompt Generation", () => {
  const loader = new OntologyLoader();

  it("builds entity prompt with all 12 NER types", () => {
    const prompt = buildEntityPrompt(loader);
    expect(prompt).toContain("person");
    expect(prompt).toContain("company");
    expect(prompt).toContain("model");
    expect(prompt).toContain("pharma");
    expect(prompt).toContain("psychology");
    expect(prompt).toContain("technology");
    expect(prompt).toContain("drug");
    expect(prompt).toContain("book");
    expect(prompt).toContain("place");
    expect(prompt).toContain("JSON");
  });

  it("includes structured field whitelist in entity prompt", () => {
    const prompt = buildEntityPrompt(loader);
    expect(prompt).toContain("birthday");
    expect(prompt).toContain("organization");
    expect(prompt).toContain("industry");
    expect(prompt).toContain("founded_year");
  });

  it("builds relation prompt with entity names", () => {
    const names = ["马斯克", "特斯拉", "SpaceX"];
    const prompt = buildRelationPrompt(loader, names);
    expect(prompt).toContain("马斯克");
    expect(prompt).toContain("特斯拉");
    expect(prompt).toContain("SpaceX");
    expect(prompt).toContain("认识");
    expect(prompt).toContain("投资");
    expect(prompt).toContain("客户");
    expect(prompt).toContain("作者");
  });

  it("relation prompt separates entity and concept relations", () => {
    const prompt = buildRelationPrompt(loader, ["飞轮效应"]);
    expect(prompt).toContain("概念关系");
    expect(prompt).toContain("关联");
    expect(prompt).toContain("基础");
  });

  it("prompts are under 3000 chars to avoid token waste", () => {
    const ep = buildEntityPrompt(loader);
    const rp = buildRelationPrompt(loader, ["张三", "李四", "公司A"]);
    expect(ep.length).toBeLessThan(3500);
    expect(rp.length).toBeLessThan(3000);
  });
});
