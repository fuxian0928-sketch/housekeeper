import { createHash } from 'node:crypto';
import { database, nowIso, sqliteVecAvailable } from '../../db.js';
import { mutateMemoryIndex } from './memory-index-mutation.js';
import { memorySearchText } from './memory-tokenizer.js';

export type MemoryRecord = Record<string, unknown>;
const snapshotFields = ['id','project_id','content','status','memory_type','source_type','source_id','source_excerpt','source_label','valid_from','valid_until','supersedes_id','fact_key','subject_key','attribute_key','details_json','origin','confidence','importance','evidence_count','reason','last_observation_order','learned_at','source_occurred_at'];
export const readMemoryRecord = (id: string) => database.prepare('SELECT * FROM memories WHERE id=?').get(id);
export function memoryRevision(row: MemoryRecord): string {
  return createHash('sha256').update(JSON.stringify([row.memory_revision ?? 1, ...snapshotFields.map(key => row[key] ?? null)])).digest('hex');
}
export function memoryFactKey(projectId: string | null, subject: string, attribute: string, facet = '') {
  return createHash('sha256').update(JSON.stringify([projectId ?? '', subject.normalize('NFKC').trim(), attribute.normalize('NFKC').trim(), facet.normalize('NFKC').trim()])).digest('hex');
}
export const memoryContentHash = (value: string) => createHash('sha256').update(value.normalize('NFKC').trim().toLowerCase()).digest('hex');
export function syncMemoryLexicalIndex(id: string) {
  mutateMemoryIndex(() => {
    database.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(id);
    const row = readMemoryRecord(id);
    if (row?.status === 'confirmed') database.prepare('INSERT INTO memories_fts(memory_id,project_id,content,source_label) VALUES(?,?,?,?)')
      .run(id, String(row.project_id ?? ''), memorySearchText(String(row.content)), memorySearchText(String(row.source_label ?? '')));
    if (sqliteVecAvailable) database.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(id);
  });
}

/** All owned memory mutations share this synchronous transaction. No model/embedding waits inside. */
export function commitMemoryMutation<T>(input: {
  ids: string[]; expected?: Map<string, string>; kind: string; observationId?: string | null;
}, write: () => T): T {
  database.exec('SAVEPOINT memory_ledger_write');
  try {
    const ids = [...new Set(input.ids)];
    const before = new Map(ids.map(id => [id, readMemoryRecord(id)]));
    for (const [id, revision] of input.expected ?? []) {
      const row = readMemoryRecord(id);
      if (!row || memoryRevision(row) !== revision) throw Object.assign(new Error('记忆在整理期间已变化，请根据新版本重新整理。'), { statusCode: 409, code: 'MEMORY_VERSION_CONFLICT' });
    }
    const result = write();
    for(const id of ids){
      const row=readMemoryRecord(id);
      if(row?.fact_key&&Number(database.prepare("SELECT COUNT(*) AS n FROM memories WHERE fact_key=? AND status='confirmed'").get(String(row.fact_key))?.n)>1)throw Object.assign(new Error('同一事实出现多个当前值，本次提交已回滚。'),{code:'MEMORY_VERSION_CONFLICT',statusCode:409});
    }
    const at = nowIso();
    for (const id of ids) {
      const old = before.get(id), current = readMemoryRecord(id);
      if (!current || old && memoryRevision(old) === memoryRevision(current)) continue;
      // Keep an immutable baseline even for data predating this migration.
      const forgotten=!!database.prepare('SELECT 1 FROM memory_forgetting WHERE memory_id=?').get(id);
      if (old) database.prepare('INSERT OR IGNORE INTO memory_history(memory_id,revision,snapshot_json,change_kind,recorded_at) VALUES(?,?,?,?,?)')
        .run(id, Number(old.memory_revision ?? 1), forgotten?'{}':JSON.stringify(old), 'baseline', at);
      const revision = old ? Number(old.memory_revision ?? 1) + 1 : 1;
      database.prepare('UPDATE memories SET memory_revision=?,learned_at=COALESCE(learned_at,?) WHERE id=?').run(revision, at, id);
      const snapshot = readMemoryRecord(id)!;
      database.prepare('INSERT INTO memory_history(memory_id,revision,snapshot_json,change_kind,observation_id,recorded_at) VALUES(?,?,?,?,?,?)')
        .run(id, revision, forgotten?'{}':JSON.stringify(snapshot), input.kind, input.observationId ?? null, at);
      syncMemoryLexicalIndex(id);
      database.prepare("INSERT INTO memory_index_jobs(memory_id,target_revision,status,updated_at) VALUES(?,?,'pending',?) ON CONFLICT(memory_id) DO UPDATE SET target_revision=excluded.target_revision,status='pending',attempts=0,updated_at=excluded.updated_at")
        .run(id, revision, at);
    }
    database.exec('RELEASE memory_ledger_write');
    return result;
  } catch (error) {
    database.exec('ROLLBACK TO memory_ledger_write');
    database.exec('RELEASE memory_ledger_write');
    throw error;
  }
}

