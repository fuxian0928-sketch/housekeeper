import { database } from '../../db.js';

export type ActionProposalRow = Record<string, unknown> & { id: string; status: string; action_type: string; payload_json: string; result_json: string | null };

export const actionProposalRepository = {
  list(conversationId?: string | null) {
    return (conversationId
      ? database.prepare(`SELECT * FROM action_proposals WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 100`).all(conversationId)
      : database.prepare(`SELECT * FROM action_proposals ORDER BY created_at DESC LIMIT 100`).all()) as ActionProposalRow[];
  },
  find(id: string) {
    return database.prepare(`SELECT * FROM action_proposals WHERE id = ?`).get(id) as ActionProposalRow | undefined;
  },
  insert(values: unknown[]) {
    return database.prepare(`INSERT OR IGNORE INTO action_proposals (id, conversation_id, message_id, action_type, target_type, target_id, target_path, payload_json, reason, source_refs_json, risk_level, requires_confirmation, status, idempotency_key, original_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)`).run(...values as Parameters<ReturnType<typeof database.prepare>['run']>);
  },
  complete(id: string, resultJson: string, timestamp: string) {
    return database.prepare(`UPDATE action_proposals SET status = 'succeeded', confirmed_at = COALESCE(confirmed_at, ?), executed_at = ?, result_json = ?, error_message = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'edited', 'confirmed', 'executing')`).run(timestamp, timestamp, resultJson, timestamp, id);
  },
  cancel(id: string, status: 'cancelled' | 'superseded', timestamp: string) {
    return database.prepare(`UPDATE action_proposals SET status = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'edited')`).run(status, timestamp, id);
  }
};
