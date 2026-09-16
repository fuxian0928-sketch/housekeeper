export interface RerankItem { index: number; score: number }
export interface RerankerProvider {
  readonly model: string;
  rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<RerankItem[]>;
}

export class HttpRerankerProvider implements RerankerProvider {
  readonly model: string;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, model = 'BAAI/bge-reranker-v2-m3') { this.model = model; }
  async rerank(query: string, documents: string[], topN: number, signal?: AbortSignal) {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/rerank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, query, documents, top_n: topN }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({})) as { results?: Array<{ index: number; relevance_score?: number; score?: number }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `重排服务返回 ${response.status}`);
    return (payload.results ?? []).map((item) => ({ index: item.index, score: item.relevance_score ?? item.score ?? 0 }));
  }
}
