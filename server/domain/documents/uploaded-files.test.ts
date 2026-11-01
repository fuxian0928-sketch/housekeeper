import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

function pdfFixture(text:string){
  const stream=text?`BT /F1 12 Tf 40 750 Td (${text}) Tj ET`:'';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${body}\nendobj\n`;});
  const start=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(pdf+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}

test('统一上传保留原件、按实际内容读取、拒绝错误格式并隔离项目',async context=>{
  const root=mkdtempSync(join(tmpdir(),'xiwei-files-'));process.env.AI_SECRETARY_DB_PATH=join(root,'test.db');process.env.AI_SECRETARY_DOCUMENT_ROOT=join(root,'raw');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
  context.after(()=>{database.close();rmSync(root,{recursive:true,force:true});});
  const {importUploadedFile,readUploadedFile,parseUploadedBuffer,uploadedFileSource}=await import('./uploaded-files.js');
  const upload=(filename:string,content:string|Buffer)=>importUploadedFile({filename,contentBase64:Buffer.from(content).toString('base64')});
  const scope={projectId:null,vaultPath:'central://documents'};
  await context.test('JSON、Markdown、代码与原件哈希，长行可以连续分页',async()=>{
    const json=await upload('配置.json','{"name":"希微","enabled":true}');
    assert.match(String(json.document.content),/希微/);
    const duplicate=await upload('配置副本.json','{"name":"希微","enabled":true}');assert.equal(duplicate.document.id,json.document.id);assert.equal(duplicate.deduplicated,true);
    const md=await upload('记录.md','# 今天\n完成文件读取');assert.match(String(md.document.content),/# 今天/);
    const malicious=`require('node:fs').writeFileSync(${JSON.stringify(join(root,'must-not-exist'))},'executed');\n`+'x'.repeat(70000);
    const code=await upload('sample.ts',malicious),id=String(code.document.id);
    assert.equal(existsSync(join(root,'must-not-exist')),false);
    const first=await readUploadedFile({documentId:id,limit:60000},scope);assert.equal(first.content.length,60000);assert.equal(first.truncated,true);
    const second=await readUploadedFile({documentId:id,offset:first.nextOffset,limit:60000},scope);assert.equal(second.nextOffset,null);assert.equal(first.content+second.content,(await parseUploadedBuffer(Buffer.from(malicious),'ts')).markdown);
    const {buffer,source}=await uploadedFileSource(id,scope);assert.equal(buffer.toString(),malicious);assert.equal(source.sha256,code.sha256);
    await assert.rejects(()=>readUploadedFile({documentId:id},{...scope,projectId:'other-project'}),/不属于当前项目/);
  });
  await context.test('PDF 文本层读取、页码定位与扫描件警告',async()=>{
    const pdf=await upload('example.pdf',pdfFixture('Xiwei actual PDF reading'));
    assert.match(String(pdf.document.content),/第 1 页[\s\S]*Xiwei actual PDF reading/);assert.equal(pdf.stats.pages,1);
    const scanned=await upload('scan.pdf',pdfFixture(''));assert.equal(scanned.stats.emptyPages,1);assert.match(scanned.warnings.join(' '),/OCR/);
  });
  await context.test('伪装二进制、损坏 JSON、非法编码不写知识库',async()=>{
    const count=()=>Number(database.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get()?.n),before=count();
    await assert.rejects(()=>upload('broken.json','{broken'),/JSON 语法无效/);
    await assert.rejects(()=>upload('binary.ts',Buffer.from([0,1,2,3])),/二进制控制/);
    await assert.rejects(()=>upload('old.doc','legacy'),/暂不支持/);
    await assert.rejects(()=>upload('broken.pdf','not a PDF'),/有效 PDF/);
    await assert.rejects(()=>importUploadedFile({filename:'a.txt',contentBase64:'%%%'}),/编码无效/);
    assert.equal(count(),before);
  });
  await context.test('原件改变与预先取消不得继续读取',async()=>{
    const imported=await upload('immutable.txt','原始文字');
    const row=database.prepare('SELECT storage_path FROM office_document_imports WHERE document_id=?').get(String(imported.document.id))!;
    const path=join(root,'raw',String(row.storage_path));assert.equal((await readFile(path)).toString(),'原始文字');await writeFile(path,'外部修改');
    await assert.rejects(()=>readUploadedFile({documentId:imported.document.id},scope),/原件发生变化/);
    await assert.rejects(()=>parseUploadedBuffer(Buffer.from('hello'),'txt',AbortSignal.abort()),/abort/i);
  });
});
