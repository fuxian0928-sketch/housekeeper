import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { qwenRealtimeUrl } from './qwen-realtime-asr.js';

type Socket = Pick<WebSocket, 'on' | 'send' | 'close' | 'terminate' | 'pause' | 'resume' | 'bufferedAmount'>;
// PCM16 mono 16kHz: permit a long answer without retaining it in memory.
// Pause the WebSocket receiver when synthesis gets ahead of device playback.
const MAX_TURN_AUDIO_BYTES = 5_760_000; // 180 seconds, matching native playback.
const PAUSE_QUEUE_BYTES = 256_000; // 8 seconds.
const RESUME_QUEUE_BYTES = 128_000; // 4 seconds.
const MAX_QUEUE_BYTES = 384_000; // Pause threshold plus one maximum WebSocket event.
export type SpeechSynthesisMetric = {stage:'tts-first-raw-pcm'|'tts-first-voiced-pcm'|'tts-buffer-ready'|'tts-production';values?:Record<string,number>};
export type RealtimeTtsOptions = {
  baseUrl: string; model: string; apiKey: string; voice: string; signal: AbortSignal;
  connectMs?: number; totalMs?: number; speechRate?: number;
  createSocket?: (url: string, apiKey: string) => Socket;
  onMetric?: (metric:SpeechSynthesisMetric) => void;
};

/** Trusted-service transport. One connection per turn; never retries old speech.
 * PCM is explicitly negotiated at 16kHz. Legacy 24k-only models are rejected.
 * Completion means synthesis ended, NOT that any device played the audio.
 */
