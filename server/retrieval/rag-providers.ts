import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import type { RerankerProvider } from "../providers/reranker-provider.js";
import { ragHash } from "./rag-tokenizer.js";
import { finiteVector } from "./rag-lexical.js";

export type RagProviders = {
  embeddingProvider: EmbeddingProvider | null;
  rerankerProvider: RerankerProvider | null;
};
let providers: () => RagProviders = () => ({
  embeddingProvider: null,
  rerankerProvider: null,
});
export function configureRagProviders(value: () => RagProviders) {
  providers = value;
}
export function configuredRagProviders() {
  return providers();
}
export const embeddingIdentity = (provider: EmbeddingProvider) =>
  ragHash(
    JSON.stringify([
      provider.profileId ?? "",
      provider.model,
      provider.dimension,
      provider.version,
    ]),
  );
const cache = new Map<string, { until: number; value: number[] }>();
const inFlight = new Map<
  string,
  { promise: Promise<number[]>; controller: AbortController; users: number }
>();
export function clearRagQueryCache() {
  cache.clear();
  for (const request of inFlight.values()) request.controller.abort();
  inFlight.clear();
}
export async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  budget: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason),
    timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("检索阶段预算已到。", "TimeoutError"),
        ),
      Math.max(1, budget),
    );
  signal?.addEventListener("abort", abort, { once: true });
  let stop = () => {};
  const ended = new Promise<never>((_resolve, reject) => {
    stop = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), ended]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
  }
}
export async function cachedQueryEmbedding(
  provider: EmbeddingProvider,
  query: string,
  budget: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const key = ragHash(JSON.stringify([embeddingIdentity(provider), query])),
    cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  let request = inFlight.get(key);
  if (!request) {
    const controller = new AbortController();
    const promise = bounded(
      async (sharedSignal) => {
        const vectors = await provider.embed([query], sharedSignal);
        sharedSignal.throwIfAborted();
        if (
          vectors.length !== 1 ||
          !finiteVector(vectors[0], provider.dimension)
        )
          throw new Error("查询向量无效或模型维度不匹配。");
        cache.set(key, { value: vectors[0], until: Date.now() + 60_000 });
        while (cache.size > 96) cache.delete(cache.keys().next().value!);
        return vectors[0];
      },
      Math.max(50, budget),
      controller.signal,
    );
    request = { promise, controller, users: 0 };
    inFlight.set(key, request);
    const current = request;
    void promise
      .finally(() => {
        if (inFlight.get(key) === current) inFlight.delete(key);
      })
      .catch(() => undefined);
  }
  request.users++;
  try {
    return await bounded(() => request!.promise, budget, signal);
  } finally {
    request.users--;
    if (!request.users && inFlight.get(key) === request)
      request.controller.abort(
        new DOMException("查询已不再需要。", "AbortError"),
      );
  }
}
