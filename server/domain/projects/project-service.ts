import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { database, nowIso } from '../../db.js';
import { countKnowledgeDocuments, listKnowledgeDocuments, type ScanResult } from '../../vault.js';
import { buildLocalProjectSummary } from '../../summaries/project-summary.js';
import { mapTask } from '../tasks/task-service.js';

function httpError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }
function normalized(value: string) { return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim(); }
export const VOICE_CONVERSATION_PROJECT_ID = 'system-voice-conversations';

export function ensureVoiceConversationProject() {
  const timestamp = nowIso();
  database.prepare(`INSERT OR IGNORE INTO projects (id, name, summary, status, priority, vault_path, source_path, created_at, updated_at) VALUES (?, '语音对话', '桌面小E产生的语音对话历史。与普通文字聊天分开保存，共用同一套长期记忆。', 'active', 'medium', 'central://documents', '', ?, ?)`).run(VOICE_CONVERSATION_PROJECT_ID, timestamp, timestamp);
  database.prepare(`UPDATE projects SET name='语音对话', deleted_at=NULL WHERE id=?`).run(VOICE_CONVERSATION_PROJECT_ID);
  return VOICE_CONVERSATION_PROJECT_ID;
}

export function normalizeProjectSourcePath(value: string, vaultPath: string) {
  const raw = value.trim();
  if (!raw) return '';
  if (!vaultPath.trim()) throw httpError('请先在资料库中选择 Obsidian Vault。', 400);
  if (vaultPath === 'central://documents') {
    const sourcePath = normalized(raw);
    if (!sourcePath || sourcePath === '..' || sourcePath.startsWith('../')) throw httpError('请选择服务器资料库内的有效路径。', 400);
    return sourcePath;
  }
  const vault = resolve(vaultPath);
  const target = resolve(vault, raw);
  const fromVault = relative(vault, target);
  if (fromVault === '..' || fromVault.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromVault)) throw httpError('关联资料必须位于当前 Obsidian Vault 内。', 400);
  return normalized(fromVault);
}

export function mapProject(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, summary: row.summary, status: row.status, priority: row.priority, progress: Math.max(0, Math.min(100, Number(row.progress ?? 0))), vaultPath: row.vault_path, sourcePath: row.source_path, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at ?? null, taskCounts: { open: Number(row.open_tasks ?? 0), done: Number(row.done_tasks ?? 0) }, documentCount: Number(row.document_count ?? 0), memoryCount: Number(row.memory_count ?? 0) };
}

const projectSelect = `SELECT p.*, SUM(CASE WHEN t.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS open_tasks, SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_tasks, (SELECT COUNT(DISTINCT d.id) FROM knowledge_documents d LEFT JOIN project_document_links l ON l.document_id=d.id AND l.project_id=p.id WHERE l.project_id IS NOT NULL OR (p.source_path <> '' AND (d.relative_path = p.source_path OR d.relative_path LIKE p.source_path || '/%'))) AS document_count, (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id AND m.status = 'confirmed') AS memory_count FROM projects p LEFT JOIN tasks t ON t.project_id = p.id`;

export function listProjects(includeArchived = false, trash = false) {
  const condition = trash ? `p.deleted_at IS NOT NULL` : `p.deleted_at IS NULL AND (? = 1 OR p.status != 'archived')`;
  const rows = database.prepare(`${projectSelect} WHERE ${condition} GROUP BY p.id ORDER BY ${trash ? 'p.deleted_at DESC' : `CASE WHEN p.status = 'archived' THEN 1 ELSE 0 END, CASE p.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, p.updated_at DESC`}`).all(...(trash ? [] : [includeArchived ? 1 : 0])) as Array<Record<string, unknown>>;
  return rows.map(mapProject);
}

export function createProject(input: { name?: string; summary?: string; priority?: string; sourcePath?: string }, vaultPath: string) {
  const name = input.name?.trim() ?? '';
  const summary = input.summary?.trim() ?? '';
  const priority = input.priority ?? 'medium';
  if (!name || name.length > 80 || summary.length > 500 || (input.sourcePath?.length ?? 0) > 500 || !['high', 'medium', 'low'].includes(priority)) throw httpError('请检查项目名称、目标、优先级和资料路径。', 400);
  if (database.prepare(`SELECT id FROM projects WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL`).get(name)) throw httpError('已有同名项目。', 409);
  const sourcePath = normalizeProjectSourcePath(input.sourcePath ?? '', vaultPath);
  const id = randomUUID(); const timestamp = nowIso();
  database.prepare(`INSERT INTO projects (id, name, summary, status, priority, vault_path, source_path, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(id, name, summary, priority, vaultPath, sourcePath, timestamp, timestamp);
  return mapProject(database.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown>);
}

export function confirmProjectSuggestions(items: unknown, vaultPath: string) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw httpError('请选择 1 至 20 个建议项目。', 400);
  const existing = new Set((database.prepare(`SELECT name FROM projects WHERE deleted_at IS NULL`).all() as Array<{ name: string }>).map((row) => row.name.trim().toLowerCase()));
  const created: Array<{ id: string; name: string }> = []; const skipped: string[] = [];
  database.exec('BEGIN');
  try {
    for (const raw of items) {
      const item = raw as Record<string, unknown>; const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : ''; const key = name.toLowerCase();
      if (!name || existing.has(key)) { if (name) skipped.push(name); continue; }
      const id = randomUUID(); const timestamp = nowIso(); const summary = typeof item.summary === 'string' ? item.summary.trim().slice(0, 500) : '';
      const requested = typeof item.sourcePath === 'string' ? normalized(item.sourcePath).slice(0, 500) : ''; const sourcePath = requested && countKnowledgeDocuments(requested) > 0 ? requested : '';
      database.prepare(`INSERT INTO projects (id, name, summary, status, priority, vault_path, source_path, created_at, updated_at) VALUES (?, ?, ?, 'active', 'medium', ?, ?, ?, ?)`).run(id, name, summary, vaultPath, sourcePath, timestamp, timestamp);
      database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, created_at) VALUES (?, ?, 'project_created', 'project', ?, '已根据资料建议创建项目', ?, 'action_proposal', ?)`).run(randomUUID(), id, id, sourcePath ? `关联资料：${sourcePath}` : '暂未关联资料文件夹', timestamp);
      existing.add(key); created.push({ id, name });
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { created, skipped };
}

