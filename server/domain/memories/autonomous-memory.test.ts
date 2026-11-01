import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ExtractedMemory } from './memory-learning-policy.js';

test('automatic memory keeps evidence, time, versions, recovery and learned context consistent',async suite=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'xiwei-learning-v2-')),'test.db');
  const {database,initializeDatabase,nowIso}=await import('../../db.js');initializeDatabase();suite.after(()=>database.close());
  const {recordMemoryObservation,curateObservation,processPendingObservations}=await import('./memory-curator.js');
  const {memoryFactKey,forgetMemory,listMemoryHistory,memoryRevision}=await import('./memory-ledger.js');
  const {updateMemory,indexSingleMemory,searchRelevantMemories}=await import('./memory-service.js');
  const {learnedContext}=await import('./learned-context.js');
  const {getAssistantPersona,updateAssistantPersona}=await import('./assistant-persona.js');
  const {assessMemoryClaim}=await import('./memory-learning-policy.js');
  database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('life','memory','日常',?,?)").run(nowIso(),nowIso());
  const observe=(text:string)=>{
    const id=randomUUID();
    database.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,'life','user',?,?)").run(id,text,nowIso());
    return recordMemoryObservation({sourceType:'conversation',sourceId:id,sourceLabel:'合成用户发言',content:'用户：'+text,metadata:{conversationId:'life'}})!;
  };
  const completion=(content:string,extra:Partial<ExtractedMemory>={})=>async(input:string)=>{
    const evidence=JSON.parse(input).evidence as Array<{id:string;text:string}>;
    return JSON.stringify({memories:[{action:'add',content,memoryType:'preference',scope:'global',subject:'user',attribute:'food.preference',facet:'香菜',value:content,stability:'long_term',statementKind:'assertion',confidence:.98,autoApply:true,evidence:{sourceId:evidence[0].id,quote:evidence[0].text},...extra}]});
  };
  let foodId='';
  await suite.test('an ordinary statement is learned, Chinese FTS works, repeated evidence does not duplicate the fact',async()=>{
    const id=observe('我不吃香菜。');
    const result=await curateObservation(id,completion('用户不吃香菜。'));
    assert.equal(result.memories.length,1);foodId=result.memories[0];
    assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(foodId)?.status,'confirmed');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ? AND memory_id=?').get('"香菜"',foodId)?.n,1);
    const before=database.prepare('SELECT evidence_count FROM memories WHERE id=?').get(foodId)!.evidence_count;
    const repeat=observe('我确实一直不吃香菜。');
    await curateObservation(repeat,completion('用户不吃香菜。',{action:'update',targetMemoryId:foodId}));
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memories WHERE fact_key=?').get(memoryFactKey(null,'user','food.preference','香菜'))?.n,1);
    assert.equal(database.prepare('SELECT evidence_count FROM memories WHERE id=?').get(foodId)?.evidence_count,Number(before)+1);
  });
  await suite.test('changing a preference keeps one current value and a readable historical chain',async()=>{
    const before=foodId,id=observe('我现在开始吃香菜了。');
    const result=await curateObservation(id,completion('用户现在吃香菜。',{action:'supersede',targetMemoryId:before,changeKind:'changed'}));
    foodId=result.memories[0];assert.ok(foodId);assert.notEqual(foodId,before);
    assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(before)?.status,'superseded');
    const current=await searchRelevantMemories('香菜','');
    assert.equal(current.some(row=>row.id===before),false);assert.ok(current.some(row=>row.id===foodId));
    assert.ok(listMemoryHistory(before).length>=2);
    assert.match(JSON.stringify(learnedContext('饮食香菜',null).userProfile),/现在吃香菜/);
  });
  await suite.test('stale extraction is rejected, invalidated for retry, and cannot overwrite a newer preference',async()=>{
    const old=observe('我刚才说错了，还是不吃香菜。');
    let release!:(value:string)=>void,started!:(value:string)=>void;
    const begun=new Promise<string>(resolve=>{started=resolve;});
    const job=curateObservation(old,async input=>{started(input);return new Promise<string>(resolve=>{release=resolve;});});
    const original=await begun;
    const newer=observe('以这次为准，我现在吃香菜，只少放一点。');
    await curateObservation(newer,completion('用户现在吃少量香菜。',{action:'update',targetMemoryId:foodId}));
    release(await completion('过时的香菜偏好。',{action:'update',targetMemoryId:foodId})(original));
    await assert.rejects(job,/记忆在整理期间已变化/);
    assert.equal(database.prepare('SELECT content FROM memories WHERE id=?').get(foodId)?.content,'用户现在吃少量香菜。');
    assert.equal(database.prepare('SELECT extraction_json FROM memory_observations WHERE id=?').get(old)?.extraction_json,null);
  });
  await suite.test('a same-key conflict uses a bounded second review instead of adding an opposing current value',async()=>{
    let calls=0;
    const id=observe('我改主意了，以后又不吃香菜了。');
    const result=await curateObservation(id,async input=>{
      calls++;
      const data=JSON.parse(input),source=data.evidence[0];
      const item={action:calls===1?'add':'supersede',content:'用户已改为不吃香菜。',memoryType:'preference',scope:'global',subject:'user',attribute:'food.preference',facet:'香菜',stability:'long_term',confidence:1,evidence:{sourceId:source.id,quote:source.text},...(calls>1?{targetMemoryId:data.conflicts[0].current.id}:{})};
      return JSON.stringify({memories:[item]});
    });
    assert.equal(calls,2);assert.equal(result.memories.length,1);foodId=result.memories[0];
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE fact_key=? AND status='confirmed'").get(memoryFactKey(null,'user','food.preference','香菜'))?.n,1);
  });
  await suite.test('temporary, uncertain, third-person and invented evidence stay outside formal memory',async()=>{
    const cases:Array<[string,Partial<ExtractedMemory>]>=[
      ['今天想吃面。',{facet:'面',stability:'temporary'}],
      ['也许我比较喜欢咖啡吧。',{facet:'咖啡',confidence:.2,autoApply:false}],
      ['我的同事喜欢辣椒。',{facet:'辣椒'}],
      ['给你设定一个虚构角色，台词是“我喜欢喝奶茶”。',{facet:'奶茶'}],
      ['假设我喜欢咖啡，你该怎么回答？',{facet:'咖啡'}],
      ['我喜欢苹果。',{facet:'苹果',evidence:{sourceId:'invented',quote:'不是原文'}}]
    ];
    for(const [text,fields] of cases)assert.deepEqual((await curateObservation(observe(text),completion(text,fields))).memories,[]);
    assert.ok(Number(database.prepare("SELECT COUNT(*) AS n FROM memory_pending_claims WHERE status='observing'").get()?.n)>=4);
  });
  await suite.test('forget invalidates versions, recent injection, lexical recall and old in-flight results',async()=>{
    const id=observe('重复提到香菜喜好。');
    let release!:(value:string)=>void,started!:(value:string)=>void;
    const begun=new Promise<string>(resolve=>{started=resolve;});
    const job=curateObservation(id,async input=>{started(input);return new Promise<string>(resolve=>{release=resolve;});});
    const input=await begun;forgetMemory(foodId);
    release(await completion('不应复活的香菜偏好。')(input));
    assert.deepEqual((await job).memories,[]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memory_id=?').get(foodId)?.n,0);
    assert.ok(listMemoryHistory(foodId).every(row=>row.snapshot.forgotten));
    assert.equal(learnedContext('香菜',null).userProfile.facts.some(row=>row.id===foodId),false);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE content='不应复活的香菜偏好。'").get()?.n,0);
    const fresh=await curateObservation(observe('这是新的决定，以后香菜可以正常吃。'),completion('用户新决定正常吃香菜。'));
    assert.equal(fresh.memories.length,1,'a genuinely new statement may establish a new preference');
  });
  await suite.test('editing while embedding runs discards old audio-independent index work',async()=>{
    const id=database.prepare("SELECT id FROM memories WHERE status='confirmed' AND subject_key='user' LIMIT 1").get()!.id as string;
    let release!:(value:number[][])=>void;
    const pending=indexSingleMemory(id,{model:'fixture',profileId:'fixture',dimension:1024,version:'fixture',embed:()=>new Promise<number[][]>(resolve=>{release=resolve;})});
    updateMemory(id,{content:'用户现在偏好经过最新修订。'});
    release([Array(1024).fill(.01)]);assert.equal(await pending,false);
  });
  await suite.test('persona revisions remain human-controlled and memory reads need no extra model call',()=>{
    const original=getAssistantPersona(),before=JSON.stringify(original.profile);
    assert.throws(()=>updateAssistantPersona({expectedRevision:0,personality:'不会写入'}),/已变化/);
    const next=updateAssistantPersona({expectedRevision:original.revision,personality:'温柔、有主见，做事利落。'});
    assert.equal(next.revision,original.revision+1);assert.equal(next.profile.identity,original.profile.identity);
    assert.notEqual(JSON.stringify(next.profile),before);
    const context=learnedContext('工作偏好',null);assert.equal(context.assistantPersona.revision,next.revision);
  });
  await suite.test('120 labelled host-admission cases preserve subject, temporal and evidence boundaries',()=>{
    let checked=0;
    const nouns=['香菜','咖啡','面条','米饭','散步','阅读','游泳','早睡','辣椒','甜食','音乐','牛奶','番茄','茶','慢跑','写作','电影','旅行','豆浆','早餐'];
    for(const noun of nouns){
      const text='我一直喜欢'+noun+'。';
      const evidence=[{id:'source',kind:'user_statement' as const,text,occurredAt:nowIso(),revision:'fixture'}];
      const base:ExtractedMemory={action:'add',subject:'user',attribute:'preference',facet:noun,content:text,memoryType:'preference',stability:'long_term',confidence:1,evidence:{sourceId:'source',quote:text}};
      const cases:Array<[ExtractedMemory,typeof evidence,boolean]>=[
        [base,evidence,true],
        [{...base,stability:'temporary'},evidence,false],
        [{...base,statementKind:'inference'},evidence,false],
        [{...base,evidence:{sourceId:'wrong',quote:text}},evidence,false],
        [{...base,confidence:.2},evidence,false],
        [{...base,subject:'person:同事'},evidence,false]
      ];
      for(const [claim,sources,expected] of cases){assert.equal(assessMemoryClaim(claim,sources).ready,expected,JSON.stringify(claim));checked++;}
    }
    assert.equal(checked,120,'this validates host gates, not a real LLM extraction accuracy score');
  });
  await suite.test('database reinitialization retains history and queued claims',()=>{
    const before=database.prepare('SELECT COUNT(*) AS n FROM memory_history').get()?.n;
    initializeDatabase();assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memory_history').get()?.n,before);
    assert.ok(Number(database.prepare('SELECT COUNT(*) AS n FROM memory_pending_claims').get()?.n)>0);
  });

  await suite.test('document versions, project ownership and user facts cannot be confused',async()=>{
    for(const id of ['project-a','project-b'])database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES(?,?,'','',?,?)").run(id,id,nowIso(),nowIso());
    database.prepare("INSERT INTO knowledge_documents(id,relative_path,title,content,modified_at,indexed_at) VALUES('doc-a','doc-a.md','客户资料','客户不吃香菜，项目采用方案A。',?,?)").run(nowIso(),nowIso());
    const capture=()=>recordMemoryObservation({projectId:'project-a',sourceType:'document',sourceId:'doc-a',sourceLabel:'客户资料',content:'客户不吃香菜，项目采用方案A。'})!;
    const personal=await curateObservation(capture(),completion('用户不吃香菜。'));
    assert.deepEqual(personal.memories,[]);
    const foreign=recordMemoryObservation({projectId:'project-a',sourceType:'document',sourceId:'doc-a',sourceLabel:'跨项目错误样例',content:'本次来源仍属于project-a。'})!;
    assert.deepEqual((await curateObservation(foreign,completion('项目B采用方案A。',{subject:'project:project-b',attribute:'decision',facet:'方案',memoryType:'project_decision',scope:'project'}))).memories,[]);
    const changed=recordMemoryObservation({projectId:'project-a',sourceType:'document',sourceId:'doc-a',sourceLabel:'旧版本',content:'文档将被修改'})!;
    let release!:(value:string)=>void,started!:(value:string)=>void;
    const begun=new Promise<string>(resolve=>{started=resolve;});
    const pending=curateObservation(changed,async input=>{started(input);return new Promise<string>(resolve=>{release=resolve;});});
    const input=await begun;
    database.prepare("UPDATE knowledge_documents SET content='项目已经改为方案B。' WHERE id='doc-a'").run();
    release(await completion('过时方案A。',{subject:'project:project-a',attribute:'decision',facet:'方案',memoryType:'project_decision',scope:'project'})(input));
    await assert.rejects(pending,/记忆在整理期间已变化/);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE content='过时方案A。'").get()?.n,0);
  });

  await suite.test('real persisted failure receipts support a lesson and experience, never a fabricated success',async()=>{
    const {createAgentRun}=await import('../agent/run-store.js');
    const {initialAgentCheckpoint}=await import('../agent/runtime.js');
    const {agentLearningObservation}=await import('./agent-observation.js');
    const run=createAgentRun({conversationId:'life',inputId:randomUUID(),goal:'导出表格',projectId:'project-a',model:'fixture',checkpoint:initialAgentCheckpoint([],'导出表格')}).run;
    database.prepare("UPDATE agent_runs SET status='failed',answer='导出未完成',error_message='格式不兼容' WHERE id=?").run(run.id);
    const {getAgentRun}=await import('../agent/run-store.js');
    const id=recordMemoryObservation({projectId:'project-a',sourceType:'conversation',sourceId:'agent:'+run.id,...agentLearningObservation(getAgentRun(run.id))})!;
    const result=await curateObservation(id,async input=>{
      const source=JSON.parse(input).evidence.find((value:any)=>value.id==='run:'+run.id);
      const base={action:'add',subject:'project:project-a',attribute:'method.export',facet:'格式',memoryType:'lesson',scope:'project',confidence:1,conditions:'导出此类表格前检查格式兼容性',evidence:{sourceId:source.id,quote:source.text}};
      return JSON.stringify({memories:[{...base,content:'不真实的导出成功经验。',outcome:'succeeded'},{...base,content:'导出表格失败，后续需要先检查格式兼容性。',outcome:'failed'},
        {...base,subject:'user',attribute:'experience.export',memoryType:'experience',facet:run.id,content:'本次导出表格未完成。',outcome:'failed'}]});
    });
    assert.equal(result.memories.length,2);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE content='不真实的导出成功经验。'").get()?.n,0);
    const context=learnedContext('导出表格','project-a');assert.equal(context.learnedMethods.length,1);assert.equal(context.experiences.length,1);
    assert.equal(learnedContext('导出表格','project-b').learnedMethods.length,0);
  });

  await suite.test('foreground work preempts learning without consuming its bounded failure retries',async()=>{
    const {beginForegroundWork}=await import('./memory-priority.js');
    const id=observe('我长期喜欢安静的书房。');let started!:()=>void;
    const begun=new Promise<void>(resolve=>{started=resolve;});
    const pending=curateObservation(id,async(_input,options)=>{started();return new Promise<string>((_resolve,reject)=>options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true}));});
    await begun;const leave=beginForegroundWork();
    try{assert.equal((await pending).processed,false);assert.equal(database.prepare('SELECT attempt_count FROM memory_observations WHERE id=?').get(id)?.attempt_count,0);
      assert.equal((await curateObservation(id,async()=>{throw Error('foreground must win');})).processed,false);
    }finally{leave();}
    const resumed=await curateObservation(id,completion('用户长期喜欢安静的书房。',{attribute:'environment.preference',facet:'书房'}));
    assert.equal(resumed.memories.length,1);
  });

  await suite.test('history, current row, FTS and durable index work roll back in one transaction',()=>{
    const id=database.prepare("SELECT id FROM memories WHERE status='confirmed' LIMIT 1").get()!.id as string;
    const before=database.prepare('SELECT * FROM memories WHERE id=?').get(id)!;
    const revision=memoryRevision(before),history=database.prepare('SELECT COUNT(*) AS n FROM memory_history').get()?.n;
    database.exec("CREATE TEMP TRIGGER fail_history BEFORE INSERT ON memory_history WHEN NEW.change_kind='edited' BEGIN SELECT RAISE(ABORT,'fixture history rollback'); END");
    try{assert.throws(()=>updateMemory(id,{content:'这个修改应当回滚。'}),/fixture history rollback/);}finally{database.exec('DROP TRIGGER fail_history');}
    assert.equal(memoryRevision(database.prepare('SELECT * FROM memories WHERE id=?').get(id)!),revision);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memory_history').get()?.n,history);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memory_id=?').get(id)?.n,1);
  });

  await suite.test('future changes wait until their effective time and then resume automatically',async context=>{
    context.mock.timers.enable({apis:['Date'],now:Date.now()});
    const id=observe('下分钟起我的周报改到周三。'),effectiveAt=new Date(Date.now()+60_000).toISOString();
    const model=completion('用户周报改为周三。',{attribute:'work_style',facet:'定时周报',effectiveAt});
    assert.deepEqual((await curateObservation(id,model)).memories,[]);
    assert.equal(database.prepare("SELECT status FROM memory_pending_claims WHERE observation_id=?").get(id)?.status,'scheduled');
    context.mock.timers.tick(61_000);
    await processPendingObservations(async(input)=>JSON.parse(input).observation?.id===id?model(input):JSON.stringify({memories:[]}),null,100);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE content='用户周报改为周三。' AND status='confirmed'").get()?.n,1);
  });

  await suite.test('a provider ignoring abort cannot hold the queue or commit its late result',async()=>{
    const {beginForegroundWork}=await import('./memory-priority.js');
    const id=observe('我现在喜欢明亮的书桌。');let started!:(value:string)=>void,release!:(value:string)=>void;
    const begun=new Promise<string>(resolve=>{started=resolve;});
    const pending=curateObservation(id,async input=>{started(input);return new Promise<string>(resolve=>{release=resolve;});});
    const input=await begun,leave=beginForegroundWork();
    try{assert.equal((await pending).processed,false);}finally{leave();}
    release(await completion('这个迟到结果不应入库。',{attribute:'environment.preference',facet:'明亮书桌'})(input));
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE content='这个迟到结果不应入库。'").get()?.n,0);
  });

  await suite.test('backdated information cannot roll current state backwards, but explicit corrections can fix an old error',async()=>{
    const first=await curateObservation(observe('我当前选择低糖饮食。'),completion('用户当前选择低糖饮食。',{attribute:'diet.preference',facet:'糖分'}));
    const id=first.memories[0];
    const past=await curateObservation(observe('这是我以前的习惯，那时候喜欢高糖饮食。'),completion('用户过去喜欢高糖饮食。',{attribute:'diet.preference',facet:'糖分',action:'supersede',targetMemoryId:id,effectiveAt:'2020-01-01T00:00:00+08:00'}));
    assert.deepEqual(past.memories,[]);assert.equal(database.prepare('SELECT status FROM memories WHERE id=?').get(id)?.status,'confirmed');
    const corrected=await curateObservation(observe('刚才说错了，我从以前到现在一直都不吃糖。'),completion('用户一直不吃糖。',{attribute:'diet.preference',facet:'糖分',action:'supersede',targetMemoryId:id,changeKind:'corrected',effectiveAt:'2020-01-01T00:00:00+08:00'}));
    assert.equal(corrected.memories.length,1);
    assert.ok(learnedContext('以前饮食糖分',null).historicalFacts.some(row=>row.id===id&&row.knownToHaveBeenCorrected));
  });

  await suite.test('a plan is not stored as an accomplished experience',async()=>{
    const result=await curateObservation(observe('我希望下周把面试准备好。'),completion('用户计划下周准备面试。',{attribute:'interview.plan',facet:'准备',memoryType:'experience',statementKind:'plan'}));
    assert.equal(result.memories.length,1);
    assert.equal(database.prepare('SELECT memory_type FROM memories WHERE id=?').get(result.memories[0])?.memory_type,'plan');
    const context=learnedContext('面试',null);assert.equal(context.experiences.some(row=>row.id===result.memories[0]),false);assert.equal(context.openPlans.length,1);
  });

  await suite.test('newly learned preferences supersede old introductory fields and forgetting clears their derived profile',async()=>{
    const {updateUserProfile,getUserProfile}=await import('./memory-curator.js');
    const intro=updateUserProfile({communication_style:'先详细解释，再给结论。'});
    const first=await curateObservation(intro.observationIds[0],completion('用户偏好先解释再给结论。',{attribute:'communication_style',facet:'',value:'先详细解释，再给结论。'}));
    const current=await curateObservation(observe('以后请先说结论，再解释。'),completion('用户偏好先给结论再解释。',{attribute:'communication_style',facet:'',value:'先给结论，再解释。',action:'update',targetMemoryId:first.memories[0]}));
    assert.equal(getUserProfile().fields.find(field=>field.key==='communication_style')?.value,'先给结论，再解释。');
    assert.match(JSON.stringify(learnedContext('回答方式',null).userProfile),/先给结论，再解释/);
    forgetMemory(current.memories[0]);
    assert.equal(getUserProfile().fields.some(field=>field.key==='communication_style'),false);
  });
});
