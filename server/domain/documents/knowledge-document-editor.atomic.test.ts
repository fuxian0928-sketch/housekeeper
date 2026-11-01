import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('document body, chunks, title and version commit or roll back together',async suite=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'document-atomic-')),'test.db');
 const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();suite.after(()=>database.close());
 const {createKnowledgeDocument,updateKnowledgeDocument,getKnowledgeDocument,listKnowledgeDocumentVersions}=await import('./knowledge-document-editor.js');
 const {searchKnowledgeDocuments}=await import('../../vault.js');
 await suite.test('failed first version leaves no searchable document or orphan chunks',()=>{
  database.exec("CREATE TRIGGER fail_document_version BEFORE INSERT ON knowledge_document_versions BEGIN SELECT RAISE(ABORT,'fixture-version-failure'); END");
  try{
   assert.throws(()=>createKnowledgeDocument({title:'失败写入记录',content:'# 不应出现\n失败写入的独特内容'}),/fixture-version-failure/);
   assert.equal(database.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get()?.n,0);
   assert.equal(database.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get()?.n,0);
   assert.equal(database.prepare('SELECT COUNT(*) AS n FROM knowledge_document_versions').get()?.n,0);
   assert.deepEqual(searchKnowledgeDocuments('失败写入'),[]);
  }finally{database.exec('DROP TRIGGER fail_document_version');}
 });
 const document=createKnowledgeDocument({title:'正式标题',content:'## 正文范围\n应该保留的原始内容。'});
 await suite.test('the requested title agrees with the index and saved history',()=>{
  assert.equal(document.title,'正式标题');
  assert.equal(listKnowledgeDocumentVersions(String(document.id))[0].title,'正式标题');
  assert.ok(searchKnowledgeDocuments('正式标题').some(item=>item.id===document.id));
 });
 await suite.test('failed modification preserves old body, chunks and revision',()=>{
  const chunks=database.prepare('SELECT * FROM knowledge_chunks WHERE document_id=? ORDER BY position').all(String(document.id));
  database.exec("CREATE TRIGGER fail_next_version BEFORE INSERT ON knowledge_document_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'fixture-update-failure'); END");
  try{
   assert.throws(()=>updateKnowledgeDocument(String(document.id),{title:'不应保存的标题',content:'# 不应保存的内容\n版本保存失败。'}),/fixture-update-failure/);
   const current=getKnowledgeDocument(String(document.id));assert.equal(current.content,document.content);assert.equal(current.title,document.title);assert.equal(current.serverRevision,1);
   assert.deepEqual(database.prepare('SELECT * FROM knowledge_chunks WHERE document_id=? ORDER BY position').all(String(document.id)),chunks);
   assert.equal(listKnowledgeDocumentVersions(String(document.id)).length,1);
  }finally{database.exec('DROP TRIGGER fail_next_version');}
 });
 await suite.test('metadata-only rename refreshes the canonical searchable title',()=>{
  const renamed=updateKnowledgeDocument(String(document.id),{title:'评审材料新版'});
  assert.equal(renamed.title,'评审材料新版');assert.equal(renamed.serverRevision,2);
  assert.ok(searchKnowledgeDocuments('评审材料新版').some(item=>item.id===document.id));
 });
 await suite.test('document saves compose with an outer business transaction',()=>{
  database.exec('BEGIN');
  try{createKnowledgeDocument({title:'外层事务文档',content:'外层事务尚未提交'});database.exec('ROLLBACK');}
  catch(error){database.exec('ROLLBACK');throw error;}
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE title='外层事务文档'").get()?.n,0);
 });
});
