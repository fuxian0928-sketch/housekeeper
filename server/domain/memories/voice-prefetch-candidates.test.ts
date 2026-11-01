import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';

test('real memory candidates are opaque, single-use, scope-bound and revalidated after changes',async()=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'voice-candidates-')),'test.db');
 const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
 const {VoicePrefetchCandidates}=await import('./voice-prefetch-candidates.js');
 let now=Date.now();const stamp=new Date(now).toISOString();const cache=new VoicePrefetchCandidates(undefined,()=>now);
 const request={query:'请记住我的回答偏好',mode:'life' as const,projectId:null,conversationId:null};
 const signal=new AbortController().signal;
 database.prepare(`INSERT INTO memories(id,content,memory_type,status,created_at,updated_at) VALUES('m','先说结论','preference','confirmed',?,?)`).run(stamp,stamp);
 try{
   const {registerVoicePrefetchRoutes}=await import('../../api/voice-prefetch.js');
   const app=express();app.use(express.json());registerVoicePrefetchRoutes(app,cache);
   const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
   try{
     const endpoint=`http://127.0.0.1:${address.port}/api/voice/memory-prefetch`;
     const send=(body:unknown)=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
     const response=await send(request);assert.equal(response.status,200);const body=await response.json();
     assert.deepEqual(Object.keys(body),['token']);assert.equal(cache.consume(body.token,request)?.preferences[0].content,'先说结论');
     assert.equal((await send({query:'短句'})).status,409);
     const {createNativeMemoryPrefetch}=await import('../../providers/native-memory-prefetch.js');
     const client=createNativeMemoryPrefetch(`http://127.0.0.1:${address.port}`,fetch,1);
     const settings={routingMode:'life' as const,conversationId:null,voicePrefetchEnabled:true};
     client.partial('native',request.query,settings);
     for(let i=0;i<100&&(client.metrics().requests===0||client.metrics().inFlight);i++) await new Promise(resolve=>setTimeout(resolve,5));
     const nativeToken=client.finish('native',request.query,settings);
     assert.ok(nativeToken);assert.equal(cache.consume(nativeToken,request)?.preferences[0].content,'先说结论');
     const originalPrepare=cache.prepare.bind(cache);
     const releases:Array<()=>void>=[];
     cache.prepare=()=>new Promise(resolve=>releases.push(()=>resolve({token:'00000000-0000-4000-8000-000000000000'})));
     const stalled=await Promise.all([send(request),send(request)]);
     assert.deepEqual(stalled.map(item=>item.status),[409,409]);
     assert.equal((await send(request)).status,429);
     releases.forEach(release=>release());
     await new Promise(resolve=>setImmediate(resolve));
     cache.prepare=originalPrepare;
     assert.equal((await send(request)).status,200);
   }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
   const ready=await cache.prepare(request,signal);assert.deepEqual(Object.keys(ready),['token']);
   database.prepare(`INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('c','memory','voice',?,?)`).run(stamp,stamp);
   database.prepare(`INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('message','c','user','最终提问',?)`).run(stamp);
   assert.equal(cache.consume(ready.token,request)?.preferences[0].content,'先说结论');assert.equal(cache.consume(ready.token,request),undefined);
   for(const altered of [{...request,query:'不是我的回答偏好'},{...request,conversationId:'other'},{...request,mode:'work' as const}]){
     const item=await cache.prepare(request,signal);assert.equal(cache.consume(item.token,altered),undefined);
   }
   const edited=await cache.prepare(request,signal);database.prepare(`UPDATE memories SET content='后来改为详细说明' WHERE id='m'`).run();assert.equal(cache.consume(edited.token,request),undefined);
   const external=await cache.prepare(request,signal);
   const other=new DatabaseSync(process.env.AI_SECRETARY_DB_PATH!);
   try{other.prepare(`UPDATE memories SET content='外部连接修改' WHERE id='m'`).run();}finally{other.close();}
   assert.equal(cache.consume(external.token,request),undefined);
   const rolledBack=await cache.prepare(request,signal);
   database.exec('BEGIN');database.prepare(`UPDATE memories SET content='应回滚' WHERE id='m'`).run();database.exec('ROLLBACK');
   assert.equal(cache.consume(rolledBack.token,request)?.preferences[0].content,'外部连接修改');
   const projectChanged=await cache.prepare(request,signal);
   database.prepare(`INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES('revision-project','版本项目','fixture','fixture',?,?)`).run(stamp,stamp);
   assert.equal(cache.consume(projectChanged.token,request),undefined);
   const projectRenamed=await cache.prepare(request,signal);
   database.prepare(`UPDATE projects SET name='新项目名称' WHERE id='revision-project'`).run();
   assert.equal(cache.consume(projectRenamed.token,request),undefined);
   const projectDeleted=await cache.prepare(request,signal);
   database.prepare(`DELETE FROM projects WHERE id='revision-project'`).run();
   assert.equal(cache.consume(projectDeleted.token,request),undefined);
   const deleted=await cache.prepare(request,signal);database.prepare(`DELETE FROM memories WHERE id='m'`).run();assert.equal(cache.consume(deleted.token,request),undefined);
   database.prepare(`INSERT INTO memories(id,content,memory_type,status,created_at,updated_at,valid_from) VALUES('future','未来偏好','preference','confirmed',?,?,?)`).run(stamp,stamp,new Date(now+2000).toISOString());
   const future=await cache.prepare(request,signal);now+=2001;assert.equal(cache.consume(future.token,request),undefined);
   const ttl=await cache.prepare(request,signal);now+=10001;assert.equal(cache.consume(ttl.token,request),undefined);
   const controller=new AbortController();controller.abort();await assert.rejects(cache.prepare(request,controller.signal),{name:'AbortError'});
   await assert.rejects(cache.prepare({...request,mode:'work',projectId:'missing'},signal),/PROJECT_UNAVAILABLE/);
 }finally{database.close();}
});
