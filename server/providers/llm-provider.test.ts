import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleLlmProvider } from './llm-provider.js';

test('LLM Provider 统一解析非流式回答', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '连接成功' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const provider = new OpenAICompatibleLlmProvider('test-model', 'https://example.test/v1', 'secret');
    assert.equal(await provider.complete('测试', { instruction: '测试' }), '连接成功');
  } finally { globalThis.fetch = originalFetch; }
});

test('LLM Provider 统一解析流式回答', async () => {
  const originalFetch = globalThis.fetch;
  const body = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const deltas: string[] = [];
    const provider = new OpenAICompatibleLlmProvider('test-model', 'https://example.test/v1', 'secret');
    assert.equal(await provider.stream('测试', (delta) => deltas.push(delta), { instruction: '测试' }), '你好');
    assert.deepEqual(deltas, ['你', '好']);
  } finally { globalThis.fetch = originalFetch; }
});

test('LLM Provider 清理提前结束标记并提示回答可能不完整', async () => {
  const originalFetch = globalThis.fetch;
  const body = 'data: {"choices":[{"delta":{"content":"回答到一半<|eos|>"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const provider = new OpenAICompatibleLlmProvider('test-model', 'https://example.test/v1', 'secret');
    const answer = await provider.stream('测试', () => undefined, { instruction: '测试' });
    assert.equal(answer.includes('<|eos|>'), false);
    assert.match(answer, /模型提前返回了结束标记/);
  } finally { globalThis.fetch = originalFetch; }
});

test('LLM Provider 在输出长度达到上限时给出明确提示', async () => {
  const originalFetch = globalThis.fetch;
  const body = 'data: {"choices":[{"delta":{"content":"未完成回答"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const provider = new OpenAICompatibleLlmProvider('test-model', 'https://example.test/v1', 'secret');
    const answer = await provider.stream('测试', () => undefined, { instruction: '测试' });
    assert.match(answer, /输出长度上限/);
  } finally { globalThis.fetch = originalFetch; }
});
