import { database } from '../../db.js';
import { listKnowledgeDocuments } from '../../vault.js';
import { mapProject } from '../projects/project-service.js';
import { mapTask } from '../tasks/task-service.js';

export function buildHomeSnapshot() {
  const projectRows = database.prepare(`
    SELECT p.*,
      SUM(CASE WHEN t.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS open_tasks,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_tasks,
      (SELECT COUNT(*) FROM knowledge_documents d WHERE p.source_path <> '' AND (d.relative_path = p.source_path OR d.relative_path LIKE p.source_path || '/%')) AS document_count,
      (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id AND m.status = 'confirmed') AS memory_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.deleted_at IS NULL
    GROUP BY p.id
    ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
      CASE p.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      p.updated_at DESC
  `).all() as Array<Record<string, unknown>>;
  const taskRows = database.prepare(`SELECT * FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL) ORDER BY project_id, CASE status WHEN 'doing' THEN 0 WHEN 'waiting' THEN 1 WHEN 'todo' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, due_at IS NULL, due_at`).all() as Array<Record<string, unknown>>;
  const activity = database.prepare(`SELECT MAX(updated_at) AS updated_at FROM (SELECT updated_at FROM projects WHERE deleted_at IS NULL UNION ALL SELECT updated_at FROM tasks)`).get() as { updated_at: string | null };
  const scan = database.prepare(`SELECT value FROM app_settings WHERE key = 'vault_last_scanned_at'`).get() as { value: string } | undefined;
  return {
    projects: projectRows.map(mapProject),
    tasks: taskRows.map(mapTask),
    documents: listKnowledgeDocuments(),
    vaultLastScannedAt: scan?.value || null,
    projectLastChangedAt: activity.updated_at
  };
}
