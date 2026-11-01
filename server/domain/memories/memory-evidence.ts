import { createHash } from 'node:crypto';
import { database } from '../../db.js';
import {safeMemoryText} from './work-memory.js';

export type MemoryEvidence = { id: string; kind: 'user_statement' | 'document' | 'business_event' | 'tool_result' | 'derived'; text: string; occurredAt: string; revision: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function observationEvidence(observation: Record<string, unknown>): MemoryEvidence[] {
  const metadata = JSON.parse(String(observation.metadata_json ?? '{}')) as Record<string, unknown>;
  const sourceId = String(observation.source_id ?? observation.id), occurredAt = String(observation.created_at);
  const result: MemoryEvidence[] = [];
  const excerpt=(text:string)=>text.slice(Number(metadata.partOffset)||0,(Number(metadata.partOffset)||0)+14000);
  const push = (id: string, kind: MemoryEvidence['kind'], text: string, at = occurredAt, version?: unknown) => result.push({ id, kind, text:safeMemoryText(text,16000), occurredAt: at, revision: hash([id, text, version]) });
  if (metadata.maintenance) { push(sourceId, 'derived', String(observation.content)); return result; }
  if (metadata.runId) {
    const run = database.prepare('SELECT * FROM agent_runs WHERE id=?').get(String(metadata.runId));
    if (!run) return [];
    const message = database.prepare("SELECT * FROM messages WHERE id=? AND role='user'").get(String(run.user_message_id));
    if (message) push(String(message.id), 'user_statement', excerpt(String(message.content)), String(message.created_at),hash(message.content));
    for (const call of database.prepare("SELECT id,tool_name,status,result_json,error_message,updated_at FROM agent_invocations WHERE run_id=? ORDER BY rowid DESC LIMIT 12").all(String(run.id))) {
      push(String(call.id), 'tool_result', JSON.stringify(call), String(call.updated_at));
    }
    push(`run:${run.id}`, 'business_event', JSON.stringify({ runId: run.id, goal: run.goal, status: run.status }), String(run.updated_at));
    return result;
  }
  if (observation.source_type === 'document') {
    const document = database.prepare('SELECT * FROM knowledge_documents WHERE id=?').get(String(metadata.documentId ?? sourceId));
    if (!document) return [];
    push(String(document.id), 'document', excerpt(String(document.content)), String(document.modified_at),[document.modified_at,hash(document.content)]);
    return result;
  }
  if (observation.source_type === 'conversation') {
    const message = database.prepare('SELECT rowid AS ordinal,* FROM messages WHERE id=?').get(sourceId);
    if (message) {
      const user = message.role === 'user' ? message : database.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND rowid<? ORDER BY rowid DESC LIMIT 1").get(String(message.conversation_id), Number(message.ordinal));
      if (user) push(String(user.id), 'user_statement', excerpt(String(user.content)), String(user.created_at),hash(user.content));
      return result;
    }
    // Compatibility for imported observations: assistant statements are never evidence.
    const userText = String(observation.content).replace(/^用户[：:]\s*/, '').split(/\n(?:AI 秘书|希微|助手|assistant)[：:]/i)[0];
    push(sourceId, 'user_statement', userText);
    return result;
  }
  if (observation.source_type === 'onboarding') {
    const profile = database.prepare('SELECT value,updated_at FROM user_profile WHERE field_key=?').get(sourceId);
    push(sourceId, 'user_statement', profile ? String(profile.value) : String(observation.content), occurredAt, profile?.updated_at);
    return result;
  }
  push(sourceId, observation.source_type === 'manual' ? 'user_statement' : 'business_event', String(observation.content));
  return result;
}
export const evidenceRevision = (evidence: MemoryEvidence[]) => hash(evidence.map(item => [item.id, item.revision]));
