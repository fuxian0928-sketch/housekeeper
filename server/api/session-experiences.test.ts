import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { registerSessionExperienceRoutes } from './session-experiences.js';
import { SessionExperienceCoordinator } from '../domain/memories/session-experience-coordinator.js';

test('session controls list evidence, persist only the switch and retire in-flight extraction',async()=>{
  let enabled=true,calls=0,pending=false,resolve!:(value:string)=>void,signal:AbortSignal|undefined;
  const row={id:'m',conversationId:'c',role:'user',content:'我现在很开心',createdAt:new Date().toISOString()};
  const coordinator=new SessionExperienceCoordinator(()=>row,async(_input,options)=>{calls++;signal=options.signal;if(pending)return new Promise(r=>{resolve=r;});return '{"excerpts":["我现在很开心"]}';},undefined,()=>enabled);
  const app=express();app.use(express.json());registerSessionExperienceRoutes(app,{coordinator,enabled:()=>enabled,saveEnabled:value=>{enabled=value;}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/api/voice/session-experiences`;
  const update=(value:unknown)=>fetch(url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:value})});
  try{
    await coordinator.begin('c','m')();
    const snapshot=await(await fetch(url)).json();assert.equal(snapshot.records[0].sourceMessageId,'m');assert.equal(snapshot.persistent,false);
    assert.equal((await update('false')).status,400);assert.equal(enabled,true);
    pending=true;const inflight=coordinator.begin('c','m')();
    const disabled=await(await update(false)).json();assert.equal(disabled.enabled,false);assert.deepEqual(disabled.records,[]);assert.equal(signal?.aborted,true);
    resolve('{"excerpts":["我现在很开心"]}');assert.equal(await inflight,false);
    assert.equal(await coordinator.begin('c','m')(),false);assert.equal(calls,2);
    await update(true);const beforeClear=coordinator.begin('c','m')();
    assert.deepEqual((await(await fetch(url,{method:'DELETE'})).json()).records,[]);assert.equal(enabled,true);assert.equal(signal?.aborted,true);
    resolve('{"excerpts":["我现在很开心"]}');assert.equal(await beforeClear,false);
    assert.deepEqual((await(await fetch(url)).json()).records,[]);
  }finally{coordinator.clear();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('targeted HTTP deletion preserves other conversations and rejects oversized identifiers',async()=>{
 const rows=new Map(['a','b'].map(id=>[id,{id,conversationId:id,role:'user',content:'我现在很开心',createdAt:new Date().toISOString()}]));
 const coordinator=new SessionExperienceCoordinator(id=>rows.get(id),async()=>'{"excerpts":["开心"]}');
 for(const id of rows.keys())await coordinator.begin(id,id)();
 const app=express();app.use(express.json());registerSessionExperienceRoutes(app,{coordinator,enabled:()=>true,saveEnabled(){}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}/api/voice/session-experiences`;
 try{
  assert.equal((await fetch(`${url}/${'a'.repeat(201)}/a`,{method:'DELETE'})).status,400);
  assert.equal((await(await fetch(`${url}/a/b`,{method:'DELETE'})).json()).records.length,2);
  const removed=await(await fetch(`${url}/a/a`,{method:'DELETE'})).json();
  assert.deepEqual(removed.records.map((row:any)=>row.conversationId),['b']);assert.equal(removed.enabled,true);
  assert.equal((await(await fetch(`${url}/a/a`,{method:'DELETE'})).json()).records.length,1);
  assert.equal(rows.size,2);
 }finally{coordinator.clear();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
