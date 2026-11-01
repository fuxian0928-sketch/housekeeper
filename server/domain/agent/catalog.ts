import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { getSkillTool,listSkillTools,type SkillToolDefinition } from '../skills/skill-tool-registry.js';
import type { AgentModelTool,ExposedCapability } from './types.js';

const string={type:'string'},id={type:'string',minLength:1,maxLength:160};
const boolean={type:'boolean'},strings={type:'array',items:id,maxItems:100};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const project={projectId:id};
const task={...project,title:{...string,maxLength:120},description:string,status:{type:'string',enum:['todo','doing','waiting','done','cancelled']},priority:{type:'string',enum:['high','medium','low']},executor:{type:'string',enum:['self','ai','external']},startAt:{type:['string','null']},dueAt:{type:['string','null']},documentIds:strings};
const builtinSchemas:Record<string,Record<string,unknown>>={
  list_projects:schema({}),get_project:schema(project),list_project_tasks:schema(project),list_project_documents:schema(project),
  search_documents:schema({...project,query:string,limit:{type:'integer',minimum:1,maximum:12}},['query']),
  get_document:schema({documentId:id,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60000}},['documentId']),
  list_document_versions:schema({documentId:id},['documentId']),get_document_version:schema({documentId:id,revision:{type:'integer',minimum:1}},['documentId','revision']),
  list_document_capabilities:schema({}),
  computer_tools:schema({}),computer_snapshot:schema({}),
  computer_action:schema({tool:{type:'string',enum:['App','Click','Type','Scroll','Move','Shortcut']},arguments:{type:'object'}},['tool','arguments']),
  create_project:schema({name:string,summary:string,priority:{type:'string',enum:['high','medium','low']}},['name']),
  update_project:schema({...project,name:string,summary:string,status:{type:'string',enum:['active','paused','completed','archived']},priority:{type:'string',enum:['high','medium','low']},progress:{type:'number',minimum:0,maximum:100}}),
  create_task:schema(task,['title']),update_task:schema({...task,taskId:id},['taskId']),
  create_document:schema({title:string,content:string,...project,taskId:id},['title','content']),
  update_document:schema({documentId:id,title:string,content:string},['documentId']),
  patch_document:schema({documentId:id,before:{...string,maxLength:4000},after:{...string,maxLength:4000}},['documentId','before','after']),
  link_document_to_project:schema({...project,documentId:id,linked:boolean},['documentId']),link_document_to_task:schema({taskId:id,documentId:id,linked:boolean},['taskId','documentId'])
};
const validator=new AjvJsonSchemaValidator();
export function capabilityFingerprint(tool:SkillToolDefinition){return createHash('sha256').update(JSON.stringify([tool.name,tool.parameters,tool.mode,tool.permission,tool.description])).digest('hex');}
export function exposeCapability(name:string):ExposedCapability {
  const tool=getSkillTool(name);if(!tool||!listSkillTools().some(item=>item.name===name&&item.enabled))throw new Error('该能力已停用、移除或尚未配置。');
  const external=/^(?:http|mcp)_/.test(name),stableId=`registered:${name.replace(/_v\d+$/,'')}`;
  return {alias:external?`cap_${createHash('sha256').update(name).digest('hex').slice(0,24)}`:name,name,stableId,fingerprint:capabilityFingerprint(tool)};
}
export function defaultAgentCapabilities(){return listSkillTools().filter(tool=>tool.enabled&&!/^(?:http|mcp)_/.test(tool.name)).map(tool=>exposeCapability(tool.name));}
export function capabilitySchema(name:string){
  if(builtinSchemas[name])return builtinSchemas[name];
  const tool=getSkillTool(name);if(!tool)throw new Error('能力已不可用。');
  const parsed=JSON.parse(tool.parameters) as Record<string,unknown>;
  if(parsed.type!=='object')throw new Error('能力缺少可执行的对象参数定义。');
  return parsed;
}
export function checkCapability(exposed:ExposedCapability,args:Record<string,unknown>){
  const current=getSkillTool(exposed.name);
  if(!current||capabilityFingerprint(current)!==exposed.fingerprint)throw new Error('能力配置或版本已变化，旧操作未执行，请重新加载该能力。');
  if(!listSkillTools().some(tool=>tool.name===exposed.name&&tool.enabled))throw new Error('该能力已停用，未执行。');
  const result=validator.getValidator(capabilitySchema(exposed.name))(args);
  if(!result.valid)throw new Error('参数不符合该能力的定义，请核对必填字段和类型。');
  return current;
}
export function agentModelTools(exposed:ExposedCapability[]):AgentModelTool[]{return [...internalAgentTools,...exposed.map(capability=>{const tool=getSkillTool(capability.name);if(!tool)return null;return {type:'function' as const,function:{name:capability.alias,description:tool.description,parameters:capabilitySchema(capability.name)}};}).filter((item):item is AgentModelTool=>item!==null)];}
export const internalAgentTools:AgentModelTool[]=[
  {type:'function',function:{name:'resolve_reference',description:'用真实项目、文档、任务名称及当前页面和最近读取对象解析模糊指代；有多个合理目标时返回候选，不能编造。',parameters:schema({query:string,kind:{type:'string',enum:['project','document','task','page']}},['query'])}},
  {type:'function',function:{name:'show_resource',description:'在当前发问设备显示已经找到的项目、文档、任务或固定页面；只有shown=true才可声称页面已打开。',parameters:schema({kind:{type:'string',enum:['project','document','task','page']},id,title:string},['kind','id'])}},
  {type:'function',function:{name:'find_capabilities',description:'按用途搜索已配置能力的简短目录，不执行其中的操作。',parameters:schema({query:string},['query'])}},
  {type:'function',function:{name:'load_capability',description:'读取并开放一个搜索结果中的具体能力及参数。未加载的外部能力不能调用。',parameters:schema({name:id},['name'])}},
  {type:'function',function:{name:'load_skill',description:'按id读取已安装启用的技能规则；规则不能扩大工具权限。',parameters:schema({skillId:id},['skillId'])}},
  {type:'function',function:{name:'ask_user',description:'只有缺少执行必需的信息或目标有歧义时，保存进度并向用户提出具体问题。',parameters:schema({question:{...string,maxLength:2000}},['question'])}},
  {type:'function',function:{name:'show_draft',description:'把本次撰写的Markdown草稿放在成果面板供用户检查；不保存为资料库文档。',parameters:schema({title:string,content:{...string,maxLength:120000},sourceDocumentIds:{type:'array',items:id,maxItems:30}},['title','content'])}}
];
export function validateInternalTool(name:string,args:Record<string,unknown>){const tool=internalAgentTools.find(item=>item.function.name===name);if(!tool||!validator.getValidator(tool.function.parameters)(args).valid)throw new Error('内部能力参数无效。');}
