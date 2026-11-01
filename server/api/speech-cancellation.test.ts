import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { registerSpeechRoutes } from './speech.js';
import type { SettingsService } from '../domain/settings/settings-service.js';

test('closing synthesis HTTP response aborts provider request without late response', { timeout: 5000 }, async () => {
  const originalFetch = globalThis.fetch;
  let connected!: () => void, cancelled!: () => void;
  const started = new Promise<void>(resolve => { connected = resolve; });
  const stopped = new Promise<void>(resolve => { cancelled = resolve; });
  let providerSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_url, init) => {
    providerSignal = init!.signal!;
    connected();
    return new Promise<Response>((_resolve, reject) => {
      providerSignal!.addEventListener('abort', () => { cancelled(); reject(providerSignal!.reason); }, { once: true });
    });
  }) as typeof fetch;
  const app = express(); app.use(express.json());
  registerSpeechRoutes(app, {
    effectiveApiKey: () => 'fixture-only',
    current: () => ({ speechServiceBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', speechSynthesisModel: 'fixture', speechVoice: 'fixture', speechInstruction: '' })
  } as unknown as SettingsService);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const controller = new AbortController();
    const pending = originalFetch(`http://127.0.0.1:${address.port}/api/speech/synthesize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '测试' }), signal: controller.signal
    });
    void pending.catch(() => {});
    await started; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await stopped;
    assert.equal(providerSignal!.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
