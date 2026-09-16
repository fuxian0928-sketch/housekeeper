import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import { createProposal } from '../../actions/proposal-service.js';

export interface TaskDraft {
  title: string;
  description?: string;
  status?: 'todo' | 'doing' | 'waiting';
  priority?: 'high' | 'medium' | 'low';
  executor?: 'self' | 'ai' | 'external';
  dueAt?: string | null;
  sourceLabel?: string;
  dependsOn?: string[];
  blockedReason?: string;
  startAt?: string | null;
  documentIds?: string[];
}

export interface TaskInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  executor?: string;
  dueAt?: string | null;
  sourceLabel?: string;
  suggestionId?: string | null;
  dependsOn?: string[];
  blockedReason?: string;
  startAt?: string | null;
  documentIds?: string[];
}

function normalizeDependencies(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].slice(0, 20);
}

export function extractTaskBatchSuggestion(answer: string, projectId: string) {
  const tasks = answer.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:\d+[.、)]|[-*])\s+(.{4,240})$/);
    if (!match) return [];
    const description = match[1].replace(/\*\*/g, '').trim();
    const title = description.split(/[：:—]/, 1)[0].replace(/^(?:建议行动|行动建议|建议)[：:\s]*/, '').trim().slice(0, 120);
    if (!title || /^(?:来源|依据|风险|收益|成本|置信度)/.test(title)) return [];
    return [{ title, description, status: 'todo' as const, priority: 'medium' as const, executor: 'self' as const, dueAt: null, sourceLabel: '项目对话建议' }];
  });
  const unique = [...new Map(tasks.map((task) => [normalizeTitle(task.title), task])).values()].slice(0, 8);
  return unique.length >= 2 ? { projectId, tasks: unique } : null;
}

function normalizeTitle(value: string) {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
}

export function validateTaskDrafts(input: unknown): TaskDraft[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw new Error('一次请选择 1～50 个任务。');
  return input.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('任务内容格式不正确。');
    const draft = item as Record<string, unknown>;
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    const description = typeof draft.description === 'string' ? draft.description : '';
    const status = draft.status === 'doing' || draft.status === 'waiting' ? draft.status : 'todo';
    const priority = draft.priority === 'high' || draft.priority === 'low' ? draft.priority : 'medium';
    const executor = draft.executor === 'ai' || draft.executor === 'external' ? draft.executor : 'self';
    if (!title || title.length > 120 || description.length > 2000) throw new Error('每个任务名称不能为空且最多 120 字，说明最多 2000 字。');
    const dependsOn = Array.isArray(draft.dependsOn) ? [...new Set(draft.dependsOn.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].slice(0, 20) : [];
    const blockedReason = typeof draft.blockedReason === 'string' ? draft.blockedReason.trim().slice(0, 500) : '';
    return { title, description, status, priority, executor, dueAt: typeof draft.dueAt === 'string' ? draft.dueAt : null, sourceLabel: typeof draft.sourceLabel === 'string' ? draft.sourceLabel.slice(0, 200) : '批量提案', dependsOn, blockedReason };
  });
}

