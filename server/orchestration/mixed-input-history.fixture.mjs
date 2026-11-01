import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'../..'),directory=mkdtempSync(path.join(tmpdir(),'xiwei-history-real-api-'));
Object.assign(process.env,{
  AI_SECRETARY_PORT:'4373',AI_SECRETARY_HOST:'127.0.0.1',AI_SECRETARY_DB_PATH:path.join(directory,'test.db'),
  AI_SECRETARY_SKILLS_DIR:path.join(directory,'skills'),AI_SECRETARY_DOCUMENT_ROOT:path.join(directory,'documents'),AI_SECRETARY_ARTIFACT_ROOT:path.join(directory,'artifacts'),
  AI_SECRETARY_SECRET_DIRECTORY:path.join(directory,'secrets'),AI_SECRETARY_REMOTE_URL:'',AI_SECRETARY_REMOTE_TOKEN:'',AI_SECRETARY_CENTRAL_TOKEN:'',
  AI_SECRETARY_SERVER_MODE:'0',AI_SECRETARY_CLIENT_MODE:'0',AI_SECRETARY_SEED_DEMO:'0',AI_SECRETARY_STATIC_DIR:'',
  AI_SECRETARY_API_KEY:'isolated-regression-placeholder',OPENAI_API_KEY:'',AI_SECRETARY_RETRIEVAL_API_KEY:'',AI_SECRETARY_VISION_API_KEY:'',AI_SECRETARY_TAVILY_API_KEY:'',TAVILY_API_KEY:''
});
for(const name of ['skills','documents','artifacts','secrets'])mkdirSync(path.join(directory,name),{recursive:true});
const {database,initializeDatabase}=await import(pathToFileURL(path.join(root,'server/db.ts')).href);initializeDatabase();
const {SettingsService}=await import(pathToFileURL(path.join(root,'server/domain/settings/settings-service.ts')).href);

for(const key of ['memory_auto_capture_enabled','memory_auto_apply_enabled'])database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,'0',new Date().toISOString());
const captured=[];
const fake=createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw||'{}');captured.push(body.messages??[]);
  const content=JSON.stringify(body.messages??[]).includes('练手的')?'明白，这是练手原型，继续上一轮任务。':'这个原型是用于产品工作，还是练手？';
  if(body.stream){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:'stop'}]})+'\n\n');response.end('data: [DONE]\n\n');}
  else{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));}
});
await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
const mockPort=fake.address().port;
const portProbe=createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const apiPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
process.env.AI_SECRETARY_PORT=String(apiPort);
new SettingsService().update({apiBaseUrl:'http://127.0.0.1:'+mockPort+'/v1',model:'history-regression',aiEnabled:true,reasoningEffort:'low',speechExecution:'local'});
await import(pathToFileURL(path.join(root,'server/index.ts')).href);
let code=0;
try {
  const url='http://127.0.0.1:'+apiPort+'/api/chat/stream';
  for(let attempt=0;attempt<60;attempt++){
    try{if((await fetch('http://127.0.0.1:'+apiPort+'/api/health')).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const post=async data=>{
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'memory',projectId:null,routingMode:'auto',agentRuntime:true,projectRouting:'auto',reasoningEffort:'low',deviceId:'isolated-history-test',...data})});
    const raw=await response.text();return {status:response.status,raw,events:raw.split('\n').filter(Boolean).map(line=>JSON.parse(line))};
  };
  const first=await post({message:'你可以帮我随便画个原型吗',interactionMode:'voice'});
  assert.equal(first.status,200);assert.ok(!first.events.some(event=>event.type==='error'),first.raw);
  const id=first.events.find(event=>event.conversationId)?.conversationId;assert.ok(id);
  assert.equal(database.prepare('SELECT project_id FROM conversations WHERE id=?').get(id).project_id,'system-voice-conversations');
  const reply=await post({message:'练手的',interactionMode:'text',conversationId:id});
  assert.equal(reply.status,200);assert.ok(!reply.events.some(event=>event.type==='error'),reply.raw);
  assert.equal(reply.events.find(event=>event.type==='done').conversationId,id);
  const messages=database.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY rowid').all(id);
  assert.equal(messages.length,4);assert.ok(captured.some(history=>JSON.stringify(history).includes('练手的')&&JSON.stringify(history).includes('随便画个原型')));
  const stamp=new Date().toISOString();database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES('other-project','另外一个项目','','',?,?)").run(stamp,stamp);
  const switched=await post({message:'切换到另外一个项目，检查交付进展',interactionMode:'text',conversationId:id,scope:'project',projectId:'other-project'});
  assert.equal(switched.status,200);assert.ok(!switched.events.some(event=>event.type==='error'),switched.raw);assert.equal(switched.events.find(event=>event.type==='done').conversationId,id);
  assert.equal(database.prepare('SELECT project_id FROM conversations WHERE id=?').get(id).project_id,'system-voice-conversations');
  const explicit=await post({message:'检查另一个项目',interactionMode:'text',conversationId:id,scope:'project',projectId:'other-project',routingMode:'work',agentRuntime:false});
  assert.equal(explicit.status,400);
  console.log('REAL_API_REGRESSION_OK '+JSON.stringify({sameConversation:true,turns:2,storedMessages:messages.length,clarificationHistoryRetained:true,automaticProjectSwitch:true,explicitScopeStillChecked:true}));
}catch(error){code=1;console.error(error.stack??error);}
fake.closeAllConnections();fake.close();database.close();process.exit(code);
