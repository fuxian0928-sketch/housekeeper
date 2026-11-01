import ExcelJS from 'exceljs';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {database,nowIso} from '../../db.js';
import {assertSafeOfficeArchive,parseOfficeBuffer} from './office-document-parser.js';
import {contentHash,importUploadedFile,uploadedFileSource} from './uploaded-files.js';
import {generatedFilesRoot} from './spreadsheet-tools.js';
import {setProjectDocumentLink} from './knowledge-document-editor.js';
import {unknownToolOutcome} from '../skills/tool-outcome.js';
import type {SkillToolContext,SkillToolDefinition} from '../skills/skill-tool-registry.js';

const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type Scalar=string|number|boolean|null;
export type OfficeTextReplacement={before:string;after:string;part?:string};
export type OfficeCellEdit={sheet:string;cell:string;before:Scalar;after:Scalar};
const scalar={type:['string','number','boolean','null']};
const schema={type:'object',properties:{documentId:{type:'string'},expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},replacements:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{before:{type:'string',minLength:1,maxLength:4000},after:{type:'string',maxLength:4000},part:{type:'string',maxLength:160}},required:['before','after'],additionalProperties:false}},cells:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{sheet:{type:'string'},cell:{type:'string'},before:scalar,after:scalar},required:['sheet','cell','before','after'],additionalProperties:false}}},required:['documentId','expectedSha256'],oneOf:[{required:['replacements']},{required:['cells']}],additionalProperties:false};
export const officeFileEditDefinitions:SkillToolDefinition[]=[{name:'patch_office_file',description:'先读取上传原件取得哈希，再生成可下载的真实 Office 修改副本。Word/PPT 支持唯一匹配文字（可指定XML part）；Excel 支持工作表/单元格的明确旧值与新值。保留原件，校验版本并回读。不执行宏或新公式。',mode:'write',permission:'documents.write',riskLevel:'medium',parameters:JSON.stringify(schema)}];

