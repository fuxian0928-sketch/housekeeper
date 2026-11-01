import ExcelJS from 'exceljs';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve,sep } from 'node:path';
import { database,databaseDirectory,nowIso } from '../../db.js';
import type { SkillToolContext,SkillToolDefinition } from '../skills/skill-tool-registry.js';

const rawRoot=resolve(process.env.AI_SECRETARY_DOCUMENT_ROOT?.trim()||join(databaseDirectory,'..','raw-documents'));
export const generatedFilesRoot=resolve(process.env.AI_SECRETARY_ARTIFACT_ROOT?.trim()||join(databaseDirectory,'generated-files'));
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type Cell=string|number|boolean|null;
const str={type:'string'};
const documentSchema={documentId:str,sheet:str,headerRow:{type:'integer',minimum:1,maximum:100}};
const schema=(properties:Record<string,unknown>,required:string[])=>JSON.stringify({type:'object',properties,required,additionalProperties:false});
export const spreadsheetToolDefinitions:SkillToolDefinition[]=[
  {name:'read_spreadsheet',description:'读取已导入Excel工作表的列和实际数据，支持分页；不执行文件中的公式或宏。',mode:'read',permission:'documents.read',riskLevel:'low',parameters:schema({...documentSchema,startRow:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:200}},['documentId'])},
  {name:'summarize_spreadsheet',description:'由程序按指定列分组并计算合计、平均、最小值、最大值或数量，返回可直接导出的结果和异常计数。',mode:'read',permission:'documents.read',riskLevel:'low',parameters:schema({...documentSchema,groupBy:str,valueColumn:str,operation:{type:'string',enum:['sum','average','min','max','count']}},['documentId','operation'])},
  {name:'export_spreadsheet',description:'生成可下载的Excel。优先用fromInvocationId原样导出本次汇总结果；也可提供明确的列与表格数据。',mode:'write',permission:'documents.export',riskLevel:'medium',parameters:schema({title:str,fromInvocationId:str,columns:{type:'array',items:str,minItems:1,maxItems:100},rows:{type:'array',maxItems:20000,items:{type:'array',maxItems:100,items:{type:['string','number','boolean','null']}}},sourceDocumentIds:{type:'array',items:str,maxItems:30}},['title'])}
];
function assertDocumentScope(documentId:string,context:SkillToolContext){
  if(!documentId||!database.prepare('SELECT id FROM knowledge_documents WHERE id=?').get(documentId))throw fail('请提供已导入的文档编号。',404);
  if(context.projectId&&!database.prepare('SELECT document_id FROM project_document_links WHERE document_id=? AND project_id=?').get(documentId,context.projectId))throw fail('表格不属于当前项目。',403);
}
function cellValue(cell:ExcelJS.Cell):Cell {
  const value=cell.value;
  if(value==null)return null;
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')return value;
  if('formula' in value||'sharedFormula' in value){const cached=value.result;return typeof cached==='string'||typeof cached==='number'||typeof cached==='boolean'?cached:null;}
  if('richText' in value)return value.richText.map(part=>part.text).join('');
  if('text' in value)return String(value.text);
  return null;
}
async function sheetData(args:Record<string,unknown>,context:SkillToolContext){
  const documentId=String(args.documentId??'');assertDocumentScope(documentId,context);
  const source=database.prepare("SELECT * FROM office_document_imports WHERE document_id=? AND format='xlsx' AND status='ready' ORDER BY created_at DESC LIMIT 1").get(documentId);
  if(!source)throw fail('该文档没有可读取的Excel原文件，请先导入.xlsx文件。');
  const path=resolve(rawRoot,String(source.storage_path));
  if(!path.startsWith(rawRoot+sep))throw fail('表格原文件位置无效。',403);
  const bytes=await readFile(path);
  if(bytes.length>15*1024*1024||createHash('sha256').update(bytes).digest('hex')!==source.content_hash)throw fail('表格原文件大小或版本校验失败。',409);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const requested=typeof args.sheet==='string'?args.sheet:'';
  const sheet=requested?workbook.getWorksheet(requested):workbook.worksheets[0];
  if(!sheet)throw fail('没有找到指定工作表，请按返回的工作表名称选择。');
  if(sheet.rowCount>100000||sheet.columnCount>200)throw fail('表格过大，请先拆分为较小工作表。',413);
  const headerRow=Number(args.headerRow??1);
  if(!Number.isInteger(headerRow)||headerRow<1||headerRow>100)throw fail('标题行必须为1至100的整数。');
  const columns=Array.from({length:sheet.columnCount},(_,i)=>({key:`c${i+1}`,label:String(cellValue(sheet.getRow(headerRow).getCell(i+1))??'').trim()||`第${i+1}列`}));
  return {sheet,columns,headerRow,sheets:workbook.worksheets.map(item=>({name:item.name,rows:item.rowCount,columns:item.columnCount})),source:{documentId,importId:String(source.id),filename:String(source.filename),sha256:String(source.content_hash),sheet:sheet.name,readAt:nowIso()}};
}
function columnIndex(columns:Array<{key:string;label:string}>,name:unknown,required=true){
  if(!name&&!required)return -1;
  const value=String(name??'');const matches=columns.map((column,index)=>({column,index})).filter(({column})=>column.key===value||column.label===value);
  if(matches.length!==1)throw fail(`列“${value}”不存在或名称重复，请使用读取结果中的c1、c2等列编号。`);
  return matches[0].index;
}
export async function executeSpreadsheetTool(name:string,args:Record<string,unknown>,context:SkillToolContext){
  if(name==='read_spreadsheet'){
    const data=await sheetData(args,context),start=Math.max(data.headerRow+1,Math.floor(Number(args.startRow)||data.headerRow+1)),limit=Math.min(200,Math.max(1,Math.floor(Number(args.limit)||80)));
    const end=Math.min(data.sheet.rowCount,start+limit-1);
    const rows=Array.from({length:Math.max(0,end-start+1)},(_,i)=>({rowNumber:start+i,cells:Object.fromEntries(data.columns.map((column,index)=>[column.key,cellValue(data.sheet.getRow(start+i).getCell(index+1))]))}));
    return {sheets:data.sheets,sheet:data.sheet.name,columns:data.columns,rows,hasMore:end<data.sheet.rowCount,nextRow:end<data.sheet.rowCount?end+1:null,source:data.source};
  }
  if(name==='summarize_spreadsheet'){
    const data=await sheetData(args,context),operation=String(args.operation);
    if(!['sum','average','min','max','count'].includes(operation))throw fail('不支持该汇总方式。');
    const groupIndex=columnIndex(data.columns,args.groupBy,false),valueIndex=columnIndex(data.columns,args.valueColumn,operation!=='count');
    const groups=new Map<string,{sum:number;count:number;min:number;max:number}>();let skippedNumericCells=0,emptyRows=0;
    for(let rowNumber=data.headerRow+1;rowNumber<=data.sheet.rowCount;rowNumber++){
      const row=data.sheet.getRow(rowNumber);if(!row.hasValues){emptyRows++;continue;}
      const key=groupIndex<0?'全部':String(cellValue(row.getCell(groupIndex+1))??'未填写');
      const value=valueIndex<0?1:cellValue(row.getCell(valueIndex+1));
      if(operation!=='count'&&(typeof value!=='number'||!Number.isFinite(value))){skippedNumericCells++;continue;}
      const number=operation==='count'?1:Number(value),group=groups.get(key)??{sum:0,count:0,min:Infinity,max:-Infinity};
      group.sum+=number;group.count++;group.min=Math.min(group.min,number);group.max=Math.max(group.max,number);groups.set(key,group);
    }
    const labels:Record<string,string>={sum:'合计',average:'平均值',min:'最小值',max:'最大值',count:'数量'};
    const rows=[...groups].map(([key,group])=>[key,operation==='count'?group.count:operation==='average'?group.sum/group.count:operation==='min'?group.min:operation==='max'?group.max:group.sum,group.count]);
    return {columns:[groupIndex<0?'范围':data.columns[groupIndex].label,labels[operation],'有效记录数'],rows,operation,skippedNumericCells,emptyRows,source:data.source,sourceDocumentIds:[data.source.documentId],note:'使用Excel原文件中的数值及公式缓存，不计算未缓存公式；非数值单元格已计入异常数量。'};
  }
  if(name!=='export_spreadsheet')throw fail('表格工具不存在。',404);
  let columns=args.columns,rows=args.rows,sources=Array.isArray(args.sourceDocumentIds)?args.sourceDocumentIds.map(String):[];
  if(args.fromInvocationId){
    if(!context.runId)throw fail('原样导出汇总结果需要当前事务编号。');
    const invocation=database.prepare("SELECT result_json FROM agent_invocations WHERE id=? AND run_id=? AND tool_name='summarize_spreadsheet' AND status='succeeded'").get(String(args.fromInvocationId),context.runId);
    if(!invocation?.result_json)throw fail('没有找到本次事务已经成功的汇总结果。',409);
    const result=JSON.parse(String(invocation.result_json));columns=result.columns;rows=result.rows;sources=result.sourceDocumentIds??[];
  }
  if(!Array.isArray(columns)||!columns.length||columns.length>100||columns.some(column=>typeof column!=='string'||column.length>120)||!Array.isArray(rows)||rows.length>20000)throw fail('请提供有效的表头与表格数据。');
  if(rows.some(row=>!Array.isArray(row)||row.length>columns.length||row.some(cell=>cell!==null&&!['string','number','boolean'].includes(typeof cell)||typeof cell==='number'&&!Number.isFinite(cell)||typeof cell==='string'&&cell.length>32000)))throw fail('单元格必须是文字、有限数值、布尔值或空值。');
  for(const documentId of sources)assertDocumentScope(documentId,context);
  const title=String(args.title??'').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g,'').slice(0,100);if(!title)throw fail('请填写表格名称。');
  const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('整理结果');sheet.addRow(columns);for(const row of rows)sheet.addRow(row);
  sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true,color:{argb:'FF303C45'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE9EDEF'}};sheet.columns.forEach(column=>{column.width=22;});sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,rows.length+1),column:columns.length}};
  const output=Buffer.from(await workbook.xlsx.writeBuffer());const id=randomUUID(),filename=`${title}.xlsx`,storagePath=join(generatedFilesRoot,`${id}.xlsx`),sha256=createHash('sha256').update(output).digest('hex');
  await mkdir(generatedFilesRoot,{recursive:true});await writeFile(storagePath,output,{flag:'wx'});
  database.prepare('INSERT INTO generated_files(id,filename,mime_type,storage_path,bytes,sha256,sources_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,filename,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',storagePath,output.length,sha256,JSON.stringify(sources),nowIso());
  return {fileId:id,title,filename,columns,rows:rows.length,bytes:output.length,sha256,downloadUrl:`/api/agent/files/${id}`,sourceDocumentIds:sources,verified:true};
}
