import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeWave, normalizeSpeechWave, synthesizeSpeech, transcribeAudio } from './speech-provider.js';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;

test('speech normalization preserves duration and audible pitch at 16 kHz', () => {
  const source = new WaveFile();
  source.fromScratch(1, 24000, '16', Array.from({ length: 24000 }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / 24000))));
  const bytes = normalizeSpeechWave(Buffer.from(source.toBuffer()));
  const output = new WaveFile(bytes);
  assert.equal((output.fmt as {sampleRate: number}).sampleRate, 16000);
  const samples = output.getSamples(true) as Float64Array;
  assert.ok(Math.abs(samples.length - 16000) <= 1);
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i-1] <= 0 && samples[i] > 0) crossings++;
  assert.ok(Math.abs(crossings - 440) <= 2, String(crossings));
  assert.deepEqual(normalizeSpeechWave(bytes), bytes);
});

test('finalizes streaming WAV placeholders without changing PCM samples', () => {
  const wav = Buffer.alloc(52);
  wav.write('RIFF', 0); wav.writeUInt32LE(0x7fffffbf, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(0x7fffff9b, 40); wav.writeInt16LE(1234, 44);
  const result = finalizeWave(wav);
  assert.equal(result.readUInt32LE(4), 44);
  assert.equal(result.readUInt32LE(40), 8);
  assert.deepEqual(result.subarray(44), wav.subarray(44));
  assert.deepEqual(finalizeWave(result), result);
});

const settings = {
  speechServiceBaseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1',
  speechRecognitionModel: 'qwen-audio-3.0-asr-flash',
  speechSynthesisModel: 'qwen-audio-3.0-tts-flash',
  speechVoice: 'longanhuan_v3.6',
  speechInstruction: '温柔干练'
};

test('provider noise rejection is an empty transcript, while upstream failures remain errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'ASR_RESPONSE_HAVE_NO_WORDS' }), { status: 400 })) as typeof fetch;
    assert.equal(await transcribeAudio(settings, 'test-key', 'data:audio/wav;base64,YXVkaW8='), '');
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 })) as typeof fetch;
    await assert.rejects(transcribeAudio(settings, 'test-key', 'data:audio/wav;base64,YXVkaW8='), /Service unavailable/);
  } finally { globalThis.fetch = originalFetch; }
});

test('transcribeAudio sends a DashScope multimodal request and reads the transcript', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ output: { output: { sentence: { text: '你好小E' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.equal(await transcribeAudio(settings, 'test-key', 'data:audio/webm;base64,YXVkaW8='), '你好小E');
    assert.match(requestUrl, /multimodal-generation\/generation$/);
    assert.equal(JSON.parse(requestBody).model, settings.speechRecognitionModel);
  } finally { globalThis.fetch = originalFetch; }
});

test('transcribeAudio accepts Electron MediaRecorder codec parameters', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ output: { output: { sentence: { text: '测试成功' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    assert.equal(await transcribeAudio(settings, 'test-key', 'data:audio/webm;codecs=opus;base64,YXVkaW8='), '测试成功');
  } finally { globalThis.fetch = originalFetch; }
});

test('synthesizeSpeech downloads the generated audio and returns a playable data URL', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ output: { audio: { url: 'https://audio.example/test.wav' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }) as typeof fetch;
  try {
    assert.equal(await synthesizeSpeech(settings, 'test-key', '你好'), 'data:audio/wav;base64,UklGRg==');
  } finally { globalThis.fetch = originalFetch; }
});
