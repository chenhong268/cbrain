import { LLMTimeoutError } from "./provider.js";
import type { LLMProvider, ChatMessage, ChatOptions } from "./provider.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = "glm-4-flash";

interface ZhipuChatResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: { total_tokens: number };
}

export interface ZhipuLLMOptions {
  timeoutMs?: number;
}

export class ZhipuLLMProvider implements LLMProvider {
  readonly name = "zhipu";
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(apiKey: string, baseUrl?: string, model?: string, opts?: ZhipuLLMOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.model = model ?? DEFAULT_MODEL;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    options?.signal?.throwIfAborted();
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Zhipu LLM API error: ${response.status} ${text}`);
      }

      const json = (await response.json()) as ZhipuChatResponse;
      signal.throwIfAborted();
      return json.choices[0]?.message?.content ?? "";
    } catch (e) {
      options?.signal?.throwIfAborted();
      if (controller.signal.aborted) {
        throw new LLMTimeoutError("Zhipu", this.timeoutMs);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
