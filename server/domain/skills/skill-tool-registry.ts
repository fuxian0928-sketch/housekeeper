import { guardedExternalTool } from './external-tool-guard.js';
import { database } from '../../db.js';
import {httpToolDefinitions,callHttpTool} from './http-tools.js';
import { createHash } from 'node:crypto';
import {assistantToolAllowed} from '../agent/assistant-scope.js';
import { createKnowledgeDocument, getKnowledgeDocument, setProjectDocumentLink, setTaskDocumentLink, updateKnowledgeDocument } from '../documents/knowledge-document-editor.js';
import { createProject, listProjects, projectDocuments, projectOverview, updateProject } from '../projects/project-service.js';
import { createTask, listProjectTasks, updateTask } from '../tasks/task-service.js';
import {retrieveKnowledge,browseKnowledge,readKnowledgeEvidence} from '../../retrieval/rag-service.js';
import { officeCapabilityStatus } from '../documents/office-document-parser.js';
import {fileCapabilityStatus,uploadedFileToolDefinitions,readUploadedFile} from '../documents/uploaded-files.js';
import {officeFileEditDefinitions,patchOfficeFile} from '../documents/office-file-edits.js';
import {workMemoryToolDefinitions,executeWorkMemoryTool} from '../memories/work-memory.js';
import {explicitMemoryTools,executeExplicitMemoryTool} from '../memories/explicit-memory-tools.js';
import { controlledTool, toolEnabled, toolPolicy } from './tool-controls.js';
import { mcpToolDefinitions, callMcpTool } from './mcp-connections.js';
import { spreadsheetToolDefinitions,executeSpreadsheetTool } from '../documents/spreadsheet-tools.js';
import {computerCatalog,requestComputerTool} from '../interaction/computer-bridge.js';
import {webToolDefinitions,isWebTool,executeWebTool} from './web-tools.js';

export type SkillToolMode = 'read' | 'write';
export type SkillToolContext = { projectId?: string | null; vaultPath: string; confirmed?: boolean; runId?: string; deviceId?:string;goal?:string };

export type SkillToolDefinition = {
  name: string;
  description: string;
  mode: SkillToolMode;
  permission: string;
  riskLevel: 'low' | 'medium' | 'high';
  parameters: string;
};

