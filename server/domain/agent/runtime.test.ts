import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import ExcelJS from 'exceljs';
import type { AgentModel,AgentModelTurn } from './types.js';

const call=(name:string,args:Record<string,unknown>,id=name):AgentModelTurn=>({content:'',finishReason:'tool_calls',toolCalls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const answer=(content:string):AgentModelTurn=>({content,finishReason:'stop',toolCalls:[]});
test('office agent preserves real work across approval, restart, new capability and spreadsheets',async context=>{
  const directory=mkdtempSync(join(tmpdir(),'office-agent-'));
  process.env.AI_SECRETARY_DB_PATH=join(directory,'test.db');process.env.AI_SECRETARY_DOCUMENT_ROOT=join(directory,'raw');process.env.AI_SECRETARY_ARTIFACT_ROOT=join(directory,'files');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();context.after(()=>database.close());
  const {createAgentRun,getAgentRun,listAgentInvocations,listAgentArtifacts,recoverAgentRun,agentEventsAfter}=await import('./run-store.js');
  const {executeOfficeAgent,initialAgentCheckpoint,stopOfficeAgent}=await import('./runtime.js');
  const {confirmAction}=await import('../../actions/action-service.js');
  const {createKnowledgeDocument,updateKnowledgeDocument,getKnowledgeDocumentVersion}=await import('../documents/knowledge-document-editor.js');
  const {executeSkillTool}=await import('../skills/skill-tool-registry.js');
  const {importOfficeDocument}=await import('../documents/office-document-parser.js');
  const {saveHttpTool}=await import('../skills/http-tools.js');
  const {saveToolPolicy}=await import('../skills/tool-controls.js');
  database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES('office-project','产品发布','','','2026-10-21','2026-10-21')").run();
  const create=(id:string,goal:string,projectId:string|null='office-project')=>{
    database.prepare('INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,projectId?'project':'memory',projectId,goal,'2026-10-21','2026-10-21');
    return createAgentRun({conversationId:id,inputId:`input-${id}`,goal,projectId,model:'test-model',checkpoint:initialAgentCheckpoint([],goal)}).run;
  };
  await context.test('document plus two follow-up tasks resumes the same goal without repeating writes',async()=>{
    const source=createKnowledgeDocument({projectId:'office-project',title:'本周进展',content:'# 本周进展\n完成访谈，等待上线范围确认。'});
    const run=create('composite','参考资料写周报，保存后创建两项后续待办');
    const model:AgentModel=async messages=>{
      const pending=new Set<string>();for(const item of messages){if(item.role==='assistant')for(const call of item.tool_calls??[])pending.add(call.id);else if(item.role==='tool')pending.delete(item.tool_call_id!);else assert.equal(pending.size,0,'new input must follow all native tool receipts');}
      const names=messages.flatMap(message=>message.tool_calls?.map(item=>item.function.name)??[]);
      if(!names.includes('get_document'))return call('get_document',{documentId:source.id},'read-source');
      if(!names.includes('create_document'))return call('create_document',{projectId:'office-project',title:'本周周报',content:'# 本周周报\n\n已完成访谈。\n\n## 风险\n上线范围待确认。'},'save-report');
      if(!names.includes('create_task'))return {content:'',finishReason:'tool_calls',toolCalls:[call('create_task',{projectId:'office-project',title:'确认上线范围'},'task-one').toolCalls[0],call('create_task',{projectId:'office-project',title:'整理验收清单'},'task-two').toolCalls[0]]};
      return answer('周报已保存，两个后续待办已经创建。');
    };
    let result=await executeOfficeAgent({runId:run.id,modelName:'test-model',model});
    assert.equal(result.run.status,'waiting_approval');
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE title='本周周报'").get()?.n,0);
    const before=getAgentRun(run.id).checkpoint.pendingCalls;
    const script=`import {initializeDatabase,database} from ${JSON.stringify(new URL('../../db.ts',import.meta.url).href)};import {getAgentRun} from ${JSON.stringify(new URL('./run-store.ts',import.meta.url).href)};initializeDatabase();console.log(JSON.stringify(getAgentRun(${JSON.stringify(run.id)}).checkpoint.pendingCalls));database.close();`;
    const recovered=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',env:process.env});
    assert.deepEqual(JSON.parse(recovered.trim()),before,'fresh Node process reads the exact persisted native tool call');
    for(let approval=0;approval<3;approval++){
      const pending=listAgentInvocations(run.id).find(item=>item.status==='waiting_approval');assert.ok(pending?.proposalId);
      await confirmAction(pending.proposalId);
      result=await executeOfficeAgent({runId:run.id,modelName:'test-model',model,additionalInput:approval===0?'确认了，请继续':undefined});
    }
    assert.equal(result.run.status,'completed');
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE title='本周周报'").get()?.n,1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id='office-project'").get()?.n,2);
    assert.ok(listAgentArtifacts(run.id).some(artifact=>artifact.kind==='document'&&artifact.documentId));
    const duplicate=createAgentRun({conversationId:run.conversationId,inputId:run.inputId,goal:run.goal,projectId:run.projectId,model:run.model,checkpoint:initialAgentCheckpoint([],run.goal)});
    assert.equal(duplicate.created,false);assert.equal(duplicate.run.id,run.id);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND role='user' AND content=?").get(run.id,run.goal)?.n,1);
    const events=agentEventsAfter(run.id);assert.deepEqual(agentEventsAfter(run.id,events[1].seq).map(event=>event.seq),events.slice(2).map(event=>event.seq));
    await executeOfficeAgent({runId:run.id,modelName:'test-model',model:async()=>{throw new Error('completed goal must not rerun');}});
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id='office-project'").get()?.n,2);
  });
  await context.test('new configured HTTP capability is discovered and an unknown write never repeats',async()=>{
    let writes=0;const remote=createServer((_request,response)=>{writes++;response.writeHead(writes===1?500:200,{'Content-Type':'application/json'});response.end(writes===1?'{"message":"receipt lost"}':'{"saved":true}');});await new Promise<void>(resolve=>remote.listen(0,'127.0.0.1',resolve));context.after(()=>new Promise<void>(resolve=>remote.close(()=>resolve())));
    const port=(remote.address() as {port:number}).port;
    const tool=saveHttpTool({name:'新增报销服务',description:'提交报销草稿',url:`http://127.0.0.1:${port}/expense`,method:'POST',schema:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}});
    saveToolPolicy(tool.toolName,'auto');const run=create('external','将出差草稿提交到报销服务',null);
    const model:AgentModel=async(messages,tools)=>{
      const names=messages.flatMap(message=>message.tool_calls?.map(item=>item.function.name)??[]);
      if(!names.includes('find_capabilities'))return call('find_capabilities',{query:'报销'},'discover');
      if(!names.includes('load_capability'))return call('load_capability',{name:tool.toolName},'load');
      const alias=tools.find(item=>item.function.description.includes('新增报销服务'))!.function.name;
      if(names.includes(alias))return answer('已提交报销草稿。');
      return call(alias,{title:'出差报销草稿'},'external-write');
    };
    const result=await executeOfficeAgent({runId:run.id,modelName:'test-model',model});assert.equal(result.run.status,'reconciling');assert.equal(writes,1);
    await executeOfficeAgent({runId:run.id,modelName:'test-model',model});assert.equal(writes,1);
    assert.equal(listAgentInvocations(run.id).find(item=>item.mode==='write')?.status,'unknown');
    const {registerAgentRoutes}=await import('../../api/agent.js');const app=express();app.use(express.json());registerAgentRoutes(app,{canUseModel:()=>true,defaultModel:()=> 'test-model',model:()=>model,requestSignal:()=>new AbortController().signal});
    const apiServer=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>apiServer.on('listening',resolve));context.after(()=>new Promise<void>(resolve=>apiServer.close(()=>resolve())));
    const response=await fetch(`http://127.0.0.1:${(apiServer.address() as {port:number}).port}/api/agent/runs/${run.id}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invocationId:listAgentInvocations(run.id).find(item=>item.mode==='write')!.id,outcome:'not_applied',evidence:'已在目标系统核对，未生成报销记录'})});assert.equal(response.status,200);
    const resumed=await executeOfficeAgent({runId:run.id,modelName:'test-model',model});assert.equal(resumed.run.status,'completed');assert.equal(writes,2,'only an explicitly reconciled absent effect may dispatch again');
  });
  await context.test('historical document versions remain usable as distinct artifact sources',async()=>{
    const source=createKnowledgeDocument({projectId:'office-project',title:'验收规则',content:'首版验收规则'}),run=create('historical','基于文档历史整理说明');
    updateKnowledgeDocument(String(source.id),{content:'修订后的验收规则'});assert.match(getKnowledgeDocumentVersion(String(source.id),1).content,/首版验收规则/);
    const model:AgentModel=async messages=>{const names=messages.flatMap(item=>item.tool_calls?.map(call=>call.function.name)??[]);if(!names.includes('get_document_version'))return call('get_document_version',{documentId:source.id,revision:1},'history');if(!names.includes('show_draft'))return call('show_draft',{title:'历史说明',content:'依据首版验收规则整理。',sourceDocumentIds:[source.id]},'draft');return answer('历史说明已整理成草稿。');};
    const result=await executeOfficeAgent({runId:run.id,modelName:'test-model',model});assert.equal(result.run.status,'completed');assert.equal(result.run.checkpoint.sources[0].version,1);assert.equal(listAgentArtifacts(run.id)[0].kind,'markdown');
  });
  await context.test('programmatic spreadsheet sums are exported without model retyping',async()=>{
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('费用');sheet.addRows([['项目','金额'],['A',10],['A',20],['B',5],['A','待核对']]);
    const imported=await importOfficeDocument({filename:'费用明细.xlsx',contentBase64:Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'),projectId:'office-project'});
    const documentId=imported.document.id,run=create('sheet','汇总各项目费用并导出Excel');
    const model:AgentModel=async messages=>{
      const names=messages.flatMap(message=>message.tool_calls?.map(item=>item.function.name)??[]);
      if(!names.includes('summarize_spreadsheet'))return call('summarize_spreadsheet',{documentId,sheet:'费用',groupBy:'项目',valueColumn:'金额',operation:'sum'},'sum');
      if(!names.includes('export_spreadsheet')){const invocation=listAgentInvocations(run.id).find(item=>item.toolName==='summarize_spreadsheet')!;return call('export_spreadsheet',{title:'费用汇总',fromInvocationId:invocation.id},'export');}
      return answer('已导出费用汇总。1个非数值单元格需要人工核对。');
    };
    let result=await executeOfficeAgent({runId:run.id,modelName:'test-model',model});assert.equal(result.run.status,'waiting_approval');
    const summary=listAgentInvocations(run.id).find(item=>item.toolName==='summarize_spreadsheet')!.result as {rows:unknown[];skippedNumericCells:number};
    assert.deepEqual(summary.rows,[['A',30,2],['B',5,1]]);assert.equal(summary.skippedNumericCells,1);
    await confirmAction(listAgentInvocations(run.id).find(item=>item.toolName==='export_spreadsheet')!.proposalId!);
    result=await executeOfficeAgent({runId:run.id,modelName:'test-model',model});assert.equal(result.run.status,'completed');
    const artifact=listAgentArtifacts(run.id).find(item=>item.kind==='spreadsheet')!;
    const file=database.prepare('SELECT storage_path FROM generated_files WHERE id=?').get(artifact.fileId)!;
    const exported=new ExcelJS.Workbook();await exported.xlsx.load(await readFile(String(file.storage_path)) as unknown as Parameters<typeof exported.xlsx.load>[0]);
    assert.equal(exported.worksheets[0].getCell('B2').value,30);assert.equal(exported.worksheets[0].getCell('B3').value,5);
  });
  await context.test('cancelled work cannot execute stale approvals, and project boundaries remain enforced',async()=>{
    const run=create('cancel','创建一个待办');
    await executeOfficeAgent({runId:run.id,modelName:'test-model',model:async()=>call('create_task',{title:'不应创建',projectId:'office-project'},'cancelled-task')});
    const proposal=listAgentInvocations(run.id)[0].proposalId!;stopOfficeAgent(run.id,'cancel');
    await assert.rejects(async()=>confirmAction(proposal),/已经执行或关闭|暂停、取消/);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title='不应创建'").get()?.n,0);
    await assert.rejects(async()=>executeSkillTool('create_document',{title:'越界',content:'不得写入',projectId:'another-project'},{projectId:'office-project',vaultPath:'central://documents',confirmed:true}),/其他项目/);
    const interrupted=create('interrupted','保存资料');
    database.prepare("UPDATE agent_runs SET status='running',lease_token='dead',lease_expires_at='2000-01-01' WHERE id=?").run(interrupted.id);
    database.prepare("INSERT INTO agent_invocations(id,run_id,call_id,tool_name,stable_id,fingerprint,arguments_json,mode,status,created_at,updated_at) VALUES('lost-write',?,'lost','create_document','builtin:create_document','x','{}','write','dispatching','2026-10-21','2026-10-21')").run(interrupted.id);
    recoverAgentRun(interrupted.id);assert.equal(getAgentRun(interrupted.id).status,'reconciling');assert.equal(listAgentInvocations(interrupted.id)[0].status,'unknown');
    const approved=create('approval-crash','批准后保存资料');
    await executeOfficeAgent({runId:approved.id,modelName:'test-model',model:async()=>call('create_task',{projectId:'office-project',title:'批准中断测试'},'approval-crash-call')});
    const approvedCall=listAgentInvocations(approved.id)[0];database.prepare("UPDATE agent_invocations SET status='dispatching' WHERE id=?").run(approvedCall.id);database.prepare("UPDATE action_proposals SET status='executing' WHERE id=?").run(approvedCall.proposalId);
    recoverAgentRun(approved.id);assert.equal(getAgentRun(approved.id).status,'reconciling');assert.equal(listAgentInvocations(approved.id)[0].status,'unknown');
  });
  await context.test('HTTP event replay and continue endpoint expose real persisted progress',async()=>{
    const {registerAgentRoutes}=await import('../../api/agent.js');
    const app=express();app.use(express.json());registerAgentRoutes(app,{canUseModel:()=>true,defaultModel:()=> 'test-model',model:()=>async()=>answer('已说明这项事务的当前情况。'),requestSignal:()=>new AbortController().signal});
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));context.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const response=await fetch(base+'/api/agent/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'看看我的事务进展',inputId:'http-input'})});
    const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));const done=events.find(event=>event.type==='done');assert.equal(done.runStatus,'completed');
    const view=await (await fetch(base+`/api/agent/runs/${done.runId}`)).json();assert.equal(view.run.status,'completed');assert.ok(view.events.length>=3);assert.equal(view.run.checkpoint,undefined);
    const replay=await (await fetch(base+`/api/agent/runs/${done.runId}?after=${view.events[0].seq}`)).json();assert.equal(replay.events.length,view.events.length-1);
  });
});
