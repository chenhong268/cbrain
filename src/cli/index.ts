#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command()
  .name("cbrain")
  .description("Your Agent's Memory, Compounding. Agent 的记忆，复利生长。")
  .version("0.3.0");

// Register all command modules
import { register as brainCmds } from "./commands/brain.js";
import { register as contentCmds } from "./commands/content.js";
import { register as searchCmds } from "./commands/search.js";
import { register as edgeCmds } from "./commands/edges.js";
import { register as maintenanceCmds } from "./commands/maintenance.js";
import { register as serverCmds } from "./commands/server.js";
import { register as skillCmds } from "./commands/skills.js";
import { register as backupCmds } from "./commands/backup.js";

brainCmds(program);
contentCmds(program);
searchCmds(program);
edgeCmds(program);
maintenanceCmds(program);
serverCmds(program);
skillCmds(program);
backupCmds(program);

program.parse();