export function createTaskBatchProposal(projectId: string, input: unknown, suggestionId?: string | null) {
  if (!database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`).get(projectId)) throw Object.assign(new Error('项目不存在。'), { statusCode: 404 });
  const tasks = validateTaskDrafts(input);
  if (suggestionId) {
    const suggestion = database.prepare(`SELECT suggestion_type, payload_json, status FROM message_suggestions WHERE id = ?`).get(suggestionId) as { suggestion_type: string; payload_json: string; status: string } | undefined;
    const payload = suggestion ? JSON.parse(suggestion.payload_json) as { projectId?: string } : null;
    if (!suggestion || suggestion.suggestion_type !== 'task_batch' || suggestion.status !== 'pending' || payload?.projectId !== projectId) throw Object.assign(new Error('这组任务建议已处理或不属于当前项目。'), { statusCode: 409 });
  }
  const id = randomUUID();
  createProposal({ id, actionType: 'task_batch_create', targetType: 'task', targetId: projectId, payload: { projectId, tasks, sourceSuggestionId: suggestionId ?? null }, reason: `批量创建 ${tasks.length} 个任务`, sourceRefs: tasks.map((task) => task.sourceLabel).filter((value): value is string => Boolean(value)), riskLevel: 'low' });
  return { id, status: 'pending' as const, projectId, tasks, summary: `准备创建 ${tasks.length} 个任务；确认前不会改变项目。` };
}

export function createTaskBatch(projectId: string, drafts: TaskDraft[], proposalId: string) {
  if (!database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`).get(projectId)) throw new Error('项目不存在。');
  const existing = new Set((database.prepare(`SELECT title FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'cancelled')`).all(projectId) as Array<{ title: string }>).map((row) => normalizeTitle(row.title)));
  const timestamp = nowIso();
  const created: Array<{ id: string; title: string }> = [];
  const skipped: Array<{ title: string; reason: string }> = [];
  const insertTask = database.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, executor, due_at, source_label, depends_on_json, blocked_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertHistory = database.prepare(`INSERT INTO task_history (id, task_id, project_id, change_type, before_json, after_json, source_type, source_id, created_at) VALUES (?, ?, ?, 'created', NULL, ?, 'proposal', ?, ?)`);
  const insertEvent = database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, source_id, created_at) VALUES (?, ?, 'task_created', 'task', ?, ?, '', 'action_proposal', ?, ?)`);
  database.exec('BEGIN');
  try {
    for (const draft of drafts) {
      const normalized = normalizeTitle(draft.title);
      if (existing.has(normalized)) { skipped.push({ title: draft.title, reason: '已有同名未完成任务' }); continue; }
      existing.add(normalized);
      const id = randomUUID();
      insertTask.run(id, projectId, draft.title, draft.description ?? '', draft.status ?? 'todo', draft.priority ?? 'medium', draft.executor ?? 'self', draft.dueAt ?? null, draft.sourceLabel ?? '批量提案', JSON.stringify(draft.dependsOn ?? []), draft.blockedReason ?? '', timestamp, timestamp);
      insertHistory.run(randomUUID(), id, projectId, JSON.stringify(draft), proposalId, timestamp);
      insertEvent.run(randomUUID(), projectId, id, `新建任务：${draft.title}`, proposalId, timestamp);
      created.push({ id, title: draft.title });
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { created, skipped, projectId };
}

export function mapTask(row: Record<string, unknown>) {
  let dependsOn: string[] = [];
  try { dependsOn = JSON.parse(String(row.depends_on_json ?? '[]')) as string[]; } catch { dependsOn = []; }
  const relatedDocuments = database.prepare(`SELECT d.id,d.title FROM knowledge_documents d JOIN task_document_links l ON l.document_id=d.id WHERE l.task_id=? ORDER BY d.title`).all(String(row.id)) as Array<{ id: string; title: string }>;
  return { id: row.id, projectId: row.project_id, title: row.title, description: row.description, status: row.status, priority: row.priority, executor: row.executor, dueAt: row.due_at, startAt: row.start_at ?? row.created_at, sourceLabel: row.source_label, dependsOn, blockedReason: String(row.blocked_reason ?? ''), relatedDocuments, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
}

function replaceTaskDocumentLinks(taskId: string, documentIds: unknown) {
  if (!Array.isArray(documentIds)) return;
  const unique = [...new Set(documentIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].slice(0, 100);
  const insert = database.prepare(`INSERT INTO task_document_links(task_id,document_id,created_at) SELECT ?,id,? FROM knowledge_documents WHERE id=? ON CONFLICT(task_id,document_id) DO NOTHING`);
  database.prepare('DELETE FROM task_document_links WHERE task_id=?').run(taskId);
  const timestamp = nowIso();
  for (const documentId of unique) insert.run(taskId, timestamp, documentId);
}

export function listProjectTasks(projectId: string) {
  return (database.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, CASE status WHEN 'doing' THEN 0 WHEN 'waiting' THEN 1 WHEN 'todo' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, created_at DESC`).all(projectId) as Array<Record<string, unknown>>).map(mapTask);
}

