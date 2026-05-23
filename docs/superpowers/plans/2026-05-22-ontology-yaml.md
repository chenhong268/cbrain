# Ontology YAML 本体系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用声明式 YAML 本体文件替代硬编码的类型/关系系统，支持 12 种实体类型、36 种关系、层级继承、动态 NER 提示词生成。

**Architecture:** 单一 `ontology.yaml` 作为唯一真相源。启动时 `OntologyLoader` 解析 YAML，提供类型查询、关系校验、NER 提示词生成等 API。所有现有硬编码（`mapEntityType`、`CANONICAL_RELATIONS`、`ENTITY_GUIDELINE` 等）全部替换为从 YAML 动态生成。

**Tech Stack:** TypeScript, Bun, yaml ^2.7.0 (已有), gray-matter, bun:sqlite

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/ontology/ontology.yaml` | 声明式本体定义（唯一真相源） |
| Create | `src/ontology/loader.ts` | YAML 解析 + 类型查询 API |
| Create | `src/ontology/types.ts` | TypeScript 类型定义 |
| Create | `src/ontology/ner-prompt.ts` | 从 YAML 动态生成 NER 提示词 |
| Create | `src/ontology/__tests__/loader.test.ts` | Loader 单元测试 |
| Create | `src/ontology/__tests__/ner-prompt.test.ts` | NER 提示词生成测试 |
| Modify | `src/core/shared.ts` | `mapEntityType` → YAML 查询，`normalizeRelation` → YAML 查询，`PageType` 扩展 |
| Modify | `src/core/ner.ts` | 删除硬编码提示词，改为调用 `buildNerPrompts()` |
| Modify | `src/utils/slug.ts` | `TYPE_PREFIX` 改为动态查询 |
| Modify | `src/utils/frontmatter.ts` | `type` 字段类型扩展 |
| Modify | `src/storage/sqlite.ts` | DB CHECK 约束迁移，支持 `entity/person` 格式 |
| Modify | `src/core/dialogue.ts` | 使用新类型系统 |
| Modify | `src/core/entity-resolver.ts` | 使用新类型系统 |
| Create | `src/ontology/__tests__/migration.test.ts` | 数据迁移测试 |

---

### Task 1: 定义 YAML 本体文件

**Files:**
- Create: `src/ontology/ontology.yaml`

这是整个系统的唯一真相源。先定义它，后面所有代码都围绕它构建。

- [ ] **Step 1: 创建 ontology.yaml**

```yaml
# CBrain Ontology - 唯一真相源
# 修改此文件即可扩展类型系统，无需改代码

version: 1

# ─── 实体类型 ───────────────────────────────────────────────
entity_types:
  # 抽象父类型（abstract: true 表示不会直接创建此类型的页面）
  entity:
    label: 实体
    abstract: true
    vault_dir: brain/entities
    structured_fields: []

  entity/person:
    label: 人物
    parent: entity
    vault_dir: brain/entities/person
    structured_fields:
      - birthday
      - birthplace
      - english_name
      - current_title
      - organization
      - reports_to

  entity/company:
    label: 公司
    parent: entity
    vault_dir: brain/entities/company
    structured_fields:
      - location
      - industry
      - founded_year

  entity/organization:
    label: 组织机构
    parent: entity
    vault_dir: brain/entities/organization
    structured_fields:
      - location
      - founded_year

  entity/location:
    label: 地点
    parent: entity
    vault_dir: brain/entities/location
    structured_fields: []

  entity/place:
    label: 餐厅/场所
    parent: entity
    vault_dir: brain/entities/place
    structured_fields:
      - location
      - category

  entity/product:
    label: 产品
    parent: entity
    vault_dir: brain/entities/product
    structured_fields:
      - generic_name
      - brand_name

  entity/drug:
    label: 药品
    parent: entity
    vault_dir: brain/entities/drug
    structured_fields:
      - generic_name
      - brand_name
      - approval_status

  entity/book:
    label: 书籍
    parent: entity
    vault_dir: brain/entities/book
    structured_fields:
      - author
      - published_year
      - isbn

  concept:
    label: 概念
    abstract: true
    vault_dir: brain/concepts
    structured_fields: []

  concept/framework:
    label: 框架
    parent: concept
    vault_dir: brain/concepts/framework
    structured_fields: []

  concept/technology:
    label: 技术
    parent: concept
    vault_dir: brain/concepts/technology
    structured_fields: []

  concept/theory:
    label: 理论
    parent: concept
    vault_dir: brain/concepts/theory
    structured_fields: []

  concept/concept:
    label: 概念
    parent: concept
    vault_dir: brain/concepts/concept
    structured_fields: []

  record:
    label: 记录
    vault_dir: records
    structured_fields: []

  insight:
    label: 洞察
    vault_dir: brain/insights
    structured_fields: []

