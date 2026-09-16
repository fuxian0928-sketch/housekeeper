import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../db.js';
import { buildProjectOverviewContext, listKnowledgeDocuments } from '../vault.js';

export interface ProjectSnapshot {
  project: { id: string; name: string; summary: string; status: string; priority: string; sourcePath: string; createdAt: string; updatedAt: string };
  tasks: Array<Record<string, unknown>>;
  documents: Array<{ id: string; title: string; relativePath: string; modifiedAt: string }>;
  historicalDocuments: Array<{ id: string; title: string; relativePath: string; modifiedAt: string }>;
  memories: Array<{ content: string; sourceLabel: string }>;
  recentEvents: Array<{ event_type: string; title: string; detail: string; created_at: string }>;
  coverage: { documentCount: number; branchCount: number; branches: string[]; citations: Array<{ document: string; path: string; excerpt: string }> };
}

export function classifyDocumentVersions<T extends { id: string }>(documents: T[], historicalIds: ReadonlySet<string>) {
  return {
    current: documents.filter((document) => !historicalIds.has(document.id)),
    historical: documents.filter((document) => historicalIds.has(document.id))
  };
}

export function buildProjectSnapshot(projectId: string): ProjectSnapshot | null {
  const project = database.prepare(`SELECT id, name, summary, status, priority, source_path, created_at, updated_at FROM projects WHERE id = ? AND deleted_at IS NULL`).get(projectId) as Record<string, unknown> | undefined;
  if (!project) return null;
  const sourcePath = String(project.source_path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const allDocuments = (sourcePath ? listKnowledgeDocuments(sourcePath) : []).map((item) => ({ id: String(item.id), title: String(item.title), relativePath: String(item.relativePath), modifiedAt: String(item.modifiedAt) }));
  const historicalIds = new Set((database.prepare(`SELECT target_document_id AS id FROM knowledge_document_relations WHERE relation_type = 'version_previous'`).all() as Array<{ id: string }>).map((item) => item.id));
  const { current: documents, historical: historicalDocuments } = classifyDocumentVersions(allDocuments, historicalIds);
  return {
    project: { id: String(project.id), name: String(project.name), summary: String(project.summary), status: String(project.status), priority: String(project.priority), sourcePath, createdAt: String(project.created_at), updatedAt: String(project.updated_at) },
    tasks: database.prepare(`SELECT id, title, description, status, priority, executor, due_at, source_label, depends_on_json, blocked_reason, created_at, updated_at, completed_at FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100`).all(projectId) as Array<Record<string, unknown>>,
    documents,
    historicalDocuments,
    memories: (database.prepare(`SELECT content, source_label FROM memories WHERE project_id = ? AND status = 'confirmed' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?) ORDER BY updated_at DESC LIMIT 20`).all(projectId, nowIso(), nowIso()) as Array<{ content: string; source_label: string }>).map((item) => ({ content: item.content, sourceLabel: item.source_label })),
    recentEvents: database.prepare(`SELECT event_type, title, detail, created_at FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).all(projectId) as ProjectSnapshot['recentEvents'],
    coverage: buildProjectOverviewContext(sourcePath || null)
  };
}

export function summarizeSnapshot(snapshot: ProjectSnapshot) {
  const openTasks = snapshot.tasks.filter((task) => !['done', 'cancelled'].includes(String(task.status)));
  const doneTasks = snapshot.tasks.filter((task) => task.status === 'done');
  const today = new Date().toISOString().slice(0, 10);
  const overdue = openTasks.filter((task) => typeof task.due_at === 'string' && task.due_at.slice(0, 10) < today);
  const waiting = openTasks.filter((task) => task.status === 'waiting');
  const highPriority = openTasks.filter((task) => task.priority === 'high');
  const risks: Array<{ severity: 'high' | 'medium' | 'low'; title: string; detail: string }> = [];
  if (overdue.length) risks.push({ severity: 'high', title: `${overdue.length} 个任务已到期`, detail: overdue.slice(0, 3).map((task) => String(task.title)).join('、') });
  if (waiting.length) risks.push({ severity: 'medium', title: `${waiting.length} 个任务正在等待`, detail: waiting.slice(0, 3).map((task) => `${String(task.title)}${task.blocked_reason ? `（${String(task.blocked_reason)}）` : ''}`).join('、') });
  if (!snapshot.documents.length) risks.push({ severity: 'high', title: '项目资料尚未读取', detail: '当前判断只能依据任务，建议先更新 Obsidian 资料。' });
  if (highPriority.length && !overdue.length) risks.push({ severity: 'medium', title: `${highPriority.length} 个高优先级任务未完成`, detail: highPriority.slice(0, 3).map((task) => String(task.title)).join('、') });
  if (!risks.length) risks.push({ severity: 'low', title: '未发现明显阻塞', detail: '继续按当前任务优先级推进即可。' });
  const nextActions = openTasks.slice(0, 5).map((task) => ({ taskId: String(task.id), title: String(task.title), reason: typeof task.due_at === 'string' && task.due_at.slice(0, 10) < today ? '已到期，应优先处理' : task.status === 'waiting' ? '正在等待，需要解除依赖' : task.priority === 'high' ? '高优先级' : task.status === 'doing' ? '正在进行中' : '按当前顺序推进' }));
  if (!nextActions.length) nextActions.push({ taskId: '', title: snapshot.documents.length ? '回顾现有资料并拆分下一阶段任务' : '先读取 Obsidian 项目资料', reason: '当前没有未完成任务' });
  const headline = !snapshot.documents.length ? '项目资料还未进入可分析状态。' : overdue.length ? `项目有 ${overdue.length} 个到期任务，应先处理延期事项。` : highPriority.length ? `资料已就绪，当前应优先推进 ${highPriority.length} 个高优先级任务。` : openTasks.length ? `项目正在推进，当前还有 ${openTasks.length} 个未完成任务。` : '当前任务已经清空，可以规划下一阶段。';
  const progress = `项目范围共有 ${snapshot.coverage.documentCount} 篇文档，其中 ${snapshot.documents.length} 篇作为当前版本、${snapshot.historicalDocuments.length} 篇标记为历史版本；覆盖 ${snapshot.coverage.branchCount} 个资料分支，沉淀 ${snapshot.memories.length} 条已确认记忆；${doneTasks.length} 个任务已完成，${openTasks.length} 个尚未完成。`;
  const evidence = [
    ...snapshot.documents.slice(0, 4).map((document) => ({ type: 'document' as const, title: document.title, source: document.relativePath })),
    ...snapshot.memories.slice(0, 3).map((memory) => ({ type: 'memory' as const, title: memory.content, source: memory.sourceLabel })),
    ...openTasks.slice(0, 3).map((task) => ({ type: 'task' as const, title: String(task.title), source: String(task.source_label || '项目任务') }))
  ];
  const informationGaps = [
    ...(!snapshot.project.summary.trim() ? ['项目尚未填写明确目标或成功标准'] : []),
    ...(!snapshot.documents.length ? ['没有可用于判断的项目文档'] : []),
    ...(!snapshot.memories.length ? ['重要决定尚未沉淀为已确认记忆'] : []),
    ...(!snapshot.tasks.length ? ['尚未建立项目任务'] : [])
  ];
  return { headline, narrative: `${headline}${progress}`, progress, risks, nextActions: nextActions.map((item) => ({ ...item, taskId: item.taskId || null })), currentStage: openTasks.some((task) => task.status === 'doing') ? '执行中' : openTasks.length ? '待推进' : doneTasks.length ? '阶段完成' : '规划中', completedResults: doneTasks.slice(0, 8).map((task) => ({ title: String(task.title), source: String(task.source_label || '历史任务') })), recentChanges: snapshot.recentEvents, informationGaps, coverage: { documentCount: snapshot.coverage.documentCount, currentDocumentCount: snapshot.documents.length, historicalDocumentCount: snapshot.historicalDocuments.length, branchCount: snapshot.coverage.branchCount, branches: snapshot.coverage.branches, citedDocumentCount: evidence.filter((item) => item.type === 'document').length }, evidence, mode: 'local' as const, model: null as string | null, generatedAt: nowIso() };
}

export function buildLocalProjectSummary(projectId: string) {
  const snapshot = buildProjectSnapshot(projectId);
  return snapshot ? summarizeSnapshot(snapshot) : null;
}

export function saveProjectSummaryVersion(projectId: string, snapshot: ProjectSnapshot, summary: Record<string, unknown>, model: string | null) {
  const id = randomUUID();
  database.prepare(`INSERT INTO project_summary_versions (id, project_id, snapshot_json, summary_json, coverage_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, JSON.stringify(snapshot), JSON.stringify(summary), JSON.stringify(summary.coverage ?? {}), model, nowIso());
  return id;
}

export function listProjectSummaryVersions(projectId: string) {
  const rows = database.prepare(`SELECT id, summary_json, coverage_json, model, created_at FROM project_summary_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).all(projectId) as Array<{ id: string; summary_json: string; coverage_json: string; model: string | null; created_at: string }>;
  return rows.map((row) => ({ id: row.id, summary: JSON.parse(row.summary_json), coverage: JSON.parse(row.coverage_json), model: row.model, createdAt: row.created_at }));
}

export async function generateProjectSummary(projectId: string, model: string, complete: (input: string) => Promise<string>) {
  const snapshot = buildProjectSnapshot(projectId);
  if (!snapshot) throw Object.assign(new Error('项目不存在。'), { statusCode: 404 });
  const local = summarizeSnapshot(snapshot);
  const context = [`项目：${snapshot.project.name}\n目标：${snapshot.project.summary}`, `本地进展：${local.progress}`, `风险：\n${local.risks.map((risk, index) => `${index + 1}. ${risk.title}：${risk.detail}`).join('\n')}`, `下一步：\n${local.nextActions.map((action, index) => `${index + 1}. ${action.title}（${action.reason}）`).join('\n')}`, `依据：\n${local.evidence.map((item, index) => `${index + 1}. [${item.type}] ${item.title}｜${item.source}`).join('\n')}`].join('\n\n');
  const narrative = await complete(`请为下面的项目生成一段 120 至 220 字的管理摘要。必须先说当前状态，再说最大风险，最后给出下一步；只使用给定事实，不要声称已经执行任何操作。\n\n${context}`);
  const result = { ...local, narrative, mode: 'openai' as const, model, generatedAt: nowIso() };
  saveProjectSummaryVersion(projectId, snapshot, result, model);
  return result;
}
