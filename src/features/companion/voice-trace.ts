export type VoiceMilestone = 'listen-start' | 'speech-end' | 'asr-start' | 'asr-final' | 'camera-start' | 'camera-end' | 'answer-start' | 'answer-ready' | 'tts-start' | 'tts-ready' | 'progress-playing' | 'answer-playing' | 'fallback-start' | 'completed' | 'failed' | 'cancelled' | 'idle';
export type VoiceTraceRecord = { schema: 1; sessionId: string; turnId: string; sequence: number; stage: VoiceMilestone; ms: number };

// Deliberately accepts no transcript, arbitrary metadata, provider error or credential.
// Renderer playback events are observations, never proof the user heard audio.
export function createVoiceTrace(sessionId: string, emit: (record: VoiceTraceRecord) => void,
  clock = () => performance.now(), turnId = crypto.randomUUID()) {
  const started = clock();
  let sequence = 0;
  let closed = false;
  return {
    turnId,
    mark(stage: VoiceMilestone, occurredAt = clock()) {
      if (closed) return;
      if (['completed', 'failed', 'cancelled', 'idle'].includes(stage)) closed = true;
      const record: VoiceTraceRecord = { schema: 1, sessionId, turnId, sequence: ++sequence, stage, ms: Math.max(0, Math.round(occurredAt - started)) };
      try { emit(record); } catch { /* Diagnostics must never block the voice turn. */ }
    }
  };
}
export type VoiceTrace = ReturnType<typeof createVoiceTrace>;

export function summarizeVoiceTrace(records: VoiceTraceRecord[]) {
  if (!records.length) return null;
  const first = records[0];
  if (records.some(r => r.turnId !== first.turnId || r.sessionId !== first.sessionId)) throw new Error('Mixed voice turns');
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  const last = ordered.at(-1)!;
  // ASR may retry recordings: measure from the last speech boundary before final ASR.
  const final = ordered.find(r => r.stage === 'asr-final');
  const speechEnd = final && ordered.filter(r => r.stage === 'speech-end' && r.sequence < final.sequence).at(-1);
  const playing = ordered.find(r => r.stage === 'answer-playing');
  return {
    sessionId: first.sessionId, turnId: first.turnId,
    outcome: ['completed', 'failed', 'cancelled', 'idle'].includes(last.stage) ? last.stage : 'incomplete',
    // Progress and local fallback lack reliable actual-answer onset; leave missing, never zero.
    answerOnsetMs: speechEnd && playing ? playing.ms - speechEnd.ms : null,
    elapsedMs: last.ms,
    playbackEvidence: playing ? 'renderer-playing' : 'unavailable'
  };
}