function parseXml(xml:string){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw fail('文档含不支持的 XML 实体定义，未修改。',422);
  const document=new DOMParser({onError:(level)=>{if(level!=='warning')throw fail('Office XML 结构无法安全读取。',422);}}).parseFromString(xml,'application/xml');
  if(!document.documentElement)throw fail('Office XML 没有正文根节点。',422);return document;
}
function paragraphs(document:ReturnType<typeof parseXml>,format:'docx'|'pptx'){
  const ns=format==='docx'?'http://schemas.openxmlformats.org/wordprocessingml/2006/main':'http://schemas.openxmlformats.org/drawingml/2006/main';
  const groups=Array.from(document.getElementsByTagNameNS(ns,'p'));
  return(groups.length?groups:[document.documentElement!]).map(group=>Array.from(group.getElementsByTagNameNS(ns,'t')));
}
function patchPackage(buffer:Buffer,format:'docx'|'pptx',replacements:OfficeTextReplacement[]){
  assertSafeOfficeArchive(buffer);
  const files=unzipSync(new Uint8Array(buffer)),pathPattern=format==='docx'?/^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/:/^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/;
  const docs=Object.keys(files).filter(path=>pathPattern.test(path)).sort().map(path=>({path,doc:parseXml(strFromU8(files[path]))}));
  const modified=new Set<string>();
  if(!docs.length)throw fail('没有找到可修改的 Office 正文。',422);
  for(const replacement of replacements){
    if(!replacement||typeof replacement.before!=='string'||!replacement.before||typeof replacement.after!=='string'||replacement.before.length>4000||replacement.after.length>4000||replacement.before===replacement.after)throw fail('请提供不同且不超过 4000 字的修改前后文字。');
    const candidates:Array<{path:string;nodes:ReturnType<typeof paragraphs>[number];start:number}>=[];
    for(const {path,doc} of docs){
      if(replacement.part&&replacement.part!==path)continue;
      for(const nodes of paragraphs(doc,format)){
        const text=nodes.map(node=>node.textContent??'').join('');let start=text.indexOf(replacement.before);
        while(start>=0){candidates.push({path,nodes,start});start=text.indexOf(replacement.before,start+1);if(candidates.length>1)break;}
        if(candidates.length>1)break;
      }
      if(candidates.length>1)break;
    }
    if(candidates.length!==1)throw fail('原文不存在或匹配多处，请重新读取并提供更完整的片段或指定 part。',409);
    const {path,nodes,start}=candidates[0],end=start+replacement.before.length;modified.add(path);let position=0,inserted=false;
    for(const node of nodes){
      const text=node.textContent??'',nodeEnd=position+text.length;
      if(position<end&&nodeEnd>start){
        const prefix=text.slice(0,Math.max(0,start-position)),suffix=text.slice(Math.max(0,end-position));
        node.textContent=prefix+(inserted?'':replacement.after)+suffix;
        node.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');inserted=true;
      }
      position=nodeEnd;
    }
  }
  for(const {path,doc} of docs){
    if(!modified.has(path))continue;
    const output=new XMLSerializer().serializeToString(doc),reopened=parseXml(output);
    const expected=paragraphs(doc,format).map(nodes=>nodes.map(node=>node.textContent??'').join(''));
    const actual=paragraphs(reopened,format).map(nodes=>nodes.map(node=>node.textContent??'').join(''));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw fail('修改后的文字回读不一致，未生成文件。',500);
    files[path]=strToU8(output);
  }
  return Buffer.from(zipSync(files));
}
function isScalar(value:unknown):value is Scalar{return value===null||typeof value==='string'&&value.length<=32000||typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean';}
async function patchWorkbook(buffer:Buffer,cells:OfficeCellEdit[]){
  assertSafeOfficeArchive(buffer);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const seen=new Set<string>();
  for(const edit of cells){
    if(!edit||typeof edit.sheet!=='string'||typeof edit.cell!=='string'||!isScalar(edit.before)||!isScalar(edit.after))throw fail('单元格修改必须包含工作表、地址、原值和新值。');
    const address=edit.cell.toUpperCase(),match=/^([A-Z]{1,3})([1-9]\d{0,5})$/.exec(address),sheet=workbook.getWorksheet(edit.sheet);
    const column=match?.[1].split('').reduce((n,char)=>n*26+char.charCodeAt(0)-64,0)??0;
    if(!match||column>16384||!sheet)throw fail('工作表或单元格地址无效。');
    if(seen.has(`${edit.sheet}:${address}`))throw fail('一次修改不能重复指定同一个单元格。');seen.add(`${edit.sheet}:${address}`);
    const cell=sheet.getCell(address),old=cell.value??null;
    if(cell.isMerged&&cell.master.address!==cell.address)throw fail('请修改合并区域的左上角单元格。');
    if(!isScalar(old))throw fail('当前单元格含公式、富文本或特殊类型；本工具仅修改普通值。');
    if(old!==edit.before)throw fail(`单元格 ${edit.sheet}!${address} 的原值不一致，请重新读取。`,409);
    if(edit.after===edit.before)throw fail('原值与新值相同，无需生成副本。');
    cell.value=edit.after;
  }
  const output=Buffer.from(await workbook.xlsx.writeBuffer()),verified=new ExcelJS.Workbook();await verified.xlsx.load(output as unknown as ArrayBuffer);
  for(const edit of cells)if((verified.getWorksheet(edit.sheet)?.getCell(edit.cell.toUpperCase()).value??null)!==edit.after)throw fail('Excel 写入后的单元格校验失败。',500);
  return output;
}
export async function editOfficeBuffer(buffer:Buffer,format:string,input:{replacements?:OfficeTextReplacement[];cells?:OfficeCellEdit[]}){
  if(!['docx','xlsx','pptx'].includes(format))throw fail('此工具只修改 DOCX、XLSX 或 PPTX；其他格式仍可读取。',415);
  const edits=format==='xlsx'?input.cells:input.replacements;
  if(!Array.isArray(edits)||edits.length<1||edits.length>100)throw fail(format==='xlsx'?'Excel 需要 1–100 个单元格修改。':'Word/PPT 需要 1–100 个文字替换。');
  if(format==='xlsx'&&input.replacements||format!=='xlsx'&&input.cells)throw fail('修改类型与文件格式不匹配。');
  const output=format==='xlsx'?await patchWorkbook(buffer,input.cells!):patchPackage(buffer,format as 'docx'|'pptx',input.replacements!);
  await parseOfficeBuffer(output,format as 'docx'|'xlsx'|'pptx');
  return output;
}
export async function patchOfficeFile(args:Record<string,unknown>,context:SkillToolContext,signal?:AbortSignal){
  signal?.throwIfAborted();
  const documentId=String(args.documentId??''),{buffer,source}=await uploadedFileSource(documentId,context);
  if(args.expectedSha256!==source.sha256)throw fail('原件版本不一致或尚未读取，请重新读取后生成修改。',409);
  const output=await editOfficeBuffer(buffer,source.format,{replacements:args.replacements as OfficeTextReplacement[]|undefined,cells:args.cells as OfficeCellEdit[]|undefined});
  signal?.throwIfAborted();await uploadedFileSource(documentId,context);signal?.throwIfAborted();
  const fileId=randomUUID(),filename=source.filename.replace(/\.(docx|xlsx|pptx)$/i,`-修改版.${source.format}`),path=join(generatedFilesRoot,`${fileId}.${source.format}`),sha256=contentHash(output);
  const mime:Record<string,string>={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
  await mkdir(generatedFilesRoot,{recursive:true});
  let written=false;
  try{
    await writeFile(path,output,{flag:'wx'});written=true;
    const imported=await importUploadedFile({filename,contentBase64:output.toString('base64'),projectId:context.projectId});
    if(!context.projectId)for(const link of database.prepare('SELECT p.id FROM project_document_links l JOIN projects p ON p.id=l.project_id WHERE l.document_id=? AND p.deleted_at IS NULL').all(documentId))setProjectDocumentLink(String(link.id),String(imported.document.id),true);
    database.prepare('INSERT INTO generated_files(id,filename,mime_type,storage_path,bytes,sha256,sources_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(fileId,filename,mime[source.format],path,output.length,sha256,JSON.stringify([documentId]),nowIso());
    return{fileId,filename,title:filename,documentId:String(imported.document.id),previousDocumentId:documentId,sha256,previousSha256:source.sha256,format:source.format,bytes:output.length,downloadUrl:`/api/agent/files/${fileId}`,sourceDocumentIds:[documentId],verified:true,originalPreserved:true,source,warnings:source.format==='xlsx'?['复杂图表、外部链接等工作簿特性需在 Excel 中检查；未执行宏或公式。']:[],summary:'已生成修改副本并回读校验，上传原件保留。'};
  }catch(error){if(written)throw unknownToolOutcome();throw error;}
}