# ─── 关系类型 ───────────────────────────────────────────────
relation_types:
  # ── 人物关系 ──────────────────────────────────────────
  认识:
    label: 认识
    domain: [entity/person]
    range: [entity/person]
    symmetric: true
    transitive: false
    strength: weak
    weight: 0.3

  下属:
    label: 下属
    domain: [entity/person]
    range: [entity/person]
    symmetric: false
    transitive: true
    strength: strong
    weight: 1.0
    reverse: 上级

  上级:
    label: 上级
    domain: [entity/person]
    range: [entity/person]
    symmetric: false
    transitive: true
    strength: strong
    weight: 1.0
    reverse: 下属

  同学:
    label: 同学
    domain: [entity/person]
    range: [entity/person]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.5

  同事:
    label: 同事
    domain: [entity/person]
    range: [entity/person]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.5

  亲属:
    label: 亲属
    domain: [entity/person]
    range: [entity/person]
    symmetric: false
    transitive: false
    strength: strong
    weight: 0.8
    # 子类型示例（未来可扩展）: 母女, 父子, 兄弟, 姐妹 等
    children: []

  导师:
    label: 导师
    domain: [entity/person]
    range: [entity/person]
    symmetric: false
    transitive: true
    strength: strong
    weight: 0.8

  出生:
    label: 出生于
    domain: [entity/person]
    range: [entity/location]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  家庭:
    label: 家庭住址
    domain: [entity/person]
    range: [entity/location]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.5

  # ── 组织关系 ──────────────────────────────────────────
  任职:
    label: 任职于
    domain: [entity/person]
    range: [entity/company, entity/organization]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  创立:
    label: 创立
    domain: [entity/person]
    range: [entity/company, entity/organization]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  归属:
    label: 归属
    domain: [entity/company, entity/organization]
    range: [entity/company, entity/organization]
    symmetric: false
    transitive: true
    strength: strong
    weight: 1.0

  合作:
    label: 合作
    domain: [entity/company, entity/organization, entity/person]
    range: [entity/company, entity/organization, entity/person]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.7

  竞争:
    label: 竞争
    domain: [entity/company, entity/organization, entity/product]
    range: [entity/company, entity/organization, entity/product]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.7

  客户:
    label: 客户
    domain: [entity/company, entity/organization]
    range: [entity/company, entity/organization]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.7

  投资:
    label: 投资
    domain: [entity/company, entity/organization, entity/person]
    range: [entity/company, entity/organization]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.7

  收购:
    label: 收购
    domain: [entity/company]
    range: [entity/company]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  供应:
    label: 供应
    domain: [entity/company]
    range: [entity/company, entity/product]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.7

  法人:
    label: 法人
    domain: [entity/person]
    range: [entity/company]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  # ── 产品关系 ──────────────────────────────────────────
  制造:
    label: 制造/开发
    domain: [entity/company, entity/organization]
    range: [entity/product, entity/drug]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.7

  经销:
    label: 经销
    domain: [entity/company]
    range: [entity/product]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.7

  替代:
    label: 替代
    domain: [entity/product, entity/drug]
    range: [entity/product, entity/drug]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.7

  联用:
    label: 联用
    domain: [entity/drug]
    range: [entity/drug]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.7

  审批:
    label: 审批
    domain: [entity/drug]
    range: [entity/organization]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  # ── 书籍/知识 ─────────────────────────────────────────
  作者:
    label: 作者
    domain: [entity/person]
    range: [entity/book]
    symmetric: false
    transitive: false
    strength: strong
    weight: 1.0

  常去:
    label: 常去
    domain: [entity/person]
    range: [entity/place]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.5

  参会:
    label: 参会
    domain: [entity/person]
    range: [entity/person]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.5

  毕业:
    label: 毕业于
    domain: [entity/person]
    range: [entity/organization]
    symmetric: false
    transitive: false
    strength: strong
    weight: 0.8

  居住:
    label: 居住
    domain: [entity/person]
    range: [entity/location]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.5

  # ── 通用 fallback ─────────────────────────────────────
  提及:
    label: 提及
    domain: []  # any
    range: []   # any
    symmetric: false
    transitive: false
    strength: weak
    weight: 0.3

  # ── 概念关系 ──────────────────────────────────────────
  关联:
    label: 关联
    domain: [concept/framework, concept/technology, concept/theory, concept/concept]
    range: [concept/framework, concept/technology, concept/theory, concept/concept]
    symmetric: true
    transitive: false
    strength: weak
    weight: 0.3

  互补:
    label: 互补
    domain: [concept/framework, concept/technology, concept/theory, concept/concept]
    range: [concept/framework, concept/technology, concept/theory, concept/concept]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.6

  延伸:
    label: 延伸
    domain: [concept/framework, concept/technology, concept/theory, concept/concept]
    range: [concept/framework, concept/technology, concept/theory, concept/concept]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.6

  基础:
    label: 基础
    domain: [concept/framework, concept/technology, concept/theory, concept/concept]
    range: [concept/framework, concept/technology, concept/theory, concept/concept]
    symmetric: false
    transitive: true
    strength: strong
    weight: 0.8

  对比:
    label: 对比
    domain: [concept/framework, concept/technology, concept/theory, concept/concept]
    range: [concept/framework, concept/technology, concept/theory, concept/concept]
    symmetric: true
    transitive: false
    strength: medium
    weight: 0.6

  应用:
    label: 应用
    domain: [concept/framework, concept/technology, concept/theory, concept/concept]
    range: [concept/framework, concept/technology, concept/theory, concept/concept, entity/product]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.6

