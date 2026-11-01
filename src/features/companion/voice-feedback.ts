export type FeedbackStage = 'thinking' | 'retrieval' | 'vision';
export type FeedbackClip = { text: string; audioDataUrl: string };
export type FeedbackClips = Partial<Record<FeedbackStage, FeedbackClip[]>>;

export function feedbackStage(event: Record<string, unknown>): FeedbackStage | null {
  if (event.type !== 'analysis' || event.status !== 'active') return null;
  if (event.id === 'vision') return 'vision';
  if (['retrieve', 'project-retrieve', 'literature-search', 'web-search'].includes(String(event.id))) return 'retrieval';
  if (['understand', 'generate', 'verify', 'skill-tools'].includes(String(event.id))) return 'thinking';
  return null;
}

// Only cached clips are played. Slow/failed synthesis must never delay the answer.
export function createVoiceFeedback(options: {
  signal: AbortSignal;
  clips: () => FeedbackClips;
  play: (clip: FeedbackClip, signal: AbortSignal) => Promise<void>;
  delays?: number[];
}) {
  const active = new Map<string, FeedbackStage>();
  let closed = false;
  let playing: Promise<void> | null = null;
  let audioController: AbortController | null = null;
  let playingSource: string | null = null;
  const cancel = () => {
    closed = true;
    timers.forEach(clearTimeout);
    audioController?.abort();
    active.clear();
    options.signal.removeEventListener('abort', cancel);
  };
  const timers = (options.delays ?? [2000, 8000]).map((delay, index) => setTimeout(() => {
    const selected = [...active.entries()].at(-1);
    if (closed || options.signal.aborted || !selected || playing) return;
    const [source, stage] = selected;
    const clips = options.clips()[stage];
    const clip = clips?.[index % clips.length];
    if (!clip) return;
    const controller = new AbortController();
    audioController = controller; playingSource = source;
    const timeout = setTimeout(() => controller.abort(), 6000);
    controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
    const run = Promise.resolve().then(() => {
      if (closed || controller.signal.aborted) return;
      return options.play(clip, AbortSignal.any([options.signal, controller.signal]));
    }).catch(() => undefined).finally(() => {
      clearTimeout(timeout);
      if (playing === run) { playing = null; audioController = null; playingSource = null; }
    });
    playing = run;
  }, delay));
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  return {
    onEvent(event: Record<string, unknown>) {
      if (closed) return;
      if (['done', 'error', 'cancelled'].includes(String(event.type))) { cancel(); return; }
      const next = feedbackStage(event);
      const id = String(event.id ?? '');
      if (next) {
        active.delete(id); active.set(id, next);
        if (playingSource && playingSource !== id) audioController?.abort();
      } else if (event.type === 'analysis' && ['done', 'warning'].includes(String(event.status))) {
        active.delete(id);
        if (playingSource === id) audioController?.abort();
      }
    },
    cancel,
    async finish() {
      // The answer has priority. Never wait for a stale or uncooperative cue.
      cancel();
      options.signal.throwIfAborted();
    }
  };
}
