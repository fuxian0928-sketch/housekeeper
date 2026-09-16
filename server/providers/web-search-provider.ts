export type WebSearchTimeRange = 'day' | 'week' | 'month' | 'year';
export type WebSearchQuery = { query: string; purpose?: string; timeRange?: WebSearchTimeRange | null };
export type WebSearchResult = { title: string; url: string; content: string; score: number; publishedAt: string | null; query: string; purpose: string };

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function retryDelay(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt) + Math.floor(Math.random() * 120)));
}

export class TavilyWebSearchProvider {
  constructor(private readonly apiKey: string, private readonly endpoint = 'https://api.tavily.com/search') {}

  private async searchOnce(input: WebSearchQuery, signal?: AbortSignal) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: input.query,
        topic: 'general',
        search_depth: 'basic',
        max_results: 6,
        include_answer: false,
        include_raw_content: false,
        ...(input.timeRange ? { time_range: input.timeRange } : {})
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : typeof payload.message === 'string' ? payload.message : '';
      const error = Object.assign(new Error(detail || `Tavily 返回了 ${response.status}。`), { status: response.status });
      throw error;
    }
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results.flatMap((item): WebSearchResult[] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      if (!title || !/^https?:\/\//i.test(url)) return [];
      return [{
        title,
        url,
        content: typeof row.content === 'string' ? row.content.trim().slice(0, 2400) : '',
        score: typeof row.score === 'number' ? row.score : 0,
        publishedAt: typeof row.published_date === 'string' ? row.published_date : null,
        query: input.query,
        purpose: input.purpose ?? ''
      }];
    });
  }

  async search(input: WebSearchQuery, signal?: AbortSignal) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await this.searchOnce(input, signal); }
      catch (error) {
        lastError = error;
        const status = Number((error as { status?: number }).status ?? 0);
        if (signal?.aborted || !retryableStatuses.has(status) || attempt === 1) throw error;
        await retryDelay(attempt);
      }
    }
    throw lastError;
  }

  async searchMany(inputs: WebSearchQuery[], signal?: AbortSignal) {
    const settled = await Promise.allSettled(inputs.slice(0, 3).map((input) => this.search(input, signal)));
    const failedQueries: Array<{ query: string; message: string }> = [];
    const byUrl = new Map<string, WebSearchResult>();
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        failedQueries.push({ query: inputs[index]?.query ?? '', message: result.reason instanceof Error ? result.reason.message : '搜索失败' });
        return;
      }
      for (const item of result.value) {
        const current = byUrl.get(item.url);
        if (!current || item.score > current.score) byUrl.set(item.url, item);
      }
    });
    return { results: [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, 12), failedQueries };
  }
}

