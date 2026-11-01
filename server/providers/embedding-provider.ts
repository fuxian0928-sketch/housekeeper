import {createHash} from 'node:crypto';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  readonly version: string;
  readonly profileId?:string;
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
  readonly profileId:string;
  constructor(private readonly options: OpenAIEmbeddingOptions) {
    this.model = options.model ?? 'BAAI/bge-m3';
    this.dimension = options.dimension ?? 1024;
    this.profileId=createHash('sha256').update(JSON.stringify([options.baseUrl.replace(/\/+$/,''),this.model,this.dimension,this.version])).digest('hex');
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
    const rows = (payload.data ?? []).toSorted((a, b) => a.index - b.index);
    const vectors = rows.map((item) => item.embedding);
    if (vectors.length !== texts.length || rows.some((row,index)=>row.index!==index) || vectors.some((vector) => !Array.isArray(vector)||vector.length !== this.dimension||vector.some(value=>!Number.isFinite(value))||!vector.some(value=>value!==0))) throw new Error(`Embedding 返回顺序、数值或维度不正确，当前模型配置为 ${this.dimension} 维。`);
    return vectors;
  }
}

