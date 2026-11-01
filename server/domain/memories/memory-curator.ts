import { createHash, randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import type { EmbeddingProvider } from '../../providers/embedding-provider.js';
import { indexSingleMemory } from './memory-service.js';
import { assertMemoryJobOwner, claimMemoryJob, failMemoryJob, keepMemoryJobAlive, memoryJobMaxAttempts, recoverExpiredMemoryJobs } from './memory-jobs.js';
import { memoryRevision, memoryFactKey } from './memory-ledger.js';
import { evidenceRevision, observationEvidence } from './memory-evidence.js';
import { MEMORY_EXTRACTION_INSTRUCTION, assessMemoryClaim,type ExtractedMemory } from './memory-learning-policy.js';
import { applyAutomaticMemory, type LearningSnapshot } from './memory-learning-writer.js';
import {isSimpleGreeting} from './work-memory.js';
import {beginBackgroundMemory,foregroundMemoryBusy,awaitMemoryWork} from './memory-priority.js';
import {projectedProfileRows} from './user-profile-projection.js';

export type ObservationSource = 'conversation' | 'document' | 'task' | 'project' | 'event' | 'onboarding' | 'manual';

export interface MemoryObservationInput {
  projectId?: string | null;
  sourceType: ObservationSource;
  sourceId?: string | null;
  sourceLabel: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export type CuratorCompletion = (input: string, options: { instruction: string; maxTokens: number; signal?:AbortSignal }) => Promise<string>;



function parseJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? text).trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('记忆管家没有返回有效 JSON。');
  return JSON.parse(source.slice(start, end + 1)) as { memories?: ExtractedMemory[]; reflection?: string };
}

function settingEnabled(key: string, fallback = true) {
  const row = database.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value === '1' : fallback;
}

