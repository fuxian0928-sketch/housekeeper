import { setTimeout as delay } from 'node:timers/promises';

export type ProgressAudio = {
  next(): { pcm: Buffer; current(): boolean; started(): boolean } | null;
  finish(): void;
};

/** One PCM stream, one native player. Answer packets preempt optional cached
 * progress at the next 100ms packet boundary; never synthesize on this path. */
export async function* nativeOutputStream(answer: AsyncIterable<Buffer>, progress: ProgressAudio, signal: AbortSignal, onPacket?: (kind: 'answer' | 'progress', bytes: number) => void): AsyncGenerator<Buffer> {
  const iterator = answer[Symbol.asyncIterator]();
  let result: IteratorResult<Buffer> | undefined, failure: unknown, failed = false;
  let pending: Promise<void> | undefined, clip: ReturnType<ProgressAudio['next']> = null, offset = 0;
  let answerStarted = false;
  const pull = () => {
    if (!pending) pending = Promise.resolve().then(() => iterator.next()).then(item => { result = item; }, error => { failure = error; failed = true; });
  };
  try {
    while (true) {
      signal.throwIfAborted(); pull();
      // Give an already available answer priority over selecting a progress clip.
      await Promise.resolve(); await Promise.resolve();
      signal.throwIfAborted();
      if (failed) throw failure;
      if (result) {
        const item = result; result = undefined; pending = undefined;
        progress.finish(); clip = null; answerStarted = true;
        if (item.done) return;
        if (Buffer.isBuffer(item.value)) { try { onPacket?.('answer',item.value.length); } catch {} }
        yield item.value; continue;
      }
      if (!answerStarted) {
        if (clip && (!clip.current() || offset >= clip.pcm.length)) clip = null;
        if (!clip) {
          const selected = progress.next();
          if (selected && Buffer.isBuffer(selected.pcm) && selected.pcm.length >= 320 && selected.pcm.length <= 96000 && selected.pcm.length % 320 === 0 && selected.current() && selected.started()) {
            clip = selected; offset = 0;
          }
        }
        if (clip) {
          const packet = Buffer.from(clip.pcm.subarray(offset, offset + 3200)); offset += packet.length;
          try { onPacket?.('progress',packet.length); } catch {}
          yield packet; continue;
        }
      }
      // Bounded poll is interruptible and does not create unbounded promise listeners.
      await delay(25, undefined, { signal });
    }
  } finally {
    progress.finish(); clip = null;
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
  }
}
