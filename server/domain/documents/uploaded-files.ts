import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,extname,join,resolve,sep} from 'node:path';
import {database,databaseDirectory,nowIso} from '../../db.js';
import {createKnowledgeDocument,getKnowledgeDocument,setProjectDocumentLink,setTaskDocumentLink} from './knowledge-document-editor.js';
import {importOfficeDocument,parseOfficeBuffer} from './office-document-parser.js';
import type {SkillToolContext,SkillToolDefinition} from '../skills/skill-tool-registry.js';

export const uploadedFilesRoot=resolve(process.env.AI_SECRETARY_DOCUMENT_ROOT?.trim()||join(databaseDirectory,'..','raw-documents'));
const maximumBytes=Number(process.env.AI_SECRETARY_MAX_DOCUMENT_BYTES??15*1024*1024);
const maximumTextBytes=2*1024*1024;
export const textFileExtensions=['txt','md','markdown','json','jsonc','ts','tsx','js','jsx','mjs','cjs','py','java','c','h','cpp','hpp','cs','go','rs','sql','yaml','yml','toml','ini','csv','xml','html','css','sh','ps1'];
const officeFormats=new Set(['docx','xlsx','pptx']);
const textFormats=new Set(textFileExtensions);
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export const contentHash=(content:Uint8Array)=>createHash('sha256').update(content).digest('hex');
type ParsedFile={markdown:string;warnings:string[];stats:Record<string,number>};