export function listMemoryHistory(id: string) {
  const forgotten = database.prepare('SELECT 1 FROM memory_forgetting WHERE memory_id=?').get(id);
  return database.prepare('SELECT revision,snapshot_json,change_kind,recorded_at FROM memory_history WHERE memory_id=? ORDER BY revision DESC').all(id).map(row => ({
    revision: row.revision, changeKind: row.change_kind, recordedAt: row.recorded_at,
    snapshot: forgotten ? { forgotten: true } : JSON.parse(String(row.snapshot_json)) as MemoryRecord
  }));
}

export function forgottenMemory(input: { projectId: string | null; factKey?: string; content: string; observationOrder: number }) {
  return !!database.prepare(`SELECT 1 FROM memory_forgetting WHERE scope_key=? AND cutoff_order>=? AND (content_hash=? OR (fact_key<>'' AND fact_key=?))`).get(input.projectId ?? '', input.observationOrder, memoryContentHash(input.content), input.factKey ?? '');
}

export function forgetMemory(id: string) {
  const original = readMemoryRecord(id);
  if (!original) throw Object.assign(new Error('记忆不存在。'), { statusCode: 404 });
  if(database.prepare('SELECT 1 FROM memory_forgetting WHERE memory_id=?').get(id))return{forgotten:true,memoryId:id,originalConversationDeleted:false};
  const rows = original.fact_key ? database.prepare('SELECT * FROM memories WHERE fact_key=?').all(String(original.fact_key)) : database.prepare(
    `WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT m.id FROM memories m JOIN family f ON m.supersedes_id=f.id UNION SELECT m.supersedes_id FROM memories m JOIN family f ON m.id=f.id WHERE m.supersedes_id IS NOT NULL) SELECT m.* FROM memories m JOIN family f ON m.id=f.id WHERE COALESCE(m.project_id,'')=COALESCE(?,'')`
  ).all(id,original.project_id??null);
  const ids=rows.map(row=>String(row.id));
  commitMemoryMutation({ ids, expected:new Map(rows.map(row=>[String(row.id),memoryRevision(row)])),kind:'forgotten' },()=>{
    for(const row of rows){
      const memoryId=String(row.id),at=nowIso();
      database.prepare('INSERT OR REPLACE INTO memory_forgetting(memory_id,scope_key,fact_key,content_hash,cutoff_order,created_at) VALUES(?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM memory_observations),?)')
        .run(memoryId,String(row.project_id??''),String(row.fact_key??''),memoryContentHash(String(row.content)),at);
      database.prepare("UPDATE memories SET status='invalidated',content='[已遗忘]',source_excerpt=NULL,details_json='{}',invalidated_at=?,updated_at=? WHERE id=?").run(at,at,memoryId);
      database.prepare("UPDATE memory_sources SET excerpt='' WHERE memory_id=?").run(memoryId);
      if(row.source_type==='onboarding'&&row.source_id)database.prepare('DELETE FROM user_profile WHERE field_key=?').run(String(row.source_id));
      database.prepare("DELETE FROM user_profile WHERE field_key IN (SELECT source_id FROM memory_sources WHERE memory_id=? AND source_type='onboarding')").run(memoryId);
      database.prepare('DELETE FROM memory_reflections WHERE EXISTS(SELECT 1 FROM json_each(memory_reflections.source_ids_json) WHERE value=?)').run(memoryId);
      database.prepare("UPDATE memory_history SET snapshot_json='{}' WHERE memory_id=?").run(memoryId);
    }
  });
  return {forgotten:true,memoryId:id,forgottenVersions:ids.length,originalConversationDeleted:false};
}
