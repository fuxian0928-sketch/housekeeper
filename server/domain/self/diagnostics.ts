import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { database } from '../../db.js';

export const selfRequestContext = new AsyncLocalStorage<{ requestId: string; conversationId: string | null; stage: string }>();
export function diagnosticErrorCode(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : '';
  if (/AbortError|cancelled|取消/i.test(text)) return 'cancelled';
  if (/Timeout|timed out|超时/i.test(text)) return 'timeout';
  if (/\b401\b|\b403\b|unauthorized/i.test(text)) return 'authentication';
  if (/\b429\b|rate.limit/i.test(text)) return 'rate_limit';
  if (/JSON|格式|结构/.test(text)) return 'invalid_response';
  return 'provider_or_service_error';
}
export function recordDiagnostic(stage: string, status: 'succeeded' | 'failed' | 'cancelled', elapsedMs: number, model: string | null, error?: unknown) {
  const context = selfRequestContext.getStore();
  if (!context) return;
  try {
    // Never persist prompts, response bodies, URLs, keys, raw exceptions or file paths.
    database.prepare('INSERT INTO self_diagnostics VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), context.requestId, context.conversationId, stage, status, model?.slice(0,256) ?? null, error ? diagnosticErrorCode(error) : null, Math.max(0, Math.round(elapsedMs)), new Date().toISOString());
    database.prepare("DELETE FROM self_diagnostics WHERE created_at < datetime('now','-14 days') OR id IN (SELECT id FROM self_diagnostics ORDER BY created_at DESC LIMIT -1 OFFSET 5000)").run();
  } catch { /* Diagnostics cannot break chat. */ }
}
export async function traceModel<T>(model: string, operation: () => Promise<T>) {
  const start = Date.now();
  const stage = selfRequestContext.getStore()?.stage ?? 'model';
  try { const result = await operation(); recordDiagnostic(stage, 'succeeded', Date.now()-start, model); return result; }
  catch(error) { recordDiagnostic(stage, diagnosticErrorCode(error)==='cancelled'?'cancelled':'failed', Date.now()-start, model, error); throw error; }
}
export function readDiagnostics(conversationId: string) {
  const events = database.prepare('SELECT id,request_id AS requestId,stage,status,model,error_code AS errorCode,elapsed_ms AS elapsedMs,created_at AS createdAt FROM self_diagnostics WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20').all(conversationId);
  const memory = database.prepare(`SELECT id,status,created_at AS createdAt,processed_at AS processedAt,error_message FROM memory_observations WHERE json_valid(metadata_json) AND json_extract(metadata_json,'$.conversationId')=? ORDER BY created_at DESC LIMIT 10`).all(conversationId).map(row => ({ id: row.id, status: row.status, createdAt: row.createdAt, processedAt: row.processedAt, errorCode: row.error_message ? diagnosticErrorCode(new Error(String(row.error_message))) : null,
    memories: database.prepare('SELECT m.id,m.status,m.memory_type AS type FROM memory_sources s JOIN memories m ON m.id=s.memory_id WHERE s.observation_id=? LIMIT 15').all(String(row.id)) }));
  const actions = database.prepare('SELECT id,action_type AS actionType,status,created_at AS createdAt,executed_at AS executedAt FROM action_proposals WHERE conversation_id=? ORDER BY created_at DESC LIMIT 10').all(conversationId);
  const skills = database.prepare('SELECT id,tool_name AS toolName,status,started_at AS startedAt,completed_at AS completedAt FROM skill_tool_executions WHERE conversation_id=? ORDER BY created_at DESC LIMIT 10').all(conversationId);
  return { events, memory, actions, skills, scope: 'current-conversation-only', retention: '诊断最多14天、5000条；http_transport_only只表示HTTP传输状态，不代表业务成功，应查看chat_result、actions和skills。旧记录未覆盖的阶段不能推断。没有观察不等于用户没有说过，没有保存项不等于提炼失败。' };
}
