import {database,nowIso} from '../../db.js';
import {createMemory} from './memory-service.js';
import {forgetMemory,memoryRevision,listMemoryHistory} from './memory-ledger.js';
import {recallTokens,safeMemoryText} from './work-memory.js';
import type {SkillToolContext,SkillToolDefinition} from '../skills/skill-tool-registry.js';

const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const id={type:'string',minLength:1,maxLength:160},content={type:'string',minLength:1,maxLength:1000};
const memoryType={type:'string',enum:['preference','work_style','user_profile','fact','project_fact','project_decision','procedure','lesson','experience','other']};
const schema=(properties:Record<string,unknown>,required:string[])=>JSON.stringify({type:'object',properties,required,additionalProperties:false});
export const explicitMemoryTools:SkillToolDefinition[]=[
 {name:'search_memories',description:'查找当前正式记忆，返回真实ID、范围和版本；问过去时可includeHistory=true查已替代内容，必须区分历史与当前。遗忘内容不返回。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({query:{type:'string',minLength:1,maxLength:200},limit:{type:'integer',minimum:1,maximum:12},includeHistory:{type:'boolean'}},['query'])},
 {name:'get_memory',description:'按ID读取记忆及当前版本，检查是否已经被替代；不是读取聊天中助手自己声称的记忆。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({memoryId:id},['memoryId'])},
 {name:'save_memory',description:'将用户明确自述或交代的事实、偏好直接保存为正式记忆，无需重复确认。个人偏好不填projectId，项目事实填实际projectId。只有saved=true回执表示已记住；不把助手猜测当用户事实。',mode:'write',permission:'memory.write',riskLevel:'low',parameters:schema({content,memoryType,projectId:id,sourceMessageId:id},['content','memoryType'])},
 {name:'replace_memory',description:'基于刚读取的ID和revision，用用户的新自述或纠正替代旧记忆，不重复确认；保留历史并原子回读。不用新建文档代替正式记忆。',mode:'write',permission:'memory.write',riskLevel:'medium',parameters:schema({memoryId:id,expectedRevision:id,content,memoryType,sourceMessageId:id},['memoryId','expectedRevision','content','memoryType'])},
 {name:'forget_memory',description:'仅当用户明确要求忘记时，按真实ID与revision清理记忆及衍生召回，阻止旧来源自动恢复；不删除原始聊天。',mode:'write',permission:'memory.write',riskLevel:'medium',parameters:schema({memoryId:id,expectedRevision:id},['memoryId','expectedRevision'])},
 {name:'read_memory_history',description:'查看一条记忆的修订与来源，区分当前状态和历史；已遗忘内容不会返回。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({memoryId:id},['memoryId'])}
];
const revision=memoryRevision;
function memoryRow(id:unknown,context:SkillToolContext){
 const row=database.prepare('SELECT * FROM memories WHERE id=?').get(String(id??''));
 if(!row)throw fail('没有找到这条记忆。',404);
 if(context.projectId&&row.project_id&&row.project_id!==context.projectId)throw fail('不能读取其他项目的记忆。',403);
 if(row.project_id&&!database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(String(row.project_id)))throw fail('记忆所属项目已不可用。',404);
 return row;
}
function view(row:Record<string,unknown>){return{id:row.id,content:safeMemoryText(row.content,1000),status:row.status,memoryType:row.memory_type,projectId:row.project_id??null,supersedesId:row.supersedes_id??null,sourceId:row.source_id??null,revision:revision(row),updatedAt:row.updated_at};}
function source(args:Record<string,unknown>,context:SkillToolContext){
 if(!context.runId)throw fail('请通过当前对话发起记忆保存，以保留真实来源。');
 const run=database.prepare('SELECT conversation_id,user_message_id FROM agent_runs WHERE id=?').get(context.runId);
 const message=run?database.prepare("SELECT id,content FROM messages WHERE id=? AND conversation_id=? AND role='user'").get(String(args.sourceMessageId??run.user_message_id),String(run.conversation_id)):null;
 if(!message)throw fail('记忆来源必须是本次对话中的用户原话，不能引用助手回答。',409);
 return{id:String(message.id),excerpt:safeMemoryText(message.content,1000)};
}
export async function executeExplicitMemoryTool(name:string,args:Record<string,unknown>,context:SkillToolContext,signal?:AbortSignal){
 signal?.throwIfAborted();
 if(name==='get_memory')return view(memoryRow(args.memoryId,context));
 if(name==='read_memory_history'){memoryRow(args.memoryId,context);return{versions:listMemoryHistory(String(args.memoryId))};}
 if(name==='forget_memory'){
  const origin=source(args,context),row=memoryRow(args.memoryId,context);
  if(revision(row)!==args.expectedRevision)throw fail('记忆已变化，请重新读取。',409);
  if(!/(?:忘掉|忘记|别再记|不要再记|删除.{0,10}记忆|forget)/i.test(origin.excerpt))throw fail('只有用户明确要求忘记，才可以清理记忆。',409);
  return forgetMemory(String(row.id));
 }
 if(name==='search_memories'){
  const query=String(args.query??'').trim();if(!query||query.length>200)throw fail('请提供1至200字的记忆查询。');
  const tokens=recallTokens(query).slice(0,16);if(!tokens.length)return{memories:[],hasMore:false};
  const timestamp=nowIso(),patterns=tokens.map(token=>`%${token.replace(/[\\%_]/g,'\\$&')}%`);
  const history=args.includeHistory===true;
  const rows=database.prepare(`SELECT m.* FROM memories m LEFT JOIN projects p ON p.id=m.project_id WHERE ${history?"m.status IN ('confirmed','superseded')":"m.status='confirmed'"} AND NOT EXISTS(SELECT 1 FROM memory_forgetting WHERE memory_id=m.id) AND (m.project_id IS NULL OR p.id IS NOT NULL AND p.deleted_at IS NULL) AND (m.valid_from IS NULL OR m.valid_from<=?) ${history?'':"AND (m.valid_until IS NULL OR m.valid_until>=?)"}${context.projectId?' AND (m.project_id IS NULL OR m.project_id=?)':''} AND (${patterns.map(()=>"lower(m.content) LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY m.updated_at DESC LIMIT 201`).all(timestamp,...(history?[]:[timestamp]),...(context.projectId?[context.projectId]:[]),...patterns);
  const ranked=rows.map(row=>({row,score:tokens.filter(t=>String(row.content).normalize('NFKC').toLowerCase().includes(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||String(b.row.updated_at).localeCompare(String(a.row.updated_at)));
  const limit=Math.min(12,Math.max(1,Math.floor(Number(args.limit)||8)));
  return{memories:ranked.slice(0,limit).map(x=>view(x.row)),hasMore:ranked.length>limit||rows.length>200};
 }
 const text=String(args.content??'').trim();
 if(!text||text.length>1000||safeMemoryText(text)!==text)throw fail('记忆内容需为1至1000字，且不能包含敏感凭证。');
 const origin=source(args,context);
 let projectId=typeof args.projectId==='string'?args.projectId:null,old:Record<string,unknown>|undefined;
 if(context.projectId&&projectId&&projectId!==context.projectId)throw fail('不能向其他项目保存记忆。',403);
 if(name==='replace_memory'){
  old=memoryRow(args.memoryId,context);
  if(old.status!=='confirmed'||revision(old)!==args.expectedRevision)throw fail('旧记忆已经变化，请重新读取后替换。',409);
  projectId=old.project_id?String(old.project_id):null;
 }else if(name!=='save_memory')throw fail('记忆工具不存在。',404);
 const result=await createMemory({content:text,memoryType:String(args.memoryType),projectId,sourceType:'conversation',sourceId:origin.id,sourceExcerpt:origin.excerpt,sourceLabel:'用户明确自述的记忆',...(old?{supersedesId:String(old.id),expectedRevision:String(args.expectedRevision),allowRelated:true}:{})},undefined,signal);
 const saved=memoryRow(result.memory.id,context),retired=old&&old.id!==saved.id?memoryRow(old.id,context):null;
 const verified=String(saved.content).toLowerCase()===text.toLowerCase()&&saved.status==='confirmed'&&(!retired||retired.status==='superseded');
 return{saved:verified,created:result.created,memory:view(saved),...(retired?{replaced:view(retired)}:{}),...(!verified?{notice:'发现相近记忆但内容不同；请get_memory核对后用replace_memory明确替换，当前没有保存新内容。'}:{})};
}
