import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {strFromU8,strToU8,zipSync,unzipSync} from 'fflate';
import type {AgentModelTurn} from '../agent/types.js';

const word=(text='评审日期周五')=>Buffer.from(zipSync({
  '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml':strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.slice(0,4)}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${text.slice(4)}</w:t></w:r></w:p><w:p><w:r><w:t>其他段落保持原样</w:t></w:r></w:p></w:body></w:document>`),
  'word/media/image1.png':new Uint8Array([1,2,3,4]),
}));
const ppt=()=>Buffer.from(zipSync({'ppt/slides/slide1.xml':strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>本周</a:t></a:r><a:r><a:t>进展</a:t></a:r></a:p></p:sld>'),'ppt/media/image1.png':new Uint8Array([5,6,7])}));
const call=(name:string,args:Record<string,unknown>):AgentModelTurn=>({content:'',finishReason:'tool_calls',toolCalls:[{id:`${name}-${Math.random()}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('Office 原件修改保持资源、版本约束、确认续跑与真实下载成果',async context=>{
  const root=mkdtempSync(join(tmpdir(),'xiwei-office-edits-'));process.env.AI_SECRETARY_DB_PATH=join(root,'test.db');process.env.AI_SECRETARY_DOCUMENT_ROOT=join(root,'raw');process.env.AI_SECRETARY_ARTIFACT_ROOT=join(root,'files');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();context.after(()=>{database.close();rmSync(root,{recursive:true,force:true});});
  const {editOfficeBuffer,patchOfficeFile}=await import('./office-file-edits.js');
  const {importUploadedFile,uploadedFileSource}=await import('./uploaded-files.js');
  const {parseOfficeBuffer}=await import('./office-document-parser.js');
  const scope={projectId:null,vaultPath:'central://documents'};
  await context.test('Word 跨文本片段替换与 PPT 文字替换，保留未修改资源',async()=>{
    const source=word(),output=await editOfficeBuffer(source,'docx',{replacements:[{before:'评审日期周五',after:'评审日期周一 & <新方案>'}]});
    const archive=unzipSync(output);assert.deepEqual(archive['word/media/image1.png'],unzipSync(source)['word/media/image1.png']);assert.match(strFromU8(archive['word/document.xml']),/w:b/);assert.match((await parseOfficeBuffer(output,'docx')).markdown,/评审日期周一/);assert.match((await parseOfficeBuffer(output,'docx')).markdown,/其他段落保持原样/);
    const slides=await editOfficeBuffer(ppt(),'pptx',{replacements:[{before:'本周进展',after:'下周计划'}]});assert.match((await parseOfficeBuffer(slides,'pptx')).markdown,/下周计划/);assert.deepEqual(unzipSync(slides)['ppt/media/image1.png'],new Uint8Array([5,6,7]));
    await assert.rejects(()=>editOfficeBuffer(word('重复重复'),'docx',{replacements:[{before:'重复',after:'变更'}]}),/匹配多处/);
  });
  await context.test('Excel 修改实际单元格并保留其他数据与样式，拒绝过时原值',async()=>{
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('预算');sheet.getCell('A1').value='预算';sheet.getCell('B2').value=100;sheet.getCell('B2').font={bold:true};book.addWorksheet('其他').getCell('A1').value='不变';
    const input=Buffer.from(await book.xlsx.writeBuffer()),output=await editOfficeBuffer(input,'xlsx',{cells:[{sheet:'预算',cell:'B2',before:100,after:120},{sheet:'预算',cell:'C2',before:null,after:'=不执行代码'}]});
    const verified=new ExcelJS.Workbook();await verified.xlsx.load(output as unknown as ArrayBuffer);assert.equal(verified.getWorksheet('预算')?.getCell('B2').value,120);assert.equal(verified.getWorksheet('预算')?.getCell('B2').font.bold,true);assert.equal(verified.getWorksheet('其他')?.getCell('A1').value,'不变');assert.equal(verified.getWorksheet('预算')?.getCell('C2').value,'=不执行代码');
    await assert.rejects(()=>editOfficeBuffer(input,'xlsx',{cells:[{sheet:'预算',cell:'B2',before:99,after:120}]}),/原值不一致/);
  });
  await context.test('未读取原件不能写，确认前没有副本，确认后续跑并保留原件',async()=>{
    const imported=await importUploadedFile({filename:'方案.docx',contentBase64:word().toString('base64')}),documentId=String(imported.document.id);
    await assert.rejects(()=>patchOfficeFile({documentId,expectedSha256:'0'.repeat(64),replacements:[{before:'周五',after:'周一'}]},scope),/版本不一致/);
    const {createAgentRun,listAgentInvocations,listAgentArtifacts}=await import('../agent/run-store.js');
    const {initialAgentCheckpoint,executeOfficeAgent}=await import('../agent/runtime.js');const {confirmAction}=await import('../../actions/action-service.js');
    database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('no-file-read','memory','未读原件','2026-10-25','2026-10-25')").run();
    const unread=createAgentRun({conversationId:'no-file-read',inputId:'unread-request',goal:'检查未读原件不能修改',projectId:null,model:'test',checkpoint:initialAgentCheckpoint([],'修改方案')}).run;
    let unreadStep=0;
    const denied=await executeOfficeAgent({runId:unread.id,modelName:'test',model:async()=>unreadStep++===0?call('patch_office_file',{documentId,expectedSha256:imported.sha256,replacements:[{before:'周五',after:'周一'}]}):{content:'没有读取原件，尚未修改。',toolCalls:[],finishReason:'stop'}});
    assert.match(JSON.stringify(denied.run.checkpoint.messages),/请先实际读取上传原件/);assert.equal(listAgentInvocations(unread.id).length,0);
    database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES('copy-project','修改副本项目','','','2026-10-25','2026-10-25')").run();
    const {setProjectDocumentLink}=await import('./knowledge-document-editor.js');setProjectDocumentLink('copy-project',documentId,true);
    const conversationId='file-edit-test';database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES(?,'memory','修改方案','2026-10-25','2026-10-25')").run(conversationId);
    const run=createAgentRun({conversationId,inputId:'edit-request',goal:'把评审日期改为周一，保留原件',projectId:null,model:'test',checkpoint:initialAgentCheckpoint([],'修改方案')}).run;
    let step=0;
    const model=async():Promise<AgentModelTurn>=>{
      if(step++===0)return call('get_document',{documentId});
      if(step===2)return call('read_uploaded_file',{documentId});
      if(step===3)return call('patch_office_file',{documentId,expectedSha256:imported.sha256,replacements:[{before:'评审日期周五',after:'评审日期周一'}]});
      return{content:'已生成修改副本，原件保留。',toolCalls:[],finishReason:'stop'};
    };
    const waiting=await executeOfficeAgent({runId:run.id,modelName:'test',model});assert.equal(waiting.run.status,'waiting_approval');assert.equal(Number(database.prepare('SELECT COUNT(*) AS n FROM generated_files').get()?.n),0);
    const pending=listAgentInvocations(run.id).find(item=>item.status==='waiting_approval');assert.ok(pending?.proposalId);await confirmAction(pending.proposalId);
    const completed=await executeOfficeAgent({runId:run.id,modelName:'test',model});assert.equal(completed.run.status,'completed');
    const artifact=listAgentArtifacts(run.id).find(item=>item.fileId);assert.ok(artifact?.fileId);const file=database.prepare('SELECT storage_path FROM generated_files WHERE id=?').get(artifact.fileId)!;
    assert.ok(database.prepare("SELECT document_id FROM project_document_links WHERE project_id='copy-project' AND document_id=?").get(artifact.documentId));
    assert.match((await parseOfficeBuffer(await readFile(String(file.storage_path)),'docx')).markdown,/评审日期周一/);
    assert.match((await parseOfficeBuffer((await uploadedFileSource(documentId,scope)).buffer,'docx')).markdown,/评审日期周五/);
    assert.equal(listAgentInvocations(run.id).filter(item=>item.toolName==='patch_office_file'&&item.status==='succeeded').length,1);
  });
});
