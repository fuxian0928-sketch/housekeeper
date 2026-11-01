import type { ConversationDependencies } from './native-conversation-owner.js';
import { nativeOutputStream, type ProgressAudio } from './native-output-stream.js';
import {SpeechTextChunker} from './speech-text-chunker.js';

type Context = Parameters<ConversationDependencies['respond']>[0];
type Synthesis = {
  ready: Promise<void>; append(text: string): boolean; finish(): boolean;
  cancel(): void; audio: AsyncIterable<Buffer>;
};
export type ResponseStage = 'tts-start'|'tts-ready'|'answer-start'|'first-answer-text'|'first-sentence'|'first-answer-pcm'|'playback-complete'|'response-failed'|'response-cancelled';
export type ResponsePipelineDependencies = {
  onStage?(stage:ResponseStage):void;
  onFailureCode?(code:string):void;
  // Trusted life-only path: no task/document/tool actions may run speculatively.
  overlapAnswerStartup?: boolean;
  beforeAudio?(): Promise<void>;
  // The shared Agent emits only user-facing answer text, never reasoning/progress.
  answer(context: Context): AsyncIterable<string>;
  synthesize(signal: AbortSignal): Synthesis;
  progress?: ProgressAudio;
  onAudioPacket?(kind: 'answer' | 'progress', bytes: number): void;
  onDeviceReceipt?(receipt: unknown): void;
  player: { playStream(key: { generation: number; audioGeneration: number; turn: number }, source: AsyncIterable<Buffer>, signal: AbortSignal): Promise<unknown> };
};

/** Concurrent Agent -> complete sentences -> TTS -> native playback, one lifetime.
 * No tool execution or intent classification is duplicated here.
 */