const definitions: SkillToolDefinition[] = [
  ...webToolDefinitions,
  {name:'computer_tools',description:'查看当前Windows电脑已连接且允许的MCP工具及确切参数；操作电脑前先读取。',mode:'read',permission:'computer.observe',riskLevel:'low',parameters:'{}'},
  {name:'computer_snapshot',description:'读取当前Windows电脑的窗口与可操作元素，参数以本机Snapshot定义为准；不会点击。',mode:'read',permission:'computer.observe',riskLevel:'low',parameters:'{}'},
  {name:'computer_action',description:'通过当前Windows电脑的MCP执行应用或键鼠操作；先读取computer_tools和computer_snapshot。操作后应读取状态核对。',mode:'write',permission:'computer.control',riskLevel:'high',parameters:JSON.stringify({type:'object',properties:{tool:{type:'string',enum:['App','Click','Type','Scroll','Move','Shortcut']},arguments:{type:'object'}},required:['tool','arguments'],additionalProperties:false})},
  { name: 'list_projects', description: '列出服务器中的项目及任务、文档统计', mode: 'read', permission: 'projects.read', riskLevel: 'low', parameters: '{}' },
  { name: 'get_project', description: '读取一个项目的详情、进度和近期事件', mode: 'read', permission: 'projects.read', riskLevel: 'low', parameters: '{ projectId?: string }' },
  { name: 'list_project_tasks', description: '读取一个项目的任务', mode: 'read', permission: 'tasks.read', riskLevel: 'low', parameters: '{ projectId?: string }' },
  { name: 'list_project_documents', description: '读取一个项目关联的文档列表', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ projectId?: string }' },
  { name: 'search_documents', description: '检索服务器资料库；项目对话会按项目关联优先级召回', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ query: string, projectId?: string, limit?: number }' },
  {name:'retrieve_knowledge',description:'统一分层检索：子块命中、父级回填；返回证据位置、原文哈希、索引及超时降级诊断。空结果不能代表资料不存在。',mode:'read',permission:'documents.read',riskLevel:'low',parameters:JSON.stringify({type:'object',properties:{query:{type:'string',minLength:1,maxLength:1000},projectId:{type:'string'},sourcePath:{type:'string',maxLength:1000},limit:{type:'integer',minimum:1,maximum:12}},required:['query'],additionalProperties:false})},
  {name:'browse_knowledge',description:'按名称、文件路径查看知识目录和章节；精确文件、代码符号、配置项优先浏览后读原文。',mode:'read',permission:'documents.read',riskLevel:'low',parameters:JSON.stringify({type:'object',properties:{query:{type:'string',maxLength:1000},projectId:{type:'string'},sourcePath:{type:'string',maxLength:1000},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false})},
  {name:'read_knowledge_evidence',description:'凭parentId回读检索证据并检查sourceRevision；失效时重新检索。修改前仍必须get_document读取当前版本。',mode:'read',permission:'documents.read',riskLevel:'low',parameters:JSON.stringify({type:'object',properties:{parentId:{type:'string',minLength:1},sourceRevision:{type:'string'}},required:['parentId'],additionalProperties:false})},
  { name: 'get_document', description: '读取文档的解析后Markdown，支持offset、limit分页，并返回版本。', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ documentId: string, offset?: number, limit?: number }' },
  { name: 'list_document_versions', description: '查看资料库文档保留的历史版本与修改时间。', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ documentId: string }' },
  { name: 'get_document_version', description: '读取文档的一个历史版本，用于核对与对比。', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ documentId: string, revision: number }' },
  { name: 'list_document_capabilities', description: '查看服务器已安装的文档处理能力、支持格式、权限和大小限制', mode: 'read', permission: 'capabilities.read', riskLevel: 'low', parameters: '{}' },
  { name: 'create_project', description: '新建项目', mode: 'write', permission: 'projects.write', riskLevel: 'medium', parameters: '{ name: string, summary?: string, priority?: high|medium|low }' },
  { name: 'update_project', description: '修改项目名称、目标、状态、优先级或进度', mode: 'write', permission: 'projects.write', riskLevel: 'medium', parameters: '{ projectId?: string, name?, summary?, status?, priority?, progress? }' },
  { name: 'create_task', description: '在项目中创建任务', mode: 'write', permission: 'tasks.write', riskLevel: 'medium', parameters: '{ projectId?: string, title: string, description?, status?, priority?, startAt?, dueAt?, documentIds? }' },
  { name: 'update_task', description: '修改任务内容或状态', mode: 'write', permission: 'tasks.write', riskLevel: 'medium', parameters: '{ taskId: string, title?, description?, status?, priority?, startAt?, dueAt?, documentIds? }' },
  { name: 'create_document', description: '在服务器资料库中新建 Markdown 文档并自动切块、索引', mode: 'write', permission: 'documents.write', riskLevel: 'medium', parameters: '{ title: string, content: string, projectId?, taskId? }' },
  { name: 'update_document', description: '修改服务器资料库文档并重建切块与索引', mode: 'write', permission: 'documents.write', riskLevel: 'medium', parameters: '{ documentId: string, title?, content? }' },
  { name: 'patch_document', description: '先用 get_document 读取，再精确替换唯一匹配的原文片段；保留其他内容，校验版本并回读核实。', mode: 'write', permission: 'documents.write', riskLevel: 'medium', parameters: '{ documentId: string, before: string, after: string }' },
  { name: 'link_document_to_project', description: '关联或取消关联项目文档', mode: 'write', permission: 'documents.link', riskLevel: 'medium', parameters: '{ projectId?: string, documentId: string, linked?: boolean }' },
  { name: 'link_document_to_task', description: '关联或取消关联任务文档', mode: 'write', permission: 'documents.link', riskLevel: 'medium', parameters: '{ taskId: string, documentId: string, linked?: boolean }' },
  ...spreadsheetToolDefinitions,...uploadedFileToolDefinitions,...officeFileEditDefinitions,...workMemoryToolDefinitions,...explicitMemoryTools
];

const byName = new Map(definitions.map((item) => [item.name, item]));
function httpError(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function record(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('工具参数必须是对象。'); return value as Record<string, unknown>; }
function text(value: unknown, field: string, max = 2000, required = false) { const result = typeof value === 'string' ? value.trim() : ''; if (required && !result) throw httpError(`缺少 ${field}。`); if (result.length > max) throw httpError(`${field} 过长。`); return result; }
function id(value: unknown, field: string, required = true) { const result = text(value, field, 100, required); if (result && !/^[\p{L}\p{N}_.:-]+$/u.test(result)) throw httpError(`${field} 格式不正确。`); return result; }
function strings(value: unknown) { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))].slice(0, 100) : undefined; }
function projectId(args: Record<string, unknown>, context: SkillToolContext) {
  const requested = id(args.projectId, 'projectId', false) || context.projectId || '';
  if (!requested) throw httpError('缺少 projectId。');
  if (context.projectId && requested !== context.projectId) throw httpError('项目对话中的 Skill 不能操作其他项目。', 403);
  return requested;
}
function assertTaskScope(taskId: string, context: SkillToolContext) {
  if (!context.projectId) return;
  const task = database.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as { project_id: string } | undefined;
  if (!task || task.project_id !== context.projectId) throw httpError('项目对话中的 Skill 不能操作其他项目的任务。', 403);
}

