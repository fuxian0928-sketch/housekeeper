import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { database, nowIso } from '../db.js';
import { lexicalSimilarity, syncMemorySearch } from '../domain/memories/memory-service.js';

type EntityType = 'project' | 'task' | 'memory' | 'conversation' | 'message' | 'profile';
type SyncOperation = { id: string; deviceId: string; entityType: EntityType; entityId: string; operation: 'upsert'; payload: Record<string, unknown>; entityUpdatedAt: string; createdAt: string };
const entityOrder: Record<EntityType, number> = { project: 0, task: 1, memory: 1, conversation: 1, profile: 1, message: 2 };

function setting(key: string, fallback = '') {
  return (database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? fallback;
}
function setSetting(key: string, value: string) {
  database.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, nowIso());
}
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function nullable(value: unknown) { return typeof value === 'string' ? value : null; }
function number(value: unknown, fallback: number) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function normalize(value: string) { return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' '); }

function validOperation(value: unknown): value is SyncOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length <= 128 && typeof item.deviceId === 'string' && item.deviceId.length <= 128
    && ['project', 'task', 'memory', 'conversation', 'message', 'profile'].includes(String(item.entityType))
    && typeof item.entityId === 'string' && item.entityId.length <= 128 && item.operation === 'upsert'
    && Boolean(item.payload) && typeof item.payload === 'object' && typeof item.entityUpdatedAt === 'string' && typeof item.createdAt === 'string';
}

function alias(sourceDevice: string, entityType: EntityType, sourceId: string) {
  return (database.prepare(`SELECT local_entity_id FROM sync_entity_aliases WHERE source_device_id=? AND entity_type=? AND source_entity_id=?`).get(sourceDevice, entityType, sourceId) as { local_entity_id: string } | undefined)?.local_entity_id ?? sourceId;
}
function saveAlias(sourceDevice: string, entityType: EntityType, sourceId: string, localId: string) {
  if (sourceId === localId) return;
  database.prepare(`INSERT OR IGNORE INTO sync_entity_aliases VALUES(?,?,?,?,?)`).run(sourceDevice, entityType, sourceId, localId, nowIso());
}

function seedOperation(deviceId: string, entityType: EntityType, entityId: string, payload: Record<string, unknown>, updatedAt: string) {
  const id = randomUUID();
  database.prepare(`INSERT INTO sync_operations(id,device_id,entity_type,entity_id,operation,payload_json,entity_updated_at,created_at) VALUES(?,?,?,?, 'upsert',?,?,?)`).run(id, deviceId, entityType, entityId, JSON.stringify(payload), updatedAt, nowIso());
  database.prepare(`INSERT INTO sync_entity_versions VALUES(?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at`).run(entityType, entityId, deviceId, updatedAt);
}

