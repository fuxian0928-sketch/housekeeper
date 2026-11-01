import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('automatic project context follows evidence and leaves unrelated topics unbound',async t=>{
  const temporary=mkdtempSync(join(tmpdir(),'xiwei-project-context-')),previous=process.env.AI_SECRETARY_DB_PATH;
  process.env.AI_SECRETARY_DB_PATH=join(temporary,'test.db');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
  const {createAutomaticProjectContext}=await import('./automatic-project-context.js');
  const identify=createAutomaticProjectContext(database),time='2026-10-25T00:00:00Z';
  const project=(id:string,name:string,status='active',deletedAt:string|null=null)=>database.prepare('INSERT INTO projects(id,name,vault_path,source_path,status,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,name,'central://documents','',status,deletedAt,time,time);
  project('p1','发布计划');project('p2','产品研究');project('p3','App');project('archived','归档项目','archived');project('deleted','已删项目','active',time);
  database.prepare('INSERT INTO knowledge_documents(id,title,relative_path,content,modified_at,indexed_at) VALUES(?,?,?,?,?,?)').run('d1','调研报告','report.md','不应自动读取或注入的文档原文',time,time);
  database.prepare('INSERT INTO project_document_links(project_id,document_id,created_at) VALUES(?,?,?)').run('p2','d1',time);
  try{
    await t.test('explicit new project overrides the page and the previous project',()=>{
      const context=identify('产品研究进展如何？',{focus:{kind:'project',id:'p1',title:'发布计划'},recentTargets:[{kind:'project',id:'p1',title:'发布计划'}]});
      assert.equal(context.status,'resolved');assert.deepEqual(context.candidates,[{id:'p2',name:'产品研究'}]);
    });
    await t.test('an ordinary conversation does not inherit work merely from an open page',()=>{
      assert.equal(identify('今天好累，陪我聊聊',{focus:{kind:'project',id:'p1',title:'发布计划'}}).status,'unresolved');
      assert.equal(identify('Happy birthday').status,'unresolved');
    });
    await t.test('a visible document uses its real project link without reading its body',()=>{
      const context=identify('这个文档属于哪个项目？',{focus:{kind:'document',id:'d1',title:'模型伪造的名称'}});
      assert.equal(context.status,'resolved');assert.equal(context.candidates[0].id,'p2');assert.doesNotMatch(JSON.stringify(context),/文档原文|伪造/);
    });
    await t.test('multiple mentioned projects and conflicting recent reads remain ambiguous',()=>{
      assert.equal(identify('对比发布计划和产品研究').status,'ambiguous');
      assert.equal(identify('继续整理这个项目',{recentTargets:[{kind:'project',id:'p1',title:'发布计划'},{kind:'project',id:'p2',title:'产品研究'}]}).status,'ambiguous');
      project('same-name','发布计划');assert.equal(identify('发布计划进展如何').status,'ambiguous');
    });
    await t.test('stale focus, archived projects and deleted projects never resolve',()=>{
      assert.equal(identify('这个项目的进展',{focus:{kind:'project',id:'missing',title:'发布计划'}}).status,'unresolved');
      assert.equal(identify('归档项目的进展').status,'unresolved');assert.equal(identify('已删项目的进展').status,'unresolved');
    });
    await t.test('historical references use actual prior reads instead of the new page',()=>{
      const context=identify('继续上次那个项目',{focus:{kind:'project',id:'p2',title:'产品研究'},recentTargets:[{kind:'project',id:'p3',title:'App'}]});
      assert.equal(context.status,'resolved');assert.equal(context.candidates[0].id,'p3');
    });
  }finally{database.close();if(previous===undefined)delete process.env.AI_SECRETARY_DB_PATH;else process.env.AI_SECRETARY_DB_PATH=previous;rmSync(temporary,{recursive:true,force:true});}
});
