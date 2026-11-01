import { mutateMemoryIndex } from './memory-index-mutation.js';
import { randomUUID } from 'node:crypto';
import { database, nowIso, sqliteVecAvailable } from '../../db.js';
import type { EmbeddingProvider } from '../../providers/embedding-provider.js';
import { completeProposal } from '../../actions/proposal-service.js';
import { commitMemoryMutation, memoryRevision, syncMemoryLexicalIndex } from './memory-ledger.js';
import { memoryTokens, memoryFtsQuery } from './memory-tokenizer.js';
import {safeMemoryText} from './work-memory.js';
import {projectedProfileRows} from './user-profile-projection.js';

export type MemoryRow = Record<string, unknown> & { id: string; content: string; project_id: string | null };
const memoryStatuses = new Set(['candidate', 'confirmed', 'superseded', 'invalidated', 'rejected']);
const memoryTypes = new Set(['user_profile', 'preference', 'work_style', 'capability', 'project_fact', 'project_decision', 'project_state', 'procedure', 'decision', 'lesson', 'fact', 'other', 'product_principle', 'technical_constraint', 'product_decision','experience','plan']);

export function mapMemory(row: Record<string, unknown>) {
  return { id: row.id, projectId: row.project_id, projectName: row.project_name, content: row.content, memoryType: row.memory_type, status: row.status, sourceLabel: row.source_label, scopeType: row.scope_type, sourceType: row.source_type, sourceId: row.source_id, sourceExcerpt: row.source_excerpt, validFrom: row.valid_from, validUntil: row.valid_until, supersedesId: row.supersedes_id, contradictsIds: JSON.parse(String(row.contradicts_json ?? '[]')), origin: row.origin ?? 'manual', reason: row.reason ?? '', confidence: Number(row.confidence ?? 1), importance: Number(row.importance ?? row.salience ?? 0.5), evidenceCount: Number(row.evidence_count ?? 1), tags: JSON.parse(String(row.tags_json ?? '[]')), lastVerifiedAt: row.last_verified_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at, revision: memoryRevision(row), factKey: row.fact_key ?? '', subject: row.subject_key ?? '', attribute: row.attribute_key ?? '' };
}