export function trashProject(id: string, confirmationName: string) {
  if (id === VOICE_CONVERSATION_PROJECT_ID) throw httpError('“语音对话”是桌面小E的常驻项目，不能移入回收站。', 400);
  const project = database.prepare(`SELECT id, name, deleted_at FROM projects WHERE id = ?`).get(id) as { id: string; name: string; deleted_at: string | null } | undefined;
  if (!project || project.deleted_at) throw httpError('项目不存在或已在回收站中。', 404);
  if (confirmationName.trim() !== project.name) throw httpError('项目名称不匹配，没有执行删除。', 400);
  const timestamp = nowIso(); database.prepare(`UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(timestamp, timestamp, id);
  return { ok: true, deletedAt: timestamp, message: '项目已移入回收站，Obsidian 文档未受影响。' };
}

export function restoreProject(id: string) {
  if (!database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL`).get(id)) throw httpError('回收站中没有这个项目。', 404);
  database.prepare(`UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id); return { ok: true };
}

export function updateProject(id: string, input: Record<string, unknown>, vaultPath: string) {
  const existing = database.prepare(`SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`).get(id) as Record<string, unknown> | undefined;
  if (!existing) throw httpError('项目不存在。', 404);
  const name = String(input.name ?? existing.name).trim(); const summary = String(input.summary ?? existing.summary).trim(); const status = String(input.status ?? existing.status); const priority = String(input.priority ?? existing.priority); const sourcePath = normalizeProjectSourcePath(String(input.sourcePath ?? existing.source_path), vaultPath);
  const progress = input.progress === undefined ? Number(existing.progress ?? 0) : Number(input.progress);
  if (!name || name.length > 80 || summary.length > 500 || sourcePath.length > 500 || !Number.isInteger(progress) || progress < 0 || progress > 100 || !['active', 'paused', 'completed', 'archived'].includes(status) || !['high', 'medium', 'low'].includes(priority)) throw httpError('请检查项目名称、目标、进度和状态。', 400);
  const timestamp = nowIso(); database.prepare(`UPDATE projects SET name = ?, summary = ?, status = ?, priority = ?, progress = ?, vault_path = ?, source_path = ?, updated_at = ? WHERE id = ?`).run(name, summary, status, priority, progress, vaultPath, sourcePath, timestamp, id);
  const changes: string[] = []; if (name !== existing.name) changes.push(`名称：${String(existing.name)} → ${name}`); if (status !== existing.status) changes.push(`状态：${String(existing.status)} → ${status}`);
  if (changes.length) database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, created_at) VALUES (?, ?, 'project_updated', 'project', ?, '项目信息已更新', ?, 'user', ?)`).run(randomUUID(), id, id, changes.join('；'), timestamp);
  return mapProject(database.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown>);
}

export function projectOverview(id: string) {
  const project = database.prepare(`${projectSelect} WHERE p.id = ? AND p.deleted_at IS NULL GROUP BY p.id`).get(id) as Record<string, unknown> | undefined;
  if (!project) throw httpError('项目不存在。', 404);
  const nextTasks = database.prepare(`SELECT * FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at LIMIT 5`).all(id) as Array<Record<string, unknown>>;
  const events = database.prepare(`SELECT id, event_type AS eventType, title, detail, created_at AS createdAt FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT 12`).all(id);
  return { project: mapProject(project), nextTasks: nextTasks.map(mapTask), events, summary: buildLocalProjectSummary(id) };
}

export function projectDocuments(id: string) {
  const project = database.prepare(`SELECT source_path FROM projects WHERE id = ? AND deleted_at IS NULL`).get(id) as { source_path: string } | undefined;
  if (!project) throw httpError('项目不存在。', 404);
  const linked = database.prepare(`SELECT d.id,d.relative_path AS relativePath,d.title,d.excerpt,d.bytes,d.modified_at AS modifiedAt,d.indexed_at AS indexedAt,d.source_type AS sourceType,d.server_revision AS serverRevision,d.server_edited_at AS serverEditedAt FROM knowledge_documents d JOIN project_document_links l ON l.document_id=d.id WHERE l.project_id=? ORDER BY d.modified_at DESC`).all(id) as Array<Record<string, unknown>>;
  const scoped = project.source_path ? listKnowledgeDocuments(project.source_path) : [];
  return [...new Map([...linked, ...scoped].map((document) => [String(document.id), document])).values()];
}

export function recordProjectScan(id: string, result: ScanResult) {
  if (!database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`).get(id)) throw httpError('项目不存在。', 404);
  database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, created_at) VALUES (?, ?, 'scan', 'project', ?, '更新全局 Obsidian 资料库', ?, 'user', ?)`).run(randomUUID(), id, id, `已读取 ${result.indexed} 篇 Markdown，生成 ${result.chunks} 个检索片段`, nowIso());
  return result;
}
