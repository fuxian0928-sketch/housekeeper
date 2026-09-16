import { database, nowIso } from '../../db.js';

function httpError(message: string, statusCode: number) { return Object.assign(new Error(message), { statusCode }); }

function mapConversation(row: Record<string, unknown>) {
  return { id: row.id, title: row.title, scope: row.scope_type, projectId: row.project_id, projectName: row.project_name ?? null, compressedAt: row.compressed_at, messageCount: Number(row.message_count ?? 0), preview: String(row.preview ?? ''), createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listConversations(input: { scope?: string; projectId?: string | null }) {
  const scope = input.scope === 'all' ? 'all' : input.scope === 'memory' ? 'memory' : 'project';
  if (scope === 'project' && !input.projectId) throw httpError('请选择项目后再查看对话历史。', 400);
  if (scope === 'all') {
    const rows = database.prepare(`SELECT c.id, c.title, c.scope_type, c.project_id, c.created_at, c.updated_at, c.compressed_at, p.name AS project_name, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count, (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview FROM conversations c LEFT JOIN projects p ON p.id = c.project_id ORDER BY c.updated_at DESC LIMIT 200`).all() as Array<Record<string, unknown>>;
    return rows.map(mapConversation);
  }
  const rows = database.prepare(`SELECT c.id, c.title, c.scope_type, c.project_id, c.created_at, c.updated_at, c.compressed_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count, (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview FROM conversations c WHERE c.scope_type = ? AND ((? = 'memory' AND c.project_id IS NULL) OR (? = 'project' AND c.project_id = ?)) ORDER BY c.updated_at DESC LIMIT 30`).all(scope, scope, scope, input.projectId ?? null) as Array<Record<string, unknown>>;
  return rows.map(mapConversation);
}

export function getConversation(id: string) {
  const conversation = database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!conversation) throw httpError('这段对话不存在。', 404);
  const messages = database.prepare(`SELECT m.role, m.content, m.citations_json, m.created_at, s.id AS suggestion_id, s.suggestion_type, s.payload_json, s.status AS suggestion_status FROM messages m LEFT JOIN message_suggestions s ON s.message_id = m.id WHERE m.conversation_id = ? ORDER BY m.created_at, m.rowid`).all(id) as Array<Record<string, unknown>>;
  return { id: conversation.id, title: conversation.title, scope: conversation.scope_type, projectId: conversation.project_id, compressedAt: conversation.compressed_at, messages: messages.map((message) => {
    let payload: Record<string, unknown> | null = null; let citations: unknown[] = [];
    try { payload = message.payload_json ? JSON.parse(String(message.payload_json)) as Record<string, unknown> : null; } catch { payload = null; }
    try { citations = JSON.parse(String(message.citations_json ?? '[]')) as unknown[]; } catch { citations = []; }
    return { role: message.role, content: message.content, citations, memorySuggestion: message.suggestion_type === 'memory' ? payload : null, taskSuggestion: message.suggestion_type === 'task' ? payload : null, taskBatchSuggestion: message.suggestion_type === 'task_batch' ? payload : null, suggestionId: message.suggestion_id, suggestionSaved: message.suggestion_status === 'applied', createdAt: message.created_at };
  }) };
}

export function renameConversation(id: string, title: unknown) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw httpError('对话名称需要填写 1～120 个字符。', 400);
  const result = database.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.trim(), id);
  if (!result.changes) throw httpError('这段对话不存在。', 404);
  return { id, title: title.trim() };
}

export function deleteConversation(id: string) {
  const result = database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  if (!result.changes) throw httpError('这段对话不存在。', 404);
  return { id, deleted: true };
}

export function compressionTranscript(id: string) {
  if (!database.prepare('SELECT id FROM conversations WHERE id = ?').get(id)) throw httpError('这段对话不存在。', 404);
  const messages = database.prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`).all(id) as Array<{ role: string; content: string }>;
  if (messages.length < 2) throw httpError('至少完成一轮问答后才能压缩。', 400);
  return { messages, transcript: messages.map((item) => `${item.role === 'user' ? '用户' : 'AI 秘书'}：${item.content}`).join('\n\n') };
}

export function saveCompression(id: string, summary: string, messageCount: number) {
  const compressedAt = nowIso();
  database.prepare('UPDATE conversations SET compressed_summary = ?, compressed_at = ?, updated_at = ? WHERE id = ?').run(summary, compressedAt, compressedAt, id);
  return { summary, compressedAt, originalMessageCount: messageCount };
}
