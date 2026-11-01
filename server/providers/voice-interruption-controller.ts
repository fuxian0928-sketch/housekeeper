import type { createQwenRealtimeAsr } from './qwen-realtime-asr.js';
import type { AudioTurn } from './voice-asr-turn-bridge.js';

export type InterruptionKey = AudioTurn & { pauseId: number };
type Session = Pick<ReturnType<typeof createQwenRealtimeAsr>, 'append' | 'finish' | 'cancel' | 'result'>;
type Decision = 'resume' | 'interrupt' | 'stop';
type Dependencies = {
  createSession(signal: AbortSignal, onPartial: (text: string) => void): Session;
  pause(key: InterruptionKey): boolean;
  resume(key: InterruptionKey): boolean;
  // Confirmation only transfers microphone ownership. It must never execute tools.
  confirm(key: InterruptionKey, decision: 'interrupt' | 'stop'): boolean;
  onStatus?(event: InterruptionKey & { type: 'resumed' | 'confirmed' | 'cancelled'; reason: string }): void;
  budgetMs?: number;
  now?: () => number;
};
type Candidate = {
  key: InterruptionKey; controller: AbortController; session?: Session;
  timer?: ReturnType<typeof setTimeout>; sequence: number; lastCapture: number; ended: boolean;
  preview?: { text: string; at: number };
};
const valid = (key: InterruptionKey) => [key.workerGeneration, key.audioGeneration, key.turn, key.pauseId].every(n => Number.isSafeInteger(n) && n > 0);
const compare = (a: InterruptionKey, b: InterruptionKey) => a.workerGeneration - b.workerGeneration || a.audioGeneration - b.audioGeneration || a.turn - b.turn || a.pauseId - b.pauseId;
const normalize = (text: string) => text.toLowerCase().replace(/[\s，。！？、,.!?]/g, '');

export function classifyInterruption(text: string): Decision {
  const value = normalize(text);
  if (/^(?:请|你)?(?:先)?(?:停|停止|暂停|停一下|等一下|等等|别说了|不要说了|安静|stop)$/.test(value)) return 'stop';
  if (!value || /^(?:嗯+|哦+|啊+|好+的?|对的?|是的?|知道了|明白了|收到|你继续|继续吧?|不要停|别停|不用停|别停止|不要停止|ok|yes)$/.test(value)) return 'resume';
  if (/^(?:(?:没事|没关系|好的|好|嗯|ok)){0,2}(?:请)?(?:你)?(?:继续(?:说(?:下去)?)?|接着说)(?:吧|呀|啊|就好|就行)?$/.test(value)) return 'resume';
  return value.length >= 2 ? 'interrupt' : 'resume';
}

// A partial such as "没事你继" must not retire the answer before the ASR
// reaches "没事你继续说". Only these bounded control prefixes wait for final;
// a complete request with additional content is still a real interruption.
const resumePhrases = ['没事你继续说','没关系你继续说','好的你继续说','好你继续说','你继续说','请你继续说','继续说下去','接着说吧'];

/** A bounded, side-effect-free ASR candidate while the old answer is paused.
 * No candidate transcript is persisted, forwarded to tools or included in status.
 */
