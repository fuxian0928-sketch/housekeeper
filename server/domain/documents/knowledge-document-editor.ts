import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import { indexKnowledgeContent } from '../../vault.js';

let onDocumentChanged: ((documentId: string) => void) | null = null;
export function configureKnowledgeDocumentEditor(input: { onDocumentChanged?: (documentId: string) => void }) {
  onDocumentChanged = input.onDocumentChanged ?? null;
}

function httpError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }
function cleanTitle(value: unknown) { return String(value ?? '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 120); }
function markdown(title: string, value: unknown) {
  const content = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) return `# ${title}\n`;
  return /^#{1,6}\s+/m.test(content) ? content : `# ${title}\n\n${content}`;
}

function documentRecord(id: string): Record<string, unknown> & { projectIds: string[]; taskIds: string[] } {
  const row = database.prepare(`SELECT id,relative_path AS relativePath,title,excerpt,content,bytes,modified_at AS modifiedAt,indexed_at AS indexedAt,source_type AS sourceType,server_revision AS serverRevision,server_edited_at AS serverEditedAt FROM knowledge_documents WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw httpError('文档不存在。', 404);
  const projectIds = (database.prepare('SELECT project_id FROM project_document_links WHERE document_id=?').all(id) as Array<{ project_id: string }>).map((item) => item.project_id);
  const taskIds = (database.prepare('SELECT task_id FROM task_document_links WHERE document_id=?').all(id) as Array<{ task_id: string }>).map((item) => item.task_id);
  return { ...row, projectIds, taskIds };
}

function linkDocument(documentId: string, projectId?: unknown, taskId?: unknown) {
  const timestamp = nowIso();
  if (typeof projectId === 'string' && projectId) database.prepare(`INSERT INTO project_document_links(project_id,document_id,link_source,created_at) SELECT id,?,'manual',? FROM projects WHERE id=? AND deleted_at IS NULL ON CONFLICT(project_id,document_id) DO NOTHING`).run(documentId, timestamp, projectId);
  if (typeof taskId === 'string' && taskId) database.prepare(`INSERT INTO task_document_links(task_id,document_id,created_at) SELECT id,?,? FROM tasks WHERE id=? ON CONFLICT(task_id,document_id) DO NOTHING`).run(documentId, timestamp, taskId);
}

export function getKnowledgeDocument(id: string) { return documentRecord(id); }

export function createKnowledgeDocument(input: Record<string, unknown>) {
  const title = cleanTitle(input.title);
  if (!title) throw httpError('请输入文档名称。', 400);
  const id = randomUUID();
  const relativePath = `服务器文档/${title}-${id.slice(0, 8)}.md`;
  const content = markdown(title, input.content);
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw httpError('单篇可编辑文档不能超过 2MB。', 413);
  const timestamp = nowIso();
  const indexed = indexKnowledgeContent({ relativePath, content, modifiedAt: timestamp });
  database.exec('BEGIN');
  try {
    database.prepare(`UPDATE knowledge_documents SET source_type='server',server_revision=1,server_edited_at=? WHERE id=?`).run(timestamp, indexed.documentId);
    database.prepare(`INSERT INTO knowledge_document_versions(id,document_id,revision,title,content,source_type,created_at) VALUES(?,?,?,?,?,'server',?)`).run(randomUUID(), indexed.documentId, 1, title, content, timestamp);
    linkDocument(indexed.documentId, input.projectId, input.taskId);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  onDocumentChanged?.(indexed.documentId);
  return documentRecord(indexed.documentId);
}

export function updateKnowledgeDocument(id: string, input: Record<string, unknown>) {
  const existing = database.prepare(`SELECT id,relative_path,title,content,server_revision FROM knowledge_documents WHERE id=?`).get(id) as { id: string; relative_path: string; title: string; content: string; server_revision: number } | undefined;
  if (!existing) throw httpError('文档不存在。', 404);
  const title = input.title === undefined ? existing.title : cleanTitle(input.title);
  if (!title) throw httpError('请输入文档名称。', 400);
  const content = input.content === undefined ? existing.content : markdown(title, input.content);
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw httpError('单篇可编辑文档不能超过 2MB。', 413);
  const timestamp = nowIso();
  const revision = Number(existing.server_revision || 1) + 1;
  indexKnowledgeContent({ relativePath: existing.relative_path, content, modifiedAt: timestamp });
  database.exec('BEGIN');
  try {
    database.prepare(`UPDATE knowledge_documents SET title=?,source_type='server',server_revision=?,server_edited_at=?,modified_at=? WHERE id=?`).run(title, revision, timestamp, timestamp, id);
    database.prepare(`INSERT INTO knowledge_document_versions(id,document_id,revision,title,content,source_type,created_at) VALUES(?,?,?,?,?,'server',?)`).run(randomUUID(), id, revision, title, content, timestamp);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  onDocumentChanged?.(id);
  return documentRecord(id);
}

export function setProjectDocumentLink(projectId: string, documentId: string, linked: boolean) {
  if (!database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId)) throw httpError('项目不存在。', 404);
  if (!database.prepare('SELECT id FROM knowledge_documents WHERE id=?').get(documentId)) throw httpError('文档不存在。', 404);
  if (linked) database.prepare(`INSERT INTO project_document_links(project_id,document_id,link_source,created_at) VALUES(?,?, 'manual',?) ON CONFLICT(project_id,document_id) DO NOTHING`).run(projectId, documentId, nowIso());
  else database.prepare('DELETE FROM project_document_links WHERE project_id=? AND document_id=?').run(projectId, documentId);
  return { ok: true, linked };
}

export function setTaskDocumentLink(taskId: string, documentId: string, linked: boolean) {
  if (!database.prepare('SELECT id FROM tasks WHERE id=?').get(taskId)) throw httpError('任务不存在。', 404);
  if (!database.prepare('SELECT id FROM knowledge_documents WHERE id=?').get(documentId)) throw httpError('文档不存在。', 404);
  if (linked) database.prepare(`INSERT INTO task_document_links(task_id,document_id,created_at) VALUES(?,?,?) ON CONFLICT(task_id,document_id) DO NOTHING`).run(taskId, documentId, nowIso());
  else database.prepare('DELETE FROM task_document_links WHERE task_id=? AND document_id=?').run(taskId, documentId);
  return { ok: true, linked };
}

export function listKnowledgeDocumentVersions(id: string) {
  return database.prepare(`SELECT id,revision,title,source_type AS sourceType,created_at AS createdAt FROM knowledge_document_versions WHERE document_id=? ORDER BY revision DESC`).all(id);
}