export function listMemories(filters: { status?: string | null; projectId?: string | null }) {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (filters.status && filters.status !== 'all') { conditions.push('m.status = ?'); parameters.push(filters.status); }
  if (filters.projectId) { conditions.push('m.project_id = ?'); parameters.push(filters.projectId); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return (database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id${where} ORDER BY CASE m.status WHEN 'candidate' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, m.updated_at DESC`).all(...parameters) as Array<Record<string, unknown>>).map(mapMemory);
}

export function listMemorySources(memoryId: string) {
  if (!database.prepare(`SELECT id FROM memories WHERE id = ?`).get(memoryId)) throw httpError('记忆不存在。', 404);
  return database.prepare(`
    SELECT source_type AS sourceType, source_id AS sourceId, source_label AS sourceLabel,
      excerpt, created_at AS createdAt
    FROM memory_sources WHERE memory_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(memoryId);
}

export interface MemoryProjectOverview {
  projectId: string;
  projectName: string;
  memoryCount: number;
  summary: string;
  updatedAt: string | null;
}

export interface MemoryOverview {
  totalCount: number;
  projectSummaries: MemoryProjectOverview[];
  personalSummary: { summary: string; memoryCount: number; updatedAt: string | null };
  generatedAt: string;
}

function readableProjectSummary(project: { summary: string; summary_json: string | null }, memoryContents: string[]) {
  if (project.summary_json) {
    try {
      const value = JSON.parse(project.summary_json) as { narrative?: unknown; headline?: unknown; currentStage?: unknown };
      const narrative = typeof value.narrative === 'string' ? value.narrative.trim() : '';
      const headline = typeof value.headline === 'string' ? value.headline.trim() : '';
      const stage = typeof value.currentStage === 'string' ? value.currentStage.trim() : '';
      if (narrative) return narrative.slice(0, 260);
      if (headline) return `${stage ? `当前处于${stage}。` : ''}${headline}`.slice(0, 260);
    } catch {
      // Older summary rows may contain malformed JSON; fall through to preserved project data.
    }
  }
  if (project.summary.trim()) return project.summary.trim().slice(0, 260);
  if (memoryContents.length) return memoryContents.slice(0, 3).join('；').slice(0, 260);
  return 'AI 还在从这个项目的对话、资料和任务中积累信息。';
}

export function getMemoryOverview(projectId?: string | null): MemoryOverview {
  const timestamp = nowIso();
  const validCondition = `status = 'confirmed' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?)`;
  const total = database.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${validCondition}`).get(timestamp, timestamp) as { count: number };
  const projectConditions = projectId ? 'AND p.id = ?' : '';
  const projectParameters = projectId ? [timestamp, timestamp, projectId] : [timestamp, timestamp];
  const projects = database.prepare(`
    SELECT p.id, p.name, p.summary,
      COUNT(m.id) AS memory_count,
      MAX(m.updated_at) AS memory_updated_at,
      (SELECT summary_json FROM project_summary_versions v WHERE v.project_id = p.id ORDER BY v.created_at DESC LIMIT 1) AS summary_json
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id AND m.status = 'confirmed'
      AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until >= ?)
    WHERE p.deleted_at IS NULL ${projectConditions}
    GROUP BY p.id
    ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.updated_at DESC
  `).all(...projectParameters) as Array<{ id: string; name: string; summary: string; summary_json: string | null; memory_count: number; memory_updated_at: string | null }>;

  const projectSummaries = projects.map((project) => {
    const memories = database.prepare(`SELECT content FROM memories WHERE project_id = ? AND ${validCondition} ORDER BY importance DESC, updated_at DESC LIMIT 3`).all(project.id, timestamp, timestamp) as Array<{ content: string }>;
    return {
      projectId: project.id,
      projectName: project.name,
      memoryCount: Number(project.memory_count),
      summary: readableProjectSummary(project, memories.map((memory) => memory.content)),
      updatedAt: project.memory_updated_at
    };
  });

  const profileRows = projectedProfileRows().filter(row=>String(row.value).trim()).map(row=>({field_label:String(row.field_label),value:String(row.value),updated_at:String(row.updated_at)}));
  const personalMemories = database.prepare(`
    SELECT content, updated_at FROM memories
    WHERE project_id IS NULL AND ${validCondition}
      AND memory_type IN ('user_profile', 'preference', 'work_style', 'capability')
    ORDER BY importance DESC, confidence DESC, updated_at DESC LIMIT 8
  `).all(timestamp, timestamp) as Array<{ content: string; updated_at: string }>;
  const personalCount = database.prepare(`
    SELECT COUNT(*) AS count FROM memories
    WHERE project_id IS NULL AND ${validCondition}
      AND memory_type IN ('user_profile', 'preference', 'work_style', 'capability')
  `).get(timestamp, timestamp) as { count: number };
  const personalParts = [
    ...profileRows.map((row) => `${row.field_label}：${row.value}`),
    ...personalMemories.map((memory) => memory.content)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const personalSummary = personalParts.length
    ? personalParts.slice(0, 8).join('；').slice(0, 600)
    : 'AI 还在了解你的偏好、工作方式和长期习惯。';
  const personalUpdatedAt = [...profileRows.map((row) => row.updated_at), ...personalMemories.map((memory) => memory.updated_at)].sort().at(-1) ?? null;

  return {
    totalCount: total.count,
    projectSummaries,
    personalSummary: { summary: personalSummary, memoryCount: personalCount.count, updatedAt: personalUpdatedAt },
    generatedAt: timestamp
  };
}

export interface CreateMemoryInput {
  content?: string; projectId?: string | null; memoryType?: string; sourceLabel?: string; sourceType?: string; sourceId?: string | null; sourceExcerpt?: string;
  validFrom?: string | null; validUntil?: string | null; supersedesId?: string | null; contradictsIds?: string[]; allowRelated?: boolean; suggestionId?: string | null; expectedRevision?: string;
}

function httpError(message: string, statusCode: number, details: Record<string, unknown> = {}) { return Object.assign(new Error(message), { statusCode, ...details }); }

export async function createMemory(input: CreateMemoryInput, provider?: EmbeddingProvider | null, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const content = input.content?.trim() ?? '';
  const memoryType = input.memoryType ?? 'other';
  const sourceLabel = input.sourceLabel?.trim() || '对话记忆';
  if (!content || content.length > 1000 || sourceLabel.length > 200) throw httpError('记忆内容不能为空且最多 1000 字，来源最多 200 字。', 400);
  if(safeMemoryText(content,1000)!==content)throw httpError('敏感凭证不能保存为长期记忆。',400);
  if (!memoryTypes.has(memoryType)) throw httpError('记忆类型不可用。', 400);
  if (input.projectId && !database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`).get(input.projectId)) throw httpError('关联项目不存在。', 404);
  if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) throw httpError('记忆的生效时间不能晚于失效时间。', 400);
  if(input.supersedesId&&input.validFrom&&Date.parse(input.validFrom)>Date.now())throw httpError('未来变更应先作为计划保存，当前记忆未被提前替换。',409);
  const replaced = input.supersedesId ? database.prepare(`SELECT * FROM memories WHERE id = ? AND status = 'confirmed'`).get(input.supersedesId) : undefined;
  if (input.supersedesId && (!replaced || (replaced.project_id ?? null) !== (input.projectId ?? null))) throw httpError('要替代的旧记忆不存在、未确认或不属于同一范围。', 409);
  if (input.expectedRevision && (!replaced || input.expectedRevision !== memoryRevision(replaced))) throw httpError('旧记忆已经变化，请重新读取后替换。',409);
  const findDuplicate = () => database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE COALESCE(m.project_id, '') = COALESCE(?, '') AND lower(trim(m.content)) = lower(trim(?)) AND m.status NOT IN ('invalidated', 'rejected', 'superseded') ORDER BY m.status = 'confirmed' DESC LIMIT 1`).get(input.projectId ?? null, content);
  const confirmDuplicate = (duplicate: Record<string, unknown>) => {
    const target = input.supersedesId !== duplicate.id ? input.supersedesId : null;
    if (duplicate.status === 'confirmed' && !target) return { memory: mapMemory(duplicate), created: false, relatedMemories: [] };
    const timestamp = nowIso();
    const expected = new Map([[String(duplicate.id),memoryRevision(duplicate)]]);
    if (target && replaced) expected.set(target,memoryRevision(replaced));
    commitMemoryMutation({ids:[String(duplicate.id),...(target?[target]:[])],expected,kind:target?'replaced':'confirmed'},() => {
      database.prepare(`UPDATE memories SET status='confirmed', confirmed_at=COALESCE(confirmed_at,?), supersedes_id=COALESCE(?,supersedes_id), memory_type=?, updated_at=? WHERE id=?`).run(timestamp, target ?? null, memoryType, timestamp, String(duplicate.id));
      if (duplicate.status !== 'confirmed') database.prepare('UPDATE memories SET source_type=?,source_id=?,source_excerpt=?,source_label=? WHERE id=?').run(input.sourceType ?? 'manual', input.sourceId ?? null, input.sourceExcerpt?.slice(0, 1000) ?? null, sourceLabel, String(duplicate.id));
      if (target) {
        if(replaced?.fact_key)database.prepare('UPDATE memories SET fact_key=?,subject_key=?,attribute_key=?,details_json=? WHERE id=?').run(String(replaced.fact_key),String(replaced.subject_key),String(replaced.attribute_key),String(replaced.details_json),String(duplicate.id));
        const retired = database.prepare("UPDATE memories SET status='superseded',invalidated_at=?,updated_at=? WHERE id=? AND status='confirmed'").run(timestamp, timestamp, target);
        if (retired.changes !== 1) throw httpError('旧记忆已变化，本次替换未保存。', 409);
        syncMemorySearch(target);
      }
      syncMemorySearch(String(duplicate.id));
    });
    return { memory: mapMemory(database.prepare('SELECT m.*,p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id=m.project_id WHERE m.id=?').get(String(duplicate.id))!), created: false, relatedMemories: [] };
  };
  const duplicate = findDuplicate();
  if (duplicate) return confirmDuplicate(duplicate);
  const contradictsIds = Array.isArray(input.contradictsIds) ? [...new Set(input.contradictsIds.filter((id) => typeof id === 'string'))].slice(0, 20) : [];
  if (contradictsIds.length) {
    const placeholders = contradictsIds.map(() => '?').join(',');
    const relation = database.prepare(`SELECT COUNT(*) AS count FROM memories WHERE id IN (${placeholders}) AND COALESCE(project_id, '') = COALESCE(?, '') AND status = 'confirmed'`).get(...contradictsIds, input.projectId ?? null) as { count: number };
    if (relation.count !== contradictsIds.length) throw httpError('冲突记忆必须是同一范围内的已确认记忆。', 409);
  }
  const relatedMemories = await findRelatedMemories(content, input.projectId ?? null, provider, signal);
  signal?.throwIfAborted();
  if (replaced) {
    const current = database.prepare('SELECT status,content,updated_at FROM memories WHERE id=?').get(input.supersedesId!);
    if (!current || current.status !== 'confirmed' || current.content !== replaced.content || current.updated_at !== replaced.updated_at) throw httpError('旧记忆在整理期间已变化，请重新读取后替换。', 409);
  }
  // Another conversation may have saved this content while semantic matching yielded.
  const concurrentDuplicate = findDuplicate();
  if (concurrentDuplicate) return confirmDuplicate(concurrentDuplicate);
  const probableDuplicate = relatedMemories.find((item) => item.relation === 'probable_duplicate');
  if (probableDuplicate && !input.allowRelated && !input.supersedesId && !contradictsIds.length) {
    const existing = database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(probableDuplicate.id) as Record<string, unknown>;
    return { memory: mapMemory(existing), created: false, relatedMemories };
  }
  if (input.suggestionId) {
    const suggestion = database.prepare(`SELECT suggestion_type, payload_json, status FROM message_suggestions WHERE id = ?`).get(input.suggestionId) as { suggestion_type: string; payload_json: string; status: string } | undefined;
    const payload = suggestion ? JSON.parse(suggestion.payload_json) as { projectId?: string | null } : null;
    if (suggestion?.status === 'applied') {
      const proposal = database.prepare(`SELECT result_json FROM action_proposals WHERE id = ? AND status = 'succeeded'`).get(input.suggestionId) as { result_json: string | null } | undefined;
      const result = proposal?.result_json ? JSON.parse(proposal.result_json) as { memoryId?: string } : null;
      const existing = result?.memoryId ? database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(result.memoryId) as Record<string, unknown> | undefined : undefined;
      if (existing) return { memory: mapMemory(existing), created: false, relatedMemories: [] };
    }
    if (!suggestion || suggestion.suggestion_type !== 'memory' || suggestion.status !== 'pending' || (payload?.projectId ?? null) !== (input.projectId ?? null)) throw httpError('这条记忆建议已处理或不属于当前范围。', 409);
  }
  const id = randomUUID();
  const timestamp = nowIso();
  commitMemoryMutation({ids:[id,...(input.supersedesId?[input.supersedesId]:[])],expected:replaced?new Map([[input.supersedesId!,memoryRevision(replaced)]]):undefined,kind:input.supersedesId?'replaced':'created'},() => {
    database.prepare(`INSERT INTO memories (id, project_id, content, memory_type, status, source_label, scope_type, source_type, source_id, source_excerpt, valid_from, valid_until, supersedes_id, contradicts_json, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId ?? null, content, memoryType, sourceLabel, input.projectId ? 'project' : 'global', input.sourceType ?? (input.suggestionId ? 'conversation' : 'manual'), input.sourceId ?? input.suggestionId ?? null, input.sourceExcerpt?.slice(0, 1000) ?? null, input.validFrom ?? null, input.validUntil ?? null, input.supersedesId ?? null, JSON.stringify(contradictsIds), timestamp, timestamp, timestamp);
    if(replaced?.fact_key)database.prepare('UPDATE memories SET fact_key=?,subject_key=?,attribute_key=?,details_json=?,last_observation_order=(SELECT COALESCE(MAX(rowid),0)+1 FROM memory_observations) WHERE id=?').run(String(replaced.fact_key),String(replaced.subject_key),String(replaced.attribute_key),JSON.stringify({explicitReplacement:true}),id);
    syncMemorySearch(id);
    if (input.supersedesId) {
      const retired = database.prepare("UPDATE memories SET status='superseded',invalidated_at=?,updated_at=? WHERE id=? AND status='confirmed'").run(timestamp,timestamp,input.supersedesId);
      if (retired.changes !== 1) throw httpError('旧记忆已变化，本次替换未保存。',409);
      syncMemorySearch(input.supersedesId);
    }
    if (input.suggestionId) {
      database.prepare(`UPDATE message_suggestions SET status = 'applied', updated_at = ? WHERE id = ? AND status = 'pending'`).run(timestamp, input.suggestionId);
      completeProposal(input.suggestionId, { memoryId: id, projectId: input.projectId ?? null });
    }
    if (input.projectId) database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, source_id, created_at) VALUES (?, ?, 'memory_auto_confirmed', 'memory', ?, '已自动记住', ?, ?, ?, ?)`).run(randomUUID(), input.projectId, id, content.slice(0, 120), input.suggestionId ? 'action_proposal' : 'user', input.suggestionId ?? null, timestamp);
  });
  const row = database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(id) as Record<string, unknown>;
  return { memory: mapMemory(row), created: true, relatedMemories };
}

export function updateMemory(id: string, body: { content?: string; status?: string; memoryType?: string; validFrom?: string | null; validUntil?: string | null; expectedRevision?: string }) {
  const existing = database.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!existing) throw httpError('记忆不存在。', 404);
  if(body.expectedRevision&&body.expectedRevision!==memoryRevision(existing))throw httpError('记忆已经变化，请重新读取。',409);
  const content = (body.content ?? String(existing.content)).trim();
  const status = body.status ?? String(existing.status);
  const memoryType = body.memoryType ?? String(existing.memory_type);
  const validFrom = body.validFrom === undefined ? (existing.valid_from as string | null) : body.validFrom;
  const validUntil = body.validUntil === undefined ? (existing.valid_until as string | null) : body.validUntil;
  if (!content || content.length > 1000 || !memoryStatuses.has(status) || !memoryTypes.has(memoryType) || (validFrom && validUntil && validFrom > validUntil)) throw httpError('请检查记忆内容、状态、类型和有效期。', 400);
  if(safeMemoryText(content,1000)!==content)throw httpError('敏感凭证不能保存为长期记忆。',400);
  const timestamp = nowIso();
  const confirmedAt = status === 'confirmed' ? (typeof existing.confirmed_at === 'string' ? existing.confirmed_at : timestamp) : existing.confirmed_at;
  const invalidatedAt = ['invalidated', 'rejected', 'superseded'].includes(status) ? timestamp : null;
  commitMemoryMutation({ids:[id,...(typeof existing.supersedes_id==='string'?[existing.supersedes_id]:[])],expected:new Map([[id,memoryRevision(existing)]]),kind:status==='invalidated'?'invalidated':'edited'},() => {
    database.prepare(`UPDATE memories SET content = ?, status = ?, memory_type = ?, valid_from = ?, valid_until = ?, confirmed_at = ?, invalidated_at = ?, updated_at = ? WHERE id = ?`).run(content, status, memoryType, validFrom, validUntil, confirmedAt as string | null, invalidatedAt, timestamp, id);
    if (status === 'confirmed' && typeof existing.supersedes_id === 'string') {
      database.prepare(`UPDATE memories SET status = 'superseded', invalidated_at = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'`).run(timestamp, timestamp, existing.supersedes_id);
      syncMemorySearch(existing.supersedes_id);
    }
    syncMemorySearch(id);
    if (existing.project_id && status !== existing.status) database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, created_at) VALUES (?, ?, 'memory_status', 'memory', ?, '记忆状态已更新', ?, 'user', ?)`).run(randomUUID(), String(existing.project_id), id, `${String(existing.status)} → ${status}`, timestamp);
  });
  return { ...mapMemory(database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(id) as Record<string, unknown>), updatedAt: timestamp };
}

function terms(value: string) {
  return memoryTokens(value);
}

function cosine(left: number[], right: number[]) {
  let dot = 0;
  let leftSize = 0;
  let rightSize = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftSize += left[index] ** 2;
    rightSize += right[index] ** 2;
  }
  return leftSize && rightSize ? dot / Math.sqrt(leftSize * rightSize) : 0;
}

export function lexicalSimilarity(left: string, right: string) {
  const a = new Set(terms(left));
  const b = new Set(terms(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function ftsQuery(value: string) {
  return memoryFtsQuery(value);
}

export function syncMemorySearch(memoryId: string) {
  syncMemoryLexicalIndex(memoryId);
}

export function memoryEmbeddingProfile(provider:EmbeddingProvider){return JSON.stringify([provider.model,provider.dimension,provider.version,provider.profileId??'']);}
export function memoryVectorStatus(provider?:EmbeddingProvider|null){
  const profile=String(database.prepare("SELECT value FROM app_settings WHERE key='memory_vector_profile'").get()?.value??'');
  const count=sqliteVecAvailable?Number(database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n??0):0;
  return{count,compatible:!!provider&&profile===memoryEmbeddingProfile(provider),buildPending:!!database.prepare("SELECT value FROM app_settings WHERE key='memory_vector_build_id' AND value<>''").get()};
}
function setVectorSetting(key:string,value:string){database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,value,nowIso());}

export async function rebuildMemorySemanticIndex(provider: EmbeddingProvider, signal?: AbortSignal, onProgress?: (current: number, total: number) => void) {
  signal?.throwIfAborted();
  if (!sqliteVecAvailable) throw new Error('当前环境无法加载 sqlite-vec。');
  const rows = database.prepare(`SELECT id, content, memory_type, source_label FROM memories WHERE status = 'confirmed' ORDER BY updated_at DESC`).all() as Array<{ id: string; content: string; memory_type: string; source_label: string }>;
  const buildId=randomUUID(),profile=memoryEmbeddingProfile(provider);let indexed=0;
  const checkOwner=()=>{signal?.throwIfAborted();if(database.prepare("SELECT value FROM app_settings WHERE key='memory_vector_build_id'").get()?.value!==buildId)throw new Error('记忆索引已由更新的任务接管，旧结果未写入。');};
  mutateMemoryIndex(() => { database.exec('DELETE FROM memory_vectors');setVectorSetting('memory_vector_profile',profile);setVectorSetting('memory_vector_build_id',buildId); });
  const insert = database.prepare(`INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)`);
  try{
  for (let offset = 0; offset < rows.length; offset += 16) {
    checkOwner();
    const batch = rows.slice(offset, offset + 16);
    const vectors = await provider.embed(batch.map((row) => `${row.memory_type}\n${row.content}\n来源：${row.source_label}`), signal);
    checkOwner();
    database.exec('BEGIN');
    try {
      mutateMemoryIndex(() => { batch.forEach((row,index)=>{
        const current=database.prepare("SELECT content,memory_type,source_label FROM memories WHERE id=? AND status='confirmed'").get(row.id);
        if(!current||current.content!==row.content||current.memory_type!==row.memory_type||current.source_label!==row.source_label)return;
        if(!Array.isArray(vectors[index])||vectors[index].length!==provider.dimension||vectors[index].some(value=>!Number.isFinite(value)))throw new Error('记忆向量维度或数值无效。');
        database.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(row.id);insert.run(row.id,JSON.stringify(vectors[index]));indexed++;
      }); });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    onProgress?.(Math.min(offset + batch.length, rows.length), rows.length);
  }
  return { memories: indexed, considered:rows.length, model: provider.model, dimension: provider.dimension, version: provider.version };
  }finally{database.prepare("DELETE FROM app_settings WHERE key='memory_vector_build_id' AND value=?").run(buildId);}
}

export async function indexSingleMemory(memoryId: string, provider?: EmbeddingProvider | null, signal?: AbortSignal) {
  if (!provider || !sqliteVecAvailable) return false;
  const row = database.prepare(`SELECT content, memory_type, source_label,memory_revision FROM memories WHERE id = ? AND status = 'confirmed'`).get(memoryId) as { content: string; memory_type: string; source_label: string;memory_revision:number } | undefined;
  if (!row) return false;
  const beforeProfile=String(database.prepare("SELECT value FROM app_settings WHERE key='memory_vector_profile'").get()?.value??''),profile=memoryEmbeddingProfile(provider);
  const [vector] = await provider.embed([`${row.memory_type}\n${row.content}\n来源：${row.source_label}`], signal);
  signal?.throwIfAborted();
  const current=database.prepare("SELECT content,memory_type,source_label,memory_revision FROM memories WHERE id=? AND status='confirmed'").get(memoryId);
  if(!current||current.memory_revision!==row.memory_revision||current.content!==row.content||current.memory_type!==row.memory_type||current.source_label!==row.source_label)return false;
  const afterProfile=String(database.prepare("SELECT value FROM app_settings WHERE key='memory_vector_profile'").get()?.value??'');
  if(afterProfile!==beforeProfile&&afterProfile!==profile)return false;
  if(afterProfile!==profile&&Number(database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n??0)>0)return false;
  if(!Array.isArray(vector)||vector.length!==provider.dimension||vector.some(value=>!Number.isFinite(value)))throw new Error('记忆向量维度或数值无效。');
  mutateMemoryIndex(() => {
    if(afterProfile!==profile)setVectorSetting('memory_vector_profile',profile);
    database.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memoryId);
    database.prepare(`INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)`).run(memoryId, JSON.stringify(vector));
  });
  return true;
}

export async function searchRelevantMemories(query: string, projectId: string, provider?: EmbeddingProvider | null, limit = 8, signal?: AbortSignal, options: { trackAccess?: boolean } = {}) {
  signal?.throwIfAborted();
  const timestamp = nowIso();
  const readEligible = (at: string) => database.prepare(`
    SELECT m.*, p.name AS project_name
    FROM memories m LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'confirmed' AND (m.project_id IS NULL OR (m.project_id = ? AND p.id IS NOT NULL AND p.deleted_at IS NULL))
      AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until >= ?)
  `).all(projectId, at, at) as MemoryRow[];
  const eligible = readEligible(timestamp);
  const ranks = new Map<string, number>();
  const queryTerms = terms(query);
  const lexical = eligible.map((row) => ({
    row,
    score: queryTerms.reduce((score, term) => score + (String(row.content).toLowerCase().includes(term) ? 1 : 0), 0) + (row.project_id === projectId ? 2 : 0) + Number(row.salience ?? 0)
  })).sort((a, b) => b.score - a.score);
  lexical.forEach((item, index) => ranks.set(item.row.id, (ranks.get(item.row.id) ?? 0) + 1 / (60 + index + 1)));

  const match = ftsQuery(query);
  if (match) {
    try {
      const fts = database.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 30`).all(match) as Array<{ memory_id: string }>;
      fts.forEach((row, index) => ranks.set(row.memory_id, (ranks.get(row.memory_id) ?? 0) + 1 / (60 + index + 1)));
    } catch { /* The lexical branch still provides a deterministic fallback. */ }
  }

  if (provider && sqliteVecAvailable && (!provider.profileId || memoryVectorStatus(provider).compatible)) {
    const count = database.prepare(`SELECT COUNT(*) AS count FROM memory_vectors`).get() as { count: number };
    if (count.count) {
      const [vector] = await provider.embed([query], signal);
      signal?.throwIfAborted();
      if(!Array.isArray(vector)||vector.length!==provider.dimension||vector.some(value=>!Number.isFinite(value)))throw new Error('记忆向量维度或数值无效。');
      if(!provider.profileId||memoryVectorStatus(provider).compatible){
        const currentCount=Number(database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n??0);
        if(currentCount){
          const dense = database.prepare(`SELECT memory_id FROM memory_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance`).all(JSON.stringify(vector), Math.min(Math.max(limit * 4, 30), currentCount)) as Array<{ memory_id: string }>;
          dense.forEach((row, index) => ranks.set(row.memory_id, (ranks.get(row.memory_id) ?? 0) + 1 / (60 + index + 1)));
        }
      }
    }
  }
  signal?.throwIfAborted();
  const current = readEligible(nowIso());
  const allowed = new Set(current.map((row) => row.id));
  const byId = new Map(current.map((row) => [row.id, row]));
  const selected = [...ranks.entries()].filter(([id]) => allowed.has(id)).sort((a, b) => b[1] - a[1]).slice(0, limit).flatMap(([id]) => byId.get(id) ? [byId.get(id)!] : []);
  if (selected.length && options.trackAccess !== false) {
    const placeholders = selected.map(() => '?').join(',');
    database.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`).run(timestamp, ...selected.map((row) => row.id));
  }
  return selected;
}

export function getCoreMemorySnapshot(projectId?: string | null, limit = 18) {
  const timestamp = nowIso();
  return database.prepare(`
    SELECT m.*, p.name AS project_name
    FROM memories m LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'confirmed' AND (m.project_id IS NULL OR (m.project_id = ? AND p.id IS NOT NULL AND p.deleted_at IS NULL))
      AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until >= ?)
      AND (m.memory_type IN ('user_profile', 'preference', 'work_style', 'capability', 'project_decision', 'product_principle', 'technical_constraint', 'procedure') OR m.importance >= 0.78)
    ORDER BY CASE WHEN m.memory_type IN ('user_profile', 'preference', 'work_style') THEN 0 WHEN m.project_id = ? THEN 1 ELSE 2 END,
      m.importance DESC, m.confidence DESC, m.updated_at DESC LIMIT ?
  `).all(projectId ?? null, timestamp, timestamp, projectId ?? null, limit) as MemoryRow[];
}

export async function findRelatedMemories(content: string, projectId: string | null, provider?: EmbeddingProvider | null, signal?: AbortSignal) {
  const candidates = database.prepare(`
    SELECT id, content, memory_type, status, source_label, project_id
    FROM memories WHERE COALESCE(project_id, '') = COALESCE(?, '') AND status NOT IN ('invalidated', 'rejected', 'superseded')
    ORDER BY updated_at DESC LIMIT 50
  `).all(projectId) as MemoryRow[];
  let semantic: number[] = [];
  if (provider && candidates.length) {
    const vectors = await provider.embed([content, ...candidates.map((row) => row.content)], signal);
    semantic = candidates.map((_row, index) => cosine(vectors[0], vectors[index + 1]));
  }
  return candidates.map((row, index) => {
    const lexical = lexicalSimilarity(content, row.content);
    const semanticScore = semantic[index] ?? 0;
    return { id: row.id, content: row.content, status: row.status, memoryType: row.memory_type, sourceLabel: row.source_label, similarity: Math.max(lexical, semanticScore), relation: Math.max(lexical, semanticScore) >= 0.82 ? 'probable_duplicate' : 'related' };
  }).filter((item) => item.similarity >= 0.45).sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}