function weeklyBucket() {
  const date = new Date();
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function observationDedupeKey(input: MemoryObservationInput) {
  if (input.sourceType !== 'event' || input.metadata?.maintenance) return '';
  const eventType = String(input.metadata?.eventType ?? 'event');
  const objectType = String(input.metadata?.objectType ?? 'unknown');
  return `${input.projectId ?? 'global'}:${eventType}:${objectType}:${String(input.metadata?.objectId??'')}:${weeklyBucket()}`;
}

function linkObservationSource(observationId: string, sourceType: string, sourceId?: string | null) {
  if (!sourceId) return;
  database.prepare(`INSERT OR IGNORE INTO memory_observation_sources (observation_id, source_type, source_id, created_at) VALUES (?, ?, ?, ?)`).run(observationId, sourceType, sourceId, nowIso());
}

function redactSecrets(value: string) {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g, '[已隐藏敏感凭证]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[:=：]\s*)[^\s,，;；]{6,}/gi, '$1[已隐藏敏感凭证]');
}

export function recordMemoryObservation(input: MemoryObservationInput): string | null {
  if(input.content.length>16000){
    let first:string|null=null;
    for(let offset=0;offset<input.content.length;offset+=14000){
      const id=recordMemoryObservation({...input,content:input.content.slice(offset,offset+14000),metadata:{...input.metadata,partOffset:offset,documentId:input.metadata?.documentId??(input.sourceType==='document'?input.sourceId:undefined)}});
      first??=id;
    }
    return first;
  }
  const content = redactSecrets(input.content).trim();
  if(input.sourceType==='conversation'&&isSimpleGreeting(content.replace(/^用户[：:]\s*/,'').split(/\n(?:AI 秘书|希微|助手)[：:]/)[0]))return null;
  if (!content || !settingEnabled('memory_auto_capture')) return null;
  if (input.sourceType === 'document' && !settingEnabled('memory_document_capture')) return null;
  if (['task', 'project', 'event'].includes(input.sourceType) && !settingEnabled('memory_behavior_capture')) return null;
  const contentHash = createHash('sha256').update(`${input.projectId ?? ''}\n${input.sourceId ?? ''}\n${content}`).digest('hex');
  const dedupeKey = observationDedupeKey(input);
  const id = randomUUID();
  const timestamp = nowIso();
  const metadata={...input.metadata};
  const sourceEvidence=observationEvidence({id,project_id:input.projectId??null,source_type:input.sourceType,source_id:input.sourceId??null,content,created_at:timestamp,metadata_json:JSON.stringify(metadata)});
  metadata.sourceEvidenceRevision=evidenceRevision(sourceEvidence);
  if (dedupeKey) {
    const pending = database.prepare(`SELECT id, content, metadata_json, source_ids_json, occurrence_count FROM memory_observations WHERE dedupe_key = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`).get(dedupeKey) as { id: string; content: string; metadata_json: string; source_ids_json: string; occurrence_count: number } | undefined;
    if (pending) {
      let sourceIds: string[] = [];
      try { sourceIds = JSON.parse(pending.source_ids_json) as string[]; } catch { sourceIds = []; }
      if (input.sourceId && !sourceIds.includes(input.sourceId)) sourceIds.push(input.sourceId);
      const merged = `${pending.content}\n\n--- 同类行为 ${pending.occurrence_count + 1} ---\n${content}`.slice(-16000);
      database.prepare(`UPDATE memory_observations SET content = ?,content_hash=?, metadata_json = ?, source_ids_json = ?, occurrence_count = occurrence_count + 1,extraction_json=NULL,context_snapshot_json='{}' WHERE id = ?`).run(merged,createHash('sha256').update(merged).digest('hex'),JSON.stringify({ ...(JSON.parse(pending.metadata_json) as Record<string, unknown>), groupedBehavior: true }), JSON.stringify(sourceIds.slice(-200)), pending.id);
      const grouped=database.prepare('SELECT * FROM memory_observations WHERE id=?').get(pending.id)!;
      const groupedMetadata=JSON.parse(String(grouped.metadata_json));groupedMetadata.sourceEvidenceRevision=evidenceRevision(observationEvidence(grouped));
      database.prepare('UPDATE memory_observations SET metadata_json=? WHERE id=?').run(JSON.stringify(groupedMetadata),pending.id);
      linkObservationSource(pending.id, input.sourceType, input.sourceId);
      return pending.id;
    }
  }
  const result = database.prepare(`
    INSERT OR IGNORE INTO memory_observations
      (id, project_id, source_type, source_id, source_label, content, metadata_json, content_hash, status, created_at, dedupe_key, occurrence_count, source_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?)
  `).run(id, input.projectId ?? null, input.sourceType, input.sourceId ?? null, input.sourceLabel.slice(0, 200), content, JSON.stringify(metadata), contentHash, timestamp, dedupeKey, JSON.stringify(input.sourceId ? [input.sourceId] : []));
  if (result.changes) linkObservationSource(id, input.sourceType, input.sourceId);
  return result.changes ? id : null;
}

function nearbyMemoryContext(projectId: string | null) {
  const rows = database.prepare(`
    SELECT *
    FROM memories
    WHERE status IN ('confirmed', 'candidate') AND (project_id = ? OR project_id IS NULL)
    ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, importance DESC, updated_at DESC LIMIT 80
  `).all(projectId, projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id, scope: row.project_id ? 'project' : 'global', type: row.memory_type,
    status: row.status, content: row.content, confidence: row.confidence, importance: row.importance,
    revision:memoryRevision(row),subject:row.subject_key,attribute:row.attribute_key,factKey:row.fact_key,
    details:JSON.parse(String(row.details_json??'{}')),validFrom:row.valid_from
  }));
}


function persistExtracted(item: ExtractedMemory, observation: Record<string, unknown>, snapshot: LearningSnapshot, token: string) {
  return applyAutomaticMemory(item, observation, snapshot, token);
}

