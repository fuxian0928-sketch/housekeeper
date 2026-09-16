import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { database, initializeDatabase, nowIso } from '../db.js';
import { indexKnowledgeContent, removeKnowledgeContent } from '../vault.js';
import { inferProjectFromQuery, projectDocumentPriorities } from './project-document-priority.js';

test('项目文档按当前项目、无关联、其他项目分为三级', () => {
  initializeDatabase();
  const currentProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const currentProjectName = `建智汇-${suffix}`;
  const timestamp = nowIso();
  const paths = {
    current: `tests/${suffix}/current.md`,
    unlinked: `tests/${suffix}/unlinked.md`,
    other: `tests/${suffix}/other.md`
  };
  database.prepare(`INSERT INTO projects(id,name,summary,status,priority,vault_path,source_path,created_at,updated_at) VALUES(?,?,?,'active','medium','','',?,?)`).run(currentProjectId, currentProjectName, '', timestamp, timestamp);
  database.prepare(`INSERT INTO projects(id,name,summary,status,priority,vault_path,source_path,created_at,updated_at) VALUES(?,?,?,'active','medium','','',?,?)`).run(otherProjectId, `其他项目-${suffix}`, '', timestamp, timestamp);
  try {
    const current = indexKnowledgeContent({ relativePath: paths.current, content: '# 建智汇项目背景\n\n项目背景和实际情况。', modifiedAt: timestamp });
    const unlinked = indexKnowledgeContent({ relativePath: paths.unlinked, content: '# 公共资料\n\n没有关联任何项目。', modifiedAt: timestamp });
    const other = indexKnowledgeContent({ relativePath: paths.other, content: '# 其他项目资料\n\n只属于其他项目。', modifiedAt: timestamp });
    database.prepare(`INSERT INTO project_document_links(project_id,document_id,link_source,created_at) VALUES(?,?, 'manual',?)`).run(currentProjectId, current.documentId, timestamp);
    database.prepare(`INSERT INTO project_document_links(project_id,document_id,link_source,created_at) VALUES(?,?, 'manual',?)`).run(otherProjectId, other.documentId, timestamp);

    const priorities = projectDocumentPriorities(currentProjectId);
    assert.equal(priorities.byId.get(current.documentId), 0);
    assert.equal(priorities.byId.get(unlinked.documentId), 1);
    assert.equal(priorities.byId.get(other.documentId), 2);
    assert.equal(inferProjectFromQuery(`请介绍${currentProjectName}项目的背景`)?.id, currentProjectId);
  } finally {
    for (const path of Object.values(paths)) removeKnowledgeContent(path);
    database.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(currentProjectId, otherProjectId);
  }
});

