import type { CBrainDB } from "../../storage/sqlite.js";
import { validateDependencyDeclarations } from "./integrity.js";
import type { DependencyDeclaration } from "./types.js";

export interface DeclaredProjection {
  [slug: string]: Record<string, unknown>;
}

/**
 * Fail-closed reader that materializes ONLY the fields a rule declared (spec §5.3, §7.1).
 * Reads through CBrainDB's public link/page getters and `pick`s down to the declared field set,
 * so undeclared fields can never leak into a frozen decision_inputs (which would make freshness
 * miss real drift or flag spurious drift). Unsupported tables / undeclared fields / duplicate
 * (slug,as) all throw — freshness then renders the record version_invalid rather than guessing.
 */
export class DeclaredProjectionReader {
  constructor(private db: CBrainDB) {}

  read(declarations: DependencyDeclaration[]): DeclaredProjection {
    validateDependencyDeclarations(declarations);
    const proj: DeclaredProjection = {};
    for (const d of declarations) {
      const key = d.slug ?? "__global__";
      if (proj[key] === undefined) proj[key] = {};
      proj[key][d.as] = this.readOne(d);
    }
    return proj;
  }

  private readOne(d: DependencyDeclaration): unknown {
    if (d.table === "links") {
      if (!d.slug) throw new Error(`projection: links needs slug (as=${d.as})`);
      if (!d.relation) throw new Error(`projection: links needs relation (as=${d.as})`);
      const all = d.filter === "all";
      const rows = (d.direction ?? "outgoing") === "outgoing" ? this.db.getOutgoingLinks(d.slug, all) : this.db.getIncomingLinks(d.slug, all);
      return rows.filter((r) => r.relation === d.relation).map((r) => pick({ from: r.from_slug, to: r.to_slug, trust_state: r.trust_state ?? "trusted" }, d.fields, `links[${d.as}]`));
    }
    if (d.table === "pages") {
      if (!d.slug) throw new Error(`projection: pages needs slug (as=${d.as})`);
      const p = this.db.getPage(d.slug) as { content_hash?: string } | null;
      return pick({ content_hash: p?.content_hash ?? "" }, d.fields, `pages[${d.as}]`);
    }
    throw new Error(`projection: unsupported table '${d.table}' (as=${d.as})`);
  }
}

function pick(obj: Record<string, unknown>, fields: string[], ctx: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f in obj)) throw new Error(`projection: field '${f}' not available in ${ctx}`);
    out[f] = obj[f];
  }
  return out;
}
