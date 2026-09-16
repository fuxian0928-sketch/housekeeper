import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('rename validates titles without reordering; delete cascades messages but preserves other conversations', async () => {
  process.env.AI_SECRETARY_DB_PATH = join(mkdtempSync(join(tmpdir(), 'conversation-management-')), 'test.db');
  const { database, initializeDatabase } = await import('../../db.js');
  initializeDatabase();
  const { renameConversation, deleteConversation, getConversation } = await import('./conversation-service.js');
  database.prepare("INSERT INTO conversations (id, scope_type, title, created_at, updated_at) VALUES (?, 'memory', ?, ?, ?)").run('history-a', '原名称', '2026-09-01', '2026-09-02');
  database.prepare("INSERT INTO conversations (id, scope_type, title, created_at, updated_at) VALUES (?, 'memory', ?, ?, ?)").run('history-b', '其他对话', '2026-09-01', '2026-09-03');
  database.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('history-message', 'history-a', 'user', '保留其他数据', '2026-09-02')").run();
  assert.throws(() => renameConversation('history-a', '  '), /1～120/);
  assert.throws(() => renameConversation('history-a', 'x'.repeat(121)), /1～120/);
  renameConversation('history-a', ' 新名称 ');
  assert.equal(getConversation('history-a').title, '新名称');
  assert.equal((database.prepare("SELECT updated_at FROM conversations WHERE id='history-a'").get() as { updated_at: string }).updated_at, '2026-09-02');
  deleteConversation('history-a');
  assert.equal(database.prepare("SELECT id FROM messages WHERE id='history-message'").get(), undefined);
  assert.equal(getConversation('history-b').title, '其他对话');
  assert.throws(() => deleteConversation('history-a'), /不存在/);
  assert.throws(() => renameConversation('missing', '名称'), /不存在/);
  database.close();
});