export function createNativeResponsePipeline(dependencies: ResponsePipelineDependencies): ConversationDependencies['respond'] {
  return async context => {
    context.signal.throwIfAborted();
    const local = new AbortController();
    const signal = AbortSignal.any([context.signal, local.signal]);
    let rejectCancelled!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    void cancelled.catch(() => {});
    const aborted = () => rejectCancelled(Error('VOICE_RESPONSE_CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    const wait = <T>(promise: PromiseLike<T>) => Promise.race([promise, cancelled]);
    const seen=new Set<ResponseStage>();
    const mark=(stage:ResponseStage)=>{if(seen.has(stage))return;seen.add(stage);try{dependencies.onStage?.(stage);}catch{}};
    let tts: Synthesis | undefined;
    let input: AsyncIterator<string> | undefined;
    try {
      mark('tts-start');
      tts = dependencies.synthesize(signal);
      const ttsReady = Promise.resolve(tts.ready);
      void ttsReady.catch(() => {}); // Observe failures even if answer iterator construction throws.
      let first: Promise<IteratorResult<string>> | undefined;
      if (dependencies.overlapAnswerStartup) {
        mark('answer-start');
        input = dependencies.answer({ ...context, signal })[Symbol.asyncIterator]();
        first = Promise.resolve().then(() => { signal.throwIfAborted(); return input!.next(); }).then(item => {
          signal.throwIfAborted();
          if (!item.done) {
            if (typeof item.value !== 'string' || item.value.length > 3000) throw Error('VOICE_ANSWER_LIMIT');
            if (item.value.length) mark('first-answer-text');
          }
          return item;
        });
        // One bounded chunk only. Surface an early answer failure even if TTS stalls.
        const answerFailure = first.then(() => new Promise<void>(() => {}));
        await wait(Promise.race([ttsReady, answerFailure]));
      } else {
        await wait(ttsReady);
      }
      signal.throwIfAborted();mark('tts-ready');
      if (!input) {
        mark('answer-start');
        input = dependencies.answer({ ...context, signal })[Symbol.asyncIterator]();
      }
      const synthesis = tts;
      const feed = async () => {
        const chunker = new SpeechTextChunker();
        let total = 0, sent = false, flushAt: number | undefined;
        let next = first ?? Promise.resolve(input!.next()); first = undefined;
        const append = (chunks: string[]) => {
          for (const sentence of chunks) { mark('first-sentence'); if (!synthesis.append(sentence)) throw Error('VOICE_TTS_REJECTED'); sent = true; }
          flushAt = chunker.hasComplete ? performance.now() + 120 : undefined;
        };
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const flush = Symbol();
          void next.catch(() => {});
          const item = await wait(flushAt === undefined ? next : Promise.race([next, new Promise<typeof flush>(resolve => {timer = setTimeout(() => resolve(flush), Math.max(0, flushAt! - performance.now()));})])).finally(() => clearTimeout(timer));
          signal.throwIfAborted();
          if (item === flush) { append(chunker.take(true)); continue; }
          if (item.done) break;
          dependencies.progress?.finish(); // The final answer displaces any optional narration.
          if (typeof item.value !== 'string' || (total += item.value.length) > 3000) throw Error('VOICE_ANSWER_LIMIT');
          if(item.value.length){mark('first-answer-text');context.progress?.();}
          const priorFlush = flushAt;
          const chunks = chunker.push(item.value);
          if (chunks.length) append(chunks);
          else if (chunker.hasComplete) flushAt = priorFlush ?? performance.now() + 120;
          next = Promise.resolve(input!.next());
        }
        append(chunker.finish());
        if (!sent) throw Error('VOICE_EMPTY_ANSWER');
        if (!synthesis.finish()) throw Error('VOICE_TTS_REJECTED');
      };
      async function* audio() {
        let started = false;
        async function* answerAudio(){for await(const pcm of synthesis.audio){signal.throwIfAborted();if(Buffer.isBuffer(pcm)&&pcm.length)mark('first-answer-pcm');yield pcm;}}
        const output = dependencies.progress ? nativeOutputStream(answerAudio(), dependencies.progress, signal, dependencies.onAudioPacket) : answerAudio();
        for await (const pcm of output) {
          if (dependencies.beforeAudio) await wait(dependencies.beforeAudio());
          signal.throwIfAborted();
          if (!dependencies.progress && Buffer.isBuffer(pcm)) { try { dependencies.onAudioPacket?.('answer',pcm.length); } catch {} }
          if (!started) {
            if (!context.beginPlayback()) throw Error('VOICE_PLAYBACK_REJECTED');
            started = true;
          }
          yield pcm;
        }
      }
      const feeding = feed();
      // Start consumption while the Agent is still answering, not after feed ends.
      // Processing time is owned by the conversation, not the playback watchdog.
      // Open the native player only once there is actually PCM to submit.
      const playing = Promise.resolve().then(async () => {
        const output = audio();
        try {
          const first = await wait(output.next());
          signal.throwIfAborted();
          if (first.done) throw Error('VOICE_EMPTY_ANSWER');
          return await dependencies.player.playStream({
            generation: context.key.workerGeneration, audioGeneration: context.key.audioGeneration, turn: context.key.turn
          }, { async *[Symbol.asyncIterator]() { yield first.value; yield* output; } }, signal);
        } finally { try { void output.return(undefined).catch(() => {}); } catch {} }
      });
      const [,receipt] = await wait(Promise.all([feeding, playing]));
      signal.throwIfAborted();
      mark('playback-complete');
      try { dependencies.onDeviceReceipt?.(receipt); } catch {}
    } catch(error){
      if (!context.signal.aborted) {
        const message = error instanceof Error ? error.message : '';
        const code = /^(?:TTS_[A-Z_]+|VOICE_TTS_REJECTED|PLAYBACK_[A-Z_]+|VOICE_PLAYBACK_[A-Z_]+)$/.test(message) ? message : 'OTHER';
        try { dependencies.onFailureCode?.(code); } catch {}
      }
      mark(context.signal.aborted?'response-cancelled':'response-failed');throw error;
    } finally {
      dependencies.progress?.finish();
      local.abort(); signal.removeEventListener('abort', aborted);
      try { tts?.cancel(); } catch { /* Keep the original failure. */ }
      try { void Promise.resolve(input?.return?.()).catch(() => {}); } catch { /* Never await a stalled producer. */ }
    }
  };
}
