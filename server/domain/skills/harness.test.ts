import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('harness: real MCP transport, confirmation, switches, failures and complete skill rollback',async t=>{
  const root=mkdtempSync(join(tmpdir(),'xiaoe-harness-'));
  process.env.AI_SECRETARY_DB_PATH=join(root,'test.db');process.env.AI_SECRETARY_SKILLS_DIR=join(root,'skills');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
  let calls=0;
  let sse:import('node:http').ServerResponse|undefined;
  const remote=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer test-secret'){res.writeHead(401).end();return;}
    if(req.method==='GET'&&req.url==='/sse'){sse=res;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write('event: endpoint\ndata: /events\n\n');return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let body='';for await(const part of req)body+=part;const input=JSON.parse(body);
    if(input.id===undefined){res.writeHead(202).end();return;}
    let result:unknown={};
    if(input.method==='initialize')result={protocolVersion:input.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    if(input.method==='tools/list')result={tools:[{name:'echo',description:'回声',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}},{name:'fail',description:'失败测试',inputSchema:{type:'object'}}]};
    if(input.method==='tools/call'){calls++;await new Promise(r=>setTimeout(r,60));result=input.params.name==='fail'?{isError:true,content:[{type:'text',text:'private provider detail'}]}:{content:[{type:'text',text:input.params.arguments.text}]};}
    const output=JSON.stringify({jsonrpc:'2.0',id:input.id,result});
    if(req.url==='/events'){sse?.write(`event: message\ndata: ${output}\n\n`);res.writeHead(202).end();}
    else res.writeHead(200,{'Content-Type':'application/json'}).end(output);
  });
  await new Promise<void>(r=>remote.listen(0,'127.0.0.1',r));
  t.after(()=>{remote.closeAllConnections();remote.close();database.close();});
  const address=remote.address() as {port:number};
  const mcp=await import('./mcp-connections.js');const controls=await import('./tool-controls.js');
  const {executeSkillTool,listSkillTools}=await import('./skill-tool-registry.js');
  const {runSkillTools}=await import('./skill-executor.js');const {confirmAction}=await import('../../actions/action-service.js');
  const connection=mcp.saveMcpConnection({name:'联调',url:`http://127.0.0.1:${address.port}/mcp`,transport:'http',token:'test-secret'});
  assert.equal(connection.hasToken,true);assert.ok(!JSON.stringify(mcp.listMcpConnections()).includes('test-secret'));
  assert.ok(!String((database.prepare('SELECT secret FROM mcp_connections').get() as {secret:string}).secret).includes('test-secret'));
  assert.equal((await mcp.discoverMcpTools(connection.id)).toolCount,2);
  const tool=listSkillTools().find(t=>t.name.endsWith('__echo'))!;assert.ok(tool);
  const context={vaultPath:'central://documents'};
  await assert.rejects(async()=>executeSkillTool(tool.name,{text:42},context),/Schema/);assert.equal(calls,0);
  database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('mcp-chat','global','test','now','now')").run();
  const input={message:'回声 hello',conversationId:'mcp-chat',skills:[],skillInstruction:'',context,complete:async()=>JSON.stringify({toolCalls:[{tool:tool.name,arguments:{text:'hello'}}]})};
  const planned=await runSkillTools(input);assert.equal(planned.pending.length,1);assert.equal(calls,0);
  const pendingResult=confirmAction(planned.pending[0].id);
  assert.throws(()=>confirmAction(planned.pending[0].id),/已经执行|关闭/);
  const result=await pendingResult;assert.match(JSON.stringify(result),/hello/);assert.equal(calls,1);
  await confirmAction(planned.pending[0].id);assert.equal(calls,1,'repeat confirmation must not repeat external writes');
  controls.saveToolPolicy(tool.name,'auto');const automatic=await runSkillTools(input);assert.equal(automatic.pending.length,0);assert.match(automatic.context,/hello/);assert.equal(calls,2);
  controls.saveToolEnabled(tool.name,false);await assert.rejects(async()=>executeSkillTool(tool.name,{text:'no'},context),/停用/);assert.equal(calls,2);
  controls.saveToolEnabled(tool.name,true);controls.saveToolPolicy(tool.name,'confirm');
  await assert.rejects(async()=>executeSkillTool(tool.name,{text:'no'},context),/确认/);
  const failing=listSkillTools().find(t=>t.name.endsWith('__fail'))!;
  await assert.rejects(async()=>executeSkillTool(failing.name,{},context),/返回失败/);
  const runs=controls.listToolRuns() as Array<{status:string;error:string}>;
  assert.equal(runs[0].status,'failed');assert.ok(!JSON.stringify(runs).includes('private provider detail'));
  mcp.setMcpEnabled(connection.id,false);assert.ok(!listSkillTools().some(t=>t.name===tool.name));
  mcp.setMcpEnabled(connection.id,true);
  mcp.saveMcpConnection({name:'改名',url:connection.url,transport:'http',token:'new-secret'},connection.id);
  assert.ok(!listSkillTools().some(t=>t.name===tool.name),'editing clears tool catalog');
  await assert.rejects(()=>mcp.discoverMcpTools(connection.id),/失败/);
  mcp.deleteMcpConnection(connection.id);assert.equal(mcp.listMcpConnections().length,0);
  const legacy=mcp.saveMcpConnection({name:'SSE',url:`http://127.0.0.1:${address.port}/sse`,transport:'sse',token:'test-secret'});
  assert.equal((await mcp.discoverMcpTools(legacy.id)).toolCount,2);
  const legacyTool=listSkillTools().find(t=>t.name.endsWith('__echo'))!;
  assert.match(JSON.stringify(await executeSkillTool(legacyTool.name,{text:'SSE works'},context)),/SSE works/);
  mcp.deleteMcpConnection(legacy.id);

  const skills=await import('./skill-manager.js');
  const first=await skills.buildManagedSkill({name:'revision-test',description:'原版用途',instructions:'原版规则'});
  mkdirSync(join(first.installPath,'references'));writeFileSync(join(first.installPath,'references','guide.md'),'原版附带规则');
  await skills.buildManagedSkill({name:first.name,description:'新版用途',instructions:'新版规则',replace:true});
  const versions=await skills.listSkillRevisions(first.id) as Array<{id:string;version:string}>;assert.equal(versions.length,2);
  skills.setManagedSkillEnabled(first.id,false);
  const restored=await skills.rollbackSkillRevision(first.id,versions.find(v=>v.version==='1')!.id);
  assert.equal(restored.version,'3');assert.equal(restored.description,'原版用途');assert.equal(restored.enabled,false);
  assert.match(readFileSync(join(restored.installPath,'SKILL.md'),'utf8'),/原版规则/);
  assert.equal(readFileSync(join(restored.installPath,'references','guide.md'),'utf8'),'原版附带规则');
  await assert.rejects(()=>skills.rollbackSkillRevision(first.id,'invalid'),/不存在/);
  await Promise.all([skills.buildManagedSkill({name:first.name,description:'并发一',instructions:'一',replace:true}),skills.buildManagedSkill({name:first.name,description:'并发二',instructions:'二',replace:true})]);
  assert.equal(skills.listManagedSkills().find(s=>s.id===first.id)?.version,'5');
});
