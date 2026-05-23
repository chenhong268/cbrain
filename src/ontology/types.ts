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
  aliases?: string[];
}

export interface NerConfig {
  entity_types_prompt: Record<string, string>;
  relation_prompt_order: string[];
  concept_relations: string[];
}

export interface TypeAffinityGroup {
  types: string[];
  priority: string[];
}

export interface OntologyYaml {
  version: number;
  entity_types: Record<string, EntityTypeDef>;
  relation_types: Record<string, RelationTypeDef>;
  type_affinity?: TypeAffinityGroup[];
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
  resolvePageType(nerType: string): string | null;
  isDerivedPageType(type: string): boolean;
  validateRelationDomain(relation: string, fromType: string, toType: string): boolean;
  resolveAlias(input: string): string;
  getTypeAffinity(type: string): TypeAffinityGroup | undefined;
  areTypesAffine(a: string, b: string): boolean;
  resolveTypePriority(a: string, b: string): string;
}