export function createTask(projectId: string, body: TaskInput) {
  const title = body.title?.trim() ?? '';
  if (!title || title.length > 120 || (body.description?.length ?? 0) > 2000) throw Object.assign(new Error('任务名称不能为空且最多 120 字，说明最多 2000 字。'), { statusCode: 400 });
  const status = body.status ?? 'todo';
  const priority = body.priority ?? 'medium';
  const executor = body.executor ?? 'self';
  const blockedReason = (body.blockedReason ?? '').trim().slice(0, 500);
  const dependsOn = normalizeDependencies(body.dependsOn);
  if (!['todo', 'doing', 'waiting', 'done', 'cancelled'].includes(status) || !['high', 'medium', 'low'].includes(priority) || !['self', 'ai', 'external'].includes(executor)) throw Object.assign(new Error('任务状态、优先级或执行方不可用。'), { statusCode: 400 });
  if (!database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`).get(projectId)) throw Object.assign(new Error('项目不存在。'), { statusCode: 404 });
  if (body.suggestionId) {
    const suggestion = database.prepare(`SELECT suggestion_type, payload_json, status FROM message_suggestions WHERE id = ?`).get(body.suggestionId) as { suggestion_type: string; payload_json: string; status: string } | undefined;
    const payload = suggestion ? JSON.parse(suggestion.payload_json) as { projectId?: string } : null;
    if (suggestion?.status === 'applied') {
      const proposal = database.prepare(`SELECT result_json FROM action_proposals WHERE id = ? AND status = 'succeeded'`).get(body.suggestionId) as { result_json: string | null } | undefined;
      const result = proposal?.result_json ? JSON.parse(proposal.result_json) as { taskId?: string } : null;
      const existing = result?.taskId ? database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.taskId) as Record<string, unknown> | undefined : undefined;
      if (existing) return { task: mapTask(existing), created: false };
    }
    if (!suggestion || suggestion.suggestion_type !== 'task' || suggestion.status !== 'pending' || payload?.projectId !== projectId) throw Object.assign(new Error('这条任务建议已处理或不属于当前项目。'), { statusCode: 409 });
  }
  const duplicate = database.prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'cancelled') AND lower(trim(title)) = lower(trim(?)) LIMIT 1`).get(projectId, title) as { id: string; title: string } | undefined;
  if (duplicate) throw Object.assign(new Error('当前项目已有同名未完成任务。'), { statusCode: 409, existingTaskId: duplicate.id });
  const id = randomUUID();
  const timestamp = nowIso();
  database.exec('BEGIN');
  try {
    database.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, executor, due_at, source_label, depends_on_json, blocked_reason, start_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, title, body.description ?? '', status, priority, executor, body.dueAt ?? null, body.sourceLabel ?? '手动创建', JSON.stringify(dependsOn), blockedReason, body.startAt ?? timestamp, timestamp, timestamp);
    replaceTaskDocumentLinks(id, body.documentIds);
    database.prepare(`INSERT INTO task_history (id, task_id, project_id, change_type, before_json, after_json, source_type, source_id, created_at) VALUES (?, ?, ?, 'created', NULL, ?, ?, ?, ?)`).run(randomUUID(), id, projectId, JSON.stringify({ title, status, priority, executor, dueAt: body.dueAt ?? null }), body.suggestionId ? 'proposal' : 'user', body.suggestionId ?? null, timestamp);
    if (body.suggestionId) {
      database.prepare(`UPDATE message_suggestions SET status = 'applied', updated_at = ? WHERE id = ? AND status = 'pending'`).run(timestamp, body.suggestionId);
      database.prepare(`UPDATE action_proposals SET status = 'succeeded', confirmed_at = COALESCE(confirmed_at, ?), executed_at = ?, result_json = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'edited', 'confirmed', 'executing')`).run(timestamp, timestamp, JSON.stringify({ taskId: id, projectId }), timestamp, body.suggestionId);
    }
    database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, source_id, created_at) VALUES (?, ?, 'task_created', 'task', ?, ?, '', ?, ?, ?)`).run(randomUUID(), projectId, id, `新建任务：${title}`, body.suggestionId ? 'action_proposal' : 'user', body.suggestionId ?? null, timestamp);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { task: mapTask(database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>), created: true };
}

export function updateTask(id: string, body: TaskInput) {
  const existing = database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!existing) throw Object.assign(new Error('任务不存在。'), { statusCode: 404 });
  const title = (body.title ?? String(existing.title)).trim();
  const description = body.description ?? String(existing.description);
  const status = body.status ?? String(existing.status);
  const priority = body.priority ?? String(existing.priority);
  const executor = body.executor ?? String(existing.executor);
  const blockedReason = body.blockedReason === undefined ? String(existing.blocked_reason ?? '') : (body.blockedReason ?? '').trim().slice(0, 500);
  const dependsOnJson = body.dependsOn === undefined ? String(existing.depends_on_json ?? '[]') : JSON.stringify(normalizeDependencies(body.dependsOn));
  if (!title || title.length > 120 || description.length > 2000 || !['todo', 'doing', 'waiting', 'done', 'cancelled'].includes(status) || !['high', 'medium', 'low'].includes(priority) || !['self', 'ai', 'external'].includes(executor)) throw Object.assign(new Error('请检查任务名称、说明、状态、优先级和执行方。'), { statusCode: 400 });
  const timestamp = nowIso();
  const dueAt: string | null = body.dueAt === undefined ? (typeof existing.due_at === 'string' ? existing.due_at : null) : body.dueAt;
  const completedAt: string | null = status === 'done' ? (typeof existing.completed_at === 'string' ? existing.completed_at : timestamp) : null;
  const startAt: string | null = body.startAt === undefined ? (typeof existing.start_at === 'string' ? existing.start_at : String(existing.created_at)) : body.startAt;
  database.exec('BEGIN');
  try {
    database.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, executor = ?, due_at = ?, depends_on_json = ?, blocked_reason = ?, start_at = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(title, description, status, priority, executor, dueAt, dependsOnJson, blockedReason, startAt, timestamp, completedAt, id);
    replaceTaskDocumentLinks(id, body.documentIds);
    database.prepare(`INSERT INTO task_history (id, task_id, project_id, change_type, before_json, after_json, source_type, created_at) VALUES (?, ?, ?, 'updated', ?, ?, 'user', ?)`).run(randomUUID(), id, String(existing.project_id), JSON.stringify(existing), JSON.stringify({ title, description, status, priority, executor, dueAt, dependsOn: JSON.parse(dependsOnJson), blockedReason, completedAt }), timestamp);
    if (status !== existing.status || title !== existing.title) database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, created_at) VALUES (?, ?, 'task_status', 'task', ?, '任务已更新', ?, 'user', ?)`).run(randomUUID(), String(existing.project_id), id, `${String(existing.title)}：${String(existing.status)} → ${status}`, timestamp);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return mapTask(database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>);
}
