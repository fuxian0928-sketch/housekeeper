import { createHash } from 'node:crypto';
import { StreamingMemoryPrefetch } from '../domain/memories/streaming-memory-prefetch.js';

export type PrefetchSettings = {
  voicePrefetchEnabled?: boolean; voicePrefetchAttempts?: 1 | 2;
  routingMode: 'life' | 'work' | 'auto'; projectId?: string | null; conversationId?: string | null;
};
const scope = (value: PrefetchSettings) => ({
  ownerId: 'local-service', projectIds: value.routingMode !== 'life' && value.projectId ? [value.projectId] : [],
  // Database revision is checked by the server on token consumption.
  revision: createHash('sha256').update(JSON.stringify([value.routingMode, value.conversationId || null])).digest('hex')
});

/** Only speculative read requests. No Agent invocation or tool execution. */
export function createNativeMemoryPrefetch(baseUrl: string, request: typeof fetch = fetch, debounceMs = 300) {
  const root = new URL(baseUrl);
  if (!['http:', 'https:'].includes(root.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(root.hostname) || root.username || root.password || root.search || root.hash || root.pathname !== '/') throw Error('VOICE_INVALID_LOCAL_SERVICE');
  const endpoint = new URL('/api/voice/memory-prefetch', root);
  let active: { id: string; settings: PrefetchSettings } | undefined;
  const scheduler = new StreamingMemoryPrefetch<{token: string}>({
    async retrieve(input) {
      const settings = active?.settings;
      if (!settings) throw Error('PREFETCH_RETIRED');
      const response = await request(endpoint, {
        method: 'POST', redirect: 'error', signal: input.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input.query, mode: settings.routingMode,
          projectId: settings.routingMode === 'life' ? null : settings.projectId || null,
          conversationId: settings.conversationId || null })
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('PREFETCH_UNAVAILABLE'); }
      const reader = response.body.getReader();
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read(); input.signal?.throwIfAborted();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024) throw Error('PREFETCH_RESPONSE_LIMIT');
          chunks.push(part.value);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof value.token !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.token)) throw Error('PREFETCH_INVALID_TOKEN');
        return { token: value.token };
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }, debounceMs);
  return {
    partial(id: string, text: string, settings: PrefetchSettings) {
      if (active?.id !== id) {
        active = { id, settings: { ...settings } };
        scheduler.start(id, scope(settings), settings.voicePrefetchAttempts ?? 2);
      }
      if (active.settings.voicePrefetchEnabled === true) scheduler.partial(id, text);
    },
    finish(id: string, text: string, settings: PrefetchSettings) {
      const token = scheduler.finish(id, text, scope(settings))?.token;
      active = undefined;
      return token;
    },
    cancel() { scheduler.cancel(); active = undefined; },
    metrics: () => scheduler.metrics()
  };
}