export function listSkillTools() { return [...definitions,...mcpToolDefinitions(),...httpToolDefinitions()].map((item) => ({ ...item, enabled: toolEnabled(item.name)&&assistantToolAllowed(item), policy:toolPolicy(item.name) })); }
export function getSkillTool(name: string) { return byName.get(name) ?? [...mcpToolDefinitions(),...httpToolDefinitions()].find(t=>t.name===name) ?? null; }

export function documentRevision(content: unknown) { return createHash('sha256').update(String(content ?? '')).digest('hex'); }
export function prepareDocumentPatch(args: Record<string, unknown>, context: SkillToolContext) {
  const document = getKnowledgeDocument(id(args.documentId, 'documentId'));
  if (context.projectId && !document.projectIds.includes(context.projectId)) throw httpError('文档不属于当前项目。', 403);
  const content = String(document.content ?? '');
  if (args.expectedRevision !== documentRevision(content)) throw httpError('文档已变化或尚未读取，请重新读取后生成修改。', 409);
  const before = typeof args.before === 'string' ? args.before : '';
  const after = typeof args.after === 'string' ? args.after : '';
  if (!before.trim() || !after.trim() || before.length > 4000 || after.length > 4000 || before === after) throw httpError('请提供不同且不超过4000字的修改前后片段。');
  if (content.split(before).length !== 2) throw httpError('原文片段不存在或匹配多处，请读取更完整的片段。', 409);
  return { document, before, after, content: content.replace(before, () => after) };
}

