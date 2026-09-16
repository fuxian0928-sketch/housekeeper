import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('通过 Obsidian Vault 交换项目、任务、记忆和对话变更', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-secretary-sync-'));
  const vault = join(directory, 'vault');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  process.env.AI_SECRETARY_DB_PATH = join(directory, 'sync.db');
  const { database, initializeDatabase } = await import('../db.js');
  const { PeerSyncService } = await import('./peer-sync-service.js');
  initializeDatabase();
  const timestamp = new Date().toISOString();
  const set = database.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
  set.run('vault_path', vault, timestamp);
  set.run('sync_enabled', '1', timestamp);
  const sync = new PeerSyncService();
  const projectId = randomUUID();
  database.prepare(`INSERT INTO projects(id,name,summary,status,priority,vault_path,source_path,created_at,updated_at) VALUES(?,?,?,'active','medium',?,'',?,?)`).run(projectId, '本地项目', '测试同步', vault, timestamp, timestamp);
  const first = await sync.run();
  assert.ok(first.exported >= 1);
  const ownFile = join(vault, 'AI秘书', '设备同步', `${sync.status().deviceId}.md`);
  assert.match(await readFile(ownFile, 'utf8'), /AI_SECRETARY_SYNC/);

  const remoteDevice = randomUUID();
  const remoteProject = randomUUID();
  const remoteTask = randomUUID();
  const remoteMemory = randomUUID();
  const remoteConversation = randomUUID();
  const remoteMessage = randomUUID();
  const updatedAt = new Date(Date.now() + 1000).toISOString();
  const operations = [
    { id: randomUUID(), deviceId: remoteDevice, entityType: 'project', entityId: remoteProject, operation: 'upsert', payload: { id: remoteProject, name: '另一台电脑的项目', summary: '', status: 'active', priority: 'medium', source_path: '', created_at: updatedAt, updated_at: updatedAt, deleted_at: null }, entityUpdatedAt: updatedAt, createdAt: updatedAt },
    { id: randomUUID(), deviceId: remoteDevice, entityType: 'task', entityId: remoteTask, operation: 'upsert', payload: { id: remoteTask, project_id: remoteProject, title: '跨设备任务', description: '', status: 'todo', priority: 'high', executor: 'self', due_at: null, source_label: '另一台电脑', depends_on_json: '[]', blocked_reason: '', created_at: updatedAt, updated_at: updatedAt, completed_at: null }, entityUpdatedAt: updatedAt, createdAt: updatedAt },
    { id: randomUUID(), deviceId: remoteDevice, entityType: 'memory', entityId: remoteMemory, operation: 'upsert', payload: { id: remoteMemory, project_id: remoteProject, content: '这是一条跨设备记忆', memory_type: 'project_fact', status: 'confirmed', source_label: '另一台电脑', scope_type: 'project', source_type: 'manual', created_at: updatedAt, updated_at: updatedAt }, entityUpdatedAt: updatedAt, createdAt: updatedAt },
    { id: randomUUID(), deviceId: remoteDevice, entityType: 'conversation', entityId: remoteConversation, operation: 'upsert', payload: { id: remoteConversation, scope_type: 'project', project_id: remoteProject, title: '跨设备对话', created_at: updatedAt, updated_at: updatedAt }, entityUpdatedAt: updatedAt, createdAt: updatedAt },
    { id: randomUUID(), deviceId: remoteDevice, entityType: 'message', entityId: remoteMessage, operation: 'upsert', payload: { id: remoteMessage, conversation_id: remoteConversation, role: 'user', content: '另一台电脑上的消息', citations_json: '[]', created_at: updatedAt }, entityUpdatedAt: updatedAt, createdAt: updatedAt }
  ];
  const remoteContent = `# AI 秘书设备同步数据\n\n${operations.map((operation) => `<!-- AI_SECRETARY_SYNC ${Buffer.from(JSON.stringify(operation)).toString('base64url')} -->`).join('\n')}\n`;
  await writeFile(join(vault, 'AI秘书', '设备同步', `${remoteDevice}.md`), remoteContent, 'utf8');
  const second = await sync.run();
  assert.equal(second.applied, 5);
  assert.equal((database.prepare('SELECT title FROM tasks WHERE id=?').get(remoteTask) as { title: string }).title, '跨设备任务');
  assert.equal((database.prepare('SELECT content FROM memories WHERE id=?').get(remoteMemory) as { content: string }).content, '这是一条跨设备记忆');
  assert.equal((database.prepare('SELECT content FROM messages WHERE id=?').get(remoteMessage) as { content: string }).content, '另一台电脑上的消息');
  database.close();
  await rm(directory, { recursive: true, force: true });
});
