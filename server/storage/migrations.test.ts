import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion, latestSchemaVersion, runMigrations } from './migrations.js';

function legacyDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '2026-01-01');
    CREATE TABLE events (id TEXT PRIMARY KEY);
    CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT, content TEXT NOT NULL, source_label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'candidate');
    CREATE TABLE knowledge_documents (id TEXT PRIMARY KEY);
    CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL);
  `);
  return database;
}

test('旧数据库按版本迁移到最新结构且可重复运行', () => {
  const database = legacyDatabase();
  database.prepare('INSERT INTO messages(id,content) VALUES(?,?)').run('legacy-message','迁移之前保留的历史消息');
  runMigrations(database);
  runMigrations(database);
  assert.equal(currentSchemaVersion(database), latestSchemaVersion);
  const taskColumns = new Set((database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((item) => item.name));
  assert.ok(taskColumns.has('depends_on_json'));
  assert.ok(taskColumns.has('blocked_reason'));
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'action_proposals'`).get());
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_observations'`).get());
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_observation_sources'`).get());
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_profile'`).get());
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_tool_executions'`).get());
  const observationColumns = new Set((database.prepare('PRAGMA table_info(memory_observations)').all() as Array<{ name: string }>).map((item) => item.name));
  assert.ok(observationColumns.has('dedupe_key'));
  assert.ok(observationColumns.has('occurrence_count'));
  assert.ok(database.prepare(`SELECT revision FROM memory_context_revision WHERE id=1`).get());
  assert.equal(database.prepare(`SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'revision_%'`).get()?.count,6);
  assert.equal(database.prepare("SELECT message_id FROM message_archive_fts WHERE message_archive_fts MATCH '历史消息'").get()?.message_id,'legacy-message');
  assert.equal(database.prepare("SELECT content FROM messages WHERE id='legacy-message'").get()?.content,'迁移之前保留的历史消息');
  database.close();
});
