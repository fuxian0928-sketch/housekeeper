import {database} from '../../db.js';
import {getAgentRun,listAgentArtifacts,listAgentInvocations} from '../agent/run-store.js';
import type {SkillToolContext,SkillToolDefinition} from '../skills/skill-tool-registry.js';

const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const stop=new Set(['帮我','上次','之前','昨天','刚才','这个','那个','这份','那份','继续','接着','一下','什么','怎么','的事','我的','我们','你说','一下','可以','需要','请你','今天']);
export function recallTokens(value:string){
  const normalized=value.normalize('NFKC').toLowerCase(),tokens=new Set(normalized.match(/[a-z0-9_.-]{2,}/g)??[]);
  for(const text of normalized.match(/[\u3400-\u9fff]+/g)??[])for(let index=0;index<text.length-1;index++)tokens.add(text.slice(index,index+2));
  return[...tokens].filter(token=>!stop.has(token)).slice(0,24);
}
export function safeMemoryText(value:unknown,limit=1600){return String(value??'').replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g,'[已隐藏敏感凭证]').replace(/((?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[:=：]\s*)[^\s,，;；]{6,}/gi,'$1[已隐藏敏感凭证]').slice(0,limit);}
function scopeProject(context:Pick<SkillToolContext,'projectId'>,requested?:unknown){
  const projectId=typeof requested==='string'&&requested?requested:context.projectId??null;
  if(context.projectId&&projectId!==context.projectId)throw fail('不能读取其他项目的历史与事务。',403);
  if(projectId&&!database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId))throw fail('项目不存在。',404);
  return projectId;
}
const chat=/^(?:你好|您好|嗨|哈喽|早上好|晚上好|晚安|谢谢|哈哈|嗯|好)[呀啊哦呢吧~～。！!\s]*$/;
export const isSimpleGreeting=(query:string)=>chat.test(query.trim());
function sourceSummary(row:Record<string,unknown>,tokens:string[]){
  const text=safeMemoryText(row.content,100_000),positions=tokens.map(token=>text.toLowerCase().indexOf(token)).filter(position=>position>=0),start=Math.max(0,(positions.length?Math.min(...positions):0)-160);
  return{messageId:String(row.id),conversationId:String(row.conversation_id),projectId:row.project_id?String(row.project_id):null,role:String(row.role),createdAt:String(row.created_at),content:safeMemoryText(text.slice(start),1400),truncated:start>0||text.length-start>1400,evidenceType:row.role==='user'?'user_statement':'assistant_statement',source:'conversation_archive'};
}
export function searchConversationArchive(input:{query:unknown;projectId?:unknown;limit?:unknown;since?:unknown;until?:unknown},context:Pick<SkillToolContext,'projectId'>={}){
  const query=String(input.query??'').trim().slice(0,2000),tokens=recallTokens(query),projectId=scopeProject(context,input.projectId),limit=Math.min(12,Math.max(1,Math.floor(Number(input.limit)||4)));
  if(!tokens.length||isSimpleGreeting(query))return[];
  const conditions=["m.role IN ('user','assistant')","(COALESCE(r.project_id,c.project_id) IS NULL OR p.deleted_at IS NULL AND p.id IS NOT NULL)"],params:string[]=[];
  if(projectId){conditions.push('COALESCE(r.project_id,c.project_id)=?');params.push(projectId);}
  for(const [value,operator] of [[input.since,'>='],[input.until,'<=']] as const)if(value!==undefined){const date=new Date(String(value));if(Number.isNaN(date.getTime()))throw fail('历史查询时间无效。');conditions.push(`m.created_at${operator}?`);params.push(date.toISOString());}
  const base=`FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agent_runs r ON r.id=m.run_id LEFT JOIN projects p ON p.id=COALESCE(r.project_id,c.project_id) WHERE ${conditions.join(' AND ')}`;
  const select='SELECT m.id,m.conversation_id,m.role,m.content,m.created_at,COALESCE(r.project_id,c.project_id) AS project_id ';
  let rows:Record<string,unknown>[]=[];
  const terms=[...query.matchAll(/[\u3400-\u9fff]{3,}|[a-zA-Z0-9_.-]{3,}/g)].map(match=>`"${match[0].replaceAll('"','""')}"`).slice(0,8).join(' OR ');
  if(terms)try{rows=database.prepare(`${select}${base} AND m.id IN (SELECT message_id FROM message_archive_fts WHERE message_archive_fts MATCH ? LIMIT 100) ORDER BY m.created_at DESC LIMIT 80`).all(...params,terms);}catch{/* Short Chinese terms remain available through literal matching. */}
  if(!rows.length){
    const patterns=tokens.slice(0,12).map(token=>`%${token.replace(/[\\%_]/g,'\\$&')}%`);
    rows=database.prepare(`${select}${base} AND (${patterns.map(()=>"lower(m.content) LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY m.created_at DESC LIMIT 80`).all(...params,...patterns);
  }
  const seen=new Set<string>();
  return rows.map(row=>({row,score:tokens.reduce((score,token)=>score+(String(row.content).toLowerCase().includes(token)?1:0),0)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||String(b.row.created_at).localeCompare(String(a.row.created_at))).filter(({row})=>{const key=`${row.role}:${row.content}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,limit).map(({row})=>sourceSummary(row,tokens));
}
export function readConversationArchive(input:{conversationId:unknown;offset?:unknown;limit?:unknown},context:Pick<SkillToolContext,'projectId'>={}){
  const id=String(input.conversationId??''),conversation=database.prepare('SELECT project_id FROM conversations WHERE id=?').get(id);if(!conversation)throw fail('历史对话不存在。',404);
  if(context.projectId&&conversation.project_id&&conversation.project_id!==context.projectId)throw fail('历史对话不属于当前项目。',403);scopeProject(context,conversation.project_id);
  const offset=Math.max(0,Math.floor(Number(input.offset)||0)),limit=Math.min(20,Math.max(1,Math.floor(Number(input.limit)||10)));
  const base=`FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agent_runs r ON r.id=m.run_id LEFT JOIN projects p ON p.id=COALESCE(r.project_id,c.project_id) WHERE m.conversation_id=? AND m.role IN ('user','assistant') AND (COALESCE(r.project_id,c.project_id) IS NULL OR p.id IS NOT NULL AND p.deleted_at IS NULL)${context.projectId?' AND COALESCE(r.project_id,c.project_id)=?':''}`;
  const scope=context.projectId?[id,context.projectId]:[id];
  const rows=database.prepare(`SELECT m.id,m.conversation_id,m.role,m.content,m.created_at,COALESCE(r.project_id,c.project_id) AS project_id ${base} ORDER BY m.rowid LIMIT ? OFFSET ?`).all(...scope,limit,offset);
  const total=Number(database.prepare(`SELECT COUNT(*) AS n ${base}`).get(...scope)?.n??0);
  return{messages:rows.map(row=>sourceSummary(row,[])),offset,nextOffset:offset+rows.length<total?offset+rows.length:null,total};
}
export function readWorkRecord(runId:string,context:Pick<SkillToolContext,'projectId'>={}){
  const run=getAgentRun(runId);if(context.projectId&&run.projectId!==context.projectId)throw fail('事务不属于当前项目。',403);scopeProject(context,run.projectId);
  const lease=database.prepare('SELECT lease_expires_at FROM agent_runs WHERE id=?').get(runId);
  const recoveryRequired=run.status==='running'&&(!lease?.lease_expires_at||String(lease.lease_expires_at)<=new Date().toISOString());
  return{runId:run.id,conversationId:run.conversationId,projectId:run.projectId,goal:safeMemoryText(run.goal,700),status:run.status,recoveryRequired,updatedAt:run.updatedAt,artifacts:listAgentArtifacts(run.id).slice(-8).map(artifact=>({id:artifact.id,title:safeMemoryText(artifact.title,200),documentId:artifact.documentId,fileId:artifact.fileId,createdAt:artifact.createdAt})),steps:listAgentInvocations(run.id).slice(-10).map(call=>({id:call.id,tool:call.toolName,status:call.status,proposalId:call.proposalId})),note:'这是持久化的实际执行状态；执行租约过期需恢复核对。未完成、待确认或结果未知不能当作已经完成，也不能凭记忆自动重复执行。'};
}
export function findWorkContext(query:string,context:Pick<SkillToolContext,'projectId'>={}){
  const projectId=scopeProject(context),tokens=recallTokens(query);
  if(isSimpleGreeting(query))return{status:'none' as const,candidates:[] as ReturnType<typeof readWorkRecord>[]};
  const generic=/^(?:继续|接着)(?:吧|做|处理|那个|这个|上次的工作|昨天的工作|刚才的工作)?[。！!\s]*$/.test(query.trim());
  const rows=database.prepare(`SELECT r.id,r.goal,r.project_id,r.status,r.updated_at,(SELECT group_concat(a.title,' ') FROM agent_artifacts a WHERE a.run_id=r.id) AS artifact_titles FROM agent_runs r LEFT JOIN projects p ON p.id=r.project_id WHERE (r.project_id IS NULL OR p.id IS NOT NULL AND p.deleted_at IS NULL)${projectId?' AND r.project_id=?':''} ORDER BY r.updated_at DESC LIMIT 100`).all(...(projectId?[projectId]:[]));
  const ranked=rows.map(row=>({row,score:tokens.reduce((sum,token)=>sum+(`${row.goal} ${row.artifact_titles??''}`.toLowerCase().includes(token)?1:0),0)})).filter(({row,score})=>generic?!['completed','cancelled'].includes(String(row.status)):score>0).sort((a,b)=>b.score-a.score||String(b.row.updated_at).localeCompare(String(a.row.updated_at)));
  const candidates=ranked.slice(0,3).map(({row})=>readWorkRecord(String(row.id),context));
  return{status:!candidates.length?'none' as const:candidates.length===1?'resolved' as const:'ambiguous' as const,candidates};
}
const schema=(properties:Record<string,unknown>,required:string[])=>JSON.stringify({type:'object',properties,required,additionalProperties:false});
const string={type:'string',maxLength:2000},id={type:'string',maxLength:160};
export const workMemoryToolDefinitions:SkillToolDefinition[]=[
  {name:'search_conversation_history',description:'按内容查询完整语音/文字档案，返回真实角色、时间与摘录。历史助手回答只是当时说法，不是已确认事实。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({query:string,projectId:id,since:string,until:string,limit:{type:'integer',minimum:1,maximum:12}},['query'])},
  {name:'read_conversation_history',description:'读取已找到的一段历史对话，按消息分页，保留时间与发言者，敏感凭证隐藏。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({conversationId:id,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20}},['conversationId'])},
  {name:'find_work_records',description:'查找与目标相关的已保存事务和成果；直接核对执行状态，不把摘要当成已执行。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({query:string},['query'])},
  {name:'read_work_record',description:'读取某项事务的实际目标、执行回执、待确认状态和产物编号；不会继续或重复其中操作。',mode:'read',permission:'memory.read',riskLevel:'low',parameters:schema({runId:id},['runId'])}
];
export function executeWorkMemoryTool(name:string,args:Record<string,unknown>,context:SkillToolContext){
  if(name==='search_conversation_history')return searchConversationArchive({query:args.query,projectId:args.projectId,limit:args.limit,since:args.since,until:args.until},context);
  if(name==='read_conversation_history')return readConversationArchive({conversationId:args.conversationId,offset:args.offset,limit:args.limit},context);
  if(name==='find_work_records')return findWorkContext(String(args.query??''),context);
  if(name==='read_work_record')return readWorkRecord(String(args.runId??''),context);
  throw fail('记忆工具不存在。',404);
}
