import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionExperienceCoordinator } from './session-experience-coordinator.js';

test('extraction is deferred, evidence-bound and ordinary work needs no extra model call',async()=>{
  const sources=new Map([['m',{id:'m',conversationId:'c',role:'user',content:'我今天很紧张',createdAt:new Date().toISOString()}]]);
  let calls=0;
  const coordinator=new SessionExperienceCoordinator(id=>sources.get(id),async()=>{calls++;return JSON.stringify({excerpts:['我今天很紧张']});});
  const run=coordinator.begin('c','m');assert.equal(calls,0);assert.deepEqual(coordinator.context('c'),[]);
  assert.equal(await run(),true);assert.equal(calls,1);assert.equal(await run(),false);
  assert.equal(coordinator.context('c')[0].quote,'我今天很紧张');
  sources.delete('m');assert.deepEqual(coordinator.context('c'),[]);
  sources.set('m',{id:'m',conversationId:'c',role:'user',content:'帮我创建任务',createdAt:new Date().toISOString()});
  assert.equal(await coordinator.begin('c','m')(),false);assert.equal(calls,1);
  assert.equal(await coordinator.begin('other','m')(),false);
});

test('late model output cannot replace corrections or edited/deleted source evidence',async()=>{
  let source={id:'m',conversationId:'c',role:'user',content:'我今天很紧张',createdAt:new Date().toISOString()};
  let resolve!:(value:string)=>void;let signal:AbortSignal|undefined;
  const coordinator=new SessionExperienceCoordinator(()=>source,async(_input,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});});
  const pending=coordinator.begin('c','m')();
  source={...source,content:'我已经不紧张了'};coordinator.begin('c','m');
  assert.equal(signal?.aborted,true);resolve('{"excerpts":["我今天很紧张"]}');assert.equal(await pending,false);
  assert.deepEqual(coordinator.context('c'),[]);
  const edited=coordinator.begin('c','m')();source={...source,role:'assistant'};resolve('{"excerpts":["我已经不紧张了"]}');assert.equal(await edited,false);
});

test('unverifiable, oversized and malformed extraction stays out of context',async()=>{
  const source={id:'m',conversationId:'c',role:'user',content:'我今天很紧张',createdAt:new Date().toISOString()};
  for(const output of ['not json','{"excerpts":["用户性格焦虑"]}','{"excerpts":[12]}','x'.repeat(4001)]) {
    const coordinator=new SessionExperienceCoordinator(()=>source,async()=>output);
    assert.equal(await coordinator.begin('c','m')(),false);assert.deepEqual(coordinator.context('c'),[]);
  }
});

test('deadline releases logical capacity even when a provider ignores abort; late resolution is harmless',async()=>{
  const pending:Array<(value:string)=>void>=[];let calls=0;const timestamp=new Date().toISOString();
  const coordinator=new SessionExperienceCoordinator(id=>({id,conversationId:id,role:'user',content:'我现在很紧张',createdAt:timestamp}),async()=>{
    calls++;if(calls<=2)return new Promise(resolve=>pending.push(resolve));
    return '{"excerpts":["紧张"]}';
  },undefined,()=>true,20);
  const first=coordinator.begin('a','a')(),second=coordinator.begin('b','b')();
  assert.equal(await coordinator.begin('over-capacity','over-capacity')(),false);
  assert.deepEqual(await Promise.all([first,second]),[false,false]);
  assert.equal(await coordinator.begin('c','c')(),true);assert.equal(calls,3);
  for(const resolve of pending)resolve('{"excerpts":["紧张"]}');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(coordinator.context('a'),[]);assert.deepEqual(coordinator.context('b'),[]);
});

test('substring extraction cannot remove negation, chronology or speaker attribution',async()=>{
  for(const content of ['我现在不紧张了，之前确实紧张。','我之前很难过，现在已经好了。','我转述他的话：“今天很紧张”，这是他说的。']) {
    const excerpt=content.includes('紧张')?'紧张':'难过';const timestamp=new Date().toISOString();
    const coordinator=new SessionExperienceCoordinator(()=>({id:'m',conversationId:'c',role:'user',content,createdAt:timestamp}),async()=>JSON.stringify({excerpts:[excerpt]}));
    assert.equal(await coordinator.begin('c','m')(),true);
    assert.equal(coordinator.context('c')[0].quote,content);
  }
  let calls=0;
  const coordinator=new SessionExperienceCoordinator(()=>({id:'m',conversationId:'c',role:'user',content:'我很紧张'+ '很'.repeat(501),createdAt:new Date().toISOString()}),async()=>{calls++;return '{}';});
  assert.equal(await coordinator.begin('c','m')(),false);assert.equal(calls,0);
});

test('editing a source by appending a correction invalidates previously extracted context',async()=>{
 let source={id:'m',conversationId:'c',role:'user',content:'我今天很紧张',createdAt:new Date().toISOString()};
 const coordinator=new SessionExperienceCoordinator(()=>source,async()=>'{"excerpts":["紧张"]}');
 await coordinator.begin('c','m')();assert.equal(coordinator.context('c').length,1);
 source={...source,content:source.content+'。更正：现在不紧张了。'};
 assert.deepEqual(coordinator.context('c'),[]);
 source={...source,content:'我今天很紧张'};assert.deepEqual(coordinator.context('c'),[]);
});

test('targeted deletion isolates conversations and retires extraction already in flight',async()=>{
 const timestamp=new Date().toISOString(),sources=new Map(['a','b'].map(id=>[id,{id,conversationId:id,role:'user',content:'我现在很开心',createdAt:timestamp}]));
 let deferred=false,resolve!:(value:string)=>void,signal:AbortSignal|undefined;
 const coordinator=new SessionExperienceCoordinator(id=>sources.get(id),async(_input,options)=>{signal=options.signal;return deferred?new Promise(r=>{resolve=r;}):'{"excerpts":["开心"]}';});
 await coordinator.begin('a','a')();await coordinator.begin('b','b')();
 assert.equal(coordinator.remove('a','b'),false);assert.equal(coordinator.context('a').length,1);
 deferred=true;const late=coordinator.begin('a','a')();
 assert.equal(coordinator.remove('a','a'),true);assert.equal(signal?.aborted,true);
 resolve('{"excerpts":["开心"]}');assert.equal(await late,false);
 assert.deepEqual(coordinator.context('a'),[]);assert.equal(coordinator.context('b').length,1);
 assert.equal(sources.size,2);assert.equal(coordinator.remove('a','a'),false);
});