export async function curateObservation(observationId: string, complete: CuratorCompletion) {
  const observation = database.prepare('SELECT * FROM memory_observations WHERE id=?').get(observationId) as Record<string,unknown> | undefined;
  if (!observation || observation.status !== 'pending' || !settingEnabled('memory_auto_capture')) return { processed:false, memories:[] as string[] };
  if(foregroundMemoryBusy())return{processed:false,memories:[] as string[]};
  const token = claimMemoryJob(observationId);
  if (!token) return { processed:false, memories:[] as string[] };
  const stopHeartbeat = keepMemoryJobAlive(observationId,token);
  const work=beginBackgroundMemory();
  const completeBounded:CuratorCompletion=(input,options)=>awaitMemoryWork(signal=>complete(input,{...options,signal}),AbortSignal.any([work.signal,AbortSignal.timeout(30_000)]));
  try {
    const context = nearbyMemoryContext(observation.project_id as string|null);
    let snapshot = JSON.parse(String(observation.context_snapshot_json ?? '{}')) as LearningSnapshot;
    if (!snapshot.evidenceRevision) {
      const evidence = observationEvidence(observation);
      const metadata=JSON.parse(String(observation.metadata_json??'{}'));
      if(metadata.sourceEvidenceRevision&&metadata.sourceEvidenceRevision!==evidenceRevision(evidence)){
        database.prepare("UPDATE memory_observations SET status='processed',processed_at=?,error_message='来源已改变，旧观察未写入',lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?").run(nowIso(),observationId,token);
        return {processed:true,memories:[] as string[]};
      }
      snapshot = { revisions:Object.fromEntries(context.map(row=>[String(row.id),String(row.revision)])), evidence, evidenceRevision:evidenceRevision(evidence), observationHash:String(observation.content_hash) };
      database.prepare('UPDATE memory_observations SET context_snapshot_json=? WHERE id=? AND lease_token=?').run(JSON.stringify(snapshot),observationId,token);
    }
    let result = observation.extraction_json ? parseJson(String(observation.extraction_json)) : parseJson(await completeBounded(JSON.stringify({
      observation:{ id:observationId,projectId:observation.project_id,sourceType:observation.source_type,sourceLabel:observation.source_label,occurredAt:observation.created_at,timeZone:'Asia/Hong_Kong',content:observation.content,metadata:JSON.parse(String(observation.metadata_json)) },
      evidence:snapshot.evidence, existingMemories:context
    }), {instruction:MEMORY_EXTRACTION_INSTRUCTION,maxTokens:3500,signal:work.signal}));
    work.signal.throwIfAborted();
    if (!Array.isArray(result.memories)) throw new Error('记忆提取结果缺少 memories 数组，稍后自动重试。');
    assertMemoryJobOwner(observationId,token);
    // Only genuinely conflicting same-key candidates get a second model call.
    const conflicts = result.memories.filter(item=>item&&item.action==='add'&&assessMemoryClaim(item,snapshot.evidence).ready).flatMap(item=>{
      const key=memoryFactKey(item.scope==='global'?null:observation.project_id as string|null,item.subject!,item.attribute!,item.facet);
      const current=database.prepare("SELECT * FROM memories WHERE fact_key=? AND status='confirmed' LIMIT 1").get(key);
      return current&&current.content!==item.content?[{candidate:item,current}]:[];
    });
    if (conflicts.length) {
      const reviewed = parseJson(await completeBounded(JSON.stringify({evidence:snapshot.evidence,conflicts}),{
        instruction:MEMORY_EXTRACTION_INSTRUCTION+'\n本次仅复核conflicts内的候选，返回对应memories；相同事实选择update/supersede/skip，复用current的ID、主体和属性，保留本次真实来源，不产生额外记忆。',
        maxTokens:2500,signal:work.signal
      }));
      if (!Array.isArray(reviewed.memories)||reviewed.memories.length!==conflicts.length) throw new Error('记忆冲突复核未完成，稍后重试。');
      const reviewedItems=reviewed.memories;
      for(let i=0;i<conflicts.length;i++){
        const {candidate,current}=conflicts[i],item=reviewedItems[i];
        if(item.action!=='skip'&&(!['update','supersede'].includes(item.action??'')||item.targetMemoryId!==current.id||item.subject!==candidate.subject||item.attribute!==candidate.attribute||item.facet!==candidate.facet||item.scope!==candidate.scope)) throw new Error('记忆冲突复核的对象不一致。');
        if(snapshot.revisions[String(current.id)]&&snapshot.revisions[String(current.id)]!==memoryRevision(current)) throw Object.assign(new Error('记忆在整理期间已变化。'),{code:'MEMORY_VERSION_CONFLICT'});
        snapshot.revisions[String(current.id)]=memoryRevision(current);
      }
      result={...result,memories:result.memories!.map(item=>{const index=conflicts.findIndex(value=>value.candidate===item);return index<0?item:reviewedItems[index];})};
    }
    assertMemoryJobOwner(observationId,token);
    work.signal.throwIfAborted();
    database.prepare('UPDATE memory_observations SET extraction_json=?,context_snapshot_json=? WHERE id=? AND lease_token=?').run(JSON.stringify(result),JSON.stringify(snapshot),observationId,token);
    const memoryIds:string[]=[];
    for(const item of result.memories!.slice(0,12)){
      const id=persistExtracted(item,observation,snapshot,token);
      if(id)memoryIds.push(id);
    }
    assertMemoryJobOwner(observationId,token);
    database.prepare("UPDATE memory_observations SET status='processed',processed_at=?,error_message=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL WHERE id=? AND lease_token=?").run(nowIso(),observationId,token);
    return {processed:true,memories:memoryIds};
  } catch(error) {
    if(work.signal.aborted&&(work.signal.reason as {code?:string}).code==='MEMORY_FOREGROUND_PREEMPTED'){
      database.prepare("UPDATE memory_observations SET status='pending',attempt_count=MAX(0,attempt_count-1),lease_token=NULL,lease_expires_at=NULL,next_attempt_at=? WHERE id=? AND lease_token=?").run(new Date(Date.now()+1000).toISOString(),observationId,token);
      return{processed:false,memories:[] as string[]};
    }
    if((error as {code?:string}).code==='MEMORY_VERSION_CONFLICT') database.prepare("UPDATE memory_observations SET extraction_json=NULL,context_snapshot_json='{}' WHERE id=? AND lease_token=?").run(observationId,token);
    failMemoryJob(observationId,token,error);
    throw error;
  } finally { stopHeartbeat();work.finish(); }
}

