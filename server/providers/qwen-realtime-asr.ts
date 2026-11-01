import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

type Socket = Pick<WebSocket, 'on' | 'send' | 'close' | 'terminate' | 'bufferedAmount'>;
export type RealtimeAsrOptions = {
  baseUrl: string; model: string; apiKey: string; signal: AbortSignal;
  onPartial?: (preview: { text: string; final: false }) => void;
  connectMs?: number; finalMs?: number; totalMs?: number; audioAgeMs?: number;
  now?: () => number;
  createSocket?: (url: string, apiKey: string) => Socket;
};

export function qwenRealtimeUrl(base: string, model: string) {
  const url = new URL(base);
  const hosts = /^(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|[a-zA-Z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/;
  if (!['https:', 'wss:'].includes(url.protocol) || !hosts.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash) throw new Error('ASR_INVALID_OFFICIAL_ENDPOINT');
  if (!['', '/', '/api/v1', '/api/v1/', '/compatible-mode/v1', '/api-ws/v1/realtime'].includes(url.pathname)) throw new Error('ASR_INVALID_ENDPOINT_PATH');
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(model)) throw new Error('ASR_INVALID_MODEL');
  url.protocol = 'wss:';
  url.pathname = '/api-ws/v1/realtime';
  url.searchParams.set('model', model);
  return url.toString();
}

// One manual-mode cloud session per final local utterance. No retries of old audio.
// Used only by a trusted local service; never hand the key or socket to a webpage.
export function createQwenRealtimeAsr(options: RealtimeAsrOptions) {
  const url = qwenRealtimeUrl(options.baseUrl, options.model);
  if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new Error('ASR_INVALID_KEY');
  const now = options.now ?? (() => performance.now());
  const connectMs = options.connectMs ?? 5000;
  const finalMs = options.finalMs ?? 5000;
  const totalMs = options.totalMs ?? 40_000;
  const audioAgeMs = options.audioAgeMs ?? 2000;
  for (const value of [connectMs, finalMs, totalMs, audioAgeMs]) if (!Number.isFinite(value) || value <= 0 || value > 120_000) throw new Error('ASR_INVALID_BUDGET');
  options.signal.throwIfAborted();
  const socket = options.createSocket?.(url, options.apiKey) ?? new WebSocket(url, { headers: { Authorization: `Bearer ${options.apiKey}` }, handshakeTimeout: connectMs, maxPayload: 65536, perMessageDeflate: false, followRedirects: false });
  let configured = false, ended = false, committed = false, closed = false;
  let bytes = 0, queuedBytes = 0;
  let itemId: string | null = null, finalText: string | null = null;
  let commitAcknowledged = false;
  const queued: Array<{ pcm: Buffer; at: number }> = [];
  let resolveReady!: () => void, rejectReady!: (reason: Error) => void;
  let resolveResult!: (value: { text: string; final: true; audioBytes: number }) => void, rejectResult!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise<{ text: string; final: true; audioBytes: number }>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Callers may first await ready while result is cancelled concurrently.
  void ready.catch(() => {}); void result.catch(() => {});
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const connectTimer = setTimeout(() => fail('ASR_CONNECT_TIMEOUT'), connectMs);
  const totalTimer = setTimeout(() => fail('ASR_TOTAL_TIMEOUT'), totalMs);
  const ageTimer = setInterval(() => { if (queued[0] && now() - queued[0].at > audioAgeMs) fail('ASR_AUDIO_EXPIRED'); }, 50);
  const aborted = () => fail('ASR_CANCELLED');

  function cleanup() {
    clearTimeout(connectTimer); clearTimeout(totalTimer); clearTimeout(finishTimer); clearInterval(ageTimer);
    queued.length = 0; queuedBytes = 0;
    options.signal.removeEventListener('abort', aborted);
  }
  function fail(code: string) {
    if (closed) return;
    closed = true; cleanup();
    const error = new Error(code);
    rejectReady(error); rejectResult(error);
    socket.terminate();
  }
  function send(type: string, fields: Record<string, unknown> = {}) {
    if (closed) return false;
    if (socket.bufferedAmount > 128_000) { fail('ASR_SEND_BACKPRESSURE'); return false; }
    try { socket.send(JSON.stringify({ event_id: randomUUID(), type, ...fields })); return true; }
    catch { fail('ASR_SEND_FAILED'); return false; }
  }
  // A connection owns exactly one utterance. Some official snapshots omit item_id;
  // use that connection's lifetime, but still reject conflicting explicit IDs.
  function matchesItem(value: unknown) {
    if (value === undefined) return true;
    if (typeof value !== 'string' || !value || (itemId !== null && itemId !== value)) return false;
    itemId = value;
    return true;
  }
  function flush() {
    if (!configured || closed) return;
    while (queued.length) {
      const frame = queued.shift()!; queuedBytes -= frame.pcm.length;
      if (now() - frame.at > audioAgeMs) { fail('ASR_AUDIO_EXPIRED'); return; }
      if (!send('input_audio_buffer.append', { audio: frame.pcm.toString('base64') })) return;
    }
    if (ended && !committed) {
      if (bytes < 3200) { fail('ASR_AUDIO_TOO_SHORT'); return; }
      committed = true;
      finishTimer = setTimeout(() => fail('ASR_FINAL_TIMEOUT'), finalMs);
      if (send('input_audio_buffer.commit')) send('session.finish');
    }
  }
  options.signal.addEventListener('abort', aborted, { once: true });
  if (options.signal.aborted) aborted();
  socket.on('open', () => { if (!closed) send('session.update', { session: { input_audio_format: 'pcm', sample_rate: 16000, input_audio_transcription: { language: 'zh' }, turn_detection: null } }); });
  socket.on('error', () => fail('ASR_TRANSPORT_ERROR'));
  socket.on('close', () => { if (!closed) fail('ASR_CLOSED_BEFORE_FINISH'); });
  socket.on('unexpected-response', (_request, response) => { response.resume(); fail(response.statusCode === 401 || response.statusCode === 403 ? 'ASR_AUTH_FAILED' : 'ASR_HANDSHAKE_FAILED'); });
  socket.on('message', (data, binary) => {
    if (closed) return;
    if (binary || Buffer.byteLength(data.toString()) > 65536) { fail('ASR_INVALID_EVENT'); return; }
    try {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      if (event.type === 'session.updated') {
        if (configured) return;
        configured = true; clearTimeout(connectTimer); resolveReady(); flush();
      } else if (event.type === 'conversation.item.created') {
        const item = event.item as Record<string, unknown> | undefined;
        if (!configured || !bytes || !item || !matchesItem(item.id)) { fail('ASR_ITEM_MISMATCH'); return; }
      } else if (event.type === 'input_audio_buffer.committed') {
        if (!committed || !matchesItem(event.item_id)) { fail('ASR_ITEM_MISMATCH'); return; }
        commitAcknowledged = true;
      } else if (event.type === 'conversation.item.input_audio_transcription.text') {
        if (!configured || !bytes || finalText !== null) return;
        if (!matchesItem(event.item_id)) { fail('ASR_ITEM_MISMATCH'); return; }
        const text = String(event.text ?? '') + String(event.stash ?? '');
        if (text.length > 8000) { fail('ASR_TEXT_LIMIT'); return; }
        try { options.onPartial?.({ text, final: false }); } catch { /* Preview must not control transcription. */ }
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        if (!committed || !commitAcknowledged || !matchesItem(event.item_id) || typeof event.transcript !== 'string' || event.transcript.length > 8000) { fail('ASR_INVALID_FINAL'); return; }
        if (finalText !== null && finalText !== event.transcript) { fail('ASR_CONFLICTING_FINAL'); return; }
        finalText = event.transcript;
      } else if (event.type === 'session.finished') {
        if (!committed || finalText === null) { fail('ASR_MISSING_FINAL'); return; }
        closed = true; cleanup(); resolveResult({ text: finalText.trim(), final: true, audioBytes: bytes });
        socket.close(1000);
        // A server ignoring the close handshake must not leave a retained socket.
        const timer = setTimeout(() => socket.terminate(), 1000); timer.unref?.();
        socket.on('close', () => clearTimeout(timer));
      } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') fail('ASR_PROVIDER_FAILED');
    } catch { fail('ASR_INVALID_EVENT'); }
  });
  return {
    ready, result,
    append(pcm: Buffer, capturedAt = now()) {
      if (closed || ended) return false;
      if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > 6400 || pcm.length % 2 || !Number.isFinite(capturedAt) || capturedAt > now() + 10) { fail('ASR_INVALID_PCM'); return false; }
      if (now() - capturedAt > audioAgeMs) { fail('ASR_AUDIO_EXPIRED'); return false; }
      if (bytes + pcm.length > 1_024_000 || queuedBytes + pcm.length > 64_000) { fail('ASR_AUDIO_LIMIT'); return false; }
      bytes += pcm.length; queuedBytes += pcm.length;
      queued.push({ pcm: Buffer.from(pcm), at: capturedAt }); flush();
      return !closed;
    },
    finish() { if (!closed) { ended = true; flush(); } return result; },
    cancel: () => fail('ASR_CANCELLED')
  };
}