function snapshot(deviceId: string) {
  if (setting(`sync_seeded_${deviceId}`) === '1') return;
  const definitions: Array<{ type: EntityType; table: string; updated: string }> = [
    { type: 'project', table: 'projects', updated: 'updated_at' }, { type: 'task', table: 'tasks', updated: 'updated_at' },
    { type: 'memory', table: 'memories', updated: 'updated_at' }, { type: 'conversation', table: 'conversations', updated: 'updated_at' },
    { type: 'message', table: 'messages', updated: 'created_at' }, { type: 'profile', table: 'user_profile', updated: 'updated_at' }
  ];
  database.exec('BEGIN');
  try {
    for (const definition of definitions) {
      const rows = database.prepare(`SELECT * FROM ${definition.table}`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const payload = { ...row };
        if (definition.type === 'project') delete payload.vault_path;
        seedOperation(deviceId, definition.type, String(row.id), payload, String(row[definition.updated]));
      }
    }
    setSetting(`sync_seeded_${deviceId}`, '1');
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

function entityVersion(type: EntityType, id: string) {
  return database.prepare(`SELECT last_device_id,updated_at FROM sync_entity_versions WHERE entity_type=? AND entity_id=?`).get(type, id) as { last_device_id: string; updated_at: string } | undefined;
}

function recordConflict(operation: SyncOperation, local: unknown, resolution: string) {
  database.prepare(`INSERT OR IGNORE INTO sync_conflicts VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), operation.id, operation.entityType, operation.entityId, JSON.stringify(local ?? null), JSON.stringify(operation.payload), resolution, nowIso());
}

function applyOperation(operation: SyncOperation, vaultPath: string) {
  if (database.prepare('SELECT 1 FROM sync_applied_operations WHERE operation_id=?').get(operation.id)) return 'ignored';
  const payload = operation.payload;
  let localId = alias(operation.deviceId, operation.entityType, operation.entityId);

  if (operation.entityType === 'project' && localId === operation.entityId) {
    const same = database.prepare(`SELECT id FROM projects WHERE lower(trim(name))=lower(trim(?)) AND id<>?`).get(text(payload.name), localId) as { id: string } | undefined;
    if (same) { localId = same.id; saveAlias(operation.deviceId, 'project', operation.entityId, localId); }
  }
  if (operation.entityType === 'task' && localId === operation.entityId) {
    const projectId = alias(operation.deviceId, 'project', text(payload.project_id));
    const same = database.prepare(`SELECT id FROM tasks WHERE project_id=? AND lower(trim(title))=lower(trim(?)) AND id<>? AND status NOT IN ('done','cancelled')`).get(projectId, text(payload.title), localId) as { id: string } | undefined;
    if (same) { localId = same.id; saveAlias(operation.deviceId, 'task', operation.entityId, localId); }
  }
  if (operation.entityType === 'memory' && localId === operation.entityId) {
    const projectId = payload.project_id ? alias(operation.deviceId, 'project', text(payload.project_id)) : null;
    const candidates = database.prepare(`SELECT id,content FROM memories WHERE COALESCE(project_id,'')=COALESCE(?,'') AND id<>? AND status NOT IN ('invalidated','rejected','superseded') ORDER BY updated_at DESC LIMIT 50`).all(projectId, localId) as Array<{ id: string; content: string }>;
    const same = candidates.find((item) => normalize(item.content) === normalize(text(payload.content)) || lexicalSimilarity(item.content, text(payload.content)) >= .9);
    if (same) { localId = same.id; saveAlias(operation.deviceId, 'memory', operation.entityId, localId); }
  }

  const version = entityVersion(operation.entityType, localId);
  const remoteKey = `${operation.entityUpdatedAt}|${operation.deviceId}`;
  const localKey = version ? `${version.updated_at}|${version.last_device_id}` : '';
  if (localKey && localKey > remoteKey) {
    recordConflict(operation, { entityId: localId, version }, 'kept_newer_local');
    database.prepare(`INSERT INTO sync_applied_operations VALUES(?,?,?)`).run(operation.id, operation.deviceId, nowIso());
    return 'conflict';
  }

  if (operation.entityType === 'project') {
    database.prepare(`INSERT INTO projects(id,name,summary,status,priority,vault_path,source_path,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,summary=excluded.summary,status=excluded.status,priority=excluded.priority,vault_path=excluded.vault_path,source_path=excluded.source_path,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`).run(localId, text(payload.name).slice(0,80), text(payload.summary).slice(0,500), text(payload.status,'active'), text(payload.priority,'medium'), vaultPath, text(payload.source_path).slice(0,500), text(payload.created_at,operation.createdAt), operation.entityUpdatedAt, nullable(payload.deleted_at));
  } else if (operation.entityType === 'task') {
    const projectId = alias(operation.deviceId, 'project', text(payload.project_id));
    if (!database.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error(`任务所属项目尚未同步：${projectId}`);
    database.prepare(`INSERT INTO tasks(id,project_id,title,description,status,priority,executor,due_at,source_label,depends_on_json,blocked_reason,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,description=excluded.description,status=excluded.status,priority=excluded.priority,executor=excluded.executor,due_at=excluded.due_at,source_label=excluded.source_label,depends_on_json=excluded.depends_on_json,blocked_reason=excluded.blocked_reason,updated_at=excluded.updated_at,completed_at=excluded.completed_at`).run(localId, projectId, text(payload.title).slice(0,120), text(payload.description).slice(0,2000), text(payload.status,'todo'), text(payload.priority,'medium'), text(payload.executor,'self'), nullable(payload.due_at), text(payload.source_label).slice(0,200), text(payload.depends_on_json,'[]'), text(payload.blocked_reason).slice(0,500), text(payload.created_at,operation.createdAt), operation.entityUpdatedAt, nullable(payload.completed_at));
  } else if (operation.entityType === 'memory') {
    const projectId = payload.project_id ? alias(operation.deviceId, 'project', text(payload.project_id)) : null;
    if (projectId && !database.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error(`记忆所属项目尚未同步：${projectId}`);
    const existing = database.prepare('SELECT evidence_count,confidence,importance FROM memories WHERE id=?').get(localId) as { evidence_count: number; confidence: number; importance: number } | undefined;
    database.prepare(`INSERT INTO memories(id,project_id,content,memory_type,status,source_label,scope_type,source_type,source_id,source_excerpt,valid_from,valid_until,confidence,salience,supersedes_id,contradicts_json,confirmed_at,invalidated_at,origin,reason,importance,last_verified_at,evidence_count,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,content=excluded.content,memory_type=excluded.memory_type,status=excluded.status,source_label=excluded.source_label,scope_type=excluded.scope_type,source_type=excluded.source_type,source_id=excluded.source_id,source_excerpt=excluded.source_excerpt,valid_from=excluded.valid_from,valid_until=excluded.valid_until,confidence=MAX(memories.confidence,excluded.confidence),salience=MAX(memories.salience,excluded.salience),supersedes_id=excluded.supersedes_id,contradicts_json=excluded.contradicts_json,confirmed_at=excluded.confirmed_at,invalidated_at=excluded.invalidated_at,origin=excluded.origin,reason=excluded.reason,importance=MAX(memories.importance,excluded.importance),last_verified_at=excluded.last_verified_at,evidence_count=MAX(memories.evidence_count,excluded.evidence_count),tags_json=excluded.tags_json,updated_at=excluded.updated_at`).run(localId, projectId, text(payload.content).slice(0,1000), text(payload.memory_type,'other'), text(payload.status,'candidate'), text(payload.source_label).slice(0,300), text(payload.scope_type,projectId?'project':'global'), text(payload.source_type,'sync'), nullable(payload.source_id), nullable(payload.source_excerpt), nullable(payload.valid_from), nullable(payload.valid_until), Math.max(number(payload.confidence,1), existing?.confidence ?? 0), number(payload.salience,.5), nullable(payload.supersedes_id), text(payload.contradicts_json,'[]'), nullable(payload.confirmed_at), nullable(payload.invalidated_at), text(payload.origin,'manual'), text(payload.reason).slice(0,1000), Math.max(number(payload.importance,.5), existing?.importance ?? 0), nullable(payload.last_verified_at), Math.max(number(payload.evidence_count,1), existing?.evidence_count ?? 0), text(payload.tags_json,'[]'), text(payload.created_at,operation.createdAt), operation.entityUpdatedAt);
    syncMemorySearch(localId);
  } else if (operation.entityType === 'conversation') {
    const projectId = payload.project_id ? alias(operation.deviceId, 'project', text(payload.project_id)) : null;
    if (projectId && !database.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new Error(`对话所属项目尚未同步：${projectId}`);
    database.prepare(`INSERT INTO conversations(id,scope_type,project_id,title,compressed_summary,compressed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type,project_id=excluded.project_id,title=excluded.title,compressed_summary=excluded.compressed_summary,compressed_at=excluded.compressed_at,updated_at=excluded.updated_at`).run(localId,text(payload.scope_type,'project'),projectId,text(payload.title).slice(0,80),nullable(payload.compressed_summary),nullable(payload.compressed_at),text(payload.created_at,operation.createdAt),operation.entityUpdatedAt);
  } else if (operation.entityType === 'message') {
    const conversationId = alias(operation.deviceId, 'conversation', text(payload.conversation_id));
    if (!database.prepare('SELECT 1 FROM conversations WHERE id=?').get(conversationId)) throw new Error(`消息所属对话尚未同步：${conversationId}`);
    database.prepare(`INSERT OR IGNORE INTO messages(id,conversation_id,role,content,citations_json,created_at) VALUES(?,?,?,?,?,?)`).run(localId,conversationId,text(payload.role,'user'),text(payload.content).slice(0,200000),text(payload.citations_json,'[]'),text(payload.created_at,operation.createdAt));
  } else {
    const same = database.prepare('SELECT id FROM user_profile WHERE field_key=?').get(text(payload.field_key)) as { id: string } | undefined;
    if (same && same.id !== localId) { localId = same.id; saveAlias(operation.deviceId,'profile',operation.entityId,localId); }
    database.prepare(`INSERT INTO user_profile(id,field_key,field_label,value,source_type,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(field_key) DO UPDATE SET field_label=excluded.field_label,value=excluded.value,source_type=excluded.source_type,updated_at=excluded.updated_at`).run(localId,text(payload.field_key).slice(0,80),text(payload.field_label).slice(0,80),text(payload.value).slice(0,5000),text(payload.source_type,'sync'),operation.entityUpdatedAt);
  }
  database.prepare(`INSERT INTO sync_entity_versions VALUES(?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET last_device_id=excluded.last_device_id,updated_at=excluded.updated_at`).run(operation.entityType, localId, operation.deviceId, operation.entityUpdatedAt);
  database.prepare(`INSERT INTO sync_applied_operations VALUES(?,?,?)`).run(operation.id, operation.deviceId, nowIso());
  return 'applied';
}

export class PeerSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running: ReturnType<PeerSyncService['runInternal']> | null = null;

  constructor() {
    if (!setting('sync_device_id')) setSetting('sync_device_id', randomUUID());
    if (!setting('sync_device_name')) setSetting('sync_device_name', hostname() || '我的电脑');
    setSetting('sync_importing', '0');
  }

  folder() { const vault = setting('vault_path'); return vault ? join(vault, 'AI秘书', '设备同步') : ''; }
  status() {
    return {
      enabled: setting('sync_enabled','0') === '1', deviceId: setting('sync_device_id'), deviceName: setting('sync_device_name'), folderPath: this.folder(),
      lastRunAt: setting('sync_last_run_at') || null, lastError: setting('sync_last_error') || null,
      pendingOperations: Number((database.prepare(`SELECT COUNT(*) AS count FROM sync_operations WHERE exported_at IS NULL`).get() as { count: number }).count),
      conflictCount: Number((database.prepare(`SELECT COUNT(*) AS count FROM sync_conflicts`).get() as { count: number }).count)
    };
  }
  restart() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (setting('sync_enabled','0') !== '1') return;
    void this.run().catch(() => undefined);
    const timer = setInterval(() => { void this.run().catch(() => undefined); }, 8000);
    this.timer = timer;
    timer.unref?.();
  }
  run() { if (!this.running) this.running = this.runInternal().finally(() => { this.running = null; }); return this.running; }

  private async runInternal() {
    if (setting('sync_enabled','0') !== '1') throw Object.assign(new Error('请先开启双设备同步。'), { statusCode: 400 });
    const vaultPath = setting('vault_path');
    if (!vaultPath || !existsSync(join(vaultPath,'.obsidian'))) throw Object.assign(new Error('请先设置有效的 Obsidian Vault。'), { statusCode: 400 });
    const deviceId = setting('sync_device_id');
    const folder = this.folder();
    await mkdir(folder,{recursive:true});
    snapshot(deviceId);
    const deviceFile = join(folder, `${deviceId}.md`);
    if (!existsSync(deviceFile)) await writeFile(deviceFile, `# AI 秘书设备同步数据\n\n> 此文件由 AI 秘书自动维护，请勿手动编辑。设备：${setting('sync_device_name')}\n\n`, 'utf8');
    const outgoing = database.prepare(`SELECT id,device_id,entity_type,entity_id,operation,payload_json,entity_updated_at,created_at FROM sync_operations WHERE exported_at IS NULL ORDER BY created_at`).all() as Array<Record<string,unknown>>;
    for (const row of outgoing) {
      const operation: SyncOperation = { id:text(row.id),deviceId:text(row.device_id),entityType:text(row.entity_type) as EntityType,entityId:text(row.entity_id),operation:'upsert',payload:JSON.parse(text(row.payload_json)) as Record<string,unknown>,entityUpdatedAt:text(row.entity_updated_at),createdAt:text(row.created_at) };
      await appendFile(deviceFile, `<!-- AI_SECRETARY_SYNC ${Buffer.from(JSON.stringify(operation),'utf8').toString('base64url')} -->\n`, 'utf8');
      database.prepare('UPDATE sync_operations SET exported_at=? WHERE id=?').run(nowIso(), operation.id);
    }
    const files = (await readdir(folder,{withFileTypes:true})).filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== `${deviceId}.md`);
    const incoming: SyncOperation[] = [];
    for (const file of files) {
      const content = await readFile(join(folder,file.name),'utf8');
      if (content.length > 50_000_000) continue;
      for (const match of content.matchAll(/<!-- AI_SECRETARY_SYNC ([A-Za-z0-9_-]+) -->/g)) {
        try { const operation = JSON.parse(Buffer.from(match[1],'base64url').toString('utf8')) as unknown; if (validOperation(operation) && operation.deviceId !== deviceId) incoming.push(operation); } catch { /* ignore incomplete or manually edited records */ }
      }
    }
    incoming.sort((left,right) => entityOrder[left.entityType]-entityOrder[right.entityType] || left.entityUpdatedAt.localeCompare(right.entityUpdatedAt) || left.id.localeCompare(right.id));
    let applied=0, conflicts=0, failed=0;
    setSetting('sync_importing','1');
    try {
      for (const operation of incoming) {
        database.exec('BEGIN');
        try { const result=applyOperation(operation,vaultPath); database.exec('COMMIT'); if(result==='applied') applied+=1; else if(result==='conflict') conflicts+=1; }
        catch { database.exec('ROLLBACK'); failed+=1; }
      }
    } finally { setSetting('sync_importing','0'); }
    const timestamp=nowIso(); setSetting('sync_last_run_at',timestamp); setSetting('sync_last_error',failed?`${failed} 条远端变更等待依赖数据后重试`:'');
    return { exported: outgoing.length, applied, conflicts, failed, lastRunAt: timestamp };
  }
}
