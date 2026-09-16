import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('natural-language task proposal is created only after confirmation', async () => {
  process.env.AI_SECRETARY_DB_PATH = join(mkdtempSync(join(tmpdir(), 'natural-task-confirm-')), 'test.db');
  const { database, initializeDatabase, nowIso } = await import('../db.js');
  initializeDatabase();
  const timestamp = nowIso();
  database.prepare(`INSERT INTO projects (id,name,summary,status,priority,vault_path,source_path,created_at,updated_at) VALUES ('project-natural','自然语言测试','','active','medium','','',?,?)`).run(timestamp, timestamp);
  database.prepare(`INSERT INTO conversations (id,scope_type,project_id,title,created_at,updated_at) VALUES ('conversation-natural','project','project-natural','新建任务',?,?)`).run(timestamp, timestamp);
  database.prepare(`INSERT INTO messages (id,conversation_id,role,content,citations_json,created_at) VALUES ('message-natural','conversation-natural','assistant','待确认任务','[]',?)`).run(timestamp);
  const payload = { projectId: 'project-natural', title: '新增国际版语言', description: '', status: 'todo', priority: 'medium', executor: 'self', dueAt: null, sourceLabel: '自然语言任务提案' };
  database.prepare(`INSERT INTO message_suggestions (id,message_id,suggestion_type,payload_json,status,created_at,updated_at) VALUES ('proposal-natural','message-natural','task',?,'pending',?,?)`).run(JSON.stringify(payload), timestamp, timestamp);
  const { createProposal } = await import('./proposal-service.js');
  createProposal({ id: 'proposal-natural', conversationId: 'conversation-natural', messageId: 'message-natural', actionType: 'task_create', targetType: 'task', targetId: 'project-natural', payload });
  assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE project_id='project-natural'`).get() as { count: number }).count, 0);
  const { confirmAction } = await import('./action-service.js');
  const result = confirmAction('proposal-natural') as { created: Array<{ title: string }> };
  assert.equal(result.created[0]?.title, '新增国际版语言');
  assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE project_id='project-natural'`).get() as { count: number }).count, 1);
  assert.equal((database.prepare(`SELECT status FROM action_proposals WHERE id='proposal-natural'`).get() as { status: string }).status, 'succeeded');
});
