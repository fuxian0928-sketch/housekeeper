import { createQwenRealtimeAsr, type RealtimeAsrOptions } from './qwen-realtime-asr.js';

export type AudioTurn = { workerGeneration: number; audioGeneration: number; turn: number };
type Session = Pick<ReturnType<typeof createQwenRealtimeAsr>, 'append' | 'finish' | 'cancel' | 'result'>;
type BridgeEvent = AudioTurn & ({ type: 'partial'; text: string } | { type: 'final'; text: string } | { type: 'failed'; code: string });
export type VoiceAsrBridgeDependencies = {
  createSession: (signal: AbortSignal, preview: NonNullable<RealtimeAsrOptions['onPartial']>) => Session;
  onEvent: (event: BridgeEvent) => void;
};
type Active = { key: AudioTurn; controller: AbortController; session?: Session; nextSequence: number; ended: boolean; lastCapture: number };

function valid(key: AudioTurn) {
  return [key.workerGeneration, key.audioGeneration, key.turn].every(n => Number.isSafeInteger(n) && n > 0);
}
function compare(a: AudioTurn, b: AudioTurn) {
  return a.workerGeneration - b.workerGeneration || a.audioGeneration - b.audioGeneration || a.turn - b.turn;
}

/** Trusted local audio owner only. Events contain transcript: never forward to diagnostic logs.
 * PCM timestamps must already be mapped into this process's monotonic clock domain.
 * Only final events may enter intent/action processing; partials are previews/readonly prefetch.
 */
export class VoiceAsrTurnBridge {
  private active?: Active;
  private highWater?: AudioTurn;
  private closed = false;
  constructor(private readonly dependencies: VoiceAsrBridgeDependencies) {}

  reserveControlTurn(key: AudioTurn): boolean {
    if (this.closed || !valid(key) || (this.highWater && compare(key, this.highWater) <= 0)) return false;
    this.cancelActive(); this.highWater = { ...key };
    return true;
  }

  start(key: AudioTurn): boolean {
    if (this.closed || !valid(key) || (this.highWater && compare(key, this.highWater) <= 0)) return false;
    this.cancelActive();
    this.highWater = { ...key };
    const run: Active = { key: { ...key }, controller: new AbortController(), nextSequence: 0, ended: false, lastCapture: -Infinity };
    this.active = run;
    try {
      run.session = this.dependencies.createSession(run.controller.signal, preview => {
        if (this.active === run && !run.controller.signal.aborted) this.emit({ ...run.key, type: 'partial', text: preview.text });
      });
      void run.session.result.then(result => {
        if (this.active !== run || run.controller.signal.aborted) return;
        if (!run.ended || result.final !== true) { this.fail(run, 'ASR_PREMATURE_RESULT'); return; }
        this.active = undefined;
        this.emit({ ...run.key, type: 'final', text: result.text });
      }, error => {
        if (this.active !== run || run.controller.signal.aborted) return;
        // Only adapter's bounded symbolic errors can leave the provider boundary.
        const code = error instanceof Error && /^ASR_[A-Z_]{1,48}$/.test(error.message) ? error.message : 'ASR_FAILED';
        this.fail(run, code);
      });
      return true;
    } catch {
      this.fail(run, 'ASR_START_FAILED');
      return false;
    }
  }

  append(key: AudioTurn, sequence: number, pcm: Buffer, capturedAt: number): boolean {
    const run = this.match(key);
    if (!run || run.ended) return false;
    // Gap/duplicate in a current turn invalidates the utterance, not merely a frame.
    if (sequence !== run.nextSequence || !Number.isFinite(capturedAt) || capturedAt <= run.lastCapture) {
      this.fail(run, 'ASR_AUDIO_DISCONTINUITY'); return false;
    }
    run.nextSequence++; run.lastCapture = capturedAt;
    try {
      if (!run.session?.append(pcm, capturedAt)) { this.fail(run, 'ASR_AUDIO_REJECTED'); return false; }
      return true;
    } catch { this.fail(run, 'ASR_AUDIO_REJECTED'); return false; }
  }

  finish(key: AudioTurn, frameCount: number): boolean {
    const run = this.match(key);
    if (!run || run.ended) return false;
    if (!Number.isSafeInteger(frameCount) || frameCount !== run.nextSequence || frameCount < 1) {
      this.fail(run, 'ASR_AUDIO_DISCONTINUITY'); return false;
    }
    run.ended = true;
    try { void run.session!.finish().catch(() => {}); return true; }
    catch { this.fail(run, 'ASR_FINISH_FAILED'); return false; }
  }

  cancel(key: AudioTurn): boolean {
    if (!this.match(key)) return false;
    this.cancelActive(); return true;
  }

  stopWorker(workerGeneration: number) {
    if (this.active?.key.workerGeneration === workerGeneration) this.cancelActive();
    // Retire all audio generations/turns belonging to this worker, even if no turn is active.
    if (Number.isSafeInteger(workerGeneration) && workerGeneration > 0 && (!this.highWater || workerGeneration >= this.highWater.workerGeneration)) {
      this.highWater = { workerGeneration, audioGeneration: Number.MAX_SAFE_INTEGER, turn: Number.MAX_SAFE_INTEGER };
    }
  }

  close() { this.closed = true; this.cancelActive(); }
  private match(key: AudioTurn) { return valid(key) && this.active && compare(key, this.active.key) === 0 ? this.active : undefined; }
  private emit(event: BridgeEvent) { try { this.dependencies.onEvent(event); } catch { /* Consumer errors cannot resurrect an audio session. */ } }
  private cancelActive() {
    const run = this.active; this.active = undefined;
    if (!run) return;
    run.controller.abort();
    try { run.session?.cancel(); } catch { /* Signal is already cancelled. */ }
  }
  private fail(run: Active, code: string) {
    if (this.active !== run) return;
    this.cancelActive(); this.emit({ ...run.key, type: 'failed', code });
  }
}