export function executeSkillTool(name: string, rawArguments: unknown, context: SkillToolContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const definition=getSkillTool(name);
  if (!definition) throw httpError('工具不存在。',404);
  if(!assistantToolAllowed(definition))throw httpError('当前助理负责检索、文字、总结和记忆；实际执行工作请交给 Codex。',403);
  return controlledTool(name, () => {
    if(isWebTool(name))return executeWebTool(name,record(rawArguments),context,signal);
    if(name==='computer_tools')return computerCatalog(context.deviceId);
    if(name==='computer_snapshot')return requestComputerTool({deviceId:context.deviceId,runId:context.runId,tool:'Snapshot',sessionId:typeof record(rawArguments).computerSessionId==='string'?String(record(rawArguments).computerSessionId):undefined,arguments:{}},signal);
    if(name==='computer_action'){const args=record(rawArguments);return requestComputerTool({deviceId:context.deviceId,runId:context.runId,tool:String(args.tool),sessionId:typeof args.computerSessionId==='string'?args.computerSessionId:undefined,arguments:record(args.arguments)},signal);}
    if(name.startsWith('mcp_')||name.startsWith('http_')){
      const args=record(rawArguments);
      return guardedExternalTool(name,args,()=>name.startsWith('mcp_')?callMcpTool(name,args,signal):callHttpTool(name,args,signal));
    }
    if(spreadsheetToolDefinitions.some(tool=>tool.name===name))return executeSpreadsheetTool(name,record(rawArguments),context);
    if(name==='read_uploaded_file')return readUploadedFile(record(rawArguments),context,signal);
    if(name==='patch_office_file')return patchOfficeFile(record(rawArguments),context,signal);
    if(workMemoryToolDefinitions.some(tool=>tool.name===name))return executeWorkMemoryTool(name,record(rawArguments),context);
    if(explicitMemoryTools.some(tool=>tool.name===name))return executeExplicitMemoryTool(name,record(rawArguments),context,signal);
    return executeRegisteredTool(name,rawArguments,context,signal);
  },context.confirmed);
}

