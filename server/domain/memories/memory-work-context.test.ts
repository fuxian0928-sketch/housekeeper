import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('跨对话记忆、工作账本与向量索引保持来源、范围和时序',async context=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'xiwei-work-memory-')),'test.db');
  const {database,initializeDatabase,sqliteVecAvailable}=await import('../../db.js');initializeDatabase();
  context.after(()=>database.close());
  const {AgentMemoryCoordinator}=await import('./agent-memory-coordinator.js');
  const {searchConversationArchive,readConversationArchive,findWorkContext,readWorkRecord}=await import('./work-memory.js');
  const {memoryEmbeddingProfile,memoryVectorStatus,indexSingleMemory,rebuildMemorySemanticIndex,searchRelevantMemories}=await import('./memory-service.js');
  const {createAgentRun,getAgentRun}=await import('../agent/run-store.js');
  const {initialAgentCheckpoint}=await import('../agent/runtime.js');
  const {agentLearningObservation}=await import('./agent-observation.js');
  const now=new Date().toISOString(),past=new Date(Date.now()-3600_000).toISOString();
  for(const [id,name] of [['p1','星河计划'],['p2','杉木计划']])database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES(?,?,'','',?,?)").run(id,name,now,now);
  const memory=(id:string,projectId:string|null,content:string,type='fact',importance=.5)=>database.prepare("INSERT INTO memories(id,project_id,content,memory_type,status,importance,source_id,source_label,created_at,updated_at) VALUES(?,?,?,?,'confirmed',?,'source','原始用户记录',?,?)").run(id,projectId,content,type,importance,now,now);
  memory('star','p1','星河计划交付时间为周五','project_decision',.9);memory('tree','p2','杉木计划交付时间为周日','project_decision',.9);memory('personal',null,'主人偏好简洁答复','preference',.9);memory('expired','p1','星河计划旧预算一万元');
  database.prepare("UPDATE memories SET valid_until='2020-01-01' WHERE id='expired'").run();
  for(const [id,projectId] of [['c1','p1'],['c2','p2'],['global',null]])database.prepare("INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?,'memory',?,'测试',?,?)").run(id,projectId,past,past);
  const message=(id:string,conversation:string,role:string,content:string)=>database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at) VALUES(?,?,?,?,'[]',?)").run(id,conversation,role,content,past);
  message('user-budget','c1','user','星河计划预算是两万元，password=fixture-secret123。');
  message('assistant-budget','c1','assistant','预算已经支付了——这只是旧助手的说法。');
  message('system-hidden','c1','system','预算系统提示不能作为用户聊天返回');
  message('other-budget','c2','user','杉木计划预算三万元');

  await context.test('两字中文查询、角色证据、分页和删除索引一致',()=>{
    const rows=searchConversationArchive({query:'预算',limit:12},{projectId:'p1'});
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.projectId==='p1'));
    assert.equal(rows.find(row=>row.role==='assistant')?.evidenceType,'assistant_statement');
    assert.equal(rows.find(row=>row.role==='user')?.evidenceType,'user_statement');
    assert.ok(rows.every(row=>!row.content.includes('fixture-secret123')));
    const first=readConversationArchive({conversationId:'c1',limit:1},{projectId:'p1'});assert.equal(first.total,2);assert.equal(first.nextOffset,1);
    assert.equal(readConversationArchive({conversationId:'c1',offset:1,limit:1}).nextOffset,null);
    assert.throws(()=>readConversationArchive({conversationId:'c2'},{projectId:'p1'}),/不属于/);
    assert.throws(()=>searchConversationArchive({query:'预算',projectId:'p2'},{projectId:'p1'}),/其他项目/);
    assert.throws(()=>searchConversationArchive({query:'预算',since:'bad date'}),/时间无效/);
    message('temp-index','global','user','唯一档案删除标记');
    assert.equal(Number(database.prepare("SELECT count(*) AS n FROM message_archive_fts WHERE message_archive_fts MATCH '唯一档案删除标记'").get()?.n),1);
    database.prepare("DELETE FROM messages WHERE id='temp-index'").run();
    assert.equal(Number(database.prepare("SELECT count(*) AS n FROM message_archive_fts WHERE message_archive_fts MATCH '唯一档案删除标记'").get()?.n),0);
    database.prepare("UPDATE messages SET content='预算已更正' WHERE id='user-budget'").run();
    assert.equal(searchConversationArchive({query:'更正'},{projectId:'p1'})[0].messageId,'user-budget');
  });

  const pending=createAgentRun({conversationId:'c1',inputId:'pending',goal:'星河计划整理预算表',projectId:'p1',model:'fixture',checkpoint:initialAgentCheckpoint([],'整理预算表')}).run;
  database.prepare("UPDATE agent_runs SET status='waiting_approval',answer='已经付款' WHERE id=?").run(pending.id);
  const other=createAgentRun({conversationId:'c2',inputId:'other',goal:'杉木计划整理预算表',projectId:'p2',model:'fixture',checkpoint:initialAgentCheckpoint([],'整理预算表')}).run;
  await context.test('工作续接读取真实状态，不重放待确认操作',()=>{
    const record=readWorkRecord(pending.id,{projectId:'p1'});assert.equal(record.status,'waiting_approval');assert.deepEqual(record.steps,[]);
    assert.throws(()=>readWorkRecord(other.id,{projectId:'p1'}),/不属于/);
    const found=findWorkContext('继续',{projectId:'p1'});assert.equal(found.status,'resolved');assert.equal(found.candidates[0].runId,pending.id);
    assert.equal(getAgentRun(pending.id).status,'waiting_approval','recall must not resume or complete the run');
    database.prepare("UPDATE agent_runs SET status='running',lease_expires_at='2020-01-01' WHERE id=?").run(pending.id);
    assert.equal(readWorkRecord(pending.id).recoveryRequired,true);assert.equal(getAgentRun(pending.id).status,'running');
    database.prepare("UPDATE agent_runs SET status='waiting_approval' WHERE id=?").run(pending.id);
    const observation=agentLearningObservation(getAgentRun(pending.id));assert.doesNotMatch(observation.content,/已核实的处理结果/);assert.match(observation.content,/说法，不是独立事实证据/);assert.match(observation.content,/waiting_approval/);
  });
  await context.test('先定位项目再召回，保留历史证据，不串项目',async()=>{
    let calls=0;const coordinator=new AgentMemoryCoordinator({embedding:()=>({model:'unindexed',dimension:1024,version:'1',profileId:'unindexed',async embed(){calls++;return[Array(1024).fill(.1)];}})});
    const recalled=await coordinator.build('星河计划上次的预算和交付安排',null);
    assert.equal(recalled.recallProjectHint,'p1');assert.ok(recalled.memories.some(item=>item.id==='star'));assert.ok(!recalled.memories.some(item=>['tree','expired'].includes(item.id)));
    assert.ok(recalled.historyEvidence.every(item=>item.projectId==='p1'));assert.ok(recalled.workContext.candidates.every(item=>item.projectId==='p1'));
    assert.ok(recalled.memories.every(item=>item.verification==='confirmed'&&item.sourceId==='source'));assert.equal(calls,0,'an unindexed model must not query another model vector space');
    const greeting=await coordinator.build('你好',null);assert.equal(calls,0);assert.equal(greeting.historyEvidence.length,0);assert.equal(greeting.workContext.candidates.length,0);assert.ok(greeting.memories.every(item=>item.projectId===null));
  });

  await context.test('全局聊天中的有归属事务仍能按真实项目找到原始发言',()=>{
    const first=createAgentRun({conversationId:'global',inputId:'scoped-star',goal:'星河计划的结算归档说明',projectId:'p1',model:'fixture',checkpoint:initialAgentCheckpoint([],'结算归档')}).run;
    createAgentRun({conversationId:'global',inputId:'scoped-tree',goal:'杉木计划的结算归档说明',projectId:'p2',model:'fixture',checkpoint:initialAgentCheckpoint([],'结算归档')});
    const found=searchConversationArchive({query:'结算归档'},{projectId:'p1'});assert.equal(found.length,1);assert.equal(found[0].messageId,first.userMessageId);
    const conversation=readConversationArchive({conversationId:'global'},{projectId:'p1'});assert.equal(conversation.total,1);assert.ok(conversation.messages.every(item=>item.projectId==='p1'));
  });
  assert.equal(sqliteVecAvailable,true);const vector=Array(1024).fill(.02),provider={model:'fixture',dimension:1024,version:'1',profileId:'fixture-profile',async embed(texts:string[]){return texts.map(()=>vector);}};
  const setProfile=(value:string)=>database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('memory_vector_profile',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value,now);
  await context.test('异步索引回写前核对已修改或失效的记忆',async()=>{
    memory('late','p1','待更新的原始内容');let release!:(vectors:number[][])=>void;
    const deferred={...provider,embed:()=>new Promise<number[][]>(resolve=>{release=resolve;})};
    const indexing=indexSingleMemory('late',deferred);database.prepare("UPDATE memories SET content='已改过的新内容' WHERE id='late'").run();release([vector]);assert.equal(await indexing,false);
    assert.equal(Number(database.prepare("SELECT count(*) AS n FROM memory_vectors WHERE memory_id='late'").get()?.n),0);
    const second=indexSingleMemory('late',deferred);database.prepare("UPDATE memories SET status='rejected' WHERE id='late'").run();release([vector]);assert.equal(await second,false);
    database.prepare("DELETE FROM memories WHERE id='late'").run();
  });
  await context.test('模型空间不混用，旧重建结果不能覆盖新任务',async()=>{
    let release!:(vectors:number[][])=>void,oldBatch=0;
    const old={...provider,profileId:'old',embed:(texts:string[])=>{oldBatch=texts.length;return new Promise<number[][]>(resolve=>{release=resolve;});}};
    const superseded=rebuildMemorySemanticIndex(old);const rejection=assert.rejects(superseded,/接管/);
    const latest=await rebuildMemorySemanticIndex(provider);assert.ok(latest.memories>0);release(Array.from({length:oldBatch},()=>vector));await rejection;
    assert.equal(memoryVectorStatus(provider).compatible,true);assert.equal(memoryVectorStatus(old).compatible,false);assert.equal(memoryVectorStatus().buildPending,false);
    const before=memoryVectorStatus(provider).count,abort=new AbortController();abort.abort();await assert.rejects(rebuildMemorySemanticIndex(old,abort.signal),{name:'AbortError'});assert.equal(memoryVectorStatus(provider).count,before);
    let calls=0;await searchRelevantMemories('星河计划','p1',{...old,async embed(){calls++;return[vector];}});assert.equal(calls,0);
  });
  await context.test('召回向量超时回退关键词，取消能及时返回',async()=>{
    setProfile(memoryEmbeddingProfile(provider));
    const stalled={...provider,embed:()=>new Promise<number[][]>(()=>{})};
    const coordinator=new AgentMemoryCoordinator({embedding:()=>stalled,embeddingBudgetMs:30});
    const started=Date.now(),recalled=await coordinator.build('星河计划交付',null);
    assert.ok(Date.now()-started<2000);assert.equal(recalled.memoryRetrieval.embeddingFallback,true);assert.ok(recalled.memories.some(item=>item.id==='star'));
    const abort=new AbortController(),waiting=coordinator.build('星河计划交付','p1',abort.signal);abort.abort();await assert.rejects(waiting,{name:'AbortError'});
    let calls=0;const cached=new AgentMemoryCoordinator({embedding:()=>({...provider,async embed(texts:string[]){calls++;return texts.map(()=>vector);}})});
    await cached.build('星河计划交付','p1');await cached.build('星河计划交付','p1');assert.equal(calls,1);
  });
  await context.test('查询向量等待期间切换索引，旧空间不能参与排序',async()=>{
    let release!:(vectors:number[][])=>void;
    const waiting=searchRelevantMemories('星河计划','p1',{...provider,embed:()=>new Promise<number[][]>(resolve=>{release=resolve;})},8,undefined,{trackAccess:false});
    setProfile('changed-while-waiting');release([Array(1024).fill(.3)]);
    const rows=await waiting;assert.ok(rows.every(item=>item.project_id===null||item.project_id==='p1'));
    assert.equal(memoryVectorStatus(provider).compatible,false);
  });
});
