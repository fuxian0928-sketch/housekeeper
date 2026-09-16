import { database } from '../db.js';

export type ProjectDocumentTier = 0 | 1 | 2;

export interface ProjectDocumentPriorities {
  byId: Map<string, ProjectDocumentTier>;
  byPath: Map<string, ProjectDocumentTier>;
}

/**
 * Project retrieval is deliberately tiered rather than hard-filtered:
 * 0 = linked to the current project
 * 1 = not linked to any project
 * 2 = linked only to other projects
 */
export function projectDocumentPriorities(projectId: string): ProjectDocumentPriorities {
  const rows = database.prepare(`
    SELECT d.id, d.relative_path,
      COUNT(l.project_id) AS link_count,
      MAX(CASE WHEN l.project_id = ? THEN 1 ELSE 0 END) AS linked_to_current
    FROM knowledge_documents d
    LEFT JOIN project_document_links l ON l.document_id = d.id
    GROUP BY d.id, d.relative_path
  `).all(projectId) as Array<{ id: string; relative_path: string; link_count: number; linked_to_current: number }>;
  const byId = new Map<string, ProjectDocumentTier>();
  const byPath = new Map<string, ProjectDocumentTier>();
  for (const row of rows) {
    const tier: ProjectDocumentTier = Number(row.linked_to_current) > 0 ? 0 : Number(row.link_count) === 0 ? 1 : 2;
    byId.set(row.id, tier);
    byPath.set(row.relative_path, tier);
  }
  return { byId, byPath };
}

export function inferProjectFromQuery(query: string) {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return null;
  const projects = database.prepare(`SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY length(name) DESC`).all() as Array<{ id: string; name: string }>;
  return projects.find((project) => project.name.trim().length >= 2 && normalized.includes(project.name.trim().toLocaleLowerCase('zh-CN'))) ?? null;
}

