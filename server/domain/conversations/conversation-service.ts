import { database, nowIso } from '../../db.js';
import { createHash } from 'node:crypto';

function httpError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }

function mapConversation(row: Record<string, unknown>) {
  return { id: row.id, title: row.title, scope: row.scope_type, projectId: row.project_id, projectName: row.project_name ?? null, compressedAt: row.compressed_at, messageCount: Number(row.message_count ?? 0), preview: String(row.preview ?? ''), createdAt: row.created_at, updatedAt: row.updated_at, lastMessageAt: row.last_message_at ?? row.created_at };
}

export function listConversations(input: { scope?: string; projectId?: string | null }) {
  const scope = input.scope === 'all' ? 'all' : input.scope === 'memory' ? 'memory' : 'project';
  if (scope === 'project' && !input.projectId) throw httpError('请选择项目后再查看对话历史。', 400);
  if (scope === 'all') {
    const rows = database.prepare(`SELECT c.id, c.title, c.scope_type, c.project_id, c.created_at, c.updated_at, c.compressed_at, p.name AS project_name, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count, (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview, (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message_at FROM conversations c LEFT JOIN projects p ON p.id = c.project_id ORDER BY COALESCE(last_message_at, c.created_at) DESC, c.rowid DESC LIMIT 200`).all() as Array<Record<string, unknown>>;
    return rows.map(mapConversation);
  }
  const rows = database.prepare(`SELECT c.id, c.title, c.scope_type, c.project_id, c.created_at, c.updated_at, c.compressed_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count, (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview, (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message_at FROM conversations c WHERE c.scope_type = ? AND ((? = 'memory' AND c.project_id IS NULL) OR (? = 'project' AND c.project_id = ?)) ORDER BY COALESCE(last_message_at, c.created_at) DESC, c.rowid DESC LIMIT 30`).all(scope, scope, scope, input.projectId ?? null) as Array<Record<string, unknown>>;
  return rows.map(mapConversation);
}

export function getConversation(id: string) {
  const conversation = database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!conversation) throw httpError('这段对话不存在。', 404);
  const voice=conversation.project_id==='system-voice-conversations';
  const latestRun=voice?database.prepare('SELECT project_id FROM agent_runs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(id):null;
  const messages = database.prepare(`SELECT m.id, m.role, m.content, m.citations_json, m.created_at, m.run_id, s.id AS suggestion_id, s.suggestion_type, s.payload_json, s.status AS suggestion_status FROM messages m LEFT JOIN message_suggestions s ON s.message_id = m.id WHERE m.conversation_id = ? ORDER BY m.created_at, m.rowid`).all(id) as Array<Record<string, unknown>>;
  return { id: conversation.id, title: conversation.title, scope: conversation.scope_type, projectId: conversation.project_id,channel:voice?'voice':'text',businessProjectId:voice?(latestRun?.project_id??null):conversation.project_id, compressedAt: conversation.compressed_at, messages: messages.map((message) => {
    let payload: Record<string, unknown> | null = null; let citations: unknown[] = [];
    try { payload = message.payload_json ? JSON.parse(String(message.payload_json)) as Record<string, unknown> : null; } catch { payload = null; }
    try { citations = JSON.parse(String(message.citations_json ?? '[]')) as unknown[]; } catch { citations = []; }
    return { id: message.id, role: message.role, content: message.content, runId:message.run_id??null, citations, memorySuggestion: message.suggestion_type === 'memory' ? payload : null, taskSuggestion: message.suggestion_type === 'task' ? payload : null, taskBatchSuggestion: message.suggestion_type === 'task_batch' ? payload : null, suggestionId: message.suggestion_id, suggestionSaved: message.suggestion_status === 'applied', createdAt: message.created_at };
  }) };
}

export function renameConversation(id: string, title: unknown) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw httpError('对话名称需要填写 1～120 个字符。', 400);
  const result = database.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.trim(), id);
  if (!result.changes) throw httpError('这段对话不存在。', 404);
  return { id, title: title.trim() };
}

export function deleteConversation(id: string) {
  if(database.prepare("SELECT id FROM agent_runs WHERE conversation_id=? AND status IN ('running','waiting_approval','reconciling') LIMIT 1").get(id))throw httpError('这段对话还有执行中、待确认或待核实的事务，请先处理后再删除。',409);
  const result = database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  if (!result.changes) throw httpError('这段对话不存在。', 404);
  return { id, deleted: true };
}

type CompressionMessage = { seq: number; id: string; role: string; content: string; created_at: string };
export type CompressionSnapshot = { throughMessageId: string; throughSeq: number; revision: number; fingerprint: string; messageCount: number };
const compressionFingerprint = (messages: CompressionMessage[]) => createHash('sha256').update(JSON.stringify(messages)).digest('hex');

export function compressionTranscript(id: string) {
  const conversation = database.prepare('SELECT compression_revision FROM conversations WHERE id = ?').get(id) as { compression_revision: number } | undefined;
  if (!conversation) throw httpError('这段对话不存在。', 404);
  const messages = database.prepare(`SELECT rowid AS seq,id,role,content,created_at FROM messages WHERE conversation_id = ? ORDER BY rowid`).all(id) as CompressionMessage[];
  if (messages.length < 2) throw httpError('至少完成一轮问答后才能压缩。', 400);
  const last = messages.at(-1)!;
  const snapshot: CompressionSnapshot = { throughMessageId: last.id, throughSeq: last.seq, revision: conversation.compression_revision, fingerprint: compressionFingerprint(messages), messageCount: messages.length };
  return { messages, snapshot, transcript: messages.map((item) => `${item.role === 'user' ? '用户' : 'AI 秘书'}：${item.content}`).join('\n\n') };
}

export function saveCompression(id: string, summary: string, snapshot: CompressionSnapshot) {
  if (!summary.trim()) throw httpError('压缩结果为空，原对话已保留。', 400);
  const compressedAt = nowIso();
  database.exec('BEGIN IMMEDIATE');
  try {
    const messages = database.prepare('SELECT rowid AS seq,id,role,content,created_at FROM messages WHERE conversation_id=? AND rowid<=? ORDER BY rowid').all(id,snapshot.throughSeq) as CompressionMessage[];
    if (messages.at(-1)?.id !== snapshot.throughMessageId || compressionFingerprint(messages) !== snapshot.fingerprint) throw httpError('压缩期间原消息已改变，请重新压缩。',409);
    const result = database.prepare(`UPDATE conversations SET compressed_summary=?,compressed_at=?,updated_at=?,compressed_through_message_id=?,compression_revision=compression_revision+1 WHERE id=? AND compression_revision=?`).run(summary,compressedAt,compressedAt,snapshot.throughMessageId,id,snapshot.revision);
    if (!result.changes) throw httpError('这段对话已有较新的摘要，请重新读取。',409);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { summary, compressedAt, originalMessageCount: snapshot.messageCount };
}

/** A timestamp is presentation metadata, never evidence that a message was summarized. */
export function loadConversationHistory(id: string) {
  const boundary = database.prepare(`SELECT m.rowid AS seq FROM conversations c JOIN messages m ON m.id=c.compressed_through_message_id AND m.conversation_id=c.id WHERE c.id=?`).get(id) as { seq: number } | undefined;
  return database.prepare('SELECT id,role,content FROM messages WHERE conversation_id=? AND rowid>? ORDER BY created_at,rowid').all(id,boundary?.seq ?? 0) as Array<{id:string;role:string;content:string}>;
}
