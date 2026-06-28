import type { LLMProvider, ChatMessage } from "./provider.js";

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
}

export class DeepSeekLLMProvider implements LLMProvider {
  readonly name = "deepseek";
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(apiKey: string, baseUrl?: string, model?: string, opts?: DeepSeekLLMOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.model = model ?? DEFAULT_MODEL;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
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
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(`DeepSeek LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
