// Match direct dismissal commands, not mentions such as “我明天离开” or “不要离开”.
export function isDismissCommand(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\s，。！？、,.!?]/g, '');
  return /^(?:(?:小e|小艺|小易|小伊){1,2})?(?:请|麻烦)?(?:你)?(?:先)?(?:退下|离开|退下去|去休息|休息去|结束对话|停止聊天|不用陪我了)(?:一下|一会儿)?(?:吧|啦|哦|了)?$/.test(normalized);
}

export const CONVERSATION_IDLE_MS = 5 * 60 * 1000;
export const IDLE_FAREWELL = '那主人继续忙吧，小e先退下啦，有事主人随时叫我哦';

// Keep short recordings rather than uploading five minutes of silence.
export async function listenUntilIdle(listen: (signal: AbortSignal) => Promise<string>, signal: AbortSignal, idleMs = CONVERSATION_IDLE_MS): Promise<string | null> {
  const idle = new AbortController();
  const timer = setTimeout(() => idle.abort(), idleMs);
  const combined = AbortSignal.any([signal, idle.signal]);
  try {
    while (true) {
      combined.throwIfAborted();
      try {
        const text = (await listen(combined)).trim();
        combined.throwIfAborted();
        if (text) return text;
      } catch (error) {
        combined.throwIfAborted();
        if (!(error instanceof NoSpeechError)) throw error;
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (idle.signal.aborted) return null;
    throw error;
  } finally { clearTimeout(timer); }
}

export class NoSpeechError extends Error {
  constructor() { super('没有听清，这次先回到待机，叫我可以继续。'); }
}

// A brief click must not start the end-of-speech timer.
export function createSpeechGate(startedAt: number) {
  let candidateSince: number | null = null;
  let lastVoiceAt = startedAt;
  let heardVoice = false;
  return (level: number, now: number) => {
    if (level > .025) {
      candidateSince ??= now;
      if (now - candidateSince >= 120) heardVoice = true;
      lastVoiceAt = now;
    } else candidateSince = null;
    return { heardVoice, stop: (heardVoice && now - lastVoiceAt >= 1200) || now - startedAt >= 12000 };
  };
}

export async function listenForTranscript(
  capture: () => Promise<string>,
  transcribe: (audio: string) => Promise<string>,
  onRetry: () => void,
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const audio = await capture();
      signal.throwIfAborted();
      const text = (await transcribe(audio)).trim();
      signal.throwIfAborted();
      if (text) return text;
      throw new NoSpeechError();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof NoSpeechError) || attempt === 1) throw error;
      onRetry();
    }
  }
  throw new NoSpeechError();
}
