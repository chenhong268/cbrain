/**
 * Shared types for init, doctor, and mcp-config commands.
 *
 * These types define the stable contracts used by:
 * - `cbrain init --json` → InitResult
 * - `cbrain doctor --first-run --json` → FirstRunReport (readinessState + nextAction)
 * - `cbrain mcp-config` → McpConfigOutput
 */

// ── Readiness states ──

/** Finite enum for the overall readiness of a CBrain installation. */
export type ReadinessState =
  | "no_config"       // No cbrain.json found
  | "missing_creds"   // Config exists but ZHIPU_API_KEY absent
  | "missing_index"   // Creds present but no sync/index built
  | "service_active"  // A serve/watcher process is running
  | "ready";          // Fully ready — init + creds + index, no active service

// ── Structured next-action ──

/** Machine-readable action ID set — callers can switch on this. */
export type ActionId =
  | "run_init"
  | "set_credentials"
  | "sync_index"
  | "mcp_config"
  | "serve"
  | "fix_paths";

export interface NextAction {
  readonly id: ActionId;
  readonly command: string;
  readonly message: string;
}

// ── Init result (shared between --json and human output) ──

export interface InitResult {
  readonly status: "ok" | "error";
  readonly configPath: string;
  readonly created: boolean;
  readonly readinessState: ReadinessState;
  readonly nextAction: NextAction;
  readonly errorMessage?: string;
}

// ── MCP config output ──

export interface McpConfigOutput {
  readonly mcpServers: {
    readonly cbrain: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Record<string, string>;
    };
  };
}
