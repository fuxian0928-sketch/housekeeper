import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('document skill searches, reads, previews, confirms, verifies and rejects stale or cross-project edits', async t => {
 const root=mkdtempSync(join(tmpdir(),'skill-document-loop-'));
 process.env.AI_SECRETARY_DB_PATH=join(root,'test.db');
 process.env.AI_SECRETARY_SKILLS_DIR=join(root,'skills');
 const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();t.after(()=>database.close());
 const {buildManagedSkill,listManagedSkills}=await import('./skill-manager.js');
 const {runSkillTools}=await import('./skill-executor.js');
 const {executeSkillTool}=await import('./skill-tool-registry.js');
 const {createKnowledgeDocument,getKnowledgeDocument,updateKnowledgeDocument}=await import('../documents/knowledge-document-editor.js');
 const {confirmAction}=await import('../../actions/action-service.js');
 const {saveToolEnabled}=await import('./tool-controls.js');
 const context={vaultPath:'central://documents'};
 const project=await executeSkillTool('create_project',{name:'闭环测试'},context) as {id:string};
 const doc=createKnowledgeDocument({title:'上线计划',content:'# 上线计划\n\n上线日期：周一\n\n其他要求保持不变。',projectId:project.id});
 await buildManagedSkill({name:'知识整理',description:'整理项目信息',instructions:'查找文档并修改，预览确认后保存。'});
 database.prepare("INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES('loop','project',?,'test',datetime('now'),datetime('now'))").run(project.id);
 let step=0;
 const input={message:'把上线日期改成周五',conversationId:'loop',skills:listManagedSkills(),skillInstruction:'',context:{...context,projectId:project.id},complete:async(raw:string)=>{
   const received=JSON.parse(raw);const result=received.results.join('\n');
   const sequence=[{tool:'list_project_documents',arguments:{}},{tool:'get_document',arguments:{documentId:doc.id}},{tool:'patch_document',arguments:{documentId:doc.id,before:'上线日期：周一',after:'上线日期：周五'}}];
   if(step===1)assert.match(result,/上线计划/);
   if(step===2)assert.match(result,/其他要求保持不变/);
   return JSON.stringify({toolCalls:step<sequence.length?[sequence[step++]]:[]});
 }};
 const result=await runSkillTools(input);
 assert.equal(step,3);assert.equal(result.pending.length,1);
 assert.match(result.pending[0].reason,/修改前：[\s\S]*周一[\s\S]*修改后：[\s\S]*周五/);
 assert.match(String(getKnowledgeDocument(String(doc.id)).content),/周一/);
 const saved=await confirmAction(result.pending[0].id) as {verified:boolean};assert.equal(saved.verified,true);
 assert.match(String(getKnowledgeDocument(String(doc.id)).content),/周五[\s\S]*其他要求保持不变/);
 const revision=getKnowledgeDocument(String(doc.id)).serverRevision;
 await confirmAction(result.pending[0].id);assert.equal(getKnowledgeDocument(String(doc.id)).serverRevision,revision);
 // Same workflow with a concurrent edit between preview and confirmation.
 updateKnowledgeDocument(String(doc.id),{content:'# 上线计划\n\n上线日期：周一'});step=0;
 // Skip the content-preservation assertion because this is a different starting version.
 const pending=await runSkillTools({...input,complete:async()=>JSON.stringify({toolCalls:[step++===0?{tool:'get_document',arguments:{documentId:doc.id}}:{tool:'patch_document',arguments:{documentId:doc.id,before:'上线日期：周一',after:'上线日期：周五'}}]})});
 updateKnowledgeDocument(String(doc.id),{content:'# 上线计划\n\n上线日期：周二'});
 assert.throws(()=>confirmAction(pending.pending[0].id),/已变化/);
 assert.match(String(getKnowledgeDocument(String(doc.id)).content),/周二/);
 const other=await executeSkillTool('create_project',{name:'其他项目'},context) as {id:string};
 assert.throws(()=>executeSkillTool('get_document',{documentId:doc.id},{...context,projectId:other.id}),/不属于当前项目/);
 saveToolEnabled('patch_document',false);
 assert.throws(()=>executeSkillTool('patch_document',{},context),/停用/);
});
