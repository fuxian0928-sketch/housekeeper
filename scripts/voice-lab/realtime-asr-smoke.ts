/** Opt-in cloud probe. Sends only the explicitly named WAV; never opens microphone.
 * Run with DASHSCOPE_API_KEY / VOICE_ASR_BASE_URL / VOICE_ASR_MODEL in process environment.
 * No credentials or transcript are written to output. Input fixture must be non-private.
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import wavefile from 'wavefile';
import { createQwenRealtimeAsr } from '../../server/providers/qwen-realtime-asr.js';

async function main() {
  const [input, report] = process.argv.slice(2);
  if (!input || !report) throw new Error('USAGE_WAV_AND_REPORT_REQUIRED');
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const baseUrl = process.env.VOICE_ASR_BASE_URL;
  const model = process.env.VOICE_ASR_MODEL;
  if (!apiKey || !baseUrl || !model) throw new Error('EXPLICIT_REALTIME_CONNECTION_REQUIRED');
  const stat = await fs.stat(input);
  if (stat.size > 4_000_000) throw new Error('FIXTURE_TOO_LARGE');
  const raw = await fs.readFile(input);
  const wav = new wavefile.WaveFile(raw);
  const fmt = wav.fmt as { numChannels: number; sampleRate: number; audioFormat: number; bitsPerSample: number };
  if (fmt.numChannels !== 1 || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) throw new Error('FIXTURE_MUST_BE_MONO_PCM16');
  wav.toSampleRate(16000, { method: 'sinc', LPF: true });
  const samples = wav.getSamples(true);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
  if (pcm.length < 3200 || pcm.length > 960000) throw new Error('FIXTURE_DURATION_OUT_OF_RANGE');
  const began = performance.now();
  let firstPartialMs: number | null = null;
  const controller = new AbortController();
  const asr = createQwenRealtimeAsr({ apiKey, baseUrl, model, signal: controller.signal, onPartial: () => { firstPartialMs ??= performance.now() - began; } });
  let completedSending = 0;
  try {
    await asr.ready;
    const connectedMs = performance.now() - began;
    const captureStart = performance.now();
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      const capturedAt = captureStart + offset / 32;
      const wait = capturedAt - performance.now();
      if (wait > 0) await delay(wait);
      if (!asr.append(pcm.subarray(offset, offset + 3200), capturedAt)) throw new Error('AUDIO_REJECTED');
    }
    completedSending = performance.now();
    const final = await asr.finish();
    const evidence = { test: 'qwen-realtime-official-synthetic-fixture', model,
      fixtureSha256: createHash('sha256').update(raw).digest('hex'), audioMs: pcm.length / 32,
      connectedMs, firstPartialMs, finalAfterLastChunkMs: performance.now() - completedSending,
      transcriptCharacters: final.text.length, nonempty: final.text.length > 0,
      exactExpectedMatch: process.env.VOICE_ASR_EXPECTED ? final.text.replace(/[\p{P}\s]/gu,'') === process.env.VOICE_ASR_EXPECTED.replace(/[\p{P}\s]/gu,'') : null,
      transcriptSaved: false, liveMicrophone: false, completedAt: new Date().toISOString() };
    await fs.writeFile(report, JSON.stringify(evidence,null,2)+'\n', { flag: 'wx' });
    console.log(JSON.stringify(evidence));
    if (!evidence.nonempty) process.exitCode = 1;
  } finally { controller.abort(); }
}
main().catch(error => {
  const code = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'PROBE_FAILED';
  console.error(code); process.exitCode = 1;
});
