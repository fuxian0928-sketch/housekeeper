import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import type { SemanticDecision } from '../../orchestration/semantic-intent.js';

/** Execute validated semantic drafts, atomically across projects. Never infer intent here. */
export function createConversationTasks(drafts: SemanticDecision['taskDrafts'], sourceId: string) {
  if (!drafts.length) return '请告诉我需要新建的任务名称和所属项目。';
  const projects = new Map((database.prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL').all() as Array<{id: string; name: string}>).map(p => [p.id, p.name]));
  const unresolved = drafts.filter(d => !d.projectId || !projects.has(d.projectId));
  if (unresolved.length) return `以下任务要放在哪个项目？\n${unresolved.map(d => `- ${d.title}`).join('\n')}\n请补充所属项目，我再一起创建。`;
  for (const draft of drafts) {
    if (!draft.title.trim() || draft.title.length > 120) return '请补充有效的任务名称（最多 120 字）。';
    if (draft.startAt && draft.dueAt && Date.parse(draft.startAt) > Date.parse(draft.dueAt)) return `“${draft.title}”的截止时间早于开始时间，请确认起止时间。`;
  }
  const created: string[] = [], skipped: string[] = [];
  const timestamp = nowIso();
  database.exec('BEGIN');
  try {
    for (const draft of drafts) {
      const projectId = draft.projectId!;
      if (database.prepare("SELECT id FROM tasks WHERE project_id=? AND lower(trim(title))=lower(trim(?)) AND status NOT IN ('done','cancelled')").get(projectId, draft.title)) {
        skipped.push(`${projects.get(projectId)}：${draft.title}`); continue;
      }
      const id = randomUUID();
      database.prepare(`INSERT INTO tasks (id,project_id,title,description,status,priority,executor,start_at,due_at,source_label,created_at,updated_at) VALUES (?,?,?,?,'todo',?,?,?,?,?,?,?)`).run(id, projectId, draft.title, draft.description, draft.priority, draft.executor, draft.startAt ?? timestamp, draft.dueAt, '对话直接创建', timestamp, timestamp);
      database.prepare(`INSERT INTO task_history (id,task_id,project_id,change_type,before_json,after_json,source_type,source_id,created_at) VALUES (?,?,?,'created',NULL,?,'user',?,?)`).run(randomUUID(), id, projectId, JSON.stringify(draft), sourceId, timestamp);
      database.prepare(`INSERT INTO events (id,project_id,event_type,object_type,object_id,title,detail,source_type,source_id,created_at) VALUES (?,?,'task_created','task',?,?,'','user',?,?)`).run(randomUUID(), projectId, id, `新建任务：${draft.title}`, sourceId, timestamp);
      created.push(`${projects.get(projectId)}：${draft.title}`);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return [created.length ? `已在对应项目的待办事项中创建 ${created.length} 个任务：\n${created.map(t => `- ${t}`).join('\n')}` : '', skipped.length ? `以下任务已有同名未完成项，未重复创建：\n${skipped.map(t => `- ${t}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
}
