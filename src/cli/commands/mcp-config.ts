/**
 * `cbrain mcp-config` — Output MCP server configuration JSON for Agent integration.
 *
 * Generates a parseable `{ mcpServers: { cbrain: ... } }` snippet that users can
 * paste into their Agent's MCP config file. Uses the actual executable path and
 * resolved cbrain.json location — no hard-coded developer paths.
 *
 * Two transports:
 * - **stdio** (default): `{ command, args, env }` — launches a per-agent `cbrain serve`.
 *   Legit for single-user local dev (one agent, no competing writer).
 * - **`--http`** (#264): `{ url, headers }` — points the client at the shared
 *   `cbrain serve --http` `/mcp` endpoint with a pinned tool-profile header. This
 *   is the correct shape for the Hermes single-writer topology (#208): the daily
 *   Agent session gets the `agent` surface and can't reach `sync`/`dream`, so a
 *   slow maintenance call can't poison the 300s client timeout and take down
 *   recall. Timeout bounds live in docs (hermes-integration.md), not here.
 *
 * Pure helpers (`resolveExecutable`, `generateMcpConfig`, `generateMcpHttpConfig`)
 * are exported for testing.
 */
import type { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfigSafe } from "../context.js";
import type { McpConfigOutput, McpHttpConfigOutput } from "../init-types.js";
import { parseToolProfile, TOOL_PROFILE_HEADER } from "../../mcp/tool-profiles.js";
import type { ToolProfile } from "../../mcp/tool-profiles.js";

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

/** Default HTTP endpoint — matches `cbrain serve --http` default port (src/cli/commands/server.ts). */
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3399;
/** Daily-Agent surface — excludes `sync`/`dream`/`health`/`job_*` (see tool-profiles.ts). */
const DEFAULT_HTTP_PROFILE: ToolProfile = "agent";

/**
 * Build and validate the `/mcp` URL. Fails fast on anything that would yield a
 * malformed URL the MCP client silently mis-connects to (#264 review):
 * - scheme (`http://...`), slash/path (`host/path`), query/fragment, or
 *   whitespace → reject; keep bare hosts (127.0.0.1, localhost, 0.0.0.0, dns names).
 * - a stray `:` → reject (that's a port-in-host; the URL template adds its own port).
 * - port outside [1, 65535] → reject.
 */
function buildMcpHttpUrl(rawHost: string, port: number): string {
  const host = rawHost?.trim();
  if (!host) {
    throw new Error("Invalid --host: must be a non-empty host.");
  }
  if (/[/:?#]|\s/.test(host)) {
    throw new Error(
      `Invalid --host ${JSON.stringify(rawHost)}. Expected a bare host with no scheme/path/port (e.g. 127.0.0.1, localhost).`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port ${JSON.stringify(port)}. Expected an integer in [1, 65535].`);
  }
  return `http://${host}:${port}/mcp`;
}

/**
 * Generate HTTP/streamable MCP config for the single-writer topology (#264).
 *
 * The client connects to an already-running `cbrain serve --http`; it does not
 * spawn cbrain, so no `command`/`env` and no config-file validation. The pinned
 * profile header narrows the session to a tool surface that cannot reach the
 * long-running maintenance tools.
 */
export function generateMcpHttpConfig(opts: {
  host: string;
  port: number;
  profile: ToolProfile;
}): McpHttpConfigOutput {
  const url = buildMcpHttpUrl(opts.host, opts.port);
  return {
    mcpServers: {
      cbrain: {
        url,
        headers: { [TOOL_PROFILE_HEADER]: opts.profile },
      },
    },
  };
}

export function register(program: Command) {
  program
    .command("mcp-config")
    .description("Output MCP server config JSON (default stdio; --http for the shared serve /mcp topology, #264)")
    .option("--config <path>", "Path to cbrain.json (default: auto-discover; stdio only)")
    .option("--http", "Emit HTTP/streamable config for the shared `cbrain serve --http` topology (#264)")
    .option("--host <host>", `HTTP host (default: ${DEFAULT_HTTP_HOST})`, DEFAULT_HTTP_HOST)
    .option("--port <port>", `HTTP port (default: ${DEFAULT_HTTP_PORT})`, String(DEFAULT_HTTP_PORT))
    .option("--profile <profile>", `Tool profile header (default: ${DEFAULT_HTTP_PROFILE})`, DEFAULT_HTTP_PROFILE)
    .action((opts) => {
      try {
        if (opts.http) {
          // `--config` is a stdio-only flag (HTTP connects to a running serve,
          // it doesn't launch cbrain). Guard explicitly so the combination
          // doesn't get silently ignored.
          if (opts.config) {
            throw new Error("--config is stdio-only and cannot be combined with --http.");
          }
          // Profile: fail fast on garbage via the shared three-state parser.
          const parsed = parseToolProfile(opts.profile);
          if (parsed.kind !== "ok") {
            throw new Error(
              `Invalid --profile ${JSON.stringify(opts.profile)}. ` +
                `Expected an agent/maintenance/debug/full tool profile.`,
            );
          }
          const profile: ToolProfile = parsed.profile;
          // Port: strict integer string match. `Number.parseInt("3399abc")` /
          // `Number.parseInt("3.14")` would silently truncate to 3399 / 3 and
          // emit a config that looks fine but connects to the wrong port —
          // reject those before handing to the URL builder.
          const portRaw = String(opts.port).trim();
          if (!/^[0-9]+$/.test(portRaw)) {
            throw new Error(
              `Invalid --port ${JSON.stringify(opts.port)}. Expected an integer in [1, 65535].`,
            );
          }
          const port = Number(portRaw);
          // host + port-range are validated inside generateMcpHttpConfig → buildMcpHttpUrl.
          const config = generateMcpHttpConfig({ host: opts.host, port, profile });
          process.stdout.write(JSON.stringify(config, null, 2) + "\n");
          return;
        }
        const config = generateMcpConfig(opts.config);
        process.stdout.write(JSON.stringify(config, null, 2) + "\n");
      } catch (e) {
        process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
      }
    });
}
