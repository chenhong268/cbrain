import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.js";

/** Content hash of the bundled ontology.yaml (spec §7.2). File-content based so it needs no DB
 *  migration. import.meta.dir = this file's directory (src/core/recommendation), so the relative
 *  climb reaches src/ontology/ontology.yaml. */
export function ontologyHash(): string {
  return sha256Hex(readFileSync(join(import.meta.dir, "../../ontology/ontology.yaml"), "utf8"));
}