export function createQwenRealtimeTts(options: RealtimeTtsOptions) {
  if (!/^qwen3-tts-(?:instruct-)?flash-realtime(?:-[\w.-]+)?$/.test(options.model)) throw Error('TTS_UNSUPPORTED_MODEL');
  const url = qwenRealtimeUrl(options.baseUrl, options.model);
  if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || !/^[\w.-]{1,160}$/.test(options.voice)) throw Error('TTS_INVALID_CONFIGURATION');
  const speechRate = options.speechRate ?? 1;
  if (!Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2) throw Error('TTS_INVALID_SPEECH_RATE');
  const connectMs = options.connectMs ?? 5000, totalMs = options.totalMs ?? 35000;
  if (![connectMs, totalMs].every(n => Number.isFinite(n) && n > 0 && n <= 60000)) throw Error('TTS_INVALID_BUDGET');
  options.signal.throwIfAborted();
  const socket = options.createSocket?.(url, options.apiKey) ?? new WebSocket(url, {
    headers: { Authorization: `Bearer ${options.apiKey}` }, handshakeTimeout: connectMs,
    maxPayload: 131072, perMessageDeflate: false, followRedirects: false
  });
  let configured = false, inputEnded = false, finished = false, failure: Error | undefined;
  let textLength = 0, audioBytes = 0, queuedBytes = 0, consuming = false, receiverPaused = false;
  const queue: Buffer[] = [];
  let wake: (() => void) | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const connectTimer = setTimeout(() => fail('TTS_CONNECT_TIMEOUT'), connectMs);
  let totalTimer = setTimeout(() => fail('TTS_TOTAL_TIMEOUT'), totalMs);
  const turnTimer = setTimeout(() => fail('TTS_TURN_TIMEOUT'), 240_000);
  const aborted = () => fail('TTS_CANCELLED');
  function notify() { const pending = wake; wake = undefined; pending?.(); }
  function progress() { clearTimeout(totalTimer); totalTimer = setTimeout(() => fail('TTS_TOTAL_TIMEOUT'), totalMs); }
  function clearQueue() { for (const chunk of queue) chunk.fill(0); queue.length = 0; queuedBytes = 0; }
  function cleanup() { clearTimeout(connectTimer); clearTimeout(totalTimer); clearTimeout(turnTimer); options.signal.removeEventListener('abort', aborted); }
  function fail(code: string) {
    if (failure) return;
    failure = Error(code); cleanup(); clearQueue(); rejectReady(failure); notify(); socket.terminate();
  }
  function send(type: string, fields: Record<string, unknown> = {}) {
    if (failure || finished) return false;
    if (socket.bufferedAmount > 16000) { fail('TTS_SEND_BACKPRESSURE'); return false; }
    try { socket.send(JSON.stringify({ event_id: randomUUID(), type, ...fields })); return true; }
    catch { fail('TTS_SEND_FAILED'); return false; }
  }
  options.signal.addEventListener('abort', aborted, { once: true });
  socket.on('open', () => send('session.update', { session: {
    speech_rate: speechRate, voice: options.voice, mode: 'server_commit', response_format: 'pcm', sample_rate: 16000, language_type: 'Auto'
  } }));
  socket.on('error', () => { if (!finished) fail('TTS_TRANSPORT_ERROR'); });
  socket.on('close', () => { if (!finished) fail('TTS_CLOSED_BEFORE_FINISH'); });
  socket.on('unexpected-response', (_request, response) => { response.resume(); fail(response.statusCode === 401 || response.statusCode === 403 ? 'TTS_AUTH_FAILED' : 'TTS_HANDSHAKE_FAILED'); });
  socket.on('message', (raw, binary) => {
    if (failure || finished) return;
    if (binary || Buffer.byteLength(raw.toString()) > 131072) { fail('TTS_INVALID_EVENT'); return; }
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.updated') {
        if (configured) return;
        if (event.session?.sample_rate !== 16000 || event.session?.response_format !== 'pcm' || event.session?.mode !== 'server_commit') { fail('TTS_FORMAT_MISMATCH'); return; }
        configured = true; clearTimeout(connectTimer); resolveReady();
        progress();
      } else if (event.type === 'response.audio.delta') {
        if (!configured || !textLength || typeof event.delta !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) { fail('TTS_INVALID_AUDIO'); return; }
        const pcm = Buffer.from(event.delta, 'base64');
        if (!pcm.length || pcm.length % 2 || audioBytes + pcm.length > MAX_TURN_AUDIO_BYTES) { fail('TTS_AUDIO_LIMIT'); return; }
        if (queuedBytes + pcm.length > MAX_QUEUE_BYTES) { fail('TTS_QUEUE_LIMIT'); return; }
        audioBytes += pcm.length; queuedBytes += pcm.length;
        for (let i = 0; i < pcm.length; i += 6400) queue.push(Buffer.from(pcm.subarray(i, i + 6400)));
        pcm.fill(0); progress();
        if (!receiverPaused && queuedBytes >= PAUSE_QUEUE_BYTES) {
          try { socket.pause(); receiverPaused = true; } catch { fail('TTS_BACKPRESSURE_FAILED'); return; }
        }
        notify();
      } else if (event.type === 'response.done' && event.response?.status !== 'completed') fail('TTS_RESPONSE_FAILED');
      else if (event.type === 'response.done') progress();
      else if (event.type === 'error') fail('TTS_PROVIDER_FAILED');
      else if (event.type === 'session.finished') {
        if (!inputEnded || !audioBytes) { fail('TTS_MISSING_AUDIO'); return; }
        finished = true; clearTimeout(connectTimer); clearTimeout(totalTimer); clearTimeout(turnTimer); notify(); socket.close(1000);
        const timer = setTimeout(() => socket.terminate(), 1000); timer.unref?.(); socket.on('close', () => clearTimeout(timer));
        // Keep lifetime cancellation active until the consumer drains the queue.
      }
    } catch { fail('TTS_INVALID_EVENT'); }
  });
  if (options.signal.aborted) aborted();
  return {
    ready,
    append(text: string) {
      if (!configured || inputEnded || finished || failure) return false;
      if (typeof text !== 'string' || !text.length || textLength + text.length > 3000) { fail('TTS_TEXT_LIMIT'); return false; }
      textLength += text.length;
      const accepted = send('input_text_buffer.append', { text });
      if (accepted) progress();
      return accepted;
    },
    finish() {
      if (!configured || inputEnded || !textLength || finished || failure) return false;
      inputEnded = true;
      const accepted = send('session.finish');
      if (accepted) progress();
      return accepted;
    },
    cancel: aborted,
    audio: {
      async *[Symbol.asyncIterator]() {
        if (consuming) throw Error('TTS_SINGLE_CONSUMER');
        consuming = true;
        try {
          while (true) {
            options.signal.throwIfAborted();
            if (failure) throw failure;
            const chunk = queue.shift();
            if (chunk) {
              queuedBytes -= chunk.length;
              if (receiverPaused && queuedBytes <= RESUME_QUEUE_BYTES) {
                try { socket.resume(); receiverPaused = false; } catch { fail('TTS_BACKPRESSURE_FAILED'); throw failure; }
              }
              yield chunk;
            }
            else if (finished) return;
            else await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally { cleanup(); clearQueue(); if (!finished || failure) aborted(); }
      }
    }
  };
}
