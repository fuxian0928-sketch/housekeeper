const test=require('node:test'),assert=require('node:assert/strict');
const {createServer}=require('node:http'),{once}=require('node:events'),{spawn}=require('node:child_process');
const {mkdtempSync}=require('node:fs'),{tmpdir}=require('node:os'),{join,resolve}=require('node:path');
const {setTimeout:delay}=require('node:timers/promises'),{DatabaseSync}=require('node:sqlite');
const {createNativeSharedChat}=require('tsx/cjs/api').require('../../server/providers/native-shared-chat.ts',__filename);
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}

test('native voice shares the current tool-call agent, project scope, approval, life history and expression settings',{timeout:60000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'voice-work-http-')),dbPath=join(directory,'fixture.db');
 const voiceInputs=[],voiceInstructions=[],toolProjects=[];
 const provider=createServer(async(request,response)=>{
  try{
   let raw='';for await(const chunk of request)raw+=chunk;const input=JSON.parse(raw);
   if(input.stream){
    let content='我在，主人。',call;
    if(Array.isArray(input.tools)){
     const calls=input.messages.flatMap(message=>message.tool_calls??[]);
     const available=input.tools.some(tool=>tool.function.name==='create_task');
     if(!available)content='任务创建工具已停用。';
     else if(!calls.some(item=>item.function.name==='create_task')){
      const projectId=input.messages.map(message=>typeof message.content==='string'?message.content:'').join('\n').match(/当前项目范围：([^。\n]+)/u)?.[1];
      assert.ok(projectId&&!projectId.includes('全局'));toolProjects.push(projectId);
      call={index:0,id:'task-'+toolProjects.length,type:'function',function:{name:'create_task',arguments:JSON.stringify({projectId,title:input.messages.filter(message=>message.role==='user').at(-1).content})}};
     }else content='已处理当前任务请求。';
    }else{voiceInputs.push(JSON.parse(input.messages.at(-1).content));voiceInstructions.push(input.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n'));}
    response.setHeader('Content-Type','text/event-stream');
    response.end('data: '+JSON.stringify({choices:[{index:0,delta:call?{tool_calls:[call]}:{content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');return;
   }
   response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({excerpts:[],memories:[],reflection:'',skillNames:[]})},finish_reason:'stop'}]}));
  }catch(error){response.statusCode=500;response.end(JSON.stringify({error:{message:error.message}}));}
 });
 let child,closed,output='';
 try{
  const providerPort=await listen(provider),reservation=createServer(),port=await listen(reservation);await new Promise(done=>reservation.close(done));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AI_SECRETARY_|OPENAI_|DASHSCOPE_|TAVILY_)/.test(key)));
  Object.assign(env,{AI_SECRETARY_DB_PATH:dbPath,AI_SECRETARY_SKILLS_DIR:join(directory,'skills'),AI_SECRETARY_PORT:String(port),AI_SECRETARY_HOST:'127.0.0.1',AI_SECRETARY_API_KEY:'fixture-only',AI_SECRETARY_SEED_DEMO:'0'});
  child=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('server/index.ts')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});closed=once(child,'exit');
  child.stdout.on('data',data=>output=(output+data).slice(-4000));child.stderr.on('data',data=>output=(output+data).slice(-4000));
  const root='http://127.0.0.1:'+port;
  let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(root+'/api/health',{signal:AbortSignal.timeout(250)})).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,output);
  const api=async(path,body,method='POST')=>{const response=await fetch(root+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});assert.ok(response.ok,path+': '+response.status);return response;};
  await api('/api/settings',{aiEnabled:true,apiBaseUrl:'http://127.0.0.1:'+providerPort+'/v1',model:'fixture-model',voiceWebSearchEnabled:false,webSearchPolicy:'off'},'PATCH');
  const projects=[];for(const name of ['语音项目甲','语音项目乙'])projects.push(await(await api('/api/projects',{name})).json());
  const expression={version:1,address:'小林',length:'balanced',prompt:'语气干练温柔，少用语气词。'};
  await api('/api/voice/expression',expression,'PUT');
  const db=new DatabaseSync(dbPath);
  for(const key of ['memory_auto_capture','memory_auto_apply','memory_document_capture','memory_behavior_capture'])db.prepare("UPDATE app_settings SET value='0' WHERE key=?").run(key);
  db.close();
  await api('/api/skills/tools/create_task/policy',{policy:'confirm'},'PATCH');
  let conversationId=null,settings={routingMode:'work',projectId:projects[0].id};
  const ask=async text=>{
   const answer=createNativeSharedChat({baseUrl:root,settings:()=>({...settings,deviceId:'fixture-voice-device',conversationId}),onConversation:id=>{conversationId=id;}});
   let content='';for await(const delta of answer({key:{sessionId:'fixture-session',turnId:1,generation:1},text,signal:AbortSignal.timeout(15000),beginPlayback:()=>true}))content+=delta;
   assert.ok(conversationId);return content;
  };
  const tasks=()=>{const database=new DatabaseSync(dbPath,{readOnly:true});try{return database.prepare('SELECT project_id,title FROM tasks ORDER BY rowid').all();}finally{database.close();}};
  for(const [index,project] of projects.entries()){
   settings={routingMode:'work',projectId:project.id};
   assert.match(await ask('创建演示待办'+index),/确认|准备好|尚未/);
   const pendingConversation=conversationId;
   assert.equal(tasks().length,index,'no task is written before approval');
   assert.match(await ask('确认'),/任务/);
   assert.equal(conversationId,pendingConversation,'approval resumes its original conversation');
   assert.equal(tasks().length,index+1);
   settings={routingMode:'life',projectId:null};await ask('你好');
   assert.match(voiceInstructions.at(-1),/小林/);assert.match(voiceInstructions.at(-1),/语气干练温柔/);
   assert.equal(voiceInputs.at(-1).message,'你好');
  }
  assert.deepEqual(tasks().map(row=>row.project_id),projects.map(project=>project.id));
  assert.deepEqual(toolProjects,projects.map(project=>project.id));
  settings={routingMode:'work',projectId:projects[0].id};
  await api('/api/skills/tools/create_task/enabled',{enabled:false},'PATCH');assert.match(await ask('创建被禁用的任务'),/停用/);assert.equal(tasks().length,2);
  await api('/api/skills/tools/create_task/enabled',{enabled:true},'PATCH');
  assert.match(await ask('创建稍后取消的任务'),/确认|准备好|尚未/);await ask('取消');assert.equal(tasks().length,2);
  await api('/api/voice/expression',{...expression,address:'小夏',length:'detailed'},'PUT');
  settings={routingMode:'life',projectId:null};await ask('你好');assert.match(voiceInstructions.at(-1),/小夏/);assert.match(voiceInstructions.at(-1),/160–300/);
  const check=new DatabaseSync(dbPath,{readOnly:true});try{assert.equal(check.prepare("SELECT count(*) AS n FROM action_proposals WHERE status='pending'").get().n,0);assert.equal(check.prepare('SELECT count(*) AS n FROM conversations WHERE id=?').get(conversationId).n,1);}finally{check.close();}
 }finally{if(child&&child.exitCode===null){child.kill();await closed;}provider.closeAllConnections();await new Promise(done=>provider.close(done));}
});