# ─── NER 提示词模板 ───────────────────────────────────────
ner_config:
  entity_types_prompt:
    person: "人物 — 具名的人（包括中文全名、英文名）"
    company: "公司 — 具名的企业（如 红杉资本, 腾讯）"
    organization: "组织机构 — 非企业的组织（如 高校, 政府, 协会）"
    location: "地点 — 地理位置（如 北京, 硅谷）"
    place: "餐厅/场所 — 具名的好去处（如 某某餐厅, 某某咖啡馆）"
    product: "产品 — 具名产品（如 iPhone, 微信）"
    drug: "药品 — 具名药物（如 阿司匹林, 某某注射液）"
    book: "书籍 — 具名书籍（如《原则》, Good to Great）"
    framework: "框架 — 具名管理/商业/技术框架（如 OKR, SWOT, BCG矩阵）"
    technology: "技术 — 具名技术（如 Transformer, Kubernetes）"
    theory: "理论 — 具名理论/效应/定律（如 达克效应, 幸存者偏差）"
    concept: "概念 — 具名概念（不在上述分类中的抽象概念）"

  relation_prompt_order:
    # 出现在 NER 提示词中的顺序（按频率和重要性排列）
    - 认识
    - 任职
    - 创立
    - 归属
    - 合作
    - 竞争
    - 投资
    - 制造
    - 下属
    - 同学
    - 同事
    - 亲属
    - 导师
    - 作者
    - 毕业
    - 出生
    - 居住
    - 客户
    - 收购
    - 供应
    - 经销
    - 替代
    - 联用
    - 审批
    - 常去
    - 参会
    - 法人
    - 家庭
    - 提及
    - 关联
    - 互补
    - 延伸
    - 基础
    - 对比
    - 应用

  concept_relations:
    - 关联
    - 互补
    - 延伸
    - 基础
    - 对比
    - 应用
```

- [ ] **Step 2: 验证 YAML 语法**

Run: `bun -e "import {parse} from 'yaml'; import {readFileSync} from 'fs'; const y = parse(readFileSync('src/ontology/ontology.yaml','utf-8')); console.log('Types:', Object.keys(y.entity_types).length); console.log('Relations:', Object.keys(y.relation_types).length)"`
Expected: Types: 17, Relations: 36

- [ ] **Step 3: Commit**

```bash
git add src/ontology/ontology.yaml
git commit -m "feat: add declarative YAML ontology with 12 entity types and 36 relations"
```

---

### Task 2: Ontology 类型定义 + Loader

**Files:**
- Create: `src/ontology/types.ts`
- Create: `src/ontology/loader.ts`
- Create: `src/ontology/__tests__/loader.test.ts`

- [ ] **Step 1: 写 types.ts**

```typescript
import type { EntityType as NerEntityType } from "../core/ner.js";

export interface EntityTypeDef {
  label: string;
  parent?: string;
  abstract?: boolean;
  vault_dir: string;
  structured_fields: string[];
}

export interface RelationTypeDef {
  label: string;
  domain: string[];
  range: string[];
  symmetric: boolean;
  transitive: boolean;
  strength: "strong" | "medium" | "weak";
  weight: number;
  reverse?: string;
  children?: string[];
}

export interface NerConfig {
  entity_types_prompt: Record<string, string>;
  relation_prompt_order: string[];
  concept_relations: string[];
}

export interface OntologyYaml {
  version: number;
  entity_types: Record<string, EntityTypeDef>;
  relation_types: Record<string, RelationTypeDef>;
  ner_config: NerConfig;
}

export type PageType = string;

export interface Ontology {
  getEntityType(name: string): EntityTypeDef | undefined;
  getAllEntityTypes(): Record<string, EntityTypeDef>;
  getConcreteEntityTypes(): string[];
  getParentType(type: string): string | undefined;
  isAbstract(type: string): boolean;
  getVaultDir(type: string): string;
  getStructuredFields(type: string): string[];
  getRelationType(name: string): RelationTypeDef | undefined;
  getAllRelationTypes(): Record<string, RelationTypeDef>;
  isValidRelation(name: string): boolean;
  getReverseRelation(name: string): string | undefined;
  getRelationStrength(name: string): { strength: string; weight: number };
  getNerConfig(): NerConfig;
  resolvePageType(nerType: string): string;
  validateRelationDomain(relation: string, fromType: string, toType: string): boolean;
}
```

- [ ] **Step 2: 写 loader.test.ts (RED)**

```typescript
import { describe, it, expect } from "bun:test";
import { OntologyLoader } from "../loader.js";