export function createInterruptionController(dependencies: Dependencies) {
  const budget = dependencies.budgetMs ?? 1200, now = dependencies.now ?? (() => performance.now());
  if (!Number.isFinite(budget) || budget < 100 || budget > 1300) throw Error('INTERRUPTION_INVALID_BUDGET');
  let active: Candidate | undefined, highWater: InterruptionKey | undefined, closed = false;
  const matches = (key: InterruptionKey) => active && compare(active.key, key) === 0 ? active : undefined;
  function settle(run: Candidate, decision: Decision | 'cancel', reason: string) {
    if (active !== run) return;
    active = undefined; clearTimeout(run.timer); run.controller.abort();
    try { run.session?.cancel(); } catch { /* Already retired. */ }
    let confirmed = false;
    if (decision === 'interrupt' || decision === 'stop') {
      try { confirmed = dependencies.confirm(run.key, decision); } catch { /* Resume if handoff fails. */ }
    }
    if (decision !== 'cancel' && !confirmed) { try { dependencies.resume(run.key); } catch {} }
    try { dependencies.onStatus?.({ ...run.key, type: decision === 'cancel' ? 'cancelled' : confirmed ? 'confirmed' : 'resumed', reason }); } catch {}
  }
  return {
    begin(key: InterruptionKey) {
      if (closed || !valid(key) || (highWater && compare(key, highWater) <= 0)) return false;
      if (active) settle(active, 'resume', 'superseded-candidate');
      highWater = { ...key };
      const run: Candidate = { key: { ...key }, controller: new AbortController(), sequence: 0, lastCapture: -Infinity, ended: false };
      active = run;
      try {
        if (!dependencies.pause(run.key)) { settle(run, 'cancel', 'pause-rejected'); return false; }
        run.timer = setTimeout(() => settle(run, 'resume', 'candidate-timeout'), budget);
        run.timer.unref?.();
        run.session = dependencies.createSession(run.controller.signal, text => {
          if (active !== run || run.ended) return;
          if (typeof text !== 'string' || text.length > 4096) { settle(run, 'resume', 'invalid-transcript'); return; }
          const normalized = normalize(text), decision = classifyInterruption(text), at = now();
          const previous = run.preview;
          // One provisional transcript is not enough. Short acknowledgements wait for final.
          if (decision !== 'resume' && !resumePhrases.some(phrase => phrase.startsWith(normalized)) && previous && previous.text.length >= 2 && normalized.startsWith(previous.text) && at - previous.at >= 80) {
            settle(run, decision, 'stable-transcript'); return;
          }
          if (normalized !== previous?.text) run.preview = { text: normalized, at };
        });
        if (active !== run) { run.session.cancel(); void run.session.result.catch(() => {}); return false; }
        void run.session.result.then(result => {
          if (active !== run) return;
          if (!run.ended || result.final !== true) { settle(run, 'resume', 'invalid-final'); return; }
          if (typeof result.text !== 'string' || result.text.length > 4096) { settle(run, 'resume', 'invalid-transcript'); return; }
          settle(run, classifyInterruption(result.text), 'final-transcript');
        }, () => settle(run, 'resume', 'recognition-failed'));
        return true;
      } catch { settle(run, 'resume', 'recognition-failed'); return false; }
    },
    append(key: InterruptionKey, sequence: number, pcm: Buffer, capturedAt: number) {
      const run = matches(key); if (!run || run.ended) return false;
      if (sequence !== run.sequence || run.sequence >= 160 || !Buffer.isBuffer(pcm) || pcm.length !== 320 || !Number.isFinite(capturedAt) || capturedAt <= run.lastCapture || now() - capturedAt > 1800 || capturedAt > now() + 10) {
        settle(run, 'resume', 'invalid-audio'); return false;
      }
      run.sequence++; run.lastCapture = capturedAt;
      try { if (run.session?.append(pcm, capturedAt)) return true; } catch {}
      settle(run, 'resume', 'audio-rejected'); return false;
    },
    finish(key: InterruptionKey, frames: number) {
      const run = matches(key); if (!run || run.ended) return false;
      if (!Number.isSafeInteger(frames) || frames < 1 || frames !== run.sequence) { settle(run, 'resume', 'invalid-audio'); return false; }
      run.ended = true;
      try { void run.session!.finish().catch(() => settle(run, 'resume', 'recognition-failed')); return true; }
      catch { settle(run, 'resume', 'recognition-failed'); return false; }
    },
    retire(key: InterruptionKey) { const run = matches(key); if (run) settle(run, 'cancel', 'turn-retired'); },
    close() { closed = true; if (active) settle(active, 'cancel', 'closed'); }
  };
}