function decodeText(buffer:Buffer){
  let value:string;
  try {
    const encoding=buffer[0]===0xff&&buffer[1]===0xfe?'utf-16le':buffer[0]===0xfe&&buffer[1]===0xff?'utf-16be':'utf-8';
    value=new TextDecoder(encoding,{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');
  }catch{throw fail('文本编码无法读取，请另存为 UTF-8 后上传。',422);}
  if(value.includes('\0')||/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw fail('文件包含二进制控制内容，未当作代码或文本执行。',422);
  if(!value.trim())throw fail('文件没有可读取的文字。',422);
  return value;
}
function textMarkdown(value:string,format:string){
  if(format==='md'||format==='markdown')return value;
  let longest=2;for(const match of value.matchAll(/`+/g))longest=Math.max(longest,match[0].length);
  const fence='`'.repeat(longest+1);
  return `${fence}${format==='txt'?'text':format}\n${value}\n${fence}`;
}
async function parsePdf(buffer:Buffer,signal?:AbortSignal):Promise<ParsedFile>{
  if(!buffer.subarray(0,1024).includes(Buffer.from('%PDF-')))throw fail('文件内容不是有效 PDF。',422);
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  signal?.throwIfAborted();
  const loading=getDocument({data:new Uint8Array(buffer),useWasm:false,enableXfa:false,disableFontFace:true,useSystemFonts:false,verbosity:0});
  const abort=()=>{void loading.destroy().catch(()=>undefined);};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const pdf=await loading.promise;
    if(pdf.numPages>300)throw fail('PDF 超过 300 页，请分册后上传。',413);
    const pages:string[]=[],warnings:string[]=[];let textBytes=0,emptyPages=0;
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
      signal?.throwIfAborted();
      const page=await pdf.getPage(pageNumber),text=await page.getTextContent();
      const value=text.items.map(item=>'str'in item?`${item.str}${item.hasEOL?'\n':' '}`:'').join('').trim();
      textBytes+=Buffer.byteLength(value,'utf8');
      if(textBytes>maximumTextBytes)throw fail('PDF 文字超过 2MB，请拆分后上传。',413);
      if(!value){emptyPages++;warnings.push(`第 ${pageNumber} 页没有文本层，需要 OCR 才能读取图片中的文字。`);}
      pages.push(`## 第 ${pageNumber} 页\n\n${value||'（没有可读取的文本层，未进行 OCR。）'}`);
      page.cleanup();
    }
    return{markdown:pages.join('\n\n'),warnings,stats:{pages:pdf.numPages,emptyPages,textBytes}};
  }catch(error){
    signal?.throwIfAborted();
    if(error&&typeof error==='object'&&'statusCode'in error)throw error;
    throw fail('PDF 无法读取，可能已加密或文件损坏。请解密或重新导出后上传。',422);
  }finally{signal?.removeEventListener('abort',abort);await loading.destroy().catch(()=>undefined);}
}
export async function parseUploadedBuffer(buffer:Buffer,format:string,signal?:AbortSignal):Promise<ParsedFile>{
  signal?.throwIfAborted();
  if(!buffer.length||buffer.length>maximumBytes)throw fail('文件为空或超过上传大小限制。',413);
  if(officeFormats.has(format))return parseOfficeBuffer(buffer,format as 'docx'|'xlsx'|'pptx');
  if(format==='pdf')return parsePdf(buffer,signal);
  if(!textFormats.has(format))throw fail('暂不支持这个文件格式；旧版 Office 请先另存为 DOCX、XLSX 或 PPTX。',415);
  if(buffer.length>maximumTextBytes)throw fail('单个文本或代码文件不能超过 2MB，请拆分后上传。',413);
  const value=decodeText(buffer);
  if(format==='json'){try{JSON.parse(value);}catch{throw fail('JSON 语法无效，请修正后上传。',422);}}
  return{markdown:textMarkdown(value,format),warnings:[],stats:{lines:value.split(/\r\n|\n|\r/).length,characters:value.length}};
}
export function fileCapabilityStatus(){
  return{id:'uploaded-file-reader',name:'文件与代码处理',version:'1.0.0',status:'ready',bundled:true,formats:['docx','xlsx','pptx','pdf',...textFileExtensions],editableFormats:['docx','xlsx','pptx'],editMode:'verified-copy',limits:{maximumBytes,maximumTextBytes,maximumPdfPages:300},ocr:false,executesUploadedCode:false,originalsPreserved:true};
}
export async function importUploadedFile(input:{filename?:unknown;contentBase64?:unknown;projectId?:unknown;taskId?:unknown},signal?:AbortSignal){
  const filename=basename(String(input.filename??'')).replace(/[\x00-\x1f<>:"/\\|?*]/g,'').slice(0,180);
  if(!filename)throw fail('请选择需要读取的文件。');
  const format=extname(filename).slice(1).toLowerCase();
  const encoded=String(input.contentBase64??'').replace(/^data:[^;]+;base64,/,'').replace(/\s/g,'');
  if(!encoded||encoded.length>Math.ceil(maximumBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw fail('文件内容为空、编码无效或超过上传限制。',413);
  signal?.throwIfAborted();
  if(officeFormats.has(format))return importOfficeDocument({...input,filename,contentBase64:encoded});
  const buffer=Buffer.from(encoded,'base64'),parsed=await parseUploadedBuffer(buffer,format,signal),sha256=contentHash(buffer);
  const existing=database.prepare("SELECT id,document_id,warnings_json,stats_json FROM office_document_imports WHERE content_hash=? AND format=? AND status='ready' LIMIT 1").get(sha256,format);
  if(existing){
    if(typeof input.projectId==='string'&&input.projectId)setProjectDocumentLink(input.projectId,String(existing.document_id),true);
    if(typeof input.taskId==='string'&&input.taskId)setTaskDocumentLink(input.taskId,String(existing.document_id),true);
    return{importId:String(existing.id),document:getKnowledgeDocument(String(existing.document_id)),filename,format,sha256,warnings:JSON.parse(String(existing.warnings_json)),stats:JSON.parse(String(existing.stats_json)),deduplicated:true};
  }
  const title=filename.slice(0,-extname(filename).length)||filename;
  const content=`# ${title}\n\n> 来源文件：${filename}\n> 文件指纹：${sha256}\n> 解析格式：${format.toUpperCase()}\n\n${parsed.markdown}`;
  if(Buffer.byteLength(content,'utf8')>maximumTextBytes)throw fail('解析内容超过 2MB，请拆分文件后上传。',413);
  const storagePath=join('imports',sha256.slice(0,2),`${sha256}.${format}`),absolutePath=join(uploadedFilesRoot,storagePath);
  await mkdir(resolve(absolutePath,'..'),{recursive:true});
  await writeFile(absolutePath,buffer,{flag:'wx'}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
  signal?.throwIfAborted();
  const importId=randomUUID(),timestamp=nowIso();
  database.exec('SAVEPOINT uploaded_file_create');
  try{
    const document=createKnowledgeDocument({title,content,projectId:input.projectId,taskId:input.taskId}),documentId=String(document.id);
    database.prepare("UPDATE knowledge_documents SET source_type='upload' WHERE id=?").run(documentId);
    database.prepare("INSERT INTO office_document_imports(id,document_id,filename,format,content_hash,storage_path,bytes,warnings_json,stats_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?)").run(importId,documentId,filename,format,sha256,storagePath.replaceAll('\\','/'),buffer.length,JSON.stringify(parsed.warnings),JSON.stringify(parsed.stats),timestamp,timestamp);
    database.exec('RELEASE SAVEPOINT uploaded_file_create');
    return{importId,document:getKnowledgeDocument(String(document.id)),filename,format,sha256,warnings:parsed.warnings,stats:parsed.stats};
  }catch(error){database.exec('ROLLBACK TO SAVEPOINT uploaded_file_create; RELEASE SAVEPOINT uploaded_file_create');throw error;}
}
export async function uploadedFileSource(documentId:string,context:Pick<SkillToolContext,'projectId'>){
  if(context.projectId&&!database.prepare('SELECT document_id FROM project_document_links WHERE document_id=? AND project_id=?').get(documentId,context.projectId))throw fail('文件不属于当前项目。',403);
  const source=database.prepare("SELECT * FROM office_document_imports WHERE document_id=? AND status='ready' ORDER BY created_at DESC LIMIT 1").get(documentId);
  if(!source)throw fail('没有找到这个文档的上传原件。',404);
  const path=resolve(uploadedFilesRoot,String(source.storage_path));
  if(!path.startsWith(uploadedFilesRoot+sep))throw fail('原件位置无效。',403);
  const buffer=await readFile(path);
  if(contentHash(buffer)!==source.content_hash)throw fail('上传原件发生变化，已停止读取；请重新导入。',409);
  return{buffer,source:{documentId,filename:String(source.filename),format:String(source.format),sha256:String(source.content_hash)}};
}
export const uploadedFileToolDefinitions:SkillToolDefinition[]=[{name:'read_uploaded_file',description:'读取已上传原件的实际内容与格式、哈希，按字符分页并提供起始行号；支持 Office、PDF、JSON、Markdown 与代码，不执行其中的脚本或宏。',mode:'read',permission:'documents.read',riskLevel:'low',parameters:JSON.stringify({type:'object',properties:{documentId:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60000}},required:['documentId'],additionalProperties:false})}];
export async function readUploadedFile(args:Record<string,unknown>,context:SkillToolContext,signal?:AbortSignal){
  const {buffer,source}=await uploadedFileSource(String(args.documentId??''),context),parsed=await parseUploadedBuffer(buffer,source.format,signal);
  const offset=Math.max(0,Math.floor(Number(args.offset)||0)),limit=Math.min(60000,Math.max(1,Math.floor(Number(args.limit)||16000)));
  const content=parsed.markdown.slice(offset,offset+limit),nextOffset=offset+content.length<parsed.markdown.length?offset+content.length:null;
  return{content,source:{...source,startLine:parsed.markdown.slice(0,offset).split(/\r\n|\n|\r/).length},stats:parsed.stats,warnings:parsed.warnings,totalCharacters:parsed.markdown.length,offset,nextOffset,truncated:nextOffset!==null};
}
