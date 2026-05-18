import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

export const version: string = pkg.version;
