/**
 * `cbrain mcp-config` — Output MCP server configuration JSON for Agent integration.
 *
 * Generates a parseable `{ mcpServers: { cbrain: ... } }` snippet that users can
 * paste into their Agent's MCP config file. Uses the actual executable path and
 * resolved cbrain.json location — no hard-coded developer paths.
 *
 * Pure helpers (`resolveExecutable`, `generateMcpConfig`) are exported for testing.
 */
import type { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfigSafe } from "../context.js";
import type { McpConfigOutput } from "../init-types.js";

/** Minimum required string fields for a valid CBrain config used by `serve`. */
const REQUIRED_STRING_FIELDS = ["vaultPath", "dbPath", "lancePath"] as const;

/**
 * Resolve the actual executable that launched this CBrain process.
 *
 * - `bun run src/cli/index.ts` → `{ command: <bun-path>, args: ["run", <script>, "serve"] }`
 * - Global `cbrain` binary → `{ command: <cbrain-path>, args: ["serve"] }`
 */
export function resolveExecutable(): { command: string; args: string[] } {
  const execPath = process.execPath;
  const scriptArg = process.argv[1];

  // Launched via "bun run <script>" — execPath is bun, scriptArg is the .ts file
  if (scriptArg && scriptArg.endsWith("index.ts")) {
    return {
      command: execPath,
      args: ["run", scriptArg, "serve"],
    };
  }

  // Launched as a global binary (e.g. cbrain via bun install -g)
  // or via symlink — just use process.argv[0] as the command
  return {
    command: process.argv[0],
    args: ["serve"],
  };
}

/**
 * Validate that a config file path points to a readable, structurally valid CBrain config.
 *
 * @throws Error with descriptive message on validation failure.
 */
function validateConfigFile(filePath: string): void {
  const resolved = resolve(filePath);

  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Config path is not a regular file: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch {
    throw new Error(`Config file is not valid JSON: ${resolved}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file does not contain a JSON object: ${resolved}`);
  }

  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof obj[field] !== "string" || !obj[field]) {
      throw new Error(`Config file missing required field '${field}': ${resolved}`);
    }
  }

  // embedding must be an object with a non-empty string provider
  const embedding = obj.embedding;
  if (typeof embedding !== "object" || embedding === null || Array.isArray(embedding)) {
    throw new Error(`Config file missing required field 'embedding': ${resolved}`);
  }
  if (typeof (embedding as Record<string, unknown>).provider !== "string" || !(embedding as Record<string, unknown>).provider) {
    throw new Error(`Config file missing required field 'embedding.provider': ${resolved}`);
  }
}

/**
 * Generate MCP server configuration JSON.
 *
 * Uses `loadConfigSafe()` to find the active config, or accepts an explicit override.
 * Never includes credential values.
 */
export function generateMcpConfig(configPathOverride?: string): McpConfigOutput {
  let configPath: string;

  if (configPathOverride) {
    validateConfigFile(configPathOverride);
    configPath = resolve(configPathOverride);
  } else {
    const loaded = loadConfigSafe();
    if (!loaded) {
      throw new Error("No cbrain.json found. Run `cbrain init` first.");
    }
    // Auto-discovered config must also be structurally valid
    validateConfigFile(loaded.configPath);
    configPath = loaded.configPath;
  }

  const { command, args: execArgs } = resolveExecutable();

  return {
    mcpServers: {
      cbrain: {
        command,
        args: execArgs,
        env: {
          CBRAIN_CONFIG: configPath,
        },
      },
    },
  };
}

export function register(program: Command) {
  program
    .command("mcp-config")
    .description("Output MCP server configuration JSON for Agent integration")
    .option("--config <path>", "Path to cbrain.json (default: auto-discover)")
    .action((opts) => {
      try {
        const config = generateMcpConfig(opts.config);
        process.stdout.write(JSON.stringify(config, null, 2) + "\n");
      } catch (e) {
        process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
      }
    });
}
