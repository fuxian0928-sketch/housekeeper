import type { DatabaseSync } from 'node:sqlite';

type Migration = { version: number; name: string; run: (database: DatabaseSync) => void };

function columns(database: DatabaseSync, table: string) {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

function addColumn(database: DatabaseSync, table: string, definition: string) {
  const name = definition.trim().split(/\s+/, 1)[0];
  if (!columns(database, table).has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'conversation_compression',
    run(database) {
      addColumn(database, 'projects', 'deleted_at TEXT');
      addColumn(database, 'conversations', 'compressed_summary TEXT');
      addColumn(database, 'conversations', 'compressed_at TEXT');
    }
  },
  {
    version: 2,
    name: 'task_history_and_rich_events',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS task_history (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          change_type TEXT NOT NULL,
          before_json TEXT,
          after_json TEXT,
          source_type TEXT NOT NULL DEFAULT 'user',
          source_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_history_project ON task_history(project_id, created_at DESC);
      `);
      addColumn(database, 'events', 'object_type TEXT');
      addColumn(database, 'events', 'object_id TEXT');
      addColumn(database, 'events', 'source_type TEXT');
      addColumn(database, 'events', 'source_id TEXT');
      addColumn(database, 'events', 'before_json TEXT');
      addColumn(database, 'events', 'after_json TEXT');
    }
  },
  {
    version: 3,
    name: 'memory_lifecycle',
    run(database) {
      addColumn(database, 'memories', "scope_type TEXT NOT NULL DEFAULT 'project'");
      addColumn(database, 'memories', "source_type TEXT NOT NULL DEFAULT 'manual'");
      addColumn(database, 'memories', 'source_id TEXT');
      addColumn(database, 'memories', 'source_excerpt TEXT');
      addColumn(database, 'memories', 'valid_from TEXT');
      addColumn(database, 'memories', 'valid_until TEXT');
      addColumn(database, 'memories', 'confidence REAL NOT NULL DEFAULT 1');
      addColumn(database, 'memories', 'salience REAL NOT NULL DEFAULT 0.5');
      addColumn(database, 'memories', 'supersedes_id TEXT');
      addColumn(database, 'memories', "contradicts_json TEXT NOT NULL DEFAULT '[]'");
      addColumn(database, 'memories', 'confirmed_at TEXT');
      addColumn(database, 'memories', 'invalidated_at TEXT');
      addColumn(database, 'memories', 'access_count INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'memories', 'last_accessed_at TEXT');
      database.exec('CREATE INDEX IF NOT EXISTS idx_memories_validity ON memories(project_id, status, valid_until)');
    }
  },
  {
    version: 4,
    name: 'action_proposals',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS action_proposals (
          id TEXT PRIMARY KEY,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          action_type TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT,
          target_path TEXT,
          payload_json TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'low',
          requires_confirmation INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending',
          idempotency_key TEXT NOT NULL UNIQUE,
          original_hash TEXT,
          result_json TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          confirmed_at TEXT,
          executed_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_action_proposals_conversation ON action_proposals(conversation_id, status, created_at DESC);
      `);
    }
  },
  {
    version: 5,
    name: 'hybrid_retrieval',
    run(database) {
      addColumn(database, 'knowledge_chunks', 'start_line INTEGER');
      addColumn(database, 'knowledge_chunks', 'end_line INTEGER');
      addColumn(database, 'knowledge_chunks', 'token_count INTEGER');
      addColumn(database, 'knowledge_chunks', 'content_hash TEXT');
      addColumn(database, 'knowledge_chunks', "embedding_model TEXT NOT NULL DEFAULT 'feature-hash-fallback'");
      addColumn(database, 'knowledge_chunks', "embedding_version TEXT NOT NULL DEFAULT 'v1'");
      addColumn(database, 'knowledge_chunks', "chunking_version TEXT NOT NULL DEFAULT 'markdown-heading-v2'");
      database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(chunk_id UNINDEXED, document_id UNINDEXED, relative_path UNINDEXED, title, heading_path, content, tokenize='unicode61 remove_diacritics 2')`);
    }
  },
  {
    version: 6,
    name: 'project_summary_versions',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_summary_versions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          snapshot_json TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          coverage_json TEXT NOT NULL,
          model TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_summary_versions ON project_summary_versions(project_id, created_at DESC);
      `);
    }
  },
  {
    version: 7,
    name: 'chunk_metadata_and_memory_search',
    run(database) {
      addColumn(database, 'knowledge_chunks', "metadata_json TEXT NOT NULL DEFAULT '{}'");
      database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, project_id UNINDEXED, content, source_label, tokenize='unicode61 remove_diacritics 2')`);
      if ((database.prepare(`SELECT COUNT(*) AS count FROM memories_fts`).get() as { count: number }).count === 0) {
        database.exec(`INSERT INTO memories_fts (memory_id, project_id, content, source_label) SELECT id, COALESCE(project_id, ''), content, source_label FROM memories`);
      }
    }
  },
  {
    version: 8,
    name: 'document_relations_and_action_undo',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_document_relations (
          source_document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          target_document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          source_text TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          PRIMARY KEY (source_document_id, target_document_id, relation_type)
        );
        CREATE INDEX IF NOT EXISTS idx_document_relations_target ON knowledge_document_relations(target_document_id, relation_type);
      `);
      addColumn(database, 'action_proposals', 'reverted_at TEXT');
      addColumn(database, 'action_proposals', 'revert_result_json TEXT');
    }
  },
  {
    version: 9,
    name: 'task_dependencies_and_blockers',
    run(database) {
      addColumn(database, 'tasks', "depends_on_json TEXT NOT NULL DEFAULT '[]'");
      addColumn(database, 'tasks', "blocked_reason TEXT NOT NULL DEFAULT ''");
    }
  },
  {
    version: 10,
    name: 'autonomous_local_memory',
    run(database) {
      addColumn(database, 'memories', "origin TEXT NOT NULL DEFAULT 'manual'");
      addColumn(database, 'memories', "reason TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'memories', 'importance REAL NOT NULL DEFAULT 0.5');
      addColumn(database, 'memories', 'last_verified_at TEXT');
      addColumn(database, 'memories', 'evidence_count INTEGER NOT NULL DEFAULT 1');
      addColumn(database, 'memories', "tags_json TEXT NOT NULL DEFAULT '[]'");
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_observations (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          source_type TEXT NOT NULL,
          source_id TEXT,
          source_label TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT,
          created_at TEXT NOT NULL,
          processed_at TEXT,
          UNIQUE(source_type, content_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_observations_status ON memory_observations(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_memory_observations_project ON memory_observations(project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS memory_sources (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          observation_id TEXT NOT NULL REFERENCES memory_observations(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_id TEXT,
          source_label TEXT NOT NULL DEFAULT '',
          excerpt TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, observation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_sources_observation ON memory_sources(observation_id);

        CREATE TABLE IF NOT EXISTS user_profile (
          id TEXT PRIMARY KEY,
          field_key TEXT NOT NULL UNIQUE,
          field_label TEXT NOT NULL,
          value TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'onboarding',
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_reflections (
          id TEXT PRIMARY KEY,
          scope_type TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          reflection_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          source_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_reflections_project ON memory_reflections(project_id, created_at DESC);
      `);
    }
  },
  {
    version: 11,
    name: 'memory_observation_deduplication',
    run(database) {
      addColumn(database, 'memory_observations', "dedupe_key TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'memory_observations', 'occurrence_count INTEGER NOT NULL DEFAULT 1');
      addColumn(database, 'memory_observations', "source_ids_json TEXT NOT NULL DEFAULT '[]'");
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_observations_dedupe ON memory_observations(dedupe_key, status, created_at);
        CREATE TABLE IF NOT EXISTS memory_observation_sources (
          observation_id TEXT NOT NULL REFERENCES memory_observations(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_observation_sources_observation ON memory_observation_sources(observation_id);
        INSERT OR IGNORE INTO memory_observation_sources (observation_id, source_type, source_id, created_at)
          SELECT id, source_type, source_id, created_at FROM memory_observations WHERE source_id IS NOT NULL;
      `);
    }
  },
  {
    version: 12,
    name: 'peer_to_peer_sync',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sync_operations (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          entity_updated_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          exported_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_operations_export ON sync_operations(exported_at, created_at);
        CREATE TABLE IF NOT EXISTS sync_applied_operations (
          operation_id TEXT PRIMARY KEY,
          source_device_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_entity_versions (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          last_device_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        );
        CREATE TABLE IF NOT EXISTS sync_entity_aliases (
          source_device_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          source_entity_id TEXT NOT NULL,
          local_entity_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (source_device_id, entity_type, source_entity_id)
        );
        CREATE TABLE IF NOT EXISTS sync_conflicts (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          local_json TEXT NOT NULL,
          remote_json TEXT NOT NULL,
          resolution TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TRIGGER IF NOT EXISTS sync_projects_insert AFTER INSERT ON projects
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'project',NEW.id,'upsert',json_object('id',NEW.id,'name',NEW.name,'summary',NEW.summary,'status',NEW.status,'priority',NEW.priority,'source_path',NEW.source_path,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('project',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_projects_update AFTER UPDATE ON projects
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'project',NEW.id,'upsert',json_object('id',NEW.id,'name',NEW.name,'summary',NEW.summary,'status',NEW.status,'priority',NEW.priority,'source_path',NEW.source_path,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('project',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;

        CREATE TRIGGER IF NOT EXISTS sync_tasks_insert AFTER INSERT ON tasks
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'task',NEW.id,'upsert',json_object('id',NEW.id,'project_id',NEW.project_id,'title',NEW.title,'description',NEW.description,'status',NEW.status,'priority',NEW.priority,'executor',NEW.executor,'due_at',NEW.due_at,'source_label',NEW.source_label,'depends_on_json',NEW.depends_on_json,'blocked_reason',NEW.blocked_reason,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'completed_at',NEW.completed_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('task',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_tasks_update AFTER UPDATE ON tasks
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'task',NEW.id,'upsert',json_object('id',NEW.id,'project_id',NEW.project_id,'title',NEW.title,'description',NEW.description,'status',NEW.status,'priority',NEW.priority,'executor',NEW.executor,'due_at',NEW.due_at,'source_label',NEW.source_label,'depends_on_json',NEW.depends_on_json,'blocked_reason',NEW.blocked_reason,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'completed_at',NEW.completed_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('task',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;

        CREATE TRIGGER IF NOT EXISTS sync_memories_insert AFTER INSERT ON memories
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'memory',NEW.id,'upsert',json_object('id',NEW.id,'project_id',NEW.project_id,'content',NEW.content,'memory_type',NEW.memory_type,'status',NEW.status,'source_label',NEW.source_label,'scope_type',NEW.scope_type,'source_type',NEW.source_type,'source_id',NEW.source_id,'source_excerpt',NEW.source_excerpt,'valid_from',NEW.valid_from,'valid_until',NEW.valid_until,'confidence',NEW.confidence,'salience',NEW.salience,'supersedes_id',NEW.supersedes_id,'contradicts_json',NEW.contradicts_json,'confirmed_at',NEW.confirmed_at,'invalidated_at',NEW.invalidated_at,'origin',NEW.origin,'reason',NEW.reason,'importance',NEW.importance,'last_verified_at',NEW.last_verified_at,'evidence_count',NEW.evidence_count,'tags_json',NEW.tags_json,'created_at',NEW.created_at,'updated_at',NEW.updated_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('memory',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_memories_update AFTER UPDATE ON memories
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'memory',NEW.id,'upsert',json_object('id',NEW.id,'project_id',NEW.project_id,'content',NEW.content,'memory_type',NEW.memory_type,'status',NEW.status,'source_label',NEW.source_label,'scope_type',NEW.scope_type,'source_type',NEW.source_type,'source_id',NEW.source_id,'source_excerpt',NEW.source_excerpt,'valid_from',NEW.valid_from,'valid_until',NEW.valid_until,'confidence',NEW.confidence,'salience',NEW.salience,'supersedes_id',NEW.supersedes_id,'contradicts_json',NEW.contradicts_json,'confirmed_at',NEW.confirmed_at,'invalidated_at',NEW.invalidated_at,'origin',NEW.origin,'reason',NEW.reason,'importance',NEW.importance,'last_verified_at',NEW.last_verified_at,'evidence_count',NEW.evidence_count,'tags_json',NEW.tags_json,'created_at',NEW.created_at,'updated_at',NEW.updated_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('memory',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;

        CREATE TRIGGER IF NOT EXISTS sync_conversations_insert AFTER INSERT ON conversations
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'conversation',NEW.id,'upsert',json_object('id',NEW.id,'scope_type',NEW.scope_type,'project_id',NEW.project_id,'title',NEW.title,'compressed_summary',NEW.compressed_summary,'compressed_at',NEW.compressed_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('conversation',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_conversations_update AFTER UPDATE ON conversations
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'conversation',NEW.id,'upsert',json_object('id',NEW.id,'scope_type',NEW.scope_type,'project_id',NEW.project_id,'title',NEW.title,'compressed_summary',NEW.compressed_summary,'compressed_at',NEW.compressed_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('conversation',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;

        CREATE TRIGGER IF NOT EXISTS sync_messages_insert AFTER INSERT ON messages
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'message',NEW.id,'upsert',json_object('id',NEW.id,'conversation_id',NEW.conversation_id,'role',NEW.role,'content',NEW.content,'citations_json',NEW.citations_json,'created_at',NEW.created_at),NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('message',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.created_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;

        CREATE TRIGGER IF NOT EXISTS sync_profile_insert AFTER INSERT ON user_profile
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'profile',NEW.id,'upsert',json_object('id',NEW.id,'field_key',NEW.field_key,'field_label',NEW.field_label,'value',NEW.value,'source_type',NEW.source_type,'updated_at',NEW.updated_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('profile',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_profile_update AFTER UPDATE ON user_profile
        WHEN COALESCE((SELECT value FROM app_settings WHERE key='sync_enabled'),'0')='1' AND COALESCE((SELECT value FROM app_settings WHERE key='sync_importing'),'0')!='1'
        BEGIN
          INSERT INTO sync_operations VALUES(lower(hex(randomblob(16))),(SELECT value FROM app_settings WHERE key='sync_device_id'),'profile',NEW.id,'upsert',json_object('id',NEW.id,'field_key',NEW.field_key,'field_label',NEW.field_label,'value',NEW.value,'source_type',NEW.source_type,'updated_at',NEW.updated_at),NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL);
          INSERT INTO sync_entity_versions VALUES('profile',NEW.id,(SELECT value FROM app_settings WHERE key='sync_device_id'),NEW.updated_at) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at;
        END;
      `);
    }
  },
  {
    version: 13,
    name: 'central_document_sync',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS central_devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS central_vaults (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          knowledge_prefix TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS central_vault_members (
          vault_id TEXT NOT NULL REFERENCES central_vaults(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES central_devices(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (vault_id, device_id)
        );

        CREATE TABLE IF NOT EXISTS central_document_blobs (
          content_hash TEXT PRIMARY KEY,
          storage_path TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS central_source_documents (
          id TEXT PRIMARY KEY,
          vault_id TEXT NOT NULL REFERENCES central_vaults(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          knowledge_path TEXT NOT NULL UNIQUE,
          current_hash TEXT REFERENCES central_document_blobs(content_hash),
          current_modified_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          UNIQUE (vault_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_central_source_documents_vault ON central_source_documents(vault_id, deleted_at, relative_path);

        CREATE TABLE IF NOT EXISTS central_document_versions (
          id TEXT PRIMARY KEY,
          source_document_id TEXT NOT NULL REFERENCES central_source_documents(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES central_devices(id) ON DELETE CASCADE,
          content_hash TEXT NOT NULL REFERENCES central_document_blobs(content_hash),
          base_hash TEXT,
          modified_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (source_document_id, device_id, content_hash, modified_at)
        );
        CREATE INDEX IF NOT EXISTS idx_central_document_versions_source ON central_document_versions(source_document_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS central_document_replicas (
          source_document_id TEXT NOT NULL REFERENCES central_source_documents(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES central_devices(id) ON DELETE CASCADE,
          present INTEGER NOT NULL DEFAULT 1,
          content_hash TEXT,
          modified_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (source_document_id, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_central_document_replicas_device ON central_document_replicas(device_id, present, updated_at);

        CREATE TABLE IF NOT EXISTS central_document_conflicts (
          id TEXT PRIMARY KEY,
          source_document_id TEXT NOT NULL REFERENCES central_source_documents(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES central_devices(id) ON DELETE CASCADE,
          server_hash TEXT NOT NULL,
          incoming_hash TEXT NOT NULL,
          base_hash TEXT,
          resolution TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_central_document_conflicts_status ON central_document_conflicts(resolution, created_at DESC);

        CREATE TABLE IF NOT EXISTS central_device_commands (
          id TEXT PRIMARY KEY,
          target_device_id TEXT NOT NULL REFERENCES central_devices(id) ON DELETE CASCADE,
          command_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          completed_at TEXT,
          result_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_central_device_commands_pending ON central_device_commands(target_device_id, status, created_at);
      `);
    }
  },
  {
    version: 14,
    name: 'central_client_sync_state',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS central_local_sync_state (
          vault_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          last_hash TEXT NOT NULL,
          modified_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (vault_id, relative_path)
        );
      `);
    }
  },
  {
    version: 15,
    name: 'memory_overview_and_managed_skills',
    run(database) {
      addColumn(database, 'memories', 'created_at TEXT');
      addColumn(database, 'memories', 'updated_at TEXT');
      addColumn(database, 'memories', "memory_type TEXT NOT NULL DEFAULT 'other'");
      database.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_summaries (
          id TEXT PRIMARY KEY,
          scope_type TEXT NOT NULL,
          scope_id TEXT,
          summary_zh TEXT NOT NULL DEFAULT '',
          memory_count INTEGER NOT NULL DEFAULT 0,
          summary_version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_summaries_scope
          ON memory_summaries(scope_type, COALESCE(scope_id, ''));

        CREATE TABLE IF NOT EXISTS managed_skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL,
          source_url TEXT,
          version TEXT NOT NULL DEFAULT '1',
          install_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'installed',
          enabled INTEGER NOT NULL DEFAULT 1,
          risk_level TEXT NOT NULL DEFAULT 'low',
          manifest_json TEXT NOT NULL DEFAULT '{}',
          last_used_at TEXT,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_managed_skills_status ON managed_skills(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS skill_install_events (
          id TEXT PRIMARY KEY,
          skill_id TEXT REFERENCES managed_skills(id) ON DELETE SET NULL,
          operation TEXT NOT NULL,
          permissions_json TEXT NOT NULL DEFAULT '[]',
          result_json TEXT NOT NULL DEFAULT '{}',
          error_message TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skill_install_events_skill ON skill_install_events(skill_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS github_repo_cache (
          repo_key TEXT NOT NULL,
          ref TEXT NOT NULL,
          path TEXT NOT NULL,
          repository_url TEXT NOT NULL,
          checksum TEXT NOT NULL,
          content TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (repo_key, ref, path)
        );

        UPDATE memories
          SET status = 'confirmed',
              confirmed_at = COALESCE(confirmed_at, updated_at, created_at),
              updated_at = COALESCE(updated_at, created_at)
          WHERE status = 'candidate';
      `);
    }
  },
  {
    version: 16,
    name: 'managed_skill_runtime',
    run(database) {
      addColumn(database, 'managed_skills', 'enabled INTEGER NOT NULL DEFAULT 1');
      addColumn(database, 'managed_skills', 'last_used_at TEXT');
      addColumn(database, 'managed_skills', 'use_count INTEGER NOT NULL DEFAULT 0');
    }
  },
  {
    version: 17,
    name: 'server_owned_documents_and_manual_links',
    run(database) {
      addColumn(database, 'projects', 'progress INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'tasks', 'start_at TEXT');
      addColumn(database, 'knowledge_documents', "source_type TEXT NOT NULL DEFAULT 'obsidian'");
      addColumn(database, 'knowledge_documents', 'server_revision INTEGER NOT NULL DEFAULT 1');
      addColumn(database, 'knowledge_documents', 'server_edited_at TEXT');
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_document_links (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          link_source TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, document_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_document_links_document ON project_document_links(document_id, project_id);

        CREATE TABLE IF NOT EXISTS task_document_links (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, document_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_document_links_document ON task_document_links(document_id, task_id);

        CREATE TABLE IF NOT EXISTS knowledge_document_versions (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source_type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (document_id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_document_versions_document ON knowledge_document_versions(document_id, revision DESC);

        DROP TRIGGER IF EXISTS sync_projects_insert;
        DROP TRIGGER IF EXISTS sync_projects_update;
        DROP TRIGGER IF EXISTS sync_tasks_insert;
        DROP TRIGGER IF EXISTS sync_tasks_update;
        DROP TRIGGER IF EXISTS sync_memories_insert;
        DROP TRIGGER IF EXISTS sync_memories_update;
        DROP TRIGGER IF EXISTS sync_conversations_insert;
        DROP TRIGGER IF EXISTS sync_conversations_update;
        DROP TRIGGER IF EXISTS sync_messages_insert;
        DROP TRIGGER IF EXISTS sync_profile_insert;
        DROP TRIGGER IF EXISTS sync_profile_update;
        INSERT INTO app_settings(key,value,updated_at) VALUES('legacy_peer_sync_retired','1',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at;
      `);
    }
  },
  {
    version: 18,
    name: 'skill_tool_execution_audit',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS skill_tool_executions (
          id TEXT PRIMARY KEY,
          skill_id TEXT REFERENCES managed_skills(id) ON DELETE SET NULL,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          proposal_id TEXT REFERENCES action_proposals(id) ON DELETE SET NULL,
          tool_name TEXT NOT NULL,
          arguments_json TEXT NOT NULL DEFAULT '{}',
          permission TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          error_message TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skill_tool_executions_conversation ON skill_tool_executions(conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_tool_executions_proposal ON skill_tool_executions(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_skill_tool_executions_skill ON skill_tool_executions(skill_id, created_at DESC);
      `);
    }
  },
  {
    version: 19,
    name: 'office_document_imports',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS office_document_imports (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          format TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          warnings_json TEXT NOT NULL DEFAULT '[]',
          stats_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'ready',
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_office_imports_document ON office_document_imports(document_id);
        CREATE INDEX IF NOT EXISTS idx_office_imports_hash ON office_document_imports(content_hash);
      `);
    }
  }
];

migrations.push({ version: 20, name: 'self_diagnostics', run(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS self_diagnostics (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, conversation_id TEXT,
    stage TEXT NOT NULL, status TEXT NOT NULL, model TEXT,
    error_code TEXT, elapsed_ms INTEGER NOT NULL, created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_self_diagnostics_conversation ON self_diagnostics(conversation_id, created_at);`);
} });

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;

export function currentSchemaVersion(database: DatabaseSync) {
  const table = database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!table) return 0;
  return Number((database.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`).get() as { version: number }).version);
}

export function runMigrations(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set((database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN');
    try {
      migration.run(database);
      database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`数据库迁移 ${migration.version}_${migration.name} 失败`, { cause: error });
    }
  }
}
