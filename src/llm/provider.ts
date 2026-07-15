export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Provider-supported reasoning mode. Omitted preserves the provider default. */
  thinking?: "enabled" | "disabled";
}

/** Stable timeout shape so higher-level workflows do not classify an aborted
 * provider request as an ordinary provider failure. */
export class LLMTimeoutError extends Error {
  readonly code = "LLM_TIMEOUT" as const;
  readonly isLLMTimeout = true;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(`${provider} LLM request timed out after ${timeoutMs}ms`);
    this.name = "LLMTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isLLMTimeoutError(error: unknown): error is LLMTimeoutError {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; isLLMTimeout?: unknown; timeoutMs?: unknown };
  return record.code === "LLM_TIMEOUT"
    && record.isLLMTimeout === true
    && typeof record.timeoutMs === "number"
    && Number.isFinite(record.timeoutMs)
    && record.timeoutMs > 0;
}

export interface LLMProvider {
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
