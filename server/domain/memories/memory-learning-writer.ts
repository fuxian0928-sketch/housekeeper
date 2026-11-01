import { createHash, randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import { assertMemoryJobOwner } from './memory-jobs.js';
import { commitMemoryMutation, forgottenMemory, memoryFactKey, memoryRevision, readMemoryRecord } from './memory-ledger.js';
import { evidenceRevision, observationEvidence, type MemoryEvidence } from './memory-evidence.js';
import { assessMemoryClaim, type ExtractedMemory } from './memory-learning-policy.js';
import { safeMemoryText } from './work-memory.js';

export type LearningSnapshot = { revisions: Record<string,string>; evidence: MemoryEvidence[]; evidenceRevision: string; observationHash: string };
const types = new Set(['user_profile','preference','work_style','capability','project_fact','project_decision','product_principle','technical_constraint','project_state','lesson','procedure','fact','other','experience','plan']);
const enabled = (key: string) => database.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value !== '0';
const conflict = () => Object.assign(new Error('记忆在整理期间已变化，需要重新比较当前版本。'), { code: 'MEMORY_VERSION_CONFLICT', statusCode: 409 });
const weight = (value: unknown) => Math.max(0,Math.min(1,Number.isFinite(Number(value))?Number(value):.8));

export function deferMemoryClaim(observationId: string, itemKey: string, item: ExtractedMemory, reason: string, temporary = false) {
  const effective = item.effectiveAt && Date.parse(item.effectiveAt) > Date.now() ? item.effectiveAt : null;
  database.prepare(`INSERT OR IGNORE INTO memory_pending_claims(id,observation_id,item_key,claim_json,reason,status,effective_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(),observationId,itemKey,JSON.stringify(item),reason,effective?'scheduled':'observing',effective,temporary?new Date(Date.now()+30*60_000).toISOString():null,nowIso());
}

export function applyAutomaticMemory(item: ExtractedMemory, observation: Record<string,unknown>, snapshot: LearningSnapshot, token: string): string | null {
  if (!item || typeof item.content!=='string' || !item.content.trim() || item.action === 'skip') return null;
  item={...item,...Object.fromEntries(['subject','attribute','facet'].filter(key=>typeof item[key as keyof ExtractedMemory]==='string').map(key=>[key,String(item[key as keyof ExtractedMemory]).normalize('NFKC').trim()]))};
  const serialized = JSON.stringify(item);
  if (safeMemoryText(serialized,16000) !== serialized) return null;
  const content = item.content!.trim().slice(0,1000), observationId = String(observation.id);
  const itemKey = createHash('sha256').update(JSON.stringify(item)).digest('hex');
  const previous = database.prepare('SELECT memory_id FROM memory_extraction_items WHERE observation_id=? AND item_key=?').get(observationId,itemKey);
  if (previous) return previous.memory_id ? String(previous.memory_id) : null;
  assertMemoryJobOwner(observationId,token);
  const currentObservation = database.prepare('SELECT rowid AS observation_order,* FROM memory_observations WHERE id=?').get(observationId)!;
  if (snapshot.observationHash !== currentObservation.content_hash || snapshot.evidenceRevision !== evidenceRevision(observationEvidence(currentObservation))) throw conflict();
  const order = Number(currentObservation.observation_order);
  let projectId = item.scope === 'global' ? null : observation.project_id as string | null;
  const entity=/^(project|task):(.+)$/.exec(typeof item.subject==='string'?item.subject:'');
  if(entity){
    const owner=entity[1]==='project'?database.prepare('SELECT id AS project_id FROM projects WHERE id=? AND deleted_at IS NULL').get(entity[2]):database.prepare('SELECT project_id FROM tasks WHERE id=?').get(entity[2]);
    if(!owner||item.scope==='global'||projectId&&projectId!==owner.project_id){deferMemoryClaim(observationId,itemKey,item,'对象不存在或不属于本次项目');return null;}
    projectId=String(owner.project_id);
  }
  if (projectId && !database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId)) return null;
  if(item.scope==='global'&&observation.project_id&&item.subject!=='user'&&!['lesson','procedure'].includes(item.memoryType??'')){
    deferMemoryClaim(observationId,itemKey,item,'项目资料不能自动扩散为全局事实');return null;
  }
  const assessment = assessMemoryClaim(item,snapshot.evidence);
  if (!assessment.ready) { deferMemoryClaim(observationId,itemKey,item,assessment.reason,assessment.temporary); return null; }
  const object=/^(task|project|document):(.+)$/.exec(item.subject??'');
  if(object&&/(?:actual_?status|execution_?status|(?:^|\.)status$|实际状态)/i.test(item.attribute??'')){
    const row=object[1]==='task'?database.prepare('SELECT status FROM tasks WHERE id=?').get(object[2]):object[1]==='project'?database.prepare('SELECT status FROM projects WHERE id=? AND deleted_at IS NULL').get(object[2]):null;
    if(!row||row.status!==item.value){deferMemoryClaim(observationId,itemKey,item,'与业务对象的真实当前状态不一致');return null;}
  }
  const factKey = item.subject && item.attribute ? memoryFactKey(projectId,item.subject,item.attribute,item.facet) : '';
  if (forgottenMemory({projectId,factKey,content,observationOrder:order})) return null;
  const autoConfirm = enabled('memory_auto_apply') && enabled('memory_auto_confirm');
  let target = item.targetMemoryId ? readMemoryRecord(item.targetMemoryId) : undefined;
  if (item.targetMemoryId && (!target || target.status !== 'confirmed' && target.status !== 'candidate')) return null;
  if (!target && factKey) target = database.prepare("SELECT * FROM memories WHERE fact_key=? AND status='confirmed' ORDER BY memory_revision DESC LIMIT 1").get(factKey);
  if (target && (target.project_id ?? null) !== projectId) { deferMemoryClaim(observationId,itemKey,item,'事实范围不匹配'); return null; }
  if (target?.fact_key && factKey && target.fact_key !== factKey) { deferMemoryClaim(observationId,itemKey,item,'更新的主体、属性或具体对象不一致'); return null; }
  if (target && snapshot.revisions[String(target.id)] !== memoryRevision(target)) throw conflict();
  if (target && Number(target.last_observation_order)>order) { deferMemoryClaim(observationId,itemKey,item,'较早来源晚到，保留为历史线索'); return null; }
  const currentBound=target?.valid_from??target?.source_occurred_at;
  const correcting=item.changeKind==='corrected'&&assessment.source?.kind==='user_statement';
  if (currentBound && item.effectiveAt && Date.parse(item.effectiveAt)<Date.parse(String(currentBound))&&!correcting) { deferMemoryClaim(observationId,itemKey,item,'来源描述的是旧状态'); return null; }
  if (item.effectiveAt && Date.parse(item.effectiveAt)>Date.now()) { deferMemoryClaim(observationId,itemKey,item,'等待生效时间'); return null; }
  if (item.validUntil && Date.parse(item.validUntil)<=Date.now()) { deferMemoryClaim(observationId,itemKey,item,'已过有效时间，保留为历史线索'); return null; }
  if (target && !['update','supersede'].includes(item.action ?? '') && target.content !== content) throw conflict();

  const exact = !target ? database.prepare("SELECT * FROM memories WHERE COALESCE(project_id,'')=COALESCE(?,'') AND content=? AND status IN ('confirmed','candidate') ORDER BY status='confirmed' DESC LIMIT 1").get(projectId,content) : undefined;
  if (exact) target = exact;
  const duplicate = target?.content === content;
  const updating = target && autoConfirm && (duplicate || item.action === 'update');
  const id = updating ? String(target!.id) : randomUUID();
  const memoryType=item.statementKind==='plan'?'plan':types.has(item.memoryType??'')?item.memoryType!:'other';
  const supersedesId = target?.status === 'confirmed' && item.action === 'supersede' && autoConfirm ? String(target.id) : null;
  const at = nowIso(), status = autoConfirm ? 'confirmed' : 'candidate';
  const sourceId=assessment.source?.id??String(observation.source_id??observationId);
  const newEvidence=target?.source_id!==sourceId&&!database.prepare('SELECT 1 FROM memory_sources WHERE memory_id=? AND source_id=?').get(id,sourceId);
  const expected = target ? new Map([[String(target.id),memoryRevision(target)]]) : undefined;
  commitMemoryMutation({ids:[id,...(supersedesId?[supersedesId]:[])],expected,kind:item.changeKind??(supersedesId?'changed':updating?'supplemented':'learned'),observationId},() => {
    assertMemoryJobOwner(observationId,token);
    if (!updating) database.prepare(`INSERT INTO memories(id,project_id,content,memory_type,status,source_label,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id,projectId,content,memoryType,status,String(observation.source_label),at,at);
    database.prepare(`UPDATE memories SET content=?,status=?,memory_type=?,scope_type=?,source_type=?,source_id=?,source_excerpt=?,confidence=?,importance=?,salience=?,
      origin='automatic',reason=?,fact_key=?,subject_key=?,attribute_key=?,details_json=?,last_observation_order=?,valid_from=?,valid_until=?,source_occurred_at=?,
      evidence_count=CASE WHEN ? THEN evidence_count+1 ELSE evidence_count END,confirmed_at=CASE WHEN ?='confirmed' THEN COALESCE(confirmed_at,?) ELSE confirmed_at END,
      last_verified_at=?,updated_at=?,supersedes_id=COALESCE(?,supersedes_id) WHERE id=?`)
      .run(content,status,memoryType,projectId?'project':'global',String(observation.source_type),sourceId,item.evidence?.quote??String(observation.content).slice(0,1000),weight(item.confidence),weight(item.importance),weight(item.importance),item.reason?.slice(0,500)??'',factKey||String(target?.fact_key??''),item.subject??String(target?.subject_key??''),item.attribute??String(target?.attribute_key??''),JSON.stringify({value:item.value,facet:item.facet,statementKind:item.statementKind,conditions:item.conditions,outcome:item.outcome,evidence:item.evidence}),order,item.effectiveAt??(updating?target?.valid_from??null:null),item.validUntil??null,assessment.source?.occurredAt??String(observation.created_at),updating&&newEvidence?1:0,status,at,at,at,supersedesId,id);
    if (supersedesId) database.prepare("UPDATE memories SET status='superseded',invalidated_at=?,valid_until=COALESCE(?,valid_until),updated_at=? WHERE id=?").run(at,item.changeKind==='corrected'?null:item.effectiveAt??null,at,supersedesId);
    database.prepare(`INSERT OR IGNORE INTO memory_sources(memory_id,observation_id,source_type,source_id,source_label,excerpt,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id,observationId,String(observation.source_type),assessment.source?.id??String(observation.source_id??''),String(observation.source_label),item.evidence?.quote??String(observation.content).slice(0,1000),at);
    database.prepare('INSERT INTO memory_extraction_items(observation_id,item_key,memory_id,created_at) VALUES(?,?,?,?)').run(observationId,itemKey,id,at);
  });
  for(const changed of [id,...(supersedesId?[supersedesId]:[])]) snapshot.revisions[changed]=memoryRevision(readMemoryRecord(changed)!);
  return id;
}
