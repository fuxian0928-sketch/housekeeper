import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekWebSearchProvider} from './deepseek-web-search.js';

test('DeepSeek search reuses the configured host/key, normalizes sources and bounds content',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original;});const calls:any[]=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),headers:init?.headers,body:JSON.parse(String(init?.body))});return new Response(JSON.stringify({results:[{title:'官方资料',url:'https://docs.example/a',summary:'摘要',rerank_score:2.4,date:'2026-10-26'},{title:'坏链接',url:'javascript:alert(1)'},{title:'含凭据',url:'https://user:password@example.com/'}]}));};
  const provider=new DeepSeekWebSearchProvider('synthetic-key','https://api.deepseek.com/v1');
  const result=await provider.search({query:'最新变化',purpose:'核实'});
  assert.equal(calls[0].url,'https://api.deepseek.com/v1/tools/search');assert.equal(calls[0].headers.Authorization,'Bearer synthetic-key');assert.equal(calls[0].body.need_content,true);
  assert.equal(result.length,1);assert.equal(result[0].content,'摘要');assert.equal(result[0].publishedAt,'2026-10-26');
  globalThis.fetch=async(url)=>{calls.push({url:String(url)});return new Response(JSON.stringify({title:'正文',content:'x'.repeat(25000)}));};
  const relay=new DeepSeekWebSearchProvider('relay-key','https://relay.invalid/api/v1/');const page=await relay.fetchPage('https://docs.example/a');
  assert.equal(calls.at(-1).url,'https://relay.invalid/api/v1/tools/fetch');assert.equal(page.content.length,20000);assert.equal(page.truncated,true);
  await assert.rejects(()=>relay.fetchPage('file:///private'),/公开网页/);
});

test('missing Search support and cancellation never fabricate a successful lookup',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original;});let count=0;
  globalThis.fetch=async()=>{count++;return new Response('private-provider-error',{status:404});};
  const provider=new DeepSeekWebSearchProvider('synthetic-key','https://api.deepseek.com');
  await assert.rejects(()=>provider.search({query:'测试'}),/未开放 DeepSeek/);assert.equal(count,1);
  await assert.rejects(()=>provider.search({query:'测试'},AbortSignal.abort()));assert.equal(count,1);
});
