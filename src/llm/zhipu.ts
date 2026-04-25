import type { LLMProvider, ChatMessage } from "./provider.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = "glm-4-flash";

interface ZhipuChatResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: { total_tokens: number };
}

export class ZhipuLLMProvider implements LLMProvider {
  readonly name = "zhipu";
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.model = model ?? DEFAULT_MODEL;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zhipu LLM API error: ${response.status} ${text}`);
    }

    const json = (await response.json()) as ZhipuChatResponse;
    return json.choices[0]?.message?.content ?? "";
  }
}
