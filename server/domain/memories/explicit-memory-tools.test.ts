import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentModel,AgentModelTurn} from '../agent/types.js';

const call=(name:string,args:Record<string,unknown>,id=name):AgentModelTurn=>({content:'',finishReason:'tool_calls',toolCalls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const answer=(content:string):AgentModelTurn=>({content,finishReason:'stop',toolCalls:[]});

test('explicit memory tools persist confirmed preferences and replace stale rules through real Agent receipts',async suite=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'explicit-memories-')),'test.db');
  const {database,initializeDatabase,nowIso}=await import('../../db.js');initializeDatabase();suite.after(()=>database.close());
  const {createMemory,updateMemory,getCoreMemorySnapshot,searchRelevantMemories}=await import('./memory-service.js');
  const {executeSkillTool,listSkillTools}=await import('../skills/skill-tool-registry.js');
  const {saveToolEnabled,saveToolPolicy}=await import('../skills/tool-controls.js');
  const {executeOfficeAgent,initialAgentCheckpoint}=await import('../agent/runtime.js');
  const {createAgentRun,listAgentInvocations,getAgentRun}=await import('../agent/run-store.js');
  const {confirmAction}=await import('../../actions/action-service.js');
  const create=(id:string,goal:string,projectId:string|null=null)=>{
    database.prepare('INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,projectId?'project':'memory',projectId,goal,nowIso(),nowIso());
    return createAgentRun({conversationId:id,inputId:id,goal,projectId,model:'fixture',checkpoint:initialAgentCheckpoint([],goal)}).run;
  };
  const contextFor=(run:ReturnType<typeof create>)=>({runId:run.id,projectId:run.projectId,vaultPath:'central://documents',confirmed:true});
  const execute=(name:string,args:Record<string,unknown>,run:ReturnType<typeof create>)=>executeSkillTool(name,args,contextFor(run)) as Promise<any>;
  const count=()=>Number(database.prepare('SELECT count(*) AS n FROM memories').get()?.n);

  await suite.test('search, automatic replace/save, recall and retry form a complete loop without repeated confirmation',async()=>{
    const old=await createMemory({content:'正式答复时先推理再给结论。',memoryType:'work_style'});
    const run=create('confirm-preferences','请记住三条：称呼我主人；正式答复先说结论，再讲推理，替换旧顺序；情绪讨论先安慰，再给方案。');
    const names=['search_memories','get_memory','save_memory','replace_memory'];
    for(const name of names)assert.ok(listSkillTools().some(tool=>tool.name===name&&tool.enabled));
    const model:AgentModel=async(messages,tools)=>{
      for(const name of names)assert.ok(tools.some(tool=>tool.function.name===name));
      assert.match(String(messages[0].content),/只有saved=true回执/);
      const calls=messages.flatMap(message=>message.tool_calls??[]),receipts=new Map(messages.filter(message=>message.role==='tool').map(message=>[message.tool_call_id!,JSON.parse(message.content??'null').result]));
      if(!calls.some(item=>item.id==='search-old'))return call('search_memories',{query:'正式答复'},'search-old');
      assert.ok(receipts.get('search-old').memories.some((row:any)=>row.id===old.memory.id));
      if(!calls.some(item=>item.id==='read-old'))return call('get_memory',{memoryId:old.memory.id},'read-old');
      if(!calls.some(item=>item.id==='replace-order'))return call('replace_memory',{memoryId:old.memory.id,expectedRevision:receipts.get('read-old').revision,content:'正式答复先说结论，再讲推理。',memoryType:'work_style'},'replace-order');
      assert.equal(receipts.get('replace-order').saved,true);
      if(!calls.some(item=>item.id==='save-address'))return call('save_memory',{content:'称呼用户为主人。',memoryType:'preference'},'save-address');
      assert.equal(receipts.get('save-address').saved,true);
      if(!calls.some(item=>item.id==='save-emotion'))return call('save_memory',{content:'情绪讨论时先安慰，再给方案。',memoryType:'preference'},'save-emotion');
      assert.equal(receipts.get('save-emotion').saved,true);
      return answer('三条偏好已保存，旧的答复顺序已被替换。');
    };
    let result=await executeOfficeAgent({runId:run.id,modelName:'fixture',model});
    assert.equal(result.run.status,'completed');
    assert.equal(listAgentInvocations(run.id).some(row=>row.status==='waiting_approval'),false);
    assert.equal(result.run.status,'completed');assert.equal(count(),4);
    assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(String(old.memory.id))?.status,'superseded');
    const current=getCoreMemorySnapshot();assert.equal(current.length,3);assert.equal(current.some(row=>row.id===old.memory.id),false);
    const recalled=await searchRelevantMemories('正式答复结论推理','');
    assert.ok(recalled.some(row=>row.content==='正式答复先说结论，再讲推理。'));
    assert.equal(recalled.some(row=>row.id===old.memory.id),false);
    for(const row of current){
      const source=database.prepare('SELECT m.role,m.run_id FROM messages m JOIN memories x ON x.source_id=m.id WHERE x.id=?').get(row.id);
      assert.equal(source?.role,'user');assert.equal(source?.run_id,run.id);
    }
    await executeOfficeAgent({runId:run.id,modelName:'fixture',model:async()=>{throw Error('must not replay a completed run');}});
    assert.equal(count(),4);assert.equal(getAgentRun(run.id).status,'completed');
    assert.equal(database.prepare('SELECT count(*) AS n FROM knowledge_documents').get()?.n,0,'no profile document is used as a substitute for actual memory');
  });

  await suite.test('an independently selected confirmation policy is still respected',async()=>{
    saveToolPolicy('save_memory','confirm');
    try{
      const run=create('explicit-tool-policy','记住以后偏好使用目录。'),before=count();
      const model:AgentModel=async messages=>messages.some(message=>message.role==='tool')?answer('已保存。'):call('save_memory',{content:'用户偏好文档带目录。',memoryType:'preference'});
      let result=await executeOfficeAgent({runId:run.id,modelName:'fixture',model});
      assert.equal(result.run.status,'waiting_approval');assert.equal(count(),before);
      const pending=listAgentInvocations(run.id).find(row=>row.status==='waiting_approval')!;
      const receipt=await confirmAction(pending.proposalId!);
      assert.deepEqual(await confirmAction(pending.proposalId!),receipt);
      result=await executeOfficeAgent({runId:run.id,modelName:'fixture',model});
      assert.equal(result.run.status,'completed');assert.equal(count(),before+1);
    }finally{saveToolPolicy('save_memory','default');}
  });

  await suite.test('version, scope, user provenance, tool disable and validity guards apply',async()=>{
    for(const id of ['p','other'])database.prepare('INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES(?,?,\'\',\'\',?,?)').run(id,id,nowIso(),nowIso());
    const run=create('guarded','请记住本次约定','p');
    const saved=await execute('save_memory',{content:'喜欢先听结论。',memoryType:'preference'},run);
    assert.equal(saved.memory.projectId,null,'personal preferences remain available across projects');
    const read=await execute('get_memory',{memoryId:saved.memory.id},run);
    updateMemory(saved.memory.id,{content:'喜欢先听简短结论。'});
    await assert.rejects(execute('replace_memory',{memoryId:read.id,expectedRevision:read.revision,content:'结论之后给证据。',memoryType:'preference'},run),/旧记忆已经变化/);
    const other=await createMemory({content:'另一个项目的事实。',projectId:'other'});
    await assert.rejects(execute('get_memory',{memoryId:other.memory.id},run),/其他项目/);
    await assert.rejects(execute('save_memory',{content:'测试越界。',projectId:'other',memoryType:'fact'},run),/其他项目/);
    database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at) VALUES('assistant-claim',?,'assistant','我已记住','[]',?)").run(run.conversationId,nowIso());
    await assert.rejects(execute('save_memory',{content:'助手自己宣称的事实。',memoryType:'fact',sourceMessageId:'assistant-claim'},run),/用户原话/);
    const external=create('external-source','另一段用户原话');
    const externalMessage=database.prepare('SELECT user_message_id FROM agent_runs WHERE id=?').get(external.id)!.user_message_id;
    await assert.rejects(execute('save_memory',{content:'不能冒用别的聊天来源。',memoryType:'fact',sourceMessageId:externalMessage},run),/用户原话/);
    await assert.rejects(execute('save_memory',{content:'密码：sample-secret-1234',memoryType:'fact'},run),/敏感凭证/);
    await assert.rejects(executeSkillTool('save_memory',{content:'无来源的调用。',memoryType:'fact'},{vaultPath:'central://documents',confirmed:true}) as Promise<unknown>,/真实来源/);
    saveToolEnabled('save_memory',false);
    try{assert.throws(()=>executeSkillTool('save_memory',{content:'被停用时不能写入。',memoryType:'fact'},contextFor(run)),/停用/);}finally{saveToolEnabled('save_memory',true);}
    const future=await createMemory({content:'未来生效专用标记。',validFrom:new Date(Date.now()+60_000).toISOString()});
    assert.equal((await execute('search_memories',{query:'未来生效专用标记'},run)).memories.some((row:any)=>row.id===future.memory.id),false);
    database.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run(nowIso(),'other');
    assert.equal((await execute('search_memories',{query:'另一个项目'},external)).memories.some((row:any)=>row.id===other.memory.id),false);
  });

  await suite.test('parallel identical saves deduplicate and candidate promotion updates the search revision',async()=>{
    const before=count(),input={content:'并发保存测试的独立偏好。',memoryType:'preference'};
    const results=await Promise.all([createMemory(input),createMemory(input)]);
    assert.equal(count(),before+1);assert.equal(results[0].memory.id,results[1].memory.id);
    const candidate=await createMemory({content:'候选确认立即可检索。',memoryType:'preference'});
    updateMemory(String(candidate.memory.id),{status:'candidate'});
    const revision=database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()!.revision;
    const confirmed=await createMemory({content:'候选确认立即可检索。',memoryType:'preference'});
    assert.equal(confirmed.memory.id,candidate.memory.id);assert.equal(confirmed.memory.status,'confirmed');
    assert.notEqual(database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()!.revision,revision);
    const stable=database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()!.revision;
    await createMemory({content:'候选确认立即可检索。',memoryType:'preference'});
    assert.equal(database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()!.revision,stable,'idempotent success must not discard a healthy semantic index');
  });

  await suite.test('a concurrent edit cannot be overwritten during semantic matching',async()=>{
    const old=await createMemory({content:'并发替换前的旧规则。'});
    let release!:(vectors:number[][])=>void,inputs=0;
    const provider={model:'fixture',dimension:1024,version:'fixture',embed(texts:string[]){inputs=texts.length;return new Promise<number[][]>(resolve=>{release=resolve;});}};
    const pending=createMemory({content:'不应写入的过期修改。',supersedesId:String(old.memory.id)},provider);
    updateMemory(String(old.memory.id),{content:'另一事务刚保存的新规则。'});
    release(Array.from({length:inputs},()=>Array(1024).fill(.02)));
    await assert.rejects(pending,/旧记忆在整理期间已变化/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM memories WHERE content='不应写入的过期修改。'").get()?.n,0);
    assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(String(old.memory.id))?.status,'confirmed');
  });

  await suite.test('replacement and search invalidation roll back atomically',async()=>{
    const old=await createMemory({content:'原子替换回滚前的旧规则。'}),before=count();
    const revision=database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()!.revision;
    database.exec(`CREATE TEMP TRIGGER block_memory_replace BEFORE UPDATE OF status ON memories WHEN OLD.id='${old.memory.id}' AND NEW.status='superseded' BEGIN SELECT RAISE(ABORT,'fixture replacement blocked'); END`);
    try{await assert.rejects(createMemory({content:'原子替换回滚的新规则。',supersedesId:String(old.memory.id)}),/fixture replacement blocked/);}finally{database.exec('DROP TRIGGER block_memory_replace');}
    assert.equal(count(),before);assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(String(old.memory.id))?.status,'confirmed');
    assert.equal(database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()!.revision,revision);
    const replacement=await createMemory({content:'原子替换回滚的新规则。',supersedesId:String(old.memory.id)});
    const remembered=await createMemory({content:'原子替换回滚前的旧规则。',allowRelated:true});
    assert.notEqual(remembered.memory.id,old.memory.id,'obsolete text must not resurrect the historical row');
    assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(String(old.memory.id))?.status,'superseded');
    assert.equal(replacement.memory.status,'confirmed');
  });

  await suite.test('replacement can reuse an existing confirmed preference without resurrecting the old row',async()=>{
    const old=await createMemory({content:'复用已有偏好时的旧规则。'});
    const existing=await createMemory({content:'复用已有偏好时的新规则。',allowRelated:true});
    const before=count(),result=await createMemory({content:'复用已有偏好时的新规则。',supersedesId:String(old.memory.id)});
    assert.equal(result.created,false);assert.equal(result.memory.id,existing.memory.id);assert.equal(count(),before);
    assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(String(old.memory.id))?.status,'superseded');
    assert.equal(database.prepare('SELECT supersedes_id FROM memories WHERE id=?').get(String(existing.memory.id))?.supersedes_id,old.memory.id);
    const controller=new AbortController();controller.abort();
    await assert.rejects(createMemory({content:'已取消的保存不能落库。'},undefined,controller.signal),{name:'AbortError'});
    assert.equal(count(),before);
  });

  await suite.test('a similar but different record never produces a false saved receipt',async()=>{
    const previous='收到会议邀请后，提前核对议程、参会名单、会议室、材料清单、截止时间和各方准备情况，结束后再整理纪要。';
    await createMemory({content:previous,memoryType:'preference'});
    const run=create('similar-only','会议结束后改为整理行动清单。'),before=count();
    const result=await execute('save_memory',{content:previous.replace('结束后再整理纪要','结束后再整理行动清单'),memoryType:'preference'},run);
    assert.equal(result.saved,false);assert.equal(count(),before);assert.equal(result.memory.content,previous);
    assert.match(result.notice,/当前没有保存新内容/);
  });
});
