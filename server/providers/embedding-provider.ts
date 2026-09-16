export interface EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  readonly version: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface OpenAIEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  dimension?: number;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  readonly version = 'bge-m3-v1';
  constructor(private readonly options: OpenAIEmbeddingOptions) {
    this.model = options.model ?? 'BAAI/bge-m3';
    this.dimension = options.dimension ?? 1024;
  }

  async embed(texts: string[], signal?: AbortSignal) {
    if (!texts.length) return [];
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
    });
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ index: number; embedding: number[] }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `Embedding 服务返回 ${response.status}`);
    const vectors = (payload.data ?? []).toSorted((a, b) => a.index - b.index).map((item) => item.embedding);
    if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== this.dimension)) throw new Error(`Embedding 返回维度不正确，BGE-M3 应为 ${this.dimension} 维。`);
    return vectors;
  }
}

