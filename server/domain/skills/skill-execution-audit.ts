import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';

export type SkillExecutionStatus = 'running' | 'pending_confirmation' | 'succeeded' | 'failed' | 'cancelled';

export function startSkillExecution(input: {
  skillId: string | null;
  conversationId: string;
  proposalId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  permission: string;
  riskLevel: 'low' | 'medium' | 'high';
  status?: SkillExecutionStatus;
}) {
  const id = randomUUID();
  const timestamp = nowIso();
  database.prepare(`INSERT INTO skill_tool_executions
    (id,skill_id,conversation_id,proposal_id,tool_name,arguments_json,permission,risk_level,status,started_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.skillId, input.conversationId, input.proposalId ?? null, input.toolName,
      JSON.stringify(input.arguments), input.permission, input.riskLevel, input.status ?? 'running',
      input.status === 'pending_confirmation' ? null : timestamp, timestamp, timestamp
    );
  return id;
}

export function updateSkillExecution(id: string, status: SkillExecutionStatus, result?: unknown, error?: string) {
  const timestamp = nowIso();
  database.prepare(`UPDATE skill_tool_executions SET status=?, result_json=?, error_message=?,
    started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,
    completed_at=CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE completed_at END,
    updated_at=? WHERE id=?`).run(status, result === undefined ? null : JSON.stringify(result), error ?? null, status, timestamp, status, timestamp, timestamp, id);
}

export function findSkillExecutionByProposal(proposalId: string) {
  return database.prepare(`SELECT * FROM skill_tool_executions WHERE proposal_id=? ORDER BY created_at DESC LIMIT 1`).get(proposalId) as Record<string, unknown> | undefined;
}

export function listSkillExecutions(limit = 100) {
  return (database.prepare(`SELECT e.id,e.skill_id AS skillId,s.name AS skillName,e.conversation_id AS conversationId,e.proposal_id AS proposalId,
    e.tool_name AS toolName,e.permission,e.risk_level AS riskLevel,e.status,e.result_json AS resultJson,e.error_message AS errorMessage,
    e.started_at AS startedAt,e.completed_at AS completedAt,e.created_at AS createdAt,e.updated_at AS updatedAt
    FROM skill_tool_executions e LEFT JOIN managed_skills s ON s.id=e.skill_id ORDER BY e.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>).map((row) => ({
      ...row, result: row.resultJson ? JSON.parse(String(row.resultJson)) : null, resultJson: undefined
    }));
}