let processing = false;
export async function processMemoryIndexJobs(provider?:EmbeddingProvider|null,limit=4){
  if(!provider||foregroundMemoryBusy())return;
  for(const job of database.prepare("SELECT * FROM memory_index_jobs WHERE status='pending' AND (attempts<5 OR updated_at<?) ORDER BY updated_at LIMIT ?").all(new Date(Date.now()-20*60_000).toISOString(),limit)){
    const id=String(job.memory_id),revision=Number(job.target_revision);
    const current=database.prepare('SELECT status,memory_revision FROM memories WHERE id=?').get(id);
    if(!current||current.status!=='confirmed'){
      database.prepare("UPDATE memory_index_jobs SET status='done' WHERE memory_id=? AND target_revision=?").run(id,revision);continue;
    }
    const work=beginBackgroundMemory();
    try{
      if(foregroundMemoryBusy())break;
      database.prepare('UPDATE memory_index_jobs SET attempts=CASE WHEN attempts>=5 THEN 1 ELSE attempts+1 END,updated_at=? WHERE memory_id=? AND target_revision=?').run(nowIso(),id,revision);
      const indexed=await awaitMemoryWork(signal=>indexSingleMemory(id,provider,signal),AbortSignal.any([AbortSignal.timeout(2500),work.signal]));
      if(indexed)database.prepare("UPDATE memory_index_jobs SET status='done',updated_at=? WHERE memory_id=? AND target_revision=?").run(nowIso(),id,revision);
    }catch{if(work.signal.aborted)database.prepare('UPDATE memory_index_jobs SET attempts=MAX(0,attempts-1) WHERE memory_id=? AND target_revision=?').run(id,revision);}
    finally{work.finish();}
  }
}

