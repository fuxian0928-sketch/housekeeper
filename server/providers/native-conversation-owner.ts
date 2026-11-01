import { voiceFailureCode } from './voice-failure.js';
import { createNativeRecognitionOwner, type NativeAudioPacket, type NativeAudioWorker } from './native-recognition-owner.js';
import type { AudioTurn, VoiceAsrBridgeDependencies } from './voice-asr-turn-bridge.js';

type Worker = NativeAudioWorker & { command(value: { generation: number; audioGeneration: number; turn: number; type: 'speaking' | 'answer-failed' | 'answer-finished' | 'dismiss' | 'dismiss-after-playback' }): boolean };
type Run = { key: AudioTurn; controller: AbortController; responding: boolean; speaking: boolean; standbyAfterPlayback: boolean; wakeTurn: boolean; renderedFrames: number; timer: ReturnType<typeof setTimeout>; idleTimer?: ReturnType<typeof setTimeout> };
type TurnContext = { control?: 'idle-farewell' | 'voice-preview' | 'utterance-limit'; key: AudioTurn; text: string; signal: AbortSignal; beginPlayback(): boolean; requestStandby(): boolean; progress?(): void };
export type ConversationDependencies = {
  createSession: VoiceAsrBridgeDependencies['createSession'];
  // Shared Agent/TTS/playback implementation MUST observe signal, including stopping
  // audio already playing. Resolve only after actual playback completes, not synthesis.
  respond(context: TurnContext): Promise<void>;
  onRecognition?: VoiceAsrBridgeDependencies['onEvent'];
  acceptWakeTranscript?: (text: string) => boolean;
  onStatus?: (event: AudioTurn & { type: 'responding' | 'speaking' | 'finished' | 'failed'; code?: string }) => void;
  turnBudgetMs?: number;
  responseIdleMs?: number;
};
const compare = (a: AudioTurn, b: AudioTurn) => a.workerGeneration - b.workerGeneration || a.audioGeneration - b.audioGeneration || a.turn - b.turn;
const valid = (key: AudioTurn) => [key.workerGeneration, key.audioGeneration, key.turn].every(n => Number.isSafeInteger(n) && n > 0);

/** One lifetime extends from local turn-start through ASR, Agent, TTS and playback.
 * Neither a late provider nor a replaced worker can resume listening for a newer turn.
 * This is composition, not a separate intent classifier or a tool executor.
 */
