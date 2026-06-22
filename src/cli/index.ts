#!/usr/bin/env bun
import { buildProgram } from "./program.js";
import { OntologyRuntimeAssetMissingError } from "../ontology/loader.js";

// Compiled runtime may lack the ontology asset; surface a sanitized message
// (no stack / no absolute path) for that one error class. All other errors
// keep node's default behavior (stack + exit 1).
function handleFatal(e: unknown): void {
  if (e instanceof OntologyRuntimeAssetMissingError) {
    console.error(e.message);
    process.exit(1);
  }
  if (e instanceof Error) {
    console.error(e.stack ?? e.message);
  } else {
    console.error(String(e));
  }
  process.exit(1);
}

process.on("uncaughtException", handleFatal);
process.on("unhandledRejection", handleFatal);

buildProgram().parse();
