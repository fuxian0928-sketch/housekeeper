import { readVoiceProgress, progressPhrases, type VoiceProgressEvent } from './voice-progress.js';

/** Deterministic optional-progress selector. Player must revalidate before output. */
export function createVoiceProgressScheduler(options: {
  mode: 'off' | 'concise' | 'detailed'; firstDelayMs?: number; intervalMs?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now, started = now();
  const first = options.firstDelayMs ?? 2000, interval = options.intervalMs ?? 8000;
  if (!['off','concise','detailed'].includes(options.mode) || !Number.isFinite(first) || first < 1000 || first > 5000 || !Number.isFinite(interval) || interval < 5000 || interval > 20000) throw Error('VOICE_PROGRESS_INVALID_CONFIG');
  let turn: string | undefined, session: string | undefined, sequence = 0, revision = 0;
  let terminal = false, count = 0, lastStarted = -Infinity;
  const operations = new Map<string, VoiceProgressEvent>(), said = new Map<string, number>();
  const valid = (event: VoiceProgressEvent) => !terminal && event.expiresAt > now()
    && operations.get(event.operationId)?.eventId === event.eventId && event.status === 'running';
  return {
    accept(input: unknown) {
      const event = readVoiceProgress(input, now());
      if (terminal || !event || (turn && (turn !== event.turnId || session !== event.sessionId)) || event.sequence <= sequence || event.planRevision < revision) return false;
      if (event.planRevision > revision) { operations.clear(); said.clear(); revision = event.planRevision; }
      turn = event.turnId; session = event.sessionId; sequence = event.sequence;
      if (event.status !== 'running') operations.delete(event.operationId);
      else {
        operations.delete(event.operationId); operations.set(event.operationId, event);
        if (operations.size > 16) operations.delete(operations.keys().next().value!);
      }
      return true;
    },
    next() {
      if (terminal || options.mode === 'off' || count >= (options.mode === 'detailed' ? 5 : 3) || now() - started < first || now() - lastStarted < interval) return null;
      // A fresh event is required; silence/expired status never implies ongoing work.
      const event = [...operations.values()].reverse().find(e => valid(e) && (said.get(e.operationId) ?? 0) < 2);
      return event ? { event, phrase: progressPhrases[event.stage] } : null;
    },
    canPlay: valid,
    started(event: VoiceProgressEvent) {
      if (!valid(event) || now() - started < first || now() - lastStarted < interval || options.mode === 'off' || count >= (options.mode === 'detailed' ? 5 : 3) || (said.get(event.operationId) ?? 0) >= 2) return false;
      lastStarted = now(); count++; said.set(event.operationId, (said.get(event.operationId) ?? 0) + 1); return true;
    },
    finish() { terminal = true; operations.clear(); said.clear(); }
  };
}