function executeRegisteredTool(name: string, rawArguments: unknown, context: SkillToolContext, signal?:AbortSignal) {
  const tool = getSkillTool(name);
  if (!tool) throw httpError(`未注册工具：${name}`, 404);
  const args = record(rawArguments);
  switch (name) {
    case 'list_projects': return listProjects(true).filter(project=>!context.projectId||project.id===context.projectId).slice(0, 100);
    case 'get_project': return projectOverview(projectId(args, context));
    case 'list_project_tasks': return listProjectTasks(projectId(args, context)).slice(0, 200);
    case 'list_project_documents': return projectDocuments(projectId(args, context)).slice(0, 200).map((item) => ({ id: item.id, title: item.title, relativePath: item.relativePath, modifiedAt: item.modifiedAt, sourceType: item.sourceType }));
    case 'search_documents':
    case 'retrieve_knowledge': {
      const query = text(args.query, 'query', 1000, true);
      const requestedProject = args.projectId || context.projectId ? projectId(args, context) : null;
      const limit = Math.max(1, Math.min(12, Number(args.limit) || 6));
      return retrieveKnowledge({query,sourcePath:text(args.sourcePath,'sourcePath',1000)||null,limit,projectId:requestedProject,accessProjectId:context.projectId,signal}).then(result=>name==='search_documents'?result.hits:result);
    }
    case 'browse_knowledge': return browseKnowledge({accessProjectId:context.projectId,query:text(args.query,'query',1000),sourcePath:text(args.sourcePath,'sourcePath',1000),projectId:args.projectId||context.projectId?projectId(args,context):null,limit:Number(args.limit)||30});
    case 'read_knowledge_evidence': return readKnowledgeEvidence(id(args.parentId,'parentId'),text(args.sourceRevision,'sourceRevision',100)||undefined,context.projectId);
    case 'get_document': {
      const document = getKnowledgeDocument(id(args.documentId, 'documentId')) as Record<string, unknown>;
      if (context.projectId && !(document.projectIds as string[]).includes(context.projectId)) throw httpError('文档不属于当前项目。', 403);
      const content=String(document.content??''),offset=Math.max(0,Math.floor(Number(args.offset)||0)),limit=Math.max(1,Math.min(12_000,Math.floor(Number(args.limit)||12_000)));
      return {...document,revision:documentRevision(content),offset,totalCharacters:content.length,truncated:offset>0||content.length>limit,hasMore:offset+limit<content.length,nextOffset:offset+limit<content.length?offset+limit:null,content:content.slice(offset,offset+limit)};
    }
    case 'list_document_versions':
    case 'get_document_version': {
      const document=getKnowledgeDocument(id(args.documentId,'documentId'));
      if(context.projectId&&!document.projectIds.includes(context.projectId))throw httpError('文档不属于当前项目。',403);
      if(name==='list_document_versions')return database.prepare('SELECT revision,title,source_type AS sourceType,created_at AS createdAt FROM knowledge_document_versions WHERE document_id=? ORDER BY revision DESC LIMIT 100').all(String(document.id));
      const revision=Number(args.revision);if(!Number.isInteger(revision)||revision<1)throw httpError('历史版本号无效。');
      const version=database.prepare('SELECT revision,title,content,created_at AS createdAt FROM knowledge_document_versions WHERE document_id=? AND revision=?').get(String(document.id),revision);
      if(!version)throw httpError('没有找到该历史版本。',404);
      return {...version,documentId:document.id,content:String(version.content).slice(0,60000),truncated:String(version.content).length>60000};
    }
    case 'list_document_capabilities': return [officeCapabilityStatus(),fileCapabilityStatus()];
    case 'create_project': {
      if (context.projectId) throw httpError('请在全局对话中创建新项目。', 403);
      return createProject({ name: text(args.name, 'name', 80, true), summary: text(args.summary, 'summary', 500), priority: text(args.priority, 'priority', 20) || 'medium' }, context.vaultPath);
    }
    case 'update_project': return updateProject(projectId(args, context), args, context.vaultPath);
    case 'create_task': return createTask(projectId(args, context), { ...args, title: text(args.title, 'title', 120, true), description: text(args.description, 'description', 2000), documentIds: strings(args.documentIds), sourceLabel: 'Skill 确认执行' });
    case 'update_task': {
      const taskId = id(args.taskId, 'taskId');
      assertTaskScope(taskId, context);
      return updateTask(taskId, { ...args, documentIds: strings(args.documentIds) });
    }
    case 'create_document': {
      if(context.projectId&&args.projectId&&args.projectId!==context.projectId)throw httpError('不能在当前项目对话中向其他项目写入。',403);
      const taskId = id(args.taskId, 'taskId', false);
      if (taskId) assertTaskScope(taskId, context);
      return createKnowledgeDocument({ title: text(args.title, 'title', 120, true), content: text(args.content, 'content', 2_000_000, true), projectId: args.projectId || context.projectId || undefined, taskId: taskId || undefined });
    }
    case 'patch_document': {
      const prepared = prepareDocumentPatch(args, context);
      updateKnowledgeDocument(String(prepared.document.id), { content: prepared.content });
      const saved = getKnowledgeDocument(String(prepared.document.id));
      if (String(saved.content).trim() !== prepared.content.trim()) throw httpError('写入后的内容核验失败，请检查文档版本。', 500);
      return { documentId: saved.id, title: saved.title, before: prepared.before, after: prepared.after, verified: true, revision: documentRevision(saved.content) };
    }
    case 'update_document': {
      const document = getKnowledgeDocument(id(args.documentId, 'documentId'));
      if (context.projectId && !document.projectIds.includes(context.projectId)) throw httpError('文档不属于当前项目。', 403);
      if (args.expectedRevision && args.expectedRevision !== documentRevision(document.content)) throw httpError('文档已变化，请重新读取。', 409);
      return updateKnowledgeDocument(String(document.id), args);
    }
    case 'link_document_to_project': return setProjectDocumentLink(projectId(args, context), id(args.documentId, 'documentId'), args.linked !== false);
    case 'link_document_to_task': {
      const taskId = id(args.taskId, 'taskId'); assertTaskScope(taskId, context);
      return setTaskDocumentLink(taskId, id(args.documentId, 'documentId'), args.linked !== false);
    }
    default: throw httpError(`工具 ${name} 尚未实现。`, 501);
  }
}
