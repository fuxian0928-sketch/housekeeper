import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('index writes and invalidation commit or roll back together, including nested transactions',async()=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'memory-index-revision-')),'test.db');
 const {database,initializeDatabase,sqliteVecAvailable}=await import('../../db.js');initializeDatabase();
 const {mutateMemoryIndex}=await import('./memory-index-mutation.js');
 const {indexSingleMemory,syncMemorySearch,rebuildMemorySemanticIndex}=await import('./memory-service.js');
 const stamp=new Date().toISOString();
 const revision=()=>database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()?.revision;
 const vectorCount=()=>database.prepare('SELECT count(*) AS n FROM memory_vectors').get()?.n;
 try{
  assert.equal(sqliteVecAvailable,true);
  database.prepare(`INSERT INTO memories(id,content,status,created_at,updated_at) VALUES('m','索引验证','confirmed',?,?)`).run(stamp,stamp);
  const provider={model:'fixture',dimension:1024,version:'fixture',async embed(texts:string[]){return texts.map(()=>Array(1024).fill(.03));}};
  let before=revision();await indexSingleMemory('m',provider);assert.notEqual(revision(),before);assert.equal(vectorCount(),1);
  before=revision();
  assert.throws(()=>mutateMemoryIndex(()=>{database.prepare('DELETE FROM memory_vectors').run();throw Error('rollback fixture');}),/rollback fixture/);
  assert.equal(revision(),before);assert.equal(vectorCount(),1);
  database.exec('BEGIN');syncMemorySearch('m');assert.notEqual(revision(),before);assert.equal(vectorCount(),0);database.exec('ROLLBACK');
  assert.equal(revision(),before);assert.equal(vectorCount(),1);
  database.exec('BEGIN');syncMemorySearch('m');database.exec('COMMIT');assert.notEqual(revision(),before);assert.equal(vectorCount(),0);
  before=revision();await rebuildMemorySemanticIndex(provider);assert.notEqual(revision(),before);assert.equal(vectorCount(),1);
  before=revision();
  await assert.rejects(indexSingleMemory('m',{...provider,async embed(){return [[1]];}}));
  assert.equal(revision(),before);assert.equal(vectorCount(),1,'failed replacement must preserve the old index');
 }finally{database.close();}
});
