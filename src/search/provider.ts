// ─── Search Provider ─────────────────────────────────────────────
// Interface + SearXNG implementation for web search fallback
// during stub enrichment (#170).

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults?: number; // default 5
  timeoutMs?: number; // default 10_000
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

// ─── SearXNG Implementation ──────────────────────────────────────
// Self-hosted SearXNG instance with JSON API.
// Endpoint: GET ${baseUrl}/search?q=...&format=json&categories=general

export class SearXNGSearchProvider implements SearchProvider {
  readonly name = "searxng";
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = opts?.maxResults ?? 5;
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    const params = new URLSearchParams({
      q: query,
      format: "json",
      categories: "general",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/search?${params}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned ${response.status}`);
      }

      const json = (await response.json()) as {
        results?: Array<Record<string, unknown>>;
      };
      const raw = (json.results ?? []).slice(0, maxResults);

      return raw.map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: String(r.content ?? "").slice(0, 300),
      }));
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(`SearXNG search timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
