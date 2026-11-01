import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('project context excludes other-project relations and overview excludes inactive memories',async()=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'project-memory-scope-')),'test.db');
 const {database,initializeDatabase,sqliteVecAvailable}=await import('../db.js');initializeDatabase();
 const {buildProjectContext}=await import('./context-builder.js');
 const {runConversationPlan}=await import('./conversation-orchestrator.js');
 const {routeWorkIntents}=await import('./intent-router.js');
 const now=new Date().toISOString();
 try{
  for(const id of ['p1','p2'])database.prepare(`INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES(?,?, '', '',?,?)`).run(id,id,now,now);
  const add=database.prepare(`INSERT INTO memories(id,project_id,content,memory_type,status,created_at,updated_at,valid_from,valid_until,supersedes_id,contradicts_json) VALUES(?,?,?,'fact',?,?,?,?,?,?,?)`);
  add.run('other','p2','OTHER_PROJECT_SECRET','confirmed',now,now,null,null,null,'[]');
  add.run('old','p1','LOCAL_OLD_EVIDENCE','superseded',now,now,null,null,null,'[]');
  add.run('active','p1','项目当前有效设计规则','confirmed',now,now,null,null,'old','["other"]');
  add.run('future','p1','FUTURE_NOT_ACTIVE','confirmed',now,now,'2099-01-01',null,null,'[]');
  add.run('expired','p1','EXPIRED_NOT_ACTIVE','confirmed',now,now,null,'2000-01-01',null,'[]');
  const route=routeWorkIntents('当前项目进展','p1',[]);
  const context=await buildProjectContext('p1','项目设计规则',null,route);
  assert.ok(!JSON.stringify(context).includes('OTHER_PROJECT_SECRET'));
  assert.ok(JSON.stringify(context).includes('LOCAL_OLD_EVIDENCE'));
  assert.ok(!JSON.stringify(context).includes('FUTURE_NOT_ACTIVE'));
  assert.ok(!JSON.stringify(context).includes('EXPIRED_NOT_ACTIVE'));
  const overviewRoute={...route,requiresRetrieval:true,intents:[{...route.intents[0],action:'all_projects_overview' as const}]};
  const plan=await runConversationPlan({message:'所有项目进展',retrievalQuery:'项目进展',projectId:null,documentPaths:[],intentRoute:overviewRoute});
  assert.ok(!plan.contextBlocks.join('').includes('FUTURE_NOT_ACTIVE'));
  assert.ok(!plan.contextBlocks.join('').includes('EXPIRED_NOT_ACTIVE'));
  assert.ok(plan.contextBlocks.join('').includes('项目当前有效设计规则'));
  const {searchRelevantMemories,getCoreMemorySnapshot}=await import('../domain/memories/memory-service.js');
  database.prepare(`UPDATE memories SET memory_type='preference' WHERE id='other'`).run();
  database.prepare(`UPDATE projects SET deleted_at=? WHERE id='p2'`).run(now);
  assert.ok(!(await searchRelevantMemories('OTHER_PROJECT_SECRET','p2')).some(row=>row.id==='other'));
  assert.ok(!getCoreMemorySnapshot('p2').some(row=>row.id==='other'));
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(searchRelevantMemories('项目','p1',null,8,aborted.signal),{name:'AbortError'});
  assert.equal(sqliteVecAvailable,true,'race coverage requires bundled sqlite-vec');
  const vector=Array(1024).fill(0.01);
  database.prepare(`INSERT INTO memory_vectors(memory_id,embedding) VALUES('active',?)`).run(JSON.stringify(vector));
  const provider={model:'fixture',dimension:1024,version:'fixture',async embed(){
    database.prepare(`UPDATE memories SET content='查询期间更新后的内容' WHERE id='active'`).run();
    return [vector];
  }};
  const refreshed=await searchRelevantMemories('项目设计规则','p1',provider);
  assert.equal(refreshed.find(row=>row.id==='active')?.content,'查询期间更新后的内容');
  const retiring={...provider,async embed(){database.prepare(`UPDATE memories SET status='invalidated' WHERE id='active'`).run();return [vector];}};
  assert.ok(!(await searchRelevantMemories('项目设计规则','p1',retiring)).some(row=>row.id==='active'));
  database.prepare(`UPDATE memories SET status='confirmed' WHERE id='active'`).run();
  const controller=new AbortController();
  const cancelling={...provider,async embed(){controller.abort();return [vector];}};
  const accessed=database.prepare(`SELECT access_count FROM memories WHERE id='active'`).get()?.access_count;
  await assert.rejects(searchRelevantMemories('项目','p1',cancelling,8,controller.signal),{name:'AbortError'});
  assert.equal(database.prepare(`SELECT access_count FROM memories WHERE id='active'`).get()?.access_count,accessed);

 }finally{database.close();}
});