export function createNativeConversationOwner(createWorker: (consume: (packet: NativeAudioPacket) => boolean) => Worker, dependencies: ConversationDependencies) {
  const budget = dependencies.turnBudgetMs ?? 300_000;
  if (!Number.isFinite(budget) || budget < 1 || budget > 300_000) throw new Error('VOICE_INVALID_TURN_BUDGET');
  const idleBudget = dependencies.responseIdleMs ?? 60_000;
  if (!Number.isFinite(idleBudget) || idleBudget < 1 || idleBudget > 120_000) throw new Error('VOICE_INVALID_IDLE_BUDGET');
  let active: Run | undefined;
  let highWater: AudioTurn | undefined;
  let worker!: Worker;
  const emit = (run: Run, type: 'responding' | 'speaking' | 'finished' | 'failed', code?: string) => {
    try { dependencies.onStatus?.({ ...run.key, type, ...(code ? { code } : {}) }); } catch { /* Observer cannot control lifetime. */ }
  };
  const current = (run: Run) => active === run && !run.controller.signal.aborted;
  const command = (run: Run, type: 'speaking' | 'answer-failed' | 'answer-finished' | 'dismiss' | 'dismiss-after-playback') => worker.command({ generation: run.key.workerGeneration, audioGeneration: run.key.audioGeneration, turn: run.key.turn, type });
  function cancel() {
    const old = active; active = undefined;
    if (old) { clearTimeout(old.timer); clearTimeout(old.idleTimer); old.controller.abort(); }
  }
  function finish(run: Run, error?: string) {
    if (!current(run)) return;
    // Abort invalidates pending downstream callbacks before letting native VAD listen.
    cancel();
    owner.cancelRecognition(run.key);
    let accepted = false;
    try { accepted = command(run, run.standbyAfterPlayback ? 'dismiss' : error ? 'answer-failed' : 'answer-finished'); } catch { /* Retired worker. */ }
    emit(run, error || !accepted ? 'failed' : 'finished', error ?? (!accepted ? 'VOICE_CONTROL_REJECTED' : undefined));
  }
  function progress(run: Run) {
    if (!current(run)) return;
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => finish(run, 'VOICE_TURN_TIMEOUT'), run.responding ? idleBudget : 40_000);
    run.idleTimer.unref?.();
  }
  const onPlaybackProgress = (event: { type: string; generation: number; audioGeneration?: number; turn?: number; renderedFrames?: number }) => {
    const run = active;
    if (!run || !run.responding || !['playback-progress','playback-submitted'].includes(event.type) ||
      event.generation !== run.key.workerGeneration || event.audioGeneration !== run.key.audioGeneration || event.turn !== run.key.turn ||
      !Number.isSafeInteger(event.renderedFrames) || event.renderedFrames! <= run.renderedFrames || event.renderedFrames! > 24_000) return;
    run.renderedFrames = event.renderedFrames!;
    progress(run);
  };
  function respond(run: Run, text: string, control?: 'idle-farewell' | 'voice-preview' | 'utterance-limit') {
    run.responding = true; emit(run, 'responding');
    if (!current(run)) return;
    progress(run);
    void Promise.resolve().then(() => {
      run.controller.signal.throwIfAborted();
      return dependencies.respond({ key: { ...run.key }, text, control, signal: run.controller.signal,
        progress() { progress(run); },
        requestStandby() {
          if (!current(run)) return false;
          run.standbyAfterPlayback = true;
          try { return command(run, 'dismiss-after-playback'); } catch { return false; }
        },
        beginPlayback() {
          if (!current(run) || run.speaking) return false;
          try { if (!command(run, 'speaking')) { finish(run, 'VOICE_CONTROL_REJECTED'); return false; } }
          catch { finish(run, 'VOICE_CONTROL_REJECTED'); return false; }
          run.speaking = true; emit(run, 'speaking'); return current(run);
        }
      });
    }).then(() => finish(run), error => finish(run, voiceFailureCode(error)));
  }
  const owner = createNativeRecognitionOwner(consume => { worker = createWorker(consume); worker.on('event', onPlaybackProgress); return worker; }, {
    createSession: dependencies.createSession,
    onLifecycle(event) {
      if (event.type === 'retire') {
        if (active?.key.workerGeneration === event.generation) cancel();
        if (!highWater || event.generation >= highWater.workerGeneration) highWater = { workerGeneration: event.generation, audioGeneration: Number.MAX_SAFE_INTEGER, turn: Number.MAX_SAFE_INTEGER };
      } else if (event.type === 'utterance-limit') {
        if (active && current(active) && compare(active.key,event.key) === 0 && !active.responding) respond(active, '', 'utterance-limit');
      } else if (event.type === 'cancel') {
        if (active && compare(active.key, event.key) === 0) cancel();
      } else {
        if (!valid(event.key) || (highWater && compare(event.key, highWater) <= 0)) return;
        cancel(); highWater = { ...event.key };
        const run: Run = { key: { ...event.key }, controller: new AbortController(), responding: false, speaking: false, standbyAfterPlayback: event.type === 'idle-farewell' || event.type === 'voice-preview', wakeTurn: event.type === 'start' && event.reason === 'wake', renderedFrames: 0, timer: undefined! };
        active = run;
        run.timer = setTimeout(() => finish(run, 'VOICE_TURN_TIMEOUT'), budget);
        run.timer.unref?.();
        progress(run);
        if (event.type === 'idle-farewell' || event.type === 'voice-preview') respond(run, '', event.type);
      }
    },
    onEvent(event) {
      const run = active;
      if (!run || !current(run) || compare(run.key, event) !== 0) return;
      try { dependencies.onRecognition?.(event); } catch { /* No transcript in status logs. */ }
      if (!current(run)) return;
      if (event.type === 'failed') { finish(run, event.code); return; }
      if (event.type !== 'final' || run.responding) return;
      if (run.wakeTurn && dependencies.acceptWakeTranscript && !dependencies.acceptWakeTranscript(event.text)) {
        // Acoustic KWS is only a candidate. A second, text-level check prevents
        // ordinary speech from opening a fresh conversation after dismissal.
        run.standbyAfterPlayback = true;
        finish(run);
        return;
      }
      if (!event.text.trim()) { finish(run); return; }
      respond(run, event.text);
    }
  });
  return { ...owner, async stop() { cancel(); await owner.stop(); }, async close() { cancel(); try { await owner.close(); } finally { worker.off('event', onPlaybackProgress); } } };
}
