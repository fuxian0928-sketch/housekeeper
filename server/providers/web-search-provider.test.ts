import assert from 'node:assert/strict';
import test from 'node:test';
import { TavilyWebSearchProvider } from './web-search-provider.js';

test('Tavily 搜索规范化来源并忽略无效链接', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [
    { title: '有效来源', url: 'https://example.com/report', content: '摘要', score: 0.9, published_date: '2026-08-01' },
    { title: '无效来源', url: 'javascript:alert(1)', content: '不应返回', score: 1 }
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const provider = new TavilyWebSearchProvider('tvly-test-key-that-is-long-enough');
    const results = await provider.search({ query: '测试', purpose: '验证' });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, '有效来源');
    assert.equal(results[0]?.purpose, '验证');
  } finally { globalThis.fetch = originalFetch; }
});

test('Tavily 搜索遇到限流时重试一次', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response(JSON.stringify({ detail: 'too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const provider = new TavilyWebSearchProvider('tvly-test-key-that-is-long-enough');
    await provider.search({ query: '测试' });
    assert.equal(attempts, 2);
  } finally { globalThis.fetch = originalFetch; }
});

