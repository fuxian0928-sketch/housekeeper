const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {mkdtempSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const {setTimeout:delay} = require('node:timers/promises');
const {DatabaseSync} = require('node:sqlite');
const sqliteVec = require('sqlite-vec');
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}

test('voice life HTTP uses local confirmed-memory prefetch and rejects stale or unrelated evidence', {timeout:45000}, async()=>{
 const directory=mkdtempSync(join(tmpdir(),'voice-prefetch-http-')),dbPath=join(directory,'fixture.db');
 const embeddings=[],answers=[];
 const query='写代码时有哪些审计要求';
 const marker='开发偏好证据：写代码时必须保留审计记录';
 const vector=Array(1024).fill(.03);
 const provider=createServer(async(request,response)=>{
  try{
   let body='';for await(const chunk of request)body+=chunk;const input=JSON.parse(body);
   response.setHeader('Content-Type','application/json');
   if(request.url.endsWith('/embeddings')){
    embeddings.push(...input.input);response.end(JSON.stringify({data:input.input.map((_,index)=>({index,embedding:vector}))}));return;
   }
   if(input.stream){
    answers.push(input.messages);
    response.setHeader('Content-Type','text/event-stream');
    response.end('data: '+JSON.stringify({choices:[{delta:{content:'已核对你的要求。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
   }
   const context=JSON.parse(input.messages.at(-1).content);
   const decision={domain:'work',actions:['answer_question'],query:context.message,searchQuery:null,memoryContent:null,inheritDocuments:false,requiresRetrieval:true,requiresVision:false,clarification:null,responseGoal:'依据项目约束回答',confirmation:null,taskDrafts:[]};
   response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)},finish_reason:'stop'}]}));
  }catch{response.statusCode=500;response.end('{}');}
 });
 let child,closed,output='';
 try{
  const providerPort=await listen(provider),reservation=createServer(),port=await listen(reservation);await new Promise(r=>reservation.close(r));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AI_SECRETARY_|OPENAI_|DASHSCOPE_|TAVILY_)/.test(key)));
  Object.assign(env,{AI_SECRETARY_DB_PATH:dbPath,AI_SECRETARY_SKILLS_DIR:join(directory,'skills'),AI_SECRETARY_PORT:String(port),AI_SECRETARY_HOST:'127.0.0.1',AI_SECRETARY_API_KEY:'fixture-only',AI_SECRETARY_SEED_DEMO:'0'});
  child=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('server/index.ts')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});closed=once(child,'exit');
  child.stdout.on('data',d=>output=(output+d).slice(-3000));child.stderr.on('data',d=>output=(output+d).slice(-3000));
  const root=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw Error('Isolated server exited: '+output);
   try{if((await fetch(root+'/api/health',{signal:AbortSignal.timeout(200)})).ok){ready=true;break;}}catch{}await delay(100);
  }assert.ok(ready);
  const api=async(path,body,method='POST')=>{const result=await fetch(root+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});assert.ok(result.ok,`${path}: ${result.status}`);return result;};
  await api('/api/settings',{aiEnabled:true,apiBaseUrl:`http://127.0.0.1:${providerPort}/v1`,model:'fixture-model',retrievalApiBaseUrl:`http://127.0.0.1:${providerPort}/v1`,embeddingModel:'fixture-embedding',voiceWebSearchEnabled:false,webSearchPolicy:'off'},'PATCH');
  const project=await(await api('/api/projects',{name:'预取验证项目'})).json();
  const db=new DatabaseSync(dbPath,{allowExtension:true});
  try{
   db.loadExtension(sqliteVec.getLoadablePath());const now=new Date().toISOString();
   for(const key of ['memory_auto_capture','memory_auto_apply','memory_document_capture','memory_behavior_capture'])db.prepare(`UPDATE app_settings SET value='0' WHERE key=?`).run(key);
   db.prepare(`INSERT INTO memories(id,project_id,content,memory_type,status,importance,created_at,updated_at) VALUES('fixture-memory',NULL,?,'fact','confirmed',0.2,?,?)`).run(marker,now,now);
  }finally{db.close();}
  let conversationId=null;
  const ask=async(message,mode='life',token)=>{
   const response=await api('/api/chat/stream',{message,interactionMode:'voice',deviceId:'fixture-prefetch-device',routingMode:mode,projectId:null,scope:'memory',conversationId,...(token?{voicePrefetchToken:token}:{})});
   const events=(await response.text()).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
   assert.ok(!events.some(e=>e.type==='error'),JSON.stringify(events.filter(e=>e.type==='error')));
   const done=events.find(e=>e.type==='done');assert.ok(done);conversationId=done.conversationId;return done;
  };
  await ask('你好','life');
  const start=embeddings.length;
  const candidate=await(await api('/api/voice/memory-prefetch',{query,mode:'life',projectId:null,conversationId})).json();
  assert.equal(typeof candidate.token,'string');assert.deepEqual(Object.keys(candidate),['token']);
  assert.equal(embeddings.length,start,'local life prefetch performs no embedding request');
  await ask(query,'life',candidate.token);
  assert.equal(embeddings.length,start,'consuming life prefetch remains local');
  assert.ok(answers.at(-1).some(m=>m.content.includes(marker)),'answer model must receive real scoped evidence');
  const beforeFallback=embeddings.length;await ask(query);
  assert.equal(embeddings.length,beforeFallback,'ordinary life retrieval also remains local');
  assert.ok(JSON.parse(answers.at(-1).at(-1).content).memories.includes(marker));
  const changed=await(await api('/api/voice/memory-prefetch',{query,mode:'life',projectId:null,conversationId})).json();
  await ask('出门前要不要带雨伞','life',changed.token);
  assert.ok(!JSON.parse(answers.at(-1).at(-1).content).memories.includes(marker),'unrelated final text rejects the old candidate');
  const stale=await(await api('/api/voice/memory-prefetch',{query,mode:'life',projectId:null,conversationId})).json();
  const fresh='新的审计要求：写代码时需要保留七天操作记录。';
  const writer=new DatabaseSync(dbPath);try{writer.prepare('UPDATE memories SET content=?,updated_at=? WHERE id=?').run(fresh,new Date().toISOString(),'fixture-memory');}finally{writer.close();}
  await ask(query,'life',stale.token);
  const current=JSON.parse(answers.at(-1).at(-1).content).memories;
  assert.ok(current.includes(fresh));assert.ok(!current.includes(marker),'memory revision invalidates prefetched content');
  assert.equal(embeddings.length,0,'the complete life flow has no embedding network call');
 }finally{
  if(child&&child.exitCode===null){child.kill();await closed;}
  provider.closeAllConnections();await new Promise(r=>provider.close(r));
 }
});
