import { database } from '../../db.js';
import {httpToolDefinitions,callHttpTool} from './http-tools.js';
import { createHash } from 'node:crypto';
import { createKnowledgeDocument, getKnowledgeDocument, setProjectDocumentLink, setTaskDocumentLink, updateKnowledgeDocument } from '../documents/knowledge-document-editor.js';
import { createProject, listProjects, projectDocuments, projectOverview, updateProject } from '../projects/project-service.js';
import { createTask, listProjectTasks, updateTask } from '../tasks/task-service.js';
import { searchKnowledgeDocuments } from '../../vault.js';
import { officeCapabilityStatus } from '../documents/office-document-parser.js';
import { controlledTool, toolEnabled, toolPolicy } from './tool-controls.js';
import { mcpToolDefinitions, callMcpTool } from './mcp-connections.js';

export type SkillToolMode = 'read' | 'write';
export type SkillToolContext = { projectId?: string | null; vaultPath: string; confirmed?: boolean };

export type SkillToolDefinition = {
  name: string;
  description: string;
  mode: SkillToolMode;
  permission: string;
  riskLevel: 'low' | 'medium' | 'high';
  parameters: string;
};

const definitions: SkillToolDefinition[] = [
  { name: 'list_projects', description: '列出服务器中的项目及任务、文档统计', mode: 'read', permission: 'projects.read', riskLevel: 'low', parameters: '{}' },
  { name: 'get_project', description: '读取一个项目的详情、进度和近期事件', mode: 'read', permission: 'projects.read', riskLevel: 'low', parameters: '{ projectId?: string }' },
  { name: 'list_project_tasks', description: '读取一个项目的任务', mode: 'read', permission: 'tasks.read', riskLevel: 'low', parameters: '{ projectId?: string }' },
  { name: 'list_project_documents', description: '读取一个项目关联的文档列表', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ projectId?: string }' },
  { name: 'search_documents', description: '检索服务器资料库；项目对话会按项目关联优先级召回', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ query: string, projectId?: string, limit?: number }' },
  { name: 'get_document', description: '读取一篇服务器文档的解析后 Markdown', mode: 'read', permission: 'documents.read', riskLevel: 'low', parameters: '{ documentId: string }' },
  { name: 'list_document_capabilities', description: '查看服务器已安装的文档处理能力、支持格式、权限和大小限制', mode: 'read', permission: 'capabilities.read', riskLevel: 'low', parameters: '{}' },
  { name: 'create_project', description: '新建项目', mode: 'write', permission: 'projects.write', riskLevel: 'medium', parameters: '{ name: string, summary?: string, priority?: high|medium|low }' },
  { name: 'update_project', description: '修改项目名称、目标、状态、优先级或进度', mode: 'write', permission: 'projects.write', riskLevel: 'medium', parameters: '{ projectId?: string, name?, summary?, status?, priority?, progress? }' },
  { name: 'create_task', description: '在项目中创建任务', mode: 'write', permission: 'tasks.write', riskLevel: 'medium', parameters: '{ projectId?: string, title: string, description?, status?, priority?, startAt?, dueAt?, documentIds? }' },
  { name: 'update_task', description: '修改任务内容或状态', mode: 'write', permission: 'tasks.write', riskLevel: 'medium', parameters: '{ taskId: string, title?, description?, status?, priority?, startAt?, dueAt?, documentIds? }' },
  { name: 'create_document', description: '在服务器资料库中新建 Markdown 文档并自动切块、索引', mode: 'write', permission: 'documents.write', riskLevel: 'medium', parameters: '{ title: string, content: string, projectId?, taskId? }' },
  { name: 'update_document', description: '修改服务器资料库文档并重建切块与索引', mode: 'write', permission: 'documents.write', riskLevel: 'medium', parameters: '{ documentId: string, title?, content? }' },
  { name: 'patch_document', description: '先用 get_document 读取，再精确替换唯一匹配的原文片段；保留其他内容，校验版本并回读核实。', mode: 'write', permission: 'documents.write', riskLevel: 'medium', parameters: '{ documentId: string, before: string, after: string }' },
  { name: 'link_document_to_project', description: '关联或取消关联项目文档', mode: 'write', permission: 'documents.link', riskLevel: 'medium', parameters: '{ projectId?: string, documentId: string, linked?: boolean }' },
  { name: 'link_document_to_task', description: '关联或取消关联任务文档', mode: 'write', permission: 'documents.link', riskLevel: 'medium', parameters: '{ taskId: string, documentId: string, linked?: boolean }' }
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

export function listSkillTools() { return [...definitions,...mcpToolDefinitions(),...httpToolDefinitions()].map((item) => ({ ...item, enabled: toolEnabled(item.name), policy:toolPolicy(item.name) })); }
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

export function executeSkillTool(name: string, rawArguments: unknown, context: SkillToolContext) {
  if (!getSkillTool(name)) throw httpError('工具不存在。',404);
  return controlledTool(name, () => name.startsWith('mcp_')?callMcpTool(name,record(rawArguments)):name.startsWith('http_')?callHttpTool(name,record(rawArguments)):executeRegisteredTool(name, rawArguments, context),context.confirmed);
}

function executeRegisteredTool(name: string, rawArguments: unknown, context: SkillToolContext) {
  const tool = getSkillTool(name);
  if (!tool) throw httpError(`未注册工具：${name}`, 404);
  const args = record(rawArguments);
  switch (name) {
    case 'list_projects': return listProjects(true).slice(0, 100);
    case 'get_project': return projectOverview(projectId(args, context));
    case 'list_project_tasks': return listProjectTasks(projectId(args, context)).slice(0, 200);
    case 'list_project_documents': return projectDocuments(projectId(args, context)).slice(0, 200).map((item) => ({ id: item.id, title: item.title, relativePath: item.relativePath, modifiedAt: item.modifiedAt, sourceType: item.sourceType }));
    case 'search_documents': {
      const query = text(args.query, 'query', 1000, true);
      const requestedProject = args.projectId || context.projectId ? projectId(args, context) : null;
      const limit = Math.max(1, Math.min(12, Number(args.limit) || 6));
      return searchKnowledgeDocuments(query, null, limit, requestedProject);
    }
    case 'get_document': {
      const document = getKnowledgeDocument(id(args.documentId, 'documentId')) as Record<string, unknown>;
      if (context.projectId && !(document.projectIds as string[]).includes(context.projectId)) throw httpError('文档不属于当前项目。', 403);
      return { ...document, revision: documentRevision(document.content), truncated: String(document.content ?? '').length > 60_000, content: String(document.content ?? '').slice(0, 60_000) };
    }
    case 'list_document_capabilities': return [officeCapabilityStatus()];
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
