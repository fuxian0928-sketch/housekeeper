/** Trusted orchestration metadata only. Labels, tool output and model reasoning
 * are intentionally absent from this wire contract. */
export const progressStages = ['model', 'retrieval', 'vision', 'verification', 'planning', 'execution'] as const;
export type ProgressStage = typeof progressStages[number];
export type VoiceProgressEvent = {
  type: 'voice-progress'; eventId: string; sessionId: string; turnId: string;
  sequence: number; operationId: string; planRevision: number; configRevision: number;
  stage: ProgressStage; status: 'running' | 'succeeded' | 'failed';
  occurredAt: number; expiresAt: number;
};
const stages: Record<string, ProgressStage> = {
  generate: 'model', retrieve: 'retrieval', 'project-retrieve': 'retrieval',
  'literature-search': 'retrieval', vision: 'vision', verify: 'verification',
  'planning-analysis': 'planning', 'planning-plan': 'planning', 'planning-review': 'verification'
};

export function createVoiceProgressSource(sessionId: string, turnId: string, emit: (event: VoiceProgressEvent) => void, now = Date.now) {
  let sequence = 0;
  const publish = (operationId: string, stage: ProgressStage, status: 'running' | 'succeeded' | 'failed') => {
    const occurredAt = now();
    emit({ type: 'voice-progress', eventId: `${turnId}:${++sequence}`, sessionId, turnId, sequence,
      operationId, planRevision: 1, configRevision: 1, stage, status,
      occurredAt, expiresAt: occurredAt + 5000 });
  };
  return Object.assign((operationId: string, status: 'active' | 'done' | 'warning') => {
    const stage = stages[operationId];
    if(stage)publish(operationId,stage,status==='active'?'running':status==='done'?'succeeded':'failed');
  }, {tool(executionId: string, status: 'running' | 'succeeded' | 'failed') {
    // Only persisted execution IDs from the executor; never tool plans or model text.
    if(!/^[a-f0-9-]{36}$/.test(executionId))return;
    publish(`tool:${executionId}`,'execution',status);
  }});

}

export function readVoiceProgress(value: unknown, now = Date.now()): VoiceProgressEvent | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  if (e.type !== 'voice-progress' || !['eventId','sessionId','turnId','operationId'].every(k => typeof e[k] === 'string' && /^[\w:-]{1,200}$/.test(e[k] as string))
      || !['sequence','planRevision','configRevision'].every(k => Number.isSafeInteger(e[k]) && (e[k] as number) > 0)
      || !progressStages.includes(e.stage as ProgressStage) || !['running','succeeded','failed'].includes(e.status as string)
      || typeof e.occurredAt !== 'number' || typeof e.expiresAt !== 'number' || !Number.isFinite(e.occurredAt) || !Number.isFinite(e.expiresAt)
      || e.occurredAt > now + 1000 || e.expiresAt <= now || e.expiresAt - e.occurredAt > 5000 || e.expiresAt <= e.occurredAt) return null;
  const { eventId, sessionId, turnId, sequence, operationId, planRevision, configRevision, stage, status, occurredAt, expiresAt } = e;
  return { type: 'voice-progress', eventId, sessionId, turnId, sequence, operationId, planRevision, configRevision, stage, status, occurredAt, expiresAt } as VoiceProgressEvent;
}

export const progressPhrases: Record<ProgressStage, string> = {
  model: '我正在整理回答，请稍等。', retrieval: '我正在查找相关资料。',
  vision: '我正在查看当前画面。', verification: '我正在核对资料之间的关系。',
  planning: '我正在整理这次工作的安排。', execution: '我正在调用工具处理这件事。'
};
