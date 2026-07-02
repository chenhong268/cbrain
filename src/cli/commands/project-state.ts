import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { loadConfig, resolveRuntimePath } from "../context.js";
import {
  readProjectState,
  renderProjectStateEnvelope,
  writeProjectState,
  type ProjectState,
} from "../../core/project-state.js";

function parseMaxChars(value?: string): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function register(program: Command): void {
  program
    .command("project-state")
    .description("读取或显式更新 compact 项目状态 artifact（不写 vault/SQLite/LanceDB）。")
    .option("--json", "输出 JSON envelope")
    .option("--set <file>", "从 JSON 文件显式更新 runtime/project-state/state.json")
    .option("--max-chars <n>", "display 最大字符数", "2000")
    .action((opts: { json?: boolean; set?: string; maxChars?: string }) => {
      const config = loadConfig();
      const runtimePath = resolveRuntimePath(config);
      if (opts.set) {
        const parsed = JSON.parse(readFileSync(opts.set, "utf-8")) as ProjectState;
        writeProjectState(runtimePath, parsed);
      }

      const envelope = renderProjectStateEnvelope(readProjectState(runtimePath), {
        maxChars: parseMaxChars(opts.maxChars),
        includeRaw: opts.json === true,
      });
      console.log(opts.json ? JSON.stringify(envelope, null, 2) : envelope.display);
    });
}
