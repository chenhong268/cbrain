import { describe, it, expect } from "bun:test";
import { OntologyLoader } from "../loader.js";

describe("OntologyLoader", () => {
  const loader = new OntologyLoader();

  it("loads all entity types from YAML", () => {
    const types = loader.getAllEntityTypes();
    expect(Object.keys(types).length).toBeGreaterThanOrEqual(16);
    expect(types["entity/person"]).toBeDefined();
    expect(types["concept/framework"]).toBeDefined();
  });

  it("identifies abstract types", () => {
    expect(loader.isAbstract("entity")).toBe(true);
    expect(loader.isAbstract("concept")).toBe(true);
    expect(loader.isAbstract("entity/person")).toBe(false);
  });

  it("resolves parent types", () => {
    expect(loader.getParentType("entity/person")).toBe("entity");
    expect(loader.getParentType("concept/framework")).toBe("concept");
    expect(loader.getParentType("entity")).toBeUndefined();
  });

  it("returns only concrete entity types", () => {
    const concrete = loader.getConcreteEntityTypes();
    expect(concrete).not.toContain("entity");
    expect(concrete).not.toContain("concept");
    expect(concrete).toContain("entity/person");
    expect(concrete).toContain("concept/framework");
    expect(concrete).toContain("record");
    expect(concrete).toContain("insight");
  });

  it("resolves vault_dir with parent inheritance", () => {
    expect(loader.getVaultDir("entity/person")).toBe("brain/entities/person");
    expect(loader.getVaultDir("concept/framework")).toBe("brain/concepts/framework");
    expect(loader.getVaultDir("record")).toBe("records");
  });

  it("resolves NER type to page type", () => {
    expect(loader.resolvePageType("person")).toBe("entity/person");
    expect(loader.resolvePageType("company")).toBe("entity/company");
    expect(loader.resolvePageType("framework")).toBe("concept/framework");
    expect(loader.resolvePageType("technology")).toBe("concept/technology");
  });

  it("loads all relation types", () => {
    const rels = loader.getAllRelationTypes();
    expect(Object.keys(rels).length).toBeGreaterThanOrEqual(36);
    expect(rels["认识"]).toBeDefined();
    expect(rels["投资"]).toBeDefined();
  });

  it("validates relations", () => {
    expect(loader.isValidRelation("认识")).toBe(true);
    expect(loader.isValidRelation("投资")).toBe(true);
    expect(loader.isValidRelation("不存在的关系")).toBe(false);
  });

  it("returns reverse relations", () => {
    expect(loader.getReverseRelation("下属")).toBe("上级");
    expect(loader.getReverseRelation("上级")).toBe("下属");
    expect(loader.getReverseRelation("认识")).toBeUndefined();
  });

  it("returns relation strength and weight", () => {
    const s = loader.getRelationStrength("任职");
    expect(s.strength).toBe("strong");
    expect(s.weight).toBe(1.0);
  });

  it("returns structured fields with parent inheritance", () => {
    const fields = loader.getStructuredFields("entity/person");
    expect(fields).toContain("birthday");
    expect(fields).toContain("organization");
    // abstract entity has no fields
    expect(loader.getStructuredFields("entity")).toEqual([]);
  });

  it("validates relation domain/range", () => {
    expect(loader.validateRelationDomain("任职", "entity/person", "entity/company")).toBe(true);
    expect(loader.validateRelationDomain("认识", "entity/person", "entity/person")).toBe(true);
    // 提及 has empty domain/range = any
    expect(loader.validateRelationDomain("提及", "entity/person", "concept/framework")).toBe(true);
  });

  it("provides NER config", () => {
    const config = loader.getNerConfig();
    expect(Object.keys(config.entity_types_prompt).length).toBe(12);
    expect(config.relation_prompt_order.length).toBeGreaterThanOrEqual(35);
    expect(config.concept_relations).toContain("关联");
  });
});