function resumeScheduledClaims(){
  for(const row of database.prepare("SELECT DISTINCT observation_id FROM memory_pending_claims WHERE status='scheduled' AND effective_at<=?").all(nowIso())){
    database.prepare("UPDATE memory_observations SET status='pending',attempt_count=0,extraction_json=NULL,context_snapshot_json='{}',next_attempt_at=NULL WHERE id=? AND status='processed'").run(String(row.observation_id));
    database.prepare("UPDATE memory_pending_claims SET status='resumed' WHERE observation_id=? AND status='scheduled' AND effective_at<=?").run(String(row.observation_id),nowIso());
  }
  database.prepare("UPDATE memory_pending_claims SET status='expired' WHERE status='observing' AND expires_at<=?").run(nowIso());
}
export async function processPendingObservations(complete: CuratorCompletion, provider?: EmbeddingProvider | null, limit = 20) {
  if (processing) return { processed: 0, failed: 0, busy: true };
  if (!settingEnabled('memory_auto_capture')) {await processMemoryIndexJobs(provider);return { processed: 0, failed: 0, busy: false };}
  processing = true;
  let processed = 0;
  let failed = 0;
  try {
    recoverExpiredMemoryJobs();
    resumeScheduledClaims();
    const rows = database.prepare(`SELECT id FROM memory_observations WHERE status IN ('pending','failed') AND attempt_count<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT ?`).all(memoryJobMaxAttempts,nowIso(),limit) as Array<{ id: string }>;
    for (const row of rows) {
      if(foregroundMemoryBusy()||database.prepare("SELECT 1 FROM agent_runs WHERE status='running' AND lease_expires_at>? LIMIT 1").get(nowIso()))break;
      database.prepare(`UPDATE memory_observations SET status = 'pending' WHERE id = ? AND status = 'failed'`).run(row.id);
      try { const result = await curateObservation(row.id, complete); if (result.processed) processed += 1; } catch { failed += 1; }
    }
    await processMemoryIndexJobs(provider);
    return { processed, failed, busy: false };
  } finally { processing = false; }
}


export function captureUnobservedEvents() {
  const rows = database.prepare(`
    SELECT e.*, p.name AS project_name FROM events e
    LEFT JOIN projects p ON p.id = e.project_id
    WHERE e.source_type <> 'memory_curator' AND e.object_type <> 'memory'
      AND NOT EXISTS (SELECT 1 FROM memory_observation_sources os WHERE os.source_type = 'event' AND os.source_id = e.id)
    ORDER BY e.created_at LIMIT 200
  `).all() as Array<Record<string, unknown>>;
  let added = 0;
  for (const event of rows) {
    const objectContext = event.object_type === 'task' && event.object_id
      ? database.prepare(`SELECT title, description, status, priority, executor, due_at, completed_at FROM tasks WHERE id = ?`).get(String(event.object_id))
      : event.object_type === 'project' && event.object_id
        ? database.prepare(`SELECT name, summary, status, priority, source_path FROM projects WHERE id = ?`).get(String(event.object_id))
        : null;
    const id = recordMemoryObservation({
      projectId: event.project_id as string | null, sourceType: 'event', sourceId: String(event.id),
      sourceLabel: `项目行为 · ${String(event.title)}`,
      content: `项目：${String(event.project_name ?? '未知')}\n行为：${String(event.title)}\n详情：${String(event.detail ?? '')}\n对象当前信息：${JSON.stringify(objectContext ?? {})}\n时间：${String(event.created_at)}`,
      metadata: { eventType: event.event_type, objectType: event.object_type, objectId: event.object_id, objectContext }
    });
    if (id) added += 1;
  }
  return added;
}

