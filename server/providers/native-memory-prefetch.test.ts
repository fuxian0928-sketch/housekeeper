import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeMemoryPrefetch } from './native-memory-prefetch.js';
const token = '11111111-1111-4111-8111-111111111111';
const settings = { voicePrefetchEnabled:true, routingMode: 'work' as const, projectId: 'p1', conversationId: 'c1' };
async function settled(client: ReturnType<typeof createNativeMemoryPrefetch>) {
  for (let i=0;i<100&&(client.metrics().requests===0||client.metrics().inFlight);i++) await delay(5);
  assert.equal(client.metrics().inFlight,0);
}

test('native prefetch preserves transcript, returns only a scoped one-use token and drops changed finals', async () => {
  const bodies: any[] = [];
  const send = (async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return new Response(JSON.stringify({token})); }) as typeof fetch;
  for (const change of ['none','text','project','conversation','mode']) {
    const client = createNativeMemoryPrefetch('http://127.0.0.1:1',send,1);
    client.partial('t','Find project notes, please.',settings); await settled(client);
    const finalSettings = {...settings, ...(change==='project'?{projectId:'p2'}:{}), ...(change==='conversation'?{conversationId:'c2'}:{})};
    const result = client.finish('t',change==='text'?'Do not find project notes':'Find project notes, please.',change==='mode'?{...finalSettings,routingMode:'life'}:finalSettings);
    assert.equal(result,change==='none'?token:undefined);
    assert.equal(client.finish('t','Find project notes, please.',settings),undefined);
  }
  assert.equal(bodies[0].query,'Find project notes, please.');
  assert.equal(bodies[0].projectId,'p1');
});

test('cancel and final never wait for speculative HTTP, including a noncooperative response', async () => {
  let resolve!: (response: Response)=>void;
  let signal: AbortSignal | undefined;
  const client=createNativeMemoryPrefetch('http://localhost:1',((_,init)=>{signal=init!.signal as AbortSignal;return new Promise(r=>{resolve=r;});}) as typeof fetch,1);
  client.partial('old','查找之前的项目资料',settings);
  for(let i=0;i<100&&!signal;i++)await delay(5);
  assert.ok(signal);
  assert.equal(client.finish('old','查找之前的项目资料',settings),undefined);assert.equal(signal.aborted,true);
  client.partial('new','查找现在的项目资料',settings);client.cancel();
  resolve(new Response(JSON.stringify({token})));await delay(10);
  assert.equal(client.metrics().inFlight,0);assert.equal(client.metrics().hits,0);
});

test('malformed, oversized and unavailable prefetch responses fall back without throwing',async()=>{
  for(const response of [()=>new Response('bad'),()=>new Response(JSON.stringify({token:'not-a-token'})),()=>new Response('x'.repeat(1025)),()=>new Response('',{status:429})]){
    const client=createNativeMemoryPrefetch('http://localhost:1',(async()=>response()) as typeof fetch,1);
    client.partial('t','查询项目相关记忆',settings);await settled(client);
    assert.equal(client.finish('t','查询项目相关记忆',settings),undefined);
  }
  assert.throws(()=>createNativeMemoryPrefetch('https://example.com'),/LOCAL_SERVICE/);
});


test('word boundaries and arithmetic punctuation are significant for candidate reuse', async () => {
  const send=(async()=>new Response(JSON.stringify({token}))) as typeof fetch;
  for(const [partial,final] of [['Find a note please','Find anote please'],['计算 100-10 的结果','计算 10010 的结果']]){
    const client=createNativeMemoryPrefetch('http://localhost:1',send,1);
    client.partial('t',partial,settings);await settled(client);
    assert.equal(client.finish('t',final,settings),undefined);
  }
});


test('disabled turns make no requests; next turn settings and attempt budgets apply independently', async () => {
  let calls=0;
  const client=createNativeMemoryPrefetch('http://localhost:1',(async()=>{calls++;return new Response(JSON.stringify({token}));}) as typeof fetch,1);
  client.partial('disabled','查询项目相关记忆',{...settings,voicePrefetchEnabled:false});
  client.partial('disabled','查询项目最新相关记忆',{...settings,voicePrefetchEnabled:true});
  await delay(20);assert.equal(calls,0);
  assert.equal(client.finish('disabled','查询项目最新相关记忆',settings),undefined);
  client.partial('one','查询项目相关记忆',{...settings,voicePrefetchAttempts:1});await settled(client);
  client.partial('one','查询项目最新相关记忆',{...settings,voicePrefetchAttempts:2});
  await delay(20);assert.equal(calls,1);
  assert.equal(client.finish('one','查询项目最新相关记忆',settings),undefined);
  client.partial('two','查询项目相关记忆',{...settings,voicePrefetchAttempts:2});await delay(20);
  client.partial('two','查询项目最新相关记忆',settings);await delay(20);
  assert.equal(calls,3);assert.equal(client.finish('two','查询项目最新相关记忆',settings),token);
});


test('omitted or malformed opt-in never starts speculative network work',async()=>{
  let calls=0;
  const client=createNativeMemoryPrefetch('http://localhost:1',(async()=>{calls++;return new Response(JSON.stringify({token}));}) as typeof fetch,1);
  for(const enabled of [undefined,null,'true',1,false]){
    const config={...settings,voicePrefetchEnabled:enabled} as any;
    client.partial('turn','查询项目最新相关记忆',config);await delay(20);
    assert.equal(client.finish('turn','查询项目最新相关记忆',config),undefined);
  }
  assert.equal(calls,0);client.cancel();
});
