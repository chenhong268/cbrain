import { LLMTimeoutError } from "./provider.js";
import type { LLMProvider, ChatMessage, ChatOptions } from "./provider.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

interface DeepSeekChatResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: { total_tokens: number };
}

export interface DeepSeekLLMOptions {
  timeoutMs?: number;
  /** Enable DeepSeek's V4 thinking extension for a compatible proxy/model.
   * Defaults to true only for official api.deepseek.com V4 models. */
  supportsThinking?: boolean;
}

function isOfficialV4Endpoint(baseUrl: string, model: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.deepseek.com" && /^deepseek-v4(?:-|$)/.test(model);
  } catch {
    return false;
  }
}

export class DeepSeekLLMProvider implements LLMProvider {
  readonly name = "deepseek";
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private supportsThinking: boolean;

  constructor(apiKey: string, baseUrl?: string, model?: string, opts?: DeepSeekLLMOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.model = model ?? DEFAULT_MODEL;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this.supportsThinking = opts?.supportsThinking ?? isOfficialV4Endpoint(this.baseUrl, this.model);
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
      ...(options?.thinking && this.supportsThinking ? { thinking: { type: options.thinking } } : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`DeepSeek API error: ${response.status} ${text}`);
      }

      const json = (await response.json()) as DeepSeekChatResponse;
      return json.choices[0]?.message?.content ?? "";
    } catch (e) {
      if (controller.signal.aborted) {
        throw new LLMTimeoutError("DeepSeek", this.timeoutMs);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