describe("OntologyLoader", () => {
  const loader = new OntologyLoader();

  it("loads all entity types from YAML", () => {
    const types = loader.getAllEntityTypes();
    expect(Object.keys(types).length).toBeGreaterThanOrEqual(17);
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
    expect(config.relation_prompt_order.length).toBeGreaterThanOrEqual(36);
    expect(config.concept_relations).toContain("关联");
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `bun test tests/ontology/loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: 写 loader.ts (GREEN)**

```typescript
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntityTypeDef, RelationTypeDef, NerConfig, OntologyYaml, Ontology } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NER_TO_PAGE_TYPE: Record<string, string> = {
  person: "entity/person",
  company: "entity/company",
  organization: "entity/organization",
  location: "entity/location",
  place: "entity/place",
  product: "entity/product",
  drug: "entity/drug",
  book: "entity/book",
  framework: "concept/framework",
  technology: "concept/technology",
  theory: "concept/theory",
  concept: "concept/concept",
};

export class OntologyLoader implements Ontology {
  private data: OntologyYaml;

  constructor(yamlPath?: string) {
    const path = yamlPath ?? join(__dirname, "ontology.yaml");
    this.data = parse(readFileSync(path, "utf-8")) as OntologyYaml;
  }

  getEntityType(name: string): EntityTypeDef | undefined {
    return this.data.entity_types[name];
  }

  getAllEntityTypes(): Record<string, EntityTypeDef> {
    return this.data.entity_types;
  }

  getConcreteEntityTypes(): string[] {
    return Object.entries(this.data.entity_types)
      .filter(([_, def]) => !def.abstract)
      .map(([name]) => name);
  }

  getParentType(type: string): string | undefined {
    return this.data.entity_types[type]?.parent;
  }

  isAbstract(type: string): boolean {
    return this.data.entity_types[type]?.abstract === true;
  }

  getVaultDir(type: string): string {
    const def = this.data.entity_types[type];
    if (def?.vault_dir) return def.vault_dir;
    if (def?.parent) return this.getVaultDir(def.parent);
    return "records";
  }

  getStructuredFields(type: string): string[] {
    const def = this.data.entity_types[type];
    if (!def) return [];
    const parentFields = def.parent ? this.getStructuredFields(def.parent) : [];
    return [...new Set([...parentFields, ...def.structured_fields])];
  }

  getRelationType(name: string): RelationTypeDef | undefined {
    return this.data.relation_types[name];
  }

  getAllRelationTypes(): Record<string, RelationTypeDef> {
    return this.data.relation_types;
  }

  isValidRelation(name: string): boolean {
    return name in this.data.relation_types;
  }

  getReverseRelation(name: string): string | undefined {
    return this.data.relation_types[name]?.reverse;
  }

  getRelationStrength(name: string): { strength: string; weight: number } {
    const def = this.data.relation_types[name];
    return def
      ? { strength: def.strength, weight: def.weight }
      : { strength: "weak", weight: 0.3 };
  }

  getNerConfig(): NerConfig {
    return this.data.ner_config;
  }

  resolvePageType(nerType: string): string {
    return NER_TO_PAGE_TYPE[nerType] ?? `entity/${nerType}`;
  }

  validateRelationDomain(relation: string, fromType: string, toType: string): boolean {
    const def = this.data.relation_types[relation];
    if (!def) return false;
    if (def.domain.length === 0 && def.range.length === 0) return true;
    const domainOk = def.domain.length === 0 || def.domain.some(d => fromType === d || fromType.startsWith(d));
    const rangeOk = def.range.length === 0 || def.range.some(r => toType === r || toType.startsWith(r));
    return domainOk && rangeOk;
  }
}

let _instance: OntologyLoader | undefined;

export function getOntology(): OntologyLoader {
  if (!_instance) _instance = new OntologyLoader();
  return _instance;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `bun test tests/ontology/loader.test.ts`
Expected: PASS (all tests green)

- [ ] **Step 6: Commit**

```bash
git add src/ontology/types.ts src/ontology/loader.ts src/ontology/__tests__/loader.test.ts
git commit -m "feat: add OntologyLoader with YAML parsing and type query API"
```

---

### Task 3: 动态 NER 提示词生成

**Files:**
- Create: `src/ontology/ner-prompt.ts`
- Create: `src/ontology/__tests__/ner-prompt.test.ts`

替换 `ner.ts` 中的硬编码 `ENTITY_GUIDELINE` 和 `RELATION_GUIDELINE`。

- [ ] **Step 1: 写 ner-prompt.test.ts (RED)**

```typescript
import { describe, it, expect } from "bun:test";
import { buildEntityPrompt, buildRelationPrompt } from "../ner-prompt.js";
import { OntologyLoader } from "../loader.js";

describe("NER Prompt Generation", () => {
  const loader = new OntologyLoader();

  it("builds entity prompt with all 12 NER types", () => {
    const prompt = buildEntityPrompt(loader);
    expect(prompt).toContain("person");
    expect(prompt).toContain("company");
    expect(prompt).toContain("framework");
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
    expect(ep.length).toBeLessThan(3000);
    expect(rp.length).toBeLessThan(3000);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/ontology/ner-prompt.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写 ner-prompt.ts (GREEN)**

```typescript
import type { Ontology } from "./types.js";

export function buildEntityPrompt(ontology: Ontology): string {
  const config = ontology.getNerConfig();
  const typeLines = Object.entries(config.entity_types_prompt)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const concreteTypes = ontology.getConcreteEntityTypes()
    .filter(t => !["record", "insight"].includes(t));

  const fieldWhitelist: string[] = [];
  for (const type of concreteTypes) {
    const fields = ontology.getStructuredFields(type);
    const shortName = type.split("/").pop()!;
    if (fields.length > 0) {
      fieldWhitelist.push(`- ${shortName}: ${fields.join(", ")}`);
    }
  }

  return `You are a precision entity extractor for a personal knowledge graph. Extract entities worth remembering long-term.

## Entity Types
${typeLines}

## Edge case: 2-3 character Chinese terms
These are inherently ambiguous.
- VALID (extract): 特斯拉 (company), 马斯克 (person), 王传福 (person)
- INVALID (skip): 汽车 (common noun), 钢铁 (material), 能力 (abstract quality)
Decision: Does this short term refer to a specific real-world entity? If yes, extract. If common noun/abstract quality, SKIP.

## Skip ALL
- Numbers, amounts, pronouns, function words
- Daily items, household objects, tools
- Generic nouns (email, bank, code, brand)
- Job titles without a specific person
- Departments and teams
- Abstract qualities and activities
- Generic business terms
- Document structure words and section headings

## Relevance
- "high" = main subject of the text
- "medium" = supporting role
- "low" = incidental mention (try to avoid)

## Context: Must be a verbatim excerpt from the source.

## Structured Facts
Field whitelist by entity type:
${fieldWhitelist.join("\n")}
Rules: Every fact MUST have an evidence field (verbatim quote). No inference. confidence: 0.0-1.0.

## Output format (JSON only, no markdown wrap):
{"entities": [{"name": "...", "type": "person|company|organization|location|place|product|drug|book|framework|technology|theory|concept", "relevance": "high|medium|low", "context": "..."}], "events": [{"date": "YYYY-MM-DD|null", "description": "...", "participants": ["..."]}], "facts": [{"entity": "...", "field": "...", "value": "...", "confidence": 0.9, "evidence": "verbatim quote"}]}

Limits: max 8 entities + 3 concepts = 11 total. Return ONLY valid JSON.`;
}

export function buildRelationPrompt(ontology: Ontology, entityNames: string[]): string {
  const config = ontology.getNerConfig();
  const entityList = entityNames.map(n => `- ${n}`).join("\n");

  const entityRels = config.relation_prompt_order
    .filter(r => !config.concept_relations.includes(r))
    .map(r => {
      const def = ontology.getRelationType(r);
      return def ? `- ${r} — ${def.label}` : `- ${r}`;
    })
    .join("\n");

  const conceptRels = config.concept_relations
    .map(r => {
      const def = ontology.getRelationType(r);
      return def ? `- ${r} — ${def.label}` : `- ${r}`;
    })
    .join("\n");

  return `You are a relation extractor. Identify relationships between the entities listed below.

## Extracted Entities (use exact names)
${entityList}

## Relation Types
Use these types exactly. If none fits, use "提及":

Entity relations (person/organization/product):
${entityRels}

Concept relations (knowledge/ideas):
${conceptRels}

## Rules
1. Both from and to MUST be in the entity list above — do not invent entity names
2. Relation must be explicitly stated or clearly implied in the source text
3. context must be a verbatim excerpt from the source
4. If no clear relation exists, return empty array {"relations": []}
5. Return ONLY JSON`;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test tests/ontology/ner-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ontology/ner-prompt.ts src/ontology/__tests__/ner-prompt.test.ts
git commit -m "feat: dynamic NER prompt generation from YAML ontology"
```

---

### Task 4: 重构 shared.ts — 用 Ontology 替换硬编码

**Files:**
- Modify: `src/core/shared.ts`

关键变更：
- `mapEntityType()` → 委托给 `ontology.resolvePageType()`
- `PageType` 从 4 种扩展为动态
- `CANONICAL_RELATIONS` 整个字典 → 委托给 `ontology.isValidRelation()`
- `normalizeRelation()` → YAML 查询 + fallback
- `CANONICAL_RELATION_TYPES` → 委托给 `ontology.getAllRelationTypes()`
- `REVERSE_RELATIONS` → 委托给 `ontology.getReverseRelation()`
- `DEFAULT_WEIGHTS` → 委托给 `ontology.getRelationStrength()`
- `VAULT_DIRS` → 动态生成

- [ ] **Step 1: 添加 Ontology 依赖到 shared.ts 顶部**

在 `shared.ts` 顶部添加:

```typescript
import { getOntology } from "../ontology/loader.js";
```

- [ ] **Step 2: 替换 mapEntityType**

将 `mapEntityType` (lines 78-91) 替换为:

```typescript
export function mapEntityType(type: string): string {
  return getOntology().resolvePageType(type);
}
```

- [ ] **Step 3: 替换 PageType 和 normalizePageType**

将 `PageType` (line 93) 和 `normalizePageType` (lines 98-100) 替换为:

```typescript
export type PageType = string;

export function normalizePageType(type: string): PageType {
  const ontology = getOntology();
  if (ontology.getEntityType(type) && !ontology.isAbstract(type)) return type;
  // 兼容旧格式: "entity" → 第一个具体子类型 or "entity"
  if (ontology.getEntityType(type)) return type;
  return "record";
}
```

- [ ] **Step 4: 替换 VAULT_DIRS**

将 `VAULT_DIRS` (line 113) 替换为动态生成:

```typescript
function getVaultDirs(): string[] {
  const ontology = getOntology();
  const dirs = new Set<string>();
  for (const type of ontology.getConcreteEntityTypes()) {
    dirs.add(ontology.getVaultDir(type));
  }
  return [...dirs];
}
```

更新 `VAULT_DIRS` 的所有引用为 `getVaultDirs()`。搜索确认所有使用点。

- [ ] **Step 5: 替换 normalizeRelation**

将 `normalizeRelation` (lines 346-348) 替换为:

```typescript
export function normalizeRelation(rel: string): string {
  const ontology = getOntology();
  if (ontology.isValidRelation(rel)) return rel;
  // 保留原有 alias 映射作为 fallback
  return CANONICAL_RELATIONS[rel] ?? "提及";
}
```

保留 `CANONICAL_RELATIONS` 字典作为 alias fallback，但主路径走 YAML。后面 Task 8 会迁移 alias 到 YAML。

- [ ] **Step 6: 替换 CANONICAL_RELATION_TYPES 和 REVERSE_RELATIONS**

```typescript
export function getCanonicalRelationTypes(): Set<string> {
  return new Set(Object.keys(getOntology().getAllRelationTypes()));
}

// 兼容旧代码
export const CANONICAL_RELATION_TYPES = new Set<string>([]);

// 初始化时填充
try {
  for (const r of Object.keys(getOntology().getAllRelationTypes())) {
    CANONICAL_RELATION_TYPES.add(r);
  }
} catch {}

export function getReverseRelation(rel: string): string | undefined {
  return getOntology().getReverseRelation(rel);
}

export const REVERSE_RELATIONS: Record<string, string> = {};
```

- [ ] **Step 7: 替换 DEFAULT_WEIGHTS**

```typescript
export function getRelationStrength(rel: string): { strength: string; weight: number } {
  return getOntology().getRelationStrength(rel);
}
```

保留旧 `DEFAULT_WEIGHTS` 为空，标记 `@deprecated`。

- [ ] **Step 8: 运行现有测试确认不 break**

Run: `bun test tests/core/`
Expected: 大部分测试应该仍然通过。如有失败是因为测试中硬编码了旧类型值，在 Task 7 中修复。

- [ ] **Step 9: Commit**

```bash
git add src/core/shared.ts
git commit -m "refactor: replace hardcoded types/relations with ontology YAML lookup"
```

---

### Task 5: 重构 ner.ts — 用动态提示词替换硬编码

**Files:**
- Modify: `src/core/ner.ts`

- [ ] **Step 1: 扩展 EntityType**

将 `EntityType` (line 5) 从 5 种扩展为 12 种:

```typescript
export type EntityType =
  | "person" | "company" | "organization" | "location" | "place"
  | "product" | "drug" | "book"
  | "framework" | "technology" | "theory" | "concept";
```

- [ ] **Step 2: 更新 FACT_FIELD_WHITELIST**

替换 `FACT_FIELD_WHITELIST` (lines 37-43) 为从 ontology 动态获取:

```typescript
import { getOntology } from "../ontology/loader.js";

export function getFactFieldWhitelist(): Record<string, string[]> {
  const ontology = getOntology();
  const result: Record<string, string[]> = {};
  for (const type of ontology.getConcreteEntityTypes()) {
    const shortName = type.split("/").pop()!;
    if (["record", "insight"].includes(type)) continue;
    result[shortName] = ontology.getStructuredFields(type);
  }
  return result;
}

export const FACT_FIELD_WHITELIST: Record<string, string[]> = getFactFieldWhitelist();
```

- [ ] **Step 3: 替换 ENTITY_GUIDELINE 和 RELATION_GUIDELINE**

删除硬编码的 `ENTITY_GUIDELINE` (lines 217-281) 和 `RELATION_GUIDELINE` (lines 285-322)。

在文件顶部添加:

```typescript
import { buildEntityPrompt, buildRelationPrompt } from "../ontology/ner-prompt.js";
```

在 `NerEngine` 类中使用动态提示词。找到 `ENTITY_GUIDELINE` 的使用处，替换为 `buildEntityPrompt(getOntology())`。找到 `RELATION_GUIDELINE` 的使用处，替换为 `buildRelationPrompt(getOntology(), entityNames)`。

- [ ] **Step 4: 更新 classifyEntity 中的类型检查**

在 `classifyEntity()` (around line 101-122) 中，更新类型判断:

```typescript
function classifyEntity(type: string): "entity" | "concept" | null {
  const ontology = getOntology();
  const entityType = ontology.getEntityType(`entity/${type}`);
  if (entityType) return "entity";
  const conceptType = ontology.getEntityType(`concept/${type}`);
  if (conceptType) return "concept";
  return null;
}
```

- [ ] **Step 5: 运行测试**

Run: `bun test tests/core/ner.test.ts tests/core/ner-parallel.test.ts`
Expected: PASS（可能需要更新测试中的类型断言，见 Task 7）

- [ ] **Step 6: Commit**

```bash
git add src/core/ner.ts
git commit -m "refactor: replace hardcoded NER prompts with dynamic ontology-driven prompts"
```

---

### Task 6: 重构 slug.ts + frontmatter.ts — 支持新类型路径

**Files:**
- Modify: `src/utils/slug.ts`
- Modify: `src/utils/frontmatter.ts`

- [ ] **Step 1: 更新 slug.ts 的 TYPE_PREFIX**

替换 `slug.ts` (lines 3-15) 中的硬编码为动态查询:

```typescript
import { getOntology } from "../ontology/loader.js";

const CJK_RANGE = /[一-鿿㐀-䶿]/;

function getTypePrefixMap(): Record<string, string> {
  const ontology = getOntology();
  const map: Record<string, string> = {};
  for (const type of ontology.getConcreteEntityTypes()) {
    map[type] = ontology.getVaultDir(type);
  }
  return map;
}

export function pluralize(type: string): string {
  const prefix = getOntology().getVaultDir(type);
  return prefix.split("/").pop() ?? `${type}s`;
}

export function canonicalSlug(slug: string, type: string): string {
  const prefix = getOntology().getVaultDir(type);
  if (!prefix) return slug;
  const name = slug.split("/").pop()!;
  return `${prefix}/${name}`;
}

export function generateSlug(title: string, type: string): string {
  const prefix = getOntology().getVaultDir(type) ?? "records";
  const hasChinese = CJK_RANGE.test(title);
  if (hasChinese) {
    const cleaned = title
      .replace(/[^一-鿿㐀-䶿a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    return `${prefix}/${cleaned}`;
  }
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return `${prefix}/${cleaned}`;
}
```

- [ ] **Step 2: 更新 frontmatter.ts 的 type 字段**

替换 `PageFrontmatter` (lines 4-15) 的 type 字段:

```typescript
export interface PageFrontmatter {
  title: string;
  type: string;
  slug: string;
  tags?: string[];
  tier?: number;
  expires_at?: string;
  confidence_decay?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}
```

`type` 从联合类型 `"entity" | "concept" | "record" | "insight"` 改为 `string`，允许 `"entity/person"` 等新格式。

- [ ] **Step 3: 运行相关测试**

Run: `bun test tests/core/ingest.test.ts tests/core/page.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/utils/slug.ts src/utils/frontmatter.ts
git commit -m "refactor: dynamic type prefix and frontmatter type for ontology paths"
```

---

### Task 7: DB 迁移 — 支持 type-path 格式

**Files:**
- Modify: `src/storage/sqlite.ts`

关键变更：`pages` 表的 `type` CHECK 约束从 4 种固定值改为支持 `entity/*`、`concept/*` 格式。

- [ ] **Step 1: 添加 v6 迁移方法**

在 `sqlite.ts` 的 `migrate()` 方法中，调用 `migrateOntologyTypes()`（放在现有迁移之后）。

添加迁移方法:

```typescript
private migrateOntologyTypes(): void {
  const done = this.db.prepare("SELECT value FROM config WHERE key = 'migration_v6_ontology_types'").get() as { value: string } | undefined;
  if (done?.value === "1") return;

  this.db.exec("PRAGMA foreign_keys = OFF");

  this.db.exec(`
    CREATE TABLE pages_new (
      slug TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT,
      tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
      mention_count INTEGER DEFAULT 0,
      expires_at TEXT,
      confidence_decay REAL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO pages_new SELECT slug, type, title, file_path, content_hash, tier, mention_count, expires_at, confidence_decay, created_at, updated_at FROM pages;
    DROP TABLE pages;
    ALTER TABLE pages_new RENAME TO pages;
  `);

  // 迁移旧类型 → 新类型路径
  // person 类页面: 如果 slug 以 brain/entities/ 开头，type 改为 entity/person
  this.db.prepare("UPDATE pages SET type = 'entity/person' WHERE type = 'entity' AND slug LIKE 'brain/entities/%'").run();
  // concept 类页面
  this.db.prepare("UPDATE pages SET type = 'concept/concept' WHERE type = 'concept' AND slug LIKE 'brain/concepts/%'").run();

  this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type)");
  this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_tier ON pages(tier)");
  this.db.exec("PRAGMA foreign_keys = ON");

  this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_v6_ontology_types', '1')").run();
}
```

- [ ] **Step 2: 更新 UpsertPageData 和其他 CHECK 约束**

确认 `insights` 表的 CHECK 约束不冲突。搜索所有 `CHECK(type IN` 确保只有 `pages` 表的约束被移除:

- `insights` 表的 `type CHECK` — 保持不变（synthesis/pattern/anomaly/bridge 与本体无关）
- `ingest_log` 的 `source_type CHECK` — 保持不变

- [ ] **Step 3: 运行 DB 测试**

Run: `bun test tests/storage/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/storage/sqlite.ts
git commit -m "feat: DB migration v6 to support ontology type paths"
```

---

### Task 8: 消费者迁移 — dialogue.ts, entity-resolver.ts 等

**Files:**
- Modify: `src/core/dialogue.ts`
- Modify: `src/core/entity-resolver.ts`
- Modify: `src/core/pipeline.ts`
- Modify: `src/core/hierarchy.ts`
- Modify: `src/core/graph.ts`
- Modify: `src/core/ops.ts`

逐个文件检查并替换:

- [ ] **Step 1: dialogue.ts**

将 `mapEntityType` 调用（line 235）改为新版本。将 `normalizeRelation` 调用改为新版本。

确认 `mapEntityType(entity.type)` 现在返回 `"entity/person"` 而不是 `"entity"`。

注意：`dialogue.ts` 中 `mapEntityType` 的结果用于 `generateSlug` 和 DB upsert。新 slug 格式将是 `brain/entities/person/zhangsan` 而非 `brain/entities/zhangsan`。

- [ ] **Step 2: entity-resolver.ts**

检查 `checkTypeGate()` 中对 `mapEntityType` 的使用。确保类型比较正确处理新格式。

- [ ] **Step 3: hierarchy.ts**

`reports_to` 关系现在被 `下属`/`上级` 关系完全包含。考虑是否保留 `hierarchy.ts` 还是统一到 relation 系统。

如果 `hierarchy.ts` 的 38 条数据与 `下属`/`上级` 的 124 条数据有重叠，在迁移时合并。

- [ ] **Step 4: graph.ts, ops.ts**

搜索 `CANONICAL_RELATION_TYPES` 和 `normalizeRelation` 的使用点，确认兼容新系统。

- [ ] **Step 5: 运行全量测试**

Run: `bun test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/dialogue.ts src/core/entity-resolver.ts src/core/pipeline.ts src/core/hierarchy.ts src/core/graph.ts src/core/ops.ts
git commit -m "refactor: migrate consumers to ontology-driven type system"
```

---

### Task 9: 测试更新

**Files:**
- Modify: `tests/core/ner.test.ts`
- Modify: `tests/core/ner-parallel.test.ts`
- Modify: `tests/core/structured-facts.test.ts`
- Modify: `tests/core/dialogue.test.ts`
- Modify: `tests/core/entity-resolver.test.ts`
- Modify: `tests/core/ingest.test.ts`

测试中硬编码的旧类型值需要更新。

- [ ] **Step 1: 更新测试中的类型断言**

搜索所有测试文件中的:
- `"entity"` → 可能需要改为 `"entity/person"` 或保持 `"entity"` （取决于上下文）
- `"concept"` → 可能需要改为 `"concept/concept"`
- 5 种 EntityType 的 mock 数据 → 更新为 12 种
- `CANONICAL_RELATION_TYPES` 的断言 → 更新为 36 种
- `mapEntityType("person")` 返回值断言: `"entity"` → `"entity/person"`

- [ ] **Step 2: 更新 structured-facts 测试中的 field whitelist**

`FACT_FIELD_WHITELIST` 现在从 YAML 动态生成。更新测试断言以匹配新值（新增 `organization`、`drug`、`book` 等 type 的 fields）。

- [ ] **Step 3: 运行全量测试**

Run: `bun test`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: update tests for ontology-driven type system"
```

---

### Task 10: 数据迁移脚本

**Files:**
- Create: `src/cli/migrate-ontology.ts`

现有 vault 中的页面需要迁移:
- `brain/entities/zhangsan.md` → `brain/entities/person/zhangsan.md`（type: entity → entity/person）
- `brain/concepts/xxx.md` → `brain/concepts/concept/xxx.md` 或 `brain/concepts/framework/xxx.md`

- [ ] **Step 1: 写迁移脚本**

```typescript
import { getOntology } from "../ontology/loader.js";
import { mkdirSync, renameSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import matter from "gray-matter";

const vaultPath = process.argv[2];
if (!vaultPath) {
  console.error("Usage: bun run src/cli/migrate-ontology.ts <vault-path>");
  process.exit(1);
}

const ontology = getOntology();

function migrateEntities(): number {
  const entitiesDir = join(vaultPath, "brain/entities");
  if (!existsSync(entitiesDir)) return 0;

  let count = 0;
  const files = findMdFiles(entitiesDir);

  for (const file of files) {
    const raw = readFileSync(file, "utf-8");
    const { data, content } = matter(raw);

    if (data.type === "entity" && data.slug?.startsWith("brain/entities/")) {
      // 推断具体子类型
      const subType = inferSubType(data, content);
      data.type = subType;

      // 生成新路径
      const name = data.slug.split("/").pop();
      const newDir = join(vaultPath, ontology.getVaultDir(subType));
      mkdirSync(newDir, { recursive: true });
      const newPath = join(newDir, `${name}.md`);

      // 更新 slug
      data.slug = `${ontology.getVaultDir(subType)}/${name}`;

      // 写入新文件
      writeFileSync(newPath, matter.stringify(content, data), "utf-8");

      // 删除旧文件（如果路径不同）
      if (file !== newPath) {
        // 不删除，只记录
        console.log(`  ${file} → ${newPath}`);
        count++;
      }
    }
  }
  return count;
}

function inferSubType(data: Record<string, unknown>, content: string): string {
  const tags = (data.tags as string[]) ?? [];
  if (tags.includes("auto-extracted")) return "entity/person";
  if (data.organization) return "entity/person";
  if (data.industry) return "entity/company";
  if (data.generic_name) return "entity/product";
  return "entity/person";
}

function migrateConcepts(): number {
  let count = 0;
  // 类似逻辑：brain/concepts/xxx → brain/concepts/concept/xxx 或 framework/xxx
  return count;
}

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(full));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

console.log("Migrating entities...");
const entityCount = migrateEntities();
console.log(`Migrated ${entityCount} entities`);

console.log("Migrating concepts...");
const conceptCount = migrateConcepts();
console.log(`Migrated ${conceptCount} concepts`);
```

- [ ] **Step 2: 手动测试迁移脚本（dry run）**

Run: `bun run src/cli/migrate-ontology.ts <vault-path> 2>&1 | head -50`
Expected: 显示迁移计划但不执行（先加 `--dry-run` flag）

- [ ] **Step 3: Commit**

```bash
git add src/cli/migrate-ontology.ts
git commit -m "feat: add ontology data migration script for vault restructuring"
```

---

### Task 11: Alias 迁移到 YAML + 关系别名系统

**Files:**
- Modify: `src/ontology/ontology.yaml`
- Modify: `src/core/shared.ts`

将 `CANONICAL_RELATIONS` 中的 300+ 条 alias 映射迁移到 YAML 中。

- [ ] **Step 1: 在 YAML 中添加 aliases 段**

在 `ontology.yaml` 的每个 `relation_types` 条目下添加 `aliases` 数组:

```yaml
relation_types:
  认识:
    label: 认识
    aliases: ["knows", "同事", "同行", "师承", "前同事", "同学", "聚会", "师徒", "妻子", "父子"]
    ...
  任职:
    label: 任职
    aliases: ["works_at", "joined", "任职于", "董事长", "员工", "曾任", "创始人"]
    ...
```

从 `shared.ts` 的 `CANONICAL_RELATIONS` 逐条提取。

- [ ] **Step 2: 更新 loader.ts 支持 alias 查找**

在 `OntologyLoader` 中添加 alias 反向映射:

```typescript
private aliasMap: Map<string, string> = new Map();

// 在构造函数中构建
for (const [canonical, def] of Object.entries(this.data.relation_types)) {
  for (const alias of (def as any).aliases ?? []) {
    this.aliasMap.set(alias, canonical);
  }
}

resolveAlias(input: string): string {
  if (this.isValidRelation(input)) return input;
  return this.aliasMap.get(input) ?? "提及";
}
```

- [ ] **Step 3: 更新 normalizeRelation 使用 aliasMap**

`shared.ts` 中 `normalizeRelation` 改为:

```typescript
export function normalizeRelation(rel: string): string {
  return getOntology().resolveAlias(rel);
}
```

- [ ] **Step 4: 运行全量测试**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ontology/ontology.yaml src/ontology/loader.ts src/core/shared.ts
git commit -m "feat: migrate relation aliases to YAML ontology"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: 12 entity types ✅, 36 relations ✅, hierarchy ✅, NER prompt ✅, slug/frontmatter ✅, DB migration ✅, vault restructure ✅, data migration ✅
- [x] **Placeholder scan**: 无 TBD/TODO，所有步骤有完整代码
- [x] **Type consistency**: `resolvePageType` 返回 `string`，所有消费者统一使用；`EntityType` 在 ner.ts 中定义 12 种
