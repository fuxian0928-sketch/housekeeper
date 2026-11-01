import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('memory starfield is a sourced projection with current state, history, scope and forgetting',async suite=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'xiwei-starfield-')),'test.db');
  const {database,initializeDatabase,nowIso}=await import('../../db.js');initializeDatabase();suite.after(()=>database.close());
  const {buildMemoryGraph}=await import('./memory-graph.js');
  const {commitMemoryMutation,forgetMemory,memoryFactKey}=await import('./memory-ledger.js');
  const {recordMemoryObservation}=await import('./memory-curator.js');
  const stamp=nowIso(),factKey=memoryFactKey(null,'user','food.preference','coffee');
  for(const id of ['project-one','project-two'])database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES(?,?, '', '',?,?)").run(id,id,stamp,stamp);
  database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('chat','memory','合成聊天',?,?)").run(stamp,stamp);
  const source=(id:string,content:string)=>{
    database.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,'chat','user',?,?)").run(id,content,stamp);
    return recordMemoryObservation({sourceType:'conversation',sourceId:id,sourceLabel:'合成用户发言',content})!;
  };
  const memory=(id:string,content:string,sourceId:string,observation:string,options:{project?:string;state?:string;replaces?:string}={})=>{
    commitMemoryMutation({ids:[id],kind:'learned'},()=>{
      database.prepare(`INSERT INTO memories(id,project_id,content,memory_type,status,source_type,source_id,source_label,created_at,updated_at,fact_key,supersedes_id) VALUES(?,?,?,'preference',?,'conversation',?,'合成依据',?,?,?,?)`).run(id,options.project??null,content,options.state??'confirmed',sourceId,stamp,stamp,options.project?'':factKey,options.replaces??null);
      database.prepare("INSERT INTO memory_sources(memory_id,observation_id,source_type,source_id,source_label,excerpt,created_at) VALUES(?,?,'conversation',?,'合成原话',?,?)").run(id,observation,sourceId,content,stamp);
    });
  };
  const oldSource=source('msg-old','我喜欢加糖的咖啡。'),newSource=source('msg-new','现在喝咖啡不加糖了。');
  memory('old','喜欢加糖咖啡','msg-old',oldSource,{state:'superseded'});memory('current','喝咖啡不加糖','msg-new',newSource,{replaces:'old'});
  await suite.test('current view never includes superseded or speculative conclusions',()=>{
    database.prepare("INSERT INTO memories(id,content,status,source_label,created_at,updated_at) VALUES('candidate','未确认猜测','candidate','',?,?)").run(stamp,stamp);
    const graph=buildMemoryGraph();assert.ok(graph.nodes.some(n=>n.id==='memory:current'));assert.ok(!graph.nodes.some(n=>['memory:old','memory:candidate'].includes(n.id)));
    assert.ok(graph.edges.some(e=>e.source==='message:msg-new'&&e.target==='memory:current'&&e.kind==='evidence'));
    assert.equal(graph.revision,buildMemoryGraph().revision);
  });
  await suite.test('history follows replacement even when the current result limit excludes ancestors',()=>{
    const graph=buildMemoryGraph({history:true,limit:1});assert.ok(graph.nodes.some(n=>n.id==='memory:old'&&n.state==='historical'));
    assert.ok(graph.edges.some(e=>e.source==='memory:old'&&e.target==='memory:current'&&e.kind==='updates'));
  });
  await suite.test('a ledger update changes the graph without writing a second graph store',()=>{
    const before=buildMemoryGraph().revision,count=database.prepare('SELECT count(*) AS n FROM memories').get()!.n;
    commitMemoryMutation({ids:['current'],kind:'supplemented'},()=>database.prepare("UPDATE memories SET content='喝咖啡不加糖，而且只在上午喝',updated_at=? WHERE id='current'").run(nowIso()));
    const graph=buildMemoryGraph({history:true});assert.notEqual(graph.revision,before);assert.ok(graph.nodes.some(n=>n.id==='memory:current'&&n.content.includes('上午')));
    assert.ok(graph.nodes.some(n=>n.id.startsWith('version:current:')&&n.content==='喝咖啡不加糖'));
    assert.equal(database.prepare('SELECT count(*) AS n FROM memories').get()!.n,count);
  });
  await suite.test('project filtering and soft deletion do not expose other project nodes',()=>{
    const obs=recordMemoryObservation({projectId:'project-two',sourceType:'event',sourceId:'event-two',sourceLabel:'另一个项目',content:'合成的项目二资料'})!;
    memory('other-project','合成项目二状态','event-two',obs,{project:'project-two'});
    const graph=buildMemoryGraph({projectId:'project-one',history:true});assert.ok(graph.nodes.every(n=>n.projectId==='project-one'));assert.ok(!JSON.stringify(graph).includes('合成项目二状态'));
    database.prepare("UPDATE projects SET deleted_at=? WHERE id='project-two'").run(stamp);assert.ok(!buildMemoryGraph().nodes.some(n=>n.id==='memory:other-project'));
  });
  await suite.test('events share a sequence only for a real common object, with no causal claim',()=>{
    for(const [id,object] of [['event-one','task-one'],['event-next','task-one'],['event-unrelated','task-two']])database.prepare("INSERT INTO events(id,project_id,event_type,title,detail,object_type,object_id,created_at) VALUES(?,'project-one','task_updated',?,'合成执行记录','task',?,?)").run(id,id,object,stamp);
    const graph=buildMemoryGraph({projectId:'project-one'}),sequence=graph.edges.filter(e=>e.kind==='sequence');assert.equal(sequence.length,1);assert.equal(sequence[0].label,'同一事务的后续记录');
    assert.ok(sequence.every(e=>!e.source.includes('unrelated')&&!e.target.includes('unrelated')));
  });
  await suite.test('document evidence uses the real knowledge schema and keeps a source reference',()=>{
    database.prepare("INSERT INTO knowledge_documents(id,relative_path,title,excerpt,content,modified_at,indexed_at) VALUES('doc','合成原文.md','合成评审原文','','本周完成页面评审',?,?)").run(stamp,stamp);
    const observation=recordMemoryObservation({projectId:'project-one',sourceType:'document',sourceId:'doc',sourceLabel:'合成原文',content:'本周完成页面评审',metadata:{documentId:'doc'}})!;
    database.prepare("INSERT INTO memories(id,project_id,content,status,source_type,source_id,source_label,created_at,updated_at) VALUES('doc-memory','project-one','本周完成页面评审','confirmed','document','doc','合成原文',?,?)").run(stamp,stamp);
    database.prepare("INSERT INTO memory_sources(memory_id,observation_id,source_type,source_id,source_label,excerpt,created_at) VALUES('doc-memory',?,'document','doc','合成原文','本周完成页面评审',?)").run(observation,stamp);
    const graph=buildMemoryGraph({projectId:'project-one'}),document=graph.nodes.find(node=>node.source?.kind==='document');
    assert.equal(document?.source?.id,'doc');assert.equal(document?.title,'合成评审原文');assert.equal(document?.content,'本周完成页面评审');
    assert.ok(graph.edges.some(edge=>edge.source===document?.id&&edge.target==='memory:doc-memory'));
  });
  await suite.test('forgotten facts lose their whole graph history and original-source previews',()=>{
    forgetMemory('current');const graph=buildMemoryGraph({history:true});
    assert.ok(!graph.nodes.some(n=>n.id.includes('current')||n.id==='memory:old'||n.id==='message:msg-old'||n.id==='message:msg-new'));
    assert.ok(!JSON.stringify(graph).includes('喝咖啡不加糖'));
    assert.ok(graph.edges.every(e=>graph.nodes.some(n=>n.id===e.source)&&graph.nodes.some(n=>n.id===e.target)));
  });
  await suite.test('memory graph HTTP contract is private-cache-safe and bounded',async()=>{
    const express=(await import('express')).default,{registerMemoryRoutes}=await import('../../api/memories.js');
    const app=express();registerMemoryRoutes(app,{embeddingProvider:()=>null,requestSignal:()=>new AbortController().signal,canUseModel:()=>false,complete:async()=>{throw Error('No model request expected');}});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    try{
      const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/memory-graph?limit=999999`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
      const result=await response.json();assert.equal(typeof result.revision,'string');assert.ok(result.nodes.length<=360);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
