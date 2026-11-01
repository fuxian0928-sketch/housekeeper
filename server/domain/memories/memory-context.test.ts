import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('memory context filters scope, lifecycle and sources without writes or inferred emotion',async()=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'memory-context-')),'test.db');
 const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
 const {ExistingMemoryContextProvider}=await import('./memory-context.js');
 const now=new Date().toISOString();
 try {
 for(const id of ['allowed','other','deleted'])database.prepare(`INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at,deleted_at) VALUES(?,?, '', '',?,?,?)`).run(id,id,now,now,id==='deleted'?now:null);
 const insert=database.prepare(`INSERT INTO memories(id,project_id,content,memory_type,status,source_label,source_id,source_excerpt,valid_from,valid_until,created_at,updated_at) VALUES(?,?,?,?,?,'测试来源','message-1','原文证据',?,?,?,?)`);
 for(const [id,project,type,status,start,end] of [
 ['global',null,'preference','confirmed',null,null],['allowed','allowed','fact','confirmed',null,null],['other','other','fact','confirmed',null,null],['deleted','deleted','fact','confirmed',null,null],
 ['pending',null,'preference','candidate',null,null],['expired',null,'preference','confirmed',null,'2000-01-01'],['future',null,'preference','confirmed','2099-01-01',null],['revoked',null,'preference','invalidated',null,null]
 ] as const)insert.run(id,project,'任务安排，先说结论',type,status,start,end,now,now);
 const provider=new ExistingMemoryContextProvider();
 const global=await provider.retrieve({query:'任务安排',projectIds:[]});
 assert.deepEqual(global.preferences.map(x=>x.memoryId),['global']);assert.deepEqual(global.facts,[]);assert.deepEqual(global.experiences,[]);
 const scoped=await provider.retrieve({query:'任务安排',projectIds:['allowed','deleted']});
 assert.deepEqual(scoped.facts.map(x=>x.memoryId),['allowed']);assert.equal(scoped.preferences[0].sourceId,'message-1');assert.equal(scoped.preferences[0].sourceExcerpt,'原文证据');
 assert.equal((await provider.retrieve({query:'任务',projectIds:['allowed'],limit:1})).preferences.length,1);
 await assert.rejects(provider.retrieve({query:'任务',projectIds:[],limit:0}),/LIMIT_INVALID/);
 const controller=new AbortController();controller.abort();await assert.rejects(provider.retrieve({query:'任务',projectIds:[],signal:controller.signal}),{name:'AbortError'});
 database.prepare(`UPDATE memories SET status='invalidated' WHERE id='global'`).run();
 assert.deepEqual((await provider.retrieve({query:'任务安排',projectIds:[]})).preferences,[]);
 assert.equal((database.prepare('SELECT COUNT(*) AS n FROM memories').get() as {n:number}).n,8);
 }finally{database.close();}
});
