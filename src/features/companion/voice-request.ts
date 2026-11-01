// Retry the same recording once; asking for another recording loses the user's sentence.
export async function requestTranscript(audioDataUrl: string, signal: AbortSignal, options: { timeoutMs?: number; retries?: number } = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await withVoiceDeadline(async requestSignal => {
      const response = await fetch('/api/speech/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioDataUrl }),
        signal: requestSignal
      });
      const payload = await response.json() as { text?: string; message?: string };
      requestSignal.throwIfAborted();
      if (!response.ok) throw Object.assign(new Error(payload.message || '语音识别暂不可用'), { retryable: response.status === 429 || response.status >= 500 });
      return payload.text ?? '';
      }, signal, options.timeoutMs ?? 30_000);
    } catch (error) {
      signal.throwIfAborted();
      const retryable = error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError') || (error as { retryable?: boolean })?.retryable;
      if (attempt >= (options.retries ?? 1) || !retryable) throw error;
    }
  }
}

export async function withVoiceDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([parent, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new DOMException('设备响应超时', 'TimeoutError')), timeoutMs);
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(signal), new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); timeout.abort(); }
}
