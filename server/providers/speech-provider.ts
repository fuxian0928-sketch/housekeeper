import wavefile from 'wavefile';
const { WaveFile } = wavefile;

type SpeechSettings = {
  speechServiceBaseUrl: string;
  speechRecognitionModel: string;
  speechSynthesisModel: string;
  speechVoice: string;
  speechInstruction: string;
};

// Some TTS responses retain streaming WAV size placeholders after download.
// The returned data URL is a complete file, so finalize its RIFF/data lengths.
export function finalizeWave(bytes: Buffer): Buffer {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return bytes;
  const result = Buffer.from(bytes);
  let offset = 12;
  while (offset + 8 <= result.length) {
    const name = result.toString('ascii', offset, offset + 4);
    const size = result.readUInt32LE(offset + 4);
    const remaining = result.length - offset - 8;
    if (size > remaining) {
      if (name !== 'data') throw new Error('合成 WAV 音频文件不完整。');
      result.writeUInt32LE(remaining, offset + 4);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

export function normalizeSpeechWave(bytes: Buffer): Buffer {
  const finalized = finalizeWave(bytes);
  if (finalized.length < 44 || finalized.toString('ascii', 0, 4) !== 'RIFF' || finalized.toString('ascii', 8, 12) !== 'WAVE') return finalized;
  const wave = new WaveFile(finalized);
  const format = wave.fmt as { sampleRate: number };
  if (format.sampleRate === 16000 && wave.bitDepth === '16') return finalized;
  // Resample the PCM, rather than relabeling its rate (which changes speed/pitch).
  wave.toSampleRate(16000, { method: 'sinc', LPF: true });
  wave.toBitDepth('16');
  return Buffer.from(wave.toBuffer());
}

function apiMessage(payload: Record<string, unknown>, fallback: string) {
  const message = typeof payload.message === 'string' ? payload.message : '';
  const error = payload.error && typeof payload.error === 'object' ? String((payload.error as Record<string, unknown>).message ?? '') : '';
  return error || message || fallback;
}

function speechEndpoint(baseUrl: string, path: string) {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, '/api/v1');
  if (!root) throw new Error('请先在设置中填写百炼业务空间服务地址。');
  if (!/\.maas\.aliyuncs\.com\/api\/v1$/.test(root) && !/dashscope[^/]*\.aliyuncs\.com\/api\/v1$/.test(root)) {
    throw new Error('语音服务地址应为百炼 API 根地址，并以 /api/v1 结尾。');
  }
  return `${root}${path}`;
}

export async function transcribeAudio(settings: SpeechSettings, apiKey: string, audioDataUrl: string, signal?: AbortSignal) {
  if (!/^data:audio\/(?:webm|wav|mpeg|mp3|ogg|opus|aac)(?:;codecs=[a-zA-Z0-9._-]+)?;base64,[a-zA-Z0-9+/=]+$/i.test(audioDataUrl) || audioDataUrl.length > 14_000_000) {
    throw Object.assign(new Error('录音格式不受支持或超过 10 MB。'), { statusCode: 400 });
  }
  const mime = audioDataUrl.slice(5, audioDataUrl.indexOf(';'));
  const format = mime.includes('wav') ? 'wav' : mime.includes('ogg') || mime.includes('opus') ? 'opus' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'webm';
  const result = await fetch(speechEndpoint(settings.speechServiceBaseUrl, '/services/aigc/multimodal-generation/generation'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
    body: JSON.stringify({
      model: settings.speechRecognitionModel,
      input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audioDataUrl } }] }] },
      parameters: { format, sample_rate: '16000' }
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000)
  });
  const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
  // Provider noise rejection is an empty transcript, not an upstream outage.
  if (payload.code === 'ASR_RESPONSE_HAVE_NO_WORDS' || apiMessage(payload, '') === 'ASR_RESPONSE_HAVE_NO_WORDS') return '';
  if (!result.ok) throw new Error(apiMessage(payload, `语音识别服务返回 ${result.status}。`));
  const output = payload.output && typeof payload.output === 'object' ? payload.output as Record<string, unknown> : {};
  const nested = output.output && typeof output.output === 'object' ? output.output as Record<string, unknown> : {};
  const sentence = nested.sentence && typeof nested.sentence === 'object' ? nested.sentence as Record<string, unknown> : {};
  const text = String(output.text ?? sentence.text ?? '').trim();
  if (!text && !('text' in output) && !('text' in sentence)) throw new Error('语音识别服务返回格式异常，请稍后重试。');
  return text;
}

export async function synthesizeSpeech(settings: SpeechSettings, apiKey: string, text: string) {
  const cleanText = text.trim().slice(0, 3000);
  if (!cleanText) throw Object.assign(new Error('没有可播报的文字。'), { statusCode: 400 });
  const result = await fetch(speechEndpoint(settings.speechServiceBaseUrl, '/services/audio/tts/SpeechSynthesizer'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.speechSynthesisModel, input: { text: cleanText, voice: settings.speechVoice, format: 'wav', sample_rate: 24000, ...(settings.speechInstruction ? { instruction: settings.speechInstruction } : {}) } }),
    signal: AbortSignal.timeout(90_000)
  });
  const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (!result.ok) throw new Error(apiMessage(payload, `语音合成服务返回 ${result.status}。`));
  const output = payload.output && typeof payload.output === 'object' ? payload.output as Record<string, unknown> : {};
  const audio = output.audio && typeof output.audio === 'object' ? output.audio as Record<string, unknown> : {};
  const url = String(audio.url ?? output.url ?? '').trim();
  let audioUrl: URL;
  try { audioUrl = new URL(url); } catch { throw new Error('语音合成模型没有返回音频。'); }
  const trustedOss = /(?:^|\.)oss-cn-beijing\.aliyuncs\.com$/i.test(audioUrl.hostname);
  if (audioUrl.protocol !== 'https:' && !(audioUrl.protocol === 'http:' && trustedOss)) throw new Error('语音合成返回了不可信的音频地址。');
  const audioResponse = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!audioResponse.ok) throw new Error(`合成音频下载失败：${audioResponse.status}。`);
  const downloaded = Buffer.from(await audioResponse.arrayBuffer());
  if (!downloaded.length || downloaded.length > 20_000_000) throw new Error('合成音频为空或过大。');
  const bytes = normalizeSpeechWave(downloaded);
  if (!bytes.length || bytes.length > 20_000_000) throw new Error('合成音频为空或过大。');
  return `data:${audioResponse.headers.get('content-type') || 'audio/wav'};base64,${bytes.toString('base64')}`;
}