export function listMemoryObservations(limit = 100) {
  return database.prepare(`SELECT id, project_id AS projectId, source_type AS sourceType, source_label AS sourceLabel, status, error_message AS errorMessage, created_at AS createdAt, processed_at AS processedAt FROM memory_observations ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function memoryLearningStatus() {
  const counts = database.prepare(`SELECT status, COUNT(*) AS count FROM memory_observations GROUP BY status`).all() as Array<{ status: string; count: number }>;
  const automatic = database.prepare(`SELECT COUNT(*) AS count FROM memories WHERE origin = 'automatic'`).get() as { count: number };
  const claims=database.prepare('SELECT status,COUNT(*) AS count FROM memory_pending_claims GROUP BY status').all();
  const indexes=database.prepare('SELECT status,COUNT(*) AS count FROM memory_index_jobs GROUP BY status').all();
  return { enabled: settingEnabled('memory_auto_capture'), autoApply: settingEnabled('memory_auto_apply'), observations: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])), automaticMemories: automatic.count,claims:Object.fromEntries(claims.map(row=>[String(row.status),Number(row.count)])),indexes:Object.fromEntries(indexes.map(row=>[String(row.status),Number(row.count)])),writer:'versioned-single-authority-v2' };
}

const profileFields = new Map([
  ['name', '称呼'], ['role', '岗位/角色'], ['responsibilities', '主要职责'], ['project_types', '常做的项目'],
  ['strengths', '擅长的事情'], ['work_style', '喜欢的工作方式'], ['communication_style', '沟通偏好'], ['long_term_goals', '长期目标'],
  ['food_preferences','饮食喜好与忌口'],['interests','兴趣'],['daily_habits','生活习惯']
]);

export function getUserProfile() {
  const rows = projectedProfileRows();
  const learned=database.prepare("SELECT * FROM memories WHERE project_id IS NULL AND status='confirmed' AND memory_type IN ('user_profile','preference','work_style') AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>=?) ORDER BY importance DESC,updated_at DESC LIMIT 80").all(nowIso(),nowIso());
  return { fields: rows.map((row) => ({ key: row.field_key, label: row.field_label, value: row.value, sourceType: row.source_type, updatedAt: row.updated_at })), availableFields: [...profileFields].map(([key, label]) => ({ key, label })),learnedFacts:learned.map(row=>({id:row.id,content:row.content,subject:row.subject_key,attribute:row.attribute_key,revision:memoryRevision(row),sourceId:row.source_id,updatedAt:row.updated_at})) };
}

export function updateUserProfile(values: Record<string, unknown>) {
  const timestamp = nowIso();
  const observations: string[] = [];
  database.exec('BEGIN');
  try {
    for (const [key, label] of profileFields) {
      if (values[key] === undefined) continue;
      const value = String(values[key] ?? '').trim().slice(0, 2000);
      if (!value) database.prepare(`DELETE FROM user_profile WHERE field_key = ?`).run(key);
      else database.prepare(`INSERT INTO user_profile (id, field_key, field_label, value, source_type, updated_at) VALUES (?, ?, ?, ?, 'onboarding', ?) ON CONFLICT(field_key) DO UPDATE SET value = excluded.value, source_type = 'onboarding', updated_at = excluded.updated_at`).run(randomUUID(), key, label, value, timestamp);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  for (const [key, label] of profileFields) {
    if (values[key] === undefined || !String(values[key] ?? '').trim()) continue;
    const id = recordMemoryObservation({ sourceType: 'onboarding', sourceId: key, sourceLabel: `用户介绍 · ${label}`, content: `${label}：${String(values[key]).trim()}`, metadata: { profileField: key } });
    if (id) observations.push(id);
  }
  return { ...getUserProfile(), observationIds: observations };
}
