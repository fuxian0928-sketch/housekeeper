import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { currentSchemaVersion, latestSchemaVersion, runMigrations } from './storage/migrations.js';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(serverDirectory, '..', 'data');
const configuredDatabasePath = process.env.AI_SECRETARY_DB_PATH?.trim();
export const databasePath = configuredDatabasePath ? resolve(configuredDatabasePath) : join(dataDirectory, 'ai-secretary-v01.db');
export const databaseDirectory = dirname(databasePath);
const databaseExistedBeforeStartup = existsSync(databasePath);
mkdirSync(dirname(databasePath), { recursive: true });

export const database = new DatabaseSync(databasePath, { allowExtension: true });
export let sqliteVecAvailable = false;
try {
  const packagedSegment = `${sep}app.asar${sep}`;
  const unpackedSegment = `${sep}app.asar.unpacked${sep}`;
  const packageExtensionPath = sqliteVec.getLoadablePath();
  const unpackedExtensionPath = packageExtensionPath.includes(packagedSegment)
    ? packageExtensionPath.replace(packagedSegment, unpackedSegment)
    : packageExtensionPath;
  database.loadExtension(existsSync(unpackedExtensionPath) ? unpackedExtensionPath : packageExtensionPath);
  sqliteVecAvailable = true;
} catch (error) {
  console.warn(`sqlite-vec 不可用，将降级为 FTS5 与普通向量检索：${error instanceof Error ? error.message : '未知错误'}`);
} finally {
  database.enableLoadExtension(false);
}
database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

export function initializeDatabase() {
  const previousVersion = currentSchemaVersion(database);
  if (databaseExistedBeforeStartup && previousVersion < latestSchemaVersion) {
    const backupDirectory = join(databaseDirectory, 'migration-backups');
    mkdirSync(backupDirectory, { recursive: true });
    const backupPath = join(backupDirectory, `schema-v${previousVersion}-before-v${latestSchemaVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'medium',
      vault_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      executor TEXT NOT NULL DEFAULT 'self',
      due_at TEXT,
      source_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      modified_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE(project_id, relative_path)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'project_fact',
      status TEXT NOT NULL DEFAULT 'candidate',
      source_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_suggestions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      suggestion_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS obsidian_write_requests (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      target_path TEXT NOT NULL,
      summary TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      original_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      modified_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      heading_path TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE(document_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_suggestions_status ON message_suggestions(status, suggestion_type);
    CREATE INDEX IF NOT EXISTS idx_obsidian_write_requests_conversation ON obsidian_write_requests(conversation_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id, position);
  `);

  runMigrations(database);
  if (sqliteVecAvailable) {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[1024]);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(memory_id TEXT PRIMARY KEY, embedding float[1024]);
    `);
  }

  const timestamp = nowIso();
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('ai_enabled', '0', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('ai_model', '', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('api_base_url', '', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('reasoning_effort', 'auto', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('embedding_model', 'BAAI/bge-m3', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('reranker_model', 'BAAI/bge-reranker-v2-m3', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('web_search_policy', 'ask', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('vault_path', '', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('vault_last_scanned_at', '', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('memory_auto_capture', '1', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('memory_auto_apply', '1', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('memory_ui_mode', 'summary', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('memory_auto_confirm', '1', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('memory_document_capture', '1', ?)`).run(timestamp);
  database.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('memory_behavior_capture', '1', ?)`).run(timestamp);
  // Preserve the user's saved memory preferences.

  const vaultSetting = database.prepare(`SELECT value FROM app_settings WHERE key = 'vault_path'`).get() as { value: string } | undefined;
  if (!vaultSetting?.value) {
    const legacyVault = database.prepare(`SELECT vault_path FROM projects WHERE vault_path <> '' ORDER BY updated_at DESC LIMIT 1`).get() as { vault_path: string } | undefined;
    if (legacyVault?.vault_path) database.prepare(`UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'vault_path'`).run(legacyVault.vault_path, timestamp);
  }

  const knowledgeCount = database.prepare('SELECT COUNT(*) AS count FROM knowledge_documents').get() as { count: number };
  if (knowledgeCount.count === 0) {
    database.exec(`
      INSERT OR IGNORE INTO knowledge_documents (id, relative_path, title, excerpt, content, bytes, modified_at, indexed_at)
      SELECT substr(hex(randomblob(16)), 1, 24), relative_path, title, excerpt, content, bytes, modified_at, indexed_at
      FROM documents ORDER BY indexed_at DESC
    `);
  }


}

export function nowIso() {
  return new Date().toISOString();
}
