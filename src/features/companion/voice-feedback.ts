export type FeedbackStage = 'thinking' | 'retrieval' | 'vision';
export type FeedbackClip = { text: string; audioDataUrl: string };
export type FeedbackClips = Partial<Record<FeedbackStage, FeedbackClip[]>>;

export function feedbackStage(event: Record<string, unknown>): FeedbackStage | null {
  if (event.type !== 'analysis' || event.status !== 'active') return null;
  if (event.id === 'vision') return 'vision';
  if (['retrieve', 'literature-search', 'web-search'].includes(String(event.id))) return 'retrieval';
  if (['generate', 'verify'].includes(String(event.id))) return 'thinking';
  return null;
}

// Only cached clips are played. Slow/failed synthesis must never delay the answer.
export function createVoiceFeedback(options: {
  signal: AbortSignal;
  clips: () => FeedbackClips;
  play: (clip: FeedbackClip, signal: AbortSignal) => Promise<void>;
  delays?: number[];
}) {
  let stage: FeedbackStage | null = null;
  let closed = false;
  let playing: Promise<void> | null = null;
  let audioController: AbortController | null = null;
  const cancel = () => {
    closed = true;
    timers.forEach(clearTimeout);
    audioController?.abort();
    options.signal.removeEventListener('abort', cancel);
  };
  const timers = (options.delays ?? [2000, 8000]).map((delay, index) => setTimeout(() => {
    if (closed || options.signal.aborted || !stage || playing) return;
    const clips = options.clips()[stage];
    const clip = clips?.[index % clips.length];
    if (!clip) return;
    audioController = new AbortController();
    const timeout = setTimeout(() => audioController?.abort(), 6000);
    playing = options.play(clip, AbortSignal.any([options.signal, audioController.signal]))
      .catch(() => undefined).finally(() => { clearTimeout(timeout); playing = null; });
  }, delay));
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  return {
    onEvent(event: Record<string, unknown>) {
      const next = feedbackStage(event);
      if (next) stage = next;
      else if (event.type === 'analysis' && event.status !== 'active') stage = null;
    },
    cancel,
    async finish() {
      closed = true;
      timers.forEach(clearTimeout);
      // An already audible short phrase finishes before the actual answer.
      await playing;
      options.signal.removeEventListener('abort', cancel);
      options.signal.throwIfAborted();
    }
  };
}
