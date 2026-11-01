/** Opt-in official probe: fixed non-private text, no microphone or speaker. */
import fs from 'node:fs/promises';
import { createQwenRealtimeTts } from '../../server/providers/qwen-realtime-tts.js';

async function main() {
  const report = process.argv[2];
  const apiKey = process.env.DASHSCOPE_API_KEY, baseUrl = process.env.VOICE_TTS_BASE_URL;
  const model = process.env.VOICE_TTS_MODEL, voice = process.env.VOICE_TTS_VOICE;
  if (!report || !apiKey || !baseUrl || !model || !voice) throw Error('EXPLICIT_TTS_CONNECTION_REQUIRED');
  const speechRate = Number(process.env.VOICE_TTS_SPEECH_RATE ?? 1);
  if (!Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2) throw Error('INVALID_SPEECH_RATE');
  const began = performance.now(), controller = new AbortController();
  const cancelAfterFirst = process.env.VOICE_TTS_CANCEL_AFTER_FIRST === '1';
  let cancelledAt: number | null = null;
  let firstAudioMs: number | null = null, connectedMs: number | null = null;
  let bytes = 0, peak = 0, energy = 0, chunks = 0;
  let failure: string | null = null;
  try {
    const tts = createQwenRealtimeTts({ apiKey, baseUrl, model, voice, speechRate, signal: controller.signal });
    await tts.ready; connectedMs = performance.now() - began;
    if (!tts.append('主人，我在。流式语音测试正在进行，请继续说吧。') || !tts.finish()) throw Error('TTS_TEXT_REJECTED');
    for await (const pcm of tts.audio) {
      firstAudioMs ??= performance.now() - began; bytes += pcm.length; chunks++;
      for (let i = 0; i < pcm.length; i += 2) { const value = pcm.readInt16LE(i); peak = Math.max(peak, Math.abs(value)); energy += value * value; }
      if (cancelAfterFirst) { cancelledAt = performance.now(); controller.abort(); }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    failure = cancelledAt !== null && controller.signal.aborted ? 'TTS_CANCELLED' : /^TTS_[A-Z_]+$/.test(code) ? code : 'PROBE_FAILED';
  } finally { controller.abort(); }
  const evidence = { test: 'official-qwen-stream-tts', model, voice, speechRate, connectedMs, firstAudioMs,
    elapsedMs: performance.now() - began, audioMs: bytes / 32, chunks, peak, rms: bytes ? Math.sqrt(energy / (bytes / 2)) : 0,
    sampleRate: 16000, failure, cancelAfterFirst, cancelSettledMs: cancelledAt === null ? null : performance.now() - cancelledAt,
    audioSaved: false, speakerPlayed: false, completedAt: new Date().toISOString() };
  await fs.writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(evidence));
  if (cancelAfterFirst ? failure !== 'TTS_CANCELLED' || chunks !== 1 : failure || !peak) process.exitCode = 1;
}
void main().catch(() => { console.error('TTS_PROBE_SETUP_FAILED'); process.exitCode = 1; });
