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
test('compatibility recognition and synthesis use their independently saved URLs', async () => {
  const originalFetch = globalThis.fetch;
  const called: string[] = [];
  globalThis.fetch = (async input => {
    called.push(String(input));
    if (called.length === 1) return new Response(JSON.stringify({ output: { output: { sentence: { text: '收到' } } } }), { status: 200 });
    if (called.length === 2) return new Response(JSON.stringify({ output: { audio: { url: 'https://audio.example/test.wav' } } }), { status: 200 });
    return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }) as typeof fetch;
  try {
    const split = { ...settings, speechLegacyRecognitionBaseUrl: 'https://asr.cn-beijing.maas.aliyuncs.com/api/v1', speechLegacySynthesisBaseUrl: 'https://tts.cn-beijing.maas.aliyuncs.com/api/v1' };
    await transcribeAudio(split, 'test-key', 'data:audio/wav;base64,YXVkaW8=');
    await synthesizeSpeech(split, 'test-key', '你好');
    assert.match(called[0], /^https:\/\/asr\.cn-beijing\.maas\.aliyuncs\.com\//);
    assert.match(called[1], /^https:\/\/tts\.cn-beijing\.maas\.aliyuncs\.com\//);
  } finally { globalThis.fetch = originalFetch; }
});
test('compatibility provider rejects lookalike service URLs before any request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(); }) as typeof fetch;
  try {
    for (const url of ['http://dashscope.aliyuncs.com/api/v1', 'https://dashscope.aliyuncs.com.evil.example/api/v1', 'https://127.0.0.1/path/dashscope.aliyuncs.com/api/v1', 'https://dashscope.aliyuncs.com/api/v1?target=evil']) {
      await assert.rejects(transcribeAudio({ ...settings, speechLegacyRecognitionBaseUrl: url }, 'test-key', 'data:audio/wav;base64,YXVkaW8='));
    }
    assert.equal(calls, 0);
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

test('cancelled synthesis does not start a request or download a late response', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      controller.abort();
      return new Response(JSON.stringify({ output: { url: 'https://audio.example/late.wav' } }));
    }) as typeof fetch;
    await assert.rejects(synthesizeSpeech(settings, 'test', '你好', controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
    await assert.rejects(synthesizeSpeech(settings, 'test', '你好', controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('synthesis and download share cancellation through response body consumption', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  try {
    globalThis.fetch = (async (_url, init) => {
      signals.push(init!.signal!);
      if (signals.length === 1) return new Response(JSON.stringify({ output: { url: 'https://audio.example/test.wav' } }));
      return {
        ok: true,
        arrayBuffer: async () => { controller.abort(); return new ArrayBuffer(4); }
      } as Response;
    }) as typeof fetch;
    await assert.rejects(synthesizeSpeech(settings, 'test', '你好', controller.signal), { name: 'AbortError' });
    assert.equal(signals.length, 2);
    assert.equal(signals[0], signals[1]);
    assert.equal(signals[1].aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});


test('download MIME aliases do not break a verified WAV synthesis-to-recognition round trip', async () => {
  const originalFetch = globalThis.fetch;
  const wav = new WaveFile(); wav.fromScratch(1, 16000, '16', [0, 200, -200, 0]);
  try {
    for (const mime of ['application/octet-stream', 'audio/x-wav', 'audio/wav; charset=binary']) {
      let call = 0;
      globalThis.fetch = (async (_url, init) => {
        call++;
        if (call === 1) return new Response(JSON.stringify({output:{audio:{url:'https://audio.example/test.wav'}}}));
        if (call === 2) return new Response(new Uint8Array(wav.toBuffer()), {headers:{'content-type':mime}});
        const data = JSON.parse(String(init?.body)).input.messages[0].content[0].input_audio.data;
        assert.match(data, /^data:audio\/wav;base64,/);
        assert.deepEqual(Buffer.from(data.split(',')[1], 'base64'), Buffer.from(wav.toBuffer()));
        return new Response(JSON.stringify({output:{text:'fixed fixture'}}));
      }) as typeof fetch;
      const audio = await synthesizeSpeech(settings, 'fixture-key', 'fixed fixture');
      assert.equal(await transcribeAudio(settings, 'fixture-key', audio), 'fixed fixture');
      assert.equal(call, 3);
    }
  } finally { globalThis.fetch = originalFetch; }
});
