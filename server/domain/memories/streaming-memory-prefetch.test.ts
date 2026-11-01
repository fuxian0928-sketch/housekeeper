import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {StreamingMemoryPrefetch} from './streaming-memory-prefetch.js';
import type {MemoryContext} from './memory-context.js';
const empty=():MemoryContext=>({facts:[],preferences:[],experiences:[],provider:'fixture',retrievedAt:new Date().toISOString()});
const scope={ownerId:'local-user',projectIds:['p1'],revision:'r1'};
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await delay(5);assert.ok(check());}

test('stable partials debounce, ignore short input, and a matching final consumes a read-only candidate once',async()=>{
  let calls=0;const prefetch=new StreamingMemoryPrefetch({async retrieve(){calls++;return empty();}},15);
  prefetch.start('one',scope);prefetch.partial('one','任务');await delay(25);assert.equal(calls,0);
  prefetch.partial('one','帮我查项目文档');prefetch.partial('one','帮我查项目资料');
  await until(()=>calls===1);await delay(0);
  assert.ok(prefetch.finish('one','帮我查项目资料。',scope));assert.equal(prefetch.finish('one','帮我查项目资料',scope),undefined);
  assert.equal(prefetch.metrics().hits,1);assert.equal(calls,1);
});

test('changed final, owner, project or data revision discard speculation',async()=>{
  for(const [text,current] of [['不是查项目资料',scope],['帮我查项目资料',{...scope,ownerId:'other'}],['帮我查项目资料',{...scope,projectIds:['p2']}],['帮我查项目资料',{...scope,revision:'r2'}]] as const){
    let done=false;const prefetch=new StreamingMemoryPrefetch({async retrieve(){done=true;return empty();}},1);
    prefetch.start('t',scope);prefetch.partial('t','帮我查项目资料');await until(()=>done);await delay(0);
    assert.equal(prefetch.finish('t',text,current),undefined);assert.equal(prefetch.metrics().hits,0);
  }
});

test('pending final never waits; cancelled providers cannot leak into the next turn or run concurrently',async()=>{
  const resolves:Array<(value:MemoryContext)=>void>=[];const signals:AbortSignal[]=[];
  const prefetch=new StreamingMemoryPrefetch({retrieve(request){signals.push(request.signal!);return new Promise(resolve=>resolves.push(resolve));}},1,20);
  prefetch.start('old',scope);prefetch.partial('old','查看旧项目资料');await until(()=>resolves.length===1);
  assert.equal(prefetch.finish('old','查看旧项目资料',scope),undefined);assert.equal(signals[0].aborted,true);
  prefetch.start('new',scope);prefetch.partial('new','查看新项目资料');await delay(25);assert.equal(resolves.length,1);
  resolves[0](empty());await until(()=>resolves.length===2);assert.equal(prefetch.metrics().inFlight,1);
  resolves[1](empty());await delay(0);assert.ok(prefetch.finish('new','查看新项目资料',scope));
  assert.equal(prefetch.metrics().discarded,1);
});

test('each turn is capped at two reads and cancellation before debounce prevents dispatch',async()=>{
  let calls=0;const prefetch=new StreamingMemoryPrefetch({async retrieve(){calls++;return empty();}},1);
  prefetch.start('t',scope);
  for(let i=0;i<4;i++){prefetch.partial('t','查找项目资料'+i);await delay(15);}
  assert.equal(calls,2);assert.equal(prefetch.finish('t','查找项目资料3',scope),undefined);
  prefetch.start('cancel',scope);prefetch.partial('cancel','不需要查询资料');prefetch.cancel();await delay(15);assert.equal(calls,2);
});
