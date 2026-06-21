import { Command } from "commander";
import { version } from "../version.js";

import { register as brainCmds } from "./commands/brain.js";
import { register as contentCmds } from "./commands/content.js";
import { register as searchCmds } from "./commands/search.js";
import { register as edgeCmds } from "./commands/edges.js";
import { register as maintenanceCmds } from "./commands/maintenance.js";
import { register as serverCmds } from "./commands/server.js";
import { register as backupCmds } from "./commands/backup.js";
import { register as mcpConfigCmds } from "./commands/mcp-config.js";
import { register as skillPackCmds } from "./commands/skill-pack.js";
import { register as perfDiagCmds } from "./commands/perf-diagnose.js";
import { register as repairFkCmds } from "./commands/repair-fk.js";

/**
 * Assemble the Commander program WITHOUT parsing it.
 *
 * Importing this module is side-effect-free: each register() only declares
 * `.command().action()` — it never invokes the actions (which call
 * loadConfig()/DB) nor parses argv. This is what lets the docs-consistency
 * gate read the real, registered command set
 * (`buildProgram().commands.map(c => c.name())`) instead of regex-scanning
 * source files.
 *
 * The CLI entry (`src/cli/index.ts`) runs `buildProgram().parse()` to actually
 * dispatch. Splitting build from parse keeps the program usable as a pure
 * source of truth for tooling.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name("cbrain")
    .description("Your Agent's Memory, Compounding. Agent 的记忆，复利生长。")
    .version(version);

  brainCmds(program);
  contentCmds(program);
  searchCmds(program);
  edgeCmds(program);
  maintenanceCmds(program);
  serverCmds(program);
  backupCmds(program);
  mcpConfigCmds(program);
  skillPackCmds(program);
  perfDiagCmds(program);
  repairFkCmds(program);

  return program;
}
