import { createHash } from 'node:crypto';
import { database, nowIso } from '../db.js';
import { actionProposalRepository } from '../storage/repositories/action-proposal-repository.js';

export interface CreateProposalInput {
  id: string;
  conversationId?: string | null;
  messageId?: string | null;
  actionType: string;
  targetType: string;
  targetId?: string | null;
  targetPath?: string | null;
  payload: unknown;
  reason?: string;
  sourceRefs?: unknown[];
  riskLevel?: 'low' | 'medium' | 'high';
  originalHash?: string | null;
}

export function proposalKey(input: Pick<CreateProposalInput, 'conversationId' | 'messageId' | 'actionType' | 'targetId' | 'targetPath' | 'payload'>) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createProposal(input: CreateProposalInput) {
  const timestamp = nowIso();
  actionProposalRepository.insert([input.id, input.conversationId ?? null, input.messageId ?? null, input.actionType, input.targetType, input.targetId ?? null, input.targetPath ?? null, JSON.stringify(input.payload), input.reason ?? '', JSON.stringify(input.sourceRefs ?? []), input.riskLevel ?? 'low', proposalKey(input), input.originalHash ?? null, timestamp, timestamp]);
}

export function completeProposal(id: string, result: unknown) {
  const timestamp = nowIso();
  const update = actionProposalRepository.complete(id, JSON.stringify(result), timestamp);
  if (!update.changes) {
    const existing = actionProposalRepository.find(id);
    if (existing?.status === 'succeeded') return existing.result_json ? JSON.parse(existing.result_json) : result;
  }
  return result;
}

export function cancelProposal(id: string, status: 'cancelled' | 'superseded' = 'cancelled') {
  actionProposalRepository.cancel(id, status, nowIso());
}
