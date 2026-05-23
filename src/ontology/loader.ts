import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EntityTypeDef,
  RelationTypeDef,
  NerConfig,
  OntologyYaml,
  Ontology,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class OntologyLoader implements Ontology {
  private data: OntologyYaml;
  private aliasMap: Map<string, string>;
  private nerToPageType: Map<string, string>;

  constructor(yamlPath?: string) {
    const path = yamlPath ?? join(__dirname, "ontology.yaml");
    this.data = parse(readFileSync(path, "utf-8")) as OntologyYaml;
    this.aliasMap = new Map();
    this.nerToPageType = new Map();
    for (const type of this.getConcreteEntityTypes()) {
      if (type.includes("/")) {
        const shortName = type.split("/").pop()!;
        const existing = this.nerToPageType.get(shortName);
        if (existing && existing !== type) {
          const preferred = existing.startsWith("entity/") ? existing : type;
          console.warn(`[ontology] nerToPageType collision: "${shortName}" → "${existing}" and "${type}", using "${preferred}"`);
          this.nerToPageType.set(shortName, preferred);
        } else {
          this.nerToPageType.set(shortName, type);
        }
      }
    }
    for (const [canonical, def] of Object.entries(this.data.relation_types)) {
      for (const alias of def.aliases ?? []) {
        const existing = this.aliasMap.get(alias);
        if (existing && existing !== canonical) {
          console.warn(`[ontology] alias collision: "${alias}" → "${existing}" and "${canonical}"`);
        }
        this.aliasMap.set(alias, canonical);
      }
    }
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
    return this.nerToPageType.get(nerType) ?? "record";
  }

  isDerivedPageType(type: string): boolean {
    if (type.startsWith("insight/")) return true;
    const def = this.data.entity_types[type];
    if (!def) return false;
    return def.parent === "entity" || def.parent === "concept";
  }

  validateRelationDomain(relation: string, fromType: string, toType: string): boolean {
    const def = this.data.relation_types[relation];
    if (!def) return false;
    if (def.domain.length === 0 && def.range.length === 0) return true;
    const domainOk =
      def.domain.length === 0 ||
      def.domain.some((d) => fromType === d || fromType.startsWith(d));
    const rangeOk =
      def.range.length === 0 ||
      def.range.some((r) => toType === r || toType.startsWith(r));
    return domainOk && rangeOk;
  }

  resolveAlias(input: string): string {
    if (this.isValidRelation(input)) return input;
    const resolved = this.aliasMap.get(input);
    if (!resolved) return "提及";
    return resolved;
  }
}

let _instance: OntologyLoader | undefined;

export function getOntology(): OntologyLoader {
  if (!_instance) _instance = new OntologyLoader();
  return _instance;
}
