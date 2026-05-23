import { describe, it, expect } from "bun:test";
import { OntologyLoader } from "../loader.js";

describe("OntologyLoader", () => {
  const loader = new OntologyLoader();

  it("loads all entity types from YAML", () => {
    const types = loader.getAllEntityTypes();
    expect(Object.keys(types).length).toBeGreaterThanOrEqual(16);
    expect(types["entity/person"]).toBeDefined();
    expect(types["concept/model"]).toBeDefined();
  });

  it("identifies abstract types", () => {
    expect(loader.isAbstract("entity")).toBe(true);
    expect(loader.isAbstract("concept")).toBe(true);
    expect(loader.isAbstract("entity/person")).toBe(false);
  });

  it("resolves parent types", () => {
    expect(loader.getParentType("entity/person")).toBe("entity");
    expect(loader.getParentType("concept/model")).toBe("concept");
    expect(loader.getParentType("entity")).toBeUndefined();
  });

  it("returns only concrete entity types", () => {
    const concrete = loader.getConcreteEntityTypes();
    expect(concrete).not.toContain("entity");
    expect(concrete).not.toContain("concept");
    expect(concrete).toContain("entity/person");
    expect(concrete).toContain("concept/model");
    expect(concrete).toContain("record");
    expect(concrete).toContain("insight");
  });

  it("resolves vault_dir with parent inheritance", () => {
    expect(loader.getVaultDir("entity/person")).toBe("brain/entities/person");
    expect(loader.getVaultDir("concept/model")).toBe("brain/concepts/model");
    expect(loader.getVaultDir("record")).toBe("records");
  });

  it("resolves NER type to page type", () => {
    expect(loader.resolvePageType("person")).toBe("entity/person");
    expect(loader.resolvePageType("company")).toBe("entity/company");
    expect(loader.resolvePageType("model")).toBe("concept/model");
    expect(loader.resolvePageType("pharma")).toBe("concept/pharma");
    expect(loader.resolvePageType("psychology")).toBe("concept/psychology");
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
    expect(loader.validateRelationDomain("提及", "entity/person", "concept/model")).toBe(true);
  });

  it("provides NER config", () => {
    const config = loader.getNerConfig();
    expect(Object.keys(config.entity_types_prompt).length).toBe(14);
    expect(config.relation_prompt_order.length).toBeGreaterThanOrEqual(35);
    expect(config.concept_relations).toContain("关联");
  });

  describe("resolveAlias", () => {
    it("returns canonical name for valid relation", () => {
      expect(loader.resolveAlias("任职")).toBe("任职");
      expect(loader.resolveAlias("认识")).toBe("认识");
      expect(loader.resolveAlias("提及")).toBe("提及");
    });

    it("resolves English aliases", () => {
      expect(loader.resolveAlias("works_at")).toBe("任职");
      expect(loader.resolveAlias("knows")).toBe("认识");
      expect(loader.resolveAlias("founded")).toBe("创立");
      expect(loader.resolveAlias("mentions")).toBe("提及");
    });

    it("resolves Chinese aliases", () => {
      expect(loader.resolveAlias("创始人")).toBe("创立");
      expect(loader.resolveAlias("董事长")).toBe("任职");
      expect(loader.resolveAlias("子公司")).toBe("归属");
      expect(loader.resolveAlias("竞争对手")).toBe("竞争");
    });

    it("resolves concept relation aliases", () => {
      expect(loader.resolveAlias("底层逻辑")).toBe("基础");
      expect(loader.resolveAlias("展开论述")).toBe("延伸");
      expect(loader.resolveAlias("反面论证")).toBe("对比");
      expect(loader.resolveAlias("案例")).toBe("应用");
    });

    it("resolves 上级 aliases", () => {
      expect(loader.resolveAlias("领导")).toBe("上级");
      expect(loader.resolveAlias("boss")).toBe("上级");
      expect(loader.resolveAlias("直属上级")).toBe("上级");
    });

    it("splits capital aliases to 投资/收购", () => {
      expect(loader.resolveAlias("invested_in")).toBe("投资");
      expect(loader.resolveAlias("投资了")).toBe("投资");
      expect(loader.resolveAlias("acquired")).toBe("收购");
      expect(loader.resolveAlias("收购了")).toBe("收购");
    });

    it("falls back to 提及 for unknown input", () => {
      expect(loader.resolveAlias("不存在的关系")).toBe("提及");
      expect(loader.resolveAlias("xyz")).toBe("提及");
    });
  });
});
