import { database, nowIso } from '../../db.js';
import { getAssistantPersona } from './assistant-persona.js';
import { selectCharacterLore,xiweiCharacterCanon } from './assistant-character-canon.js';
import { memoryTokens,memoryFtsQuery } from './memory-tokenizer.js';
import { memoryRevision } from './memory-ledger.js';
import { observationEvidence, evidenceRevision } from './memory-evidence.js';
import { safeMemoryText } from './work-memory.js';
import {projectedProfileRows} from './user-profile-projection.js';

/** Bounded, synchronous projection from authoritative rows; never invokes a model. */
export function learnedContext(query:string,projectId:string|null){
  const at=nowIso(),tokens=memoryTokens(query);
  const scope='(m.project_id IS NULL OR m.project_id=?)';
  const rows=database.prepare(`SELECT m.* FROM memories m LEFT JOIN projects p ON p.id=m.project_id WHERE ${scope}
    AND (m.project_id IS NULL OR p.deleted_at IS NULL AND p.id IS NOT NULL) AND m.status='confirmed'
    AND (m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_until IS NULL OR m.valid_until>=?)
    ORDER BY m.importance DESC,m.updated_at DESC LIMIT 160`).all(projectId,at,at);
  const match=memoryFtsQuery(query);
  if(match)try{
    const matched=database.prepare(`SELECT m.* FROM memories m LEFT JOIN projects p ON p.id=m.project_id WHERE ${scope}
      AND (m.project_id IS NULL OR p.deleted_at IS NULL AND p.id IS NOT NULL) AND m.status='confirmed'
      AND (m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_until IS NULL OR m.valid_until>=?)
      AND m.id IN (SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 80)`).all(projectId,at,at,match);
    const seen=new Set(rows.map(row=>row.id));for(const row of matched)if(!seen.has(row.id)){rows.push(row);seen.add(row.id);}
  }catch{/* The bounded local projection remains available if FTS is unavailable. */}
  const score=(row:Record<string,unknown>)=>tokens.reduce((n,token)=>n+(String(row.content).normalize('NFKC').toLowerCase().includes(token)?1:0),0);
  const view=(row:Record<string,unknown>)=>({id:String(row.id),content:safeMemoryText(row.content,700),projectId:row.project_id??null,revision:memoryRevision(row),sourceId:row.source_id,subject:row.subject_key,attribute:row.attribute_key,validFrom:row.valid_from,details:JSON.parse(String(row.details_json??'{}'))});
  const personal=rows.filter(row=>row.project_id===null&&['preference','work_style','user_profile'].includes(String(row.memory_type)))
    .sort((a,b)=>score(b)-score(a)||Number(b.importance)-Number(a.importance)).slice(0,12);
  const experiences=rows.filter(row=>row.memory_type==='experience'&&score(row)>0).sort((a,b)=>score(b)-score(a)).slice(0,4);
  const methods=rows.filter(row=>['lesson','procedure'].includes(String(row.memory_type))&&score(row)>0).sort((a,b)=>score(b)-score(a)).slice(0,4);
  const openPlans=rows.filter(row=>row.memory_type==='plan'&&score(row)>0).sort((a,b)=>score(b)-score(a)).slice(0,4);
  const historicalFacts=/(?:以前|之前|原来|曾经|变化|变过|过去|上次)/.test(query)?database.prepare(`SELECT h.*,m.project_id FROM memory_history h JOIN memories m ON m.id=h.memory_id
    WHERE (m.project_id IS NULL OR m.project_id=? AND EXISTS(SELECT 1 FROM projects p WHERE p.id=m.project_id AND p.deleted_at IS NULL)) AND NOT EXISTS(SELECT 1 FROM memory_forgetting f WHERE f.memory_id=m.id)
    AND (m.status='superseded' OR h.revision<m.memory_revision) ORDER BY h.recorded_at DESC LIMIT 80`).all(projectId).map(row=>{
      const snapshot=JSON.parse(String(row.snapshot_json));
      return {id:String(row.memory_id),revision:Number(row.revision),content:safeMemoryText(snapshot.content,700),validFrom:snapshot.valid_from??null,recordedAt:row.recorded_at,historical:true,knownToHaveBeenCorrected:!!database.prepare("SELECT 1 FROM memory_history WHERE memory_id=? AND change_kind='corrected'").get(String(row.memory_id))};
    }).filter(row=>tokens.some(token=>row.content.toLowerCase().includes(token))).slice(0,4):[];
  const recentStatements: Array<{sourceId:string;content:string;occurredAt:string;verification:string}>=[];
  const forgottenThrough=Number(database.prepare('SELECT COALESCE(MAX(cutoff_order),0) AS n FROM memory_forgetting WHERE scope_key IN (?,?)').get('',projectId??'')?.n);
  for(const observation of database.prepare(`SELECT rowid AS observation_order,* FROM memory_observations WHERE source_type IN ('conversation','onboarding') AND (project_id IS NULL OR project_id=?) AND rowid>? AND created_at>=? ORDER BY rowid DESC LIMIT 6`).all(projectId,forgottenThrough,new Date(Date.now()-30*60_000).toISOString())){
    const evidence=observationEvidence(observation),meta=JSON.parse(String(observation.metadata_json));
    if(meta.sourceEvidenceRevision&&meta.sourceEvidenceRevision!==evidenceRevision(evidence))continue;
    for(const source of evidence.filter(item=>item.kind==='user_statement')){
      // A forgotten source remains in chat history, but is not implicitly reinjected as memory.
      if(database.prepare('SELECT 1 FROM memory_forgetting f JOIN memories m ON m.id=f.memory_id WHERE m.source_id=?').get(source.id))continue;
      if(recentStatements.some(item=>item.sourceId===source.id))continue;
      recentStatements.push({sourceId:source.id,content:safeMemoryText(source.text,500),occurredAt:source.occurredAt,verification:'recent-user-statement-not-execution-proof'});
    }
  }
  const assistantPersona=getAssistantPersona();
  const characterLore=assistantPersona.profile.fictionalBackground?.canonVersion===xiweiCharacterCanon.version?selectCharacterLore(query):null;
  return{
    assistantPersona,...(characterLore?{characterLore}:{}),userProfile:{facts:personal.map(view),introduction:projectedProfileRows().map(row=>({field:row.field_label,value:safeMemoryText(row.value,600),updatedAt:row.updated_at})),revision:database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()?.revision},
    experiences:experiences.map(view),learnedMethods:methods.map(view),openPlans:openPlans.map(view),historicalFacts,recentStatements,
    rules:'人设保持稳定；assistantPersona.fictionalBackground与characterLore都是虚构设定，不能写成用户画像或真实共同经历。角色故事不等于真实记忆；不得凭故事补写用户信息或离线活动。画像、经历和方法必须按来源及适用条件使用。openPlans只是计划，不代表已经执行或完成。近期原话用于理解尚未整理的纠正，不代表已执行；临时感受不升级为性格。不要生硬复述画像。已失效的方法和事实不得作为当前依据。'
  };
}
