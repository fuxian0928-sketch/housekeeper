import type { Express } from 'express';
import type { SettingsService } from '../domain/settings/settings-service.js';
import { synthesizeSpeech, transcribeAudio } from '../providers/speech-provider.js';
import { registerRealtimeSpeechRoutes } from './realtime-speech.js';

export function registerSpeechRoutes(app: Express, settingsService: SettingsService) {
  app.use('/api/speech',(request,response,next)=>{
    if(settingsService.current().speechExecution!=='local'){next();return;}
    if(request.path==='/feedback'){response.json({});return;}
    response.status(409).json({message:'当前选择本机语音。请在 Windows 客户端使用本机识别和希微音色；云端语音不会自动启用。'});
  });
  registerRealtimeSpeechRoutes(app,settingsService);
  const feedbackCache = new Map<string, Promise<Record<string, Array<{text: string; audioDataUrl: string}>>>>();
  app.post('/api/speech/feedback', async (_request, response) => {
    try {
      const settings = settingsService.current();
      const apiKey = settingsService.effectiveApiKey();
      if (!apiKey) { response.json({}); return; }
      const key = JSON.stringify([settings.speechLegacySynthesisBaseUrl, settings.speechSynthesisModel, settings.speechVoice, settings.speechInstruction]);
      let cached = feedbackCache.get(key);
      if (!cached) {
        const phrases = {
          thinking: ['嗯，让希微想一下。', '我还在整理怎么跟你说，主人稍等一下。'],
          retrieval: ['我查一下相关资料，主人稍等。', '资料还在查找中，再等我一下。'],
          vision: ['我正在看画面，主人稍等。', '画面还在分析中，再等我一下。']
        };
        cached = (async () => {
          const result: Record<string, Array<{text: string; audioDataUrl: string}>> = {};
          for (const [stage, texts] of Object.entries(phrases)) {
            result[stage] = [];
            for (const text of texts) {
              for (let attempt = 0; ; attempt++) {
                try {
                  result[stage].push({text, audioDataUrl: await synthesizeSpeech(settings, apiKey, text)});
                  break;
                } catch (error) {
                  if (attempt >= 2 || !/rate.limit|429|限流/i.test(error instanceof Error ? error.message : '')) throw error;
                  await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                }
              }
              await new Promise(resolve => setTimeout(resolve, 600));
            }
          }
          return result;
        })();
        if (feedbackCache.size >= 4) feedbackCache.delete(feedbackCache.keys().next().value!);
        feedbackCache.set(key, cached);
        void cached.catch(() => { if (feedbackCache.get(key) === cached) feedbackCache.delete(key); });
      }
      response.json(await cached);
    } catch { response.status(503).json({message: '等待提示暂未准备好'}); }
  });

  app.post('/api/speech/transcribe', async (request, response) => {
    const started = Date.now();
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel);
    try {
      const apiKey = settingsService.effectiveApiKey();
      if (!apiKey) throw Object.assign(new Error('请先配置百炼 API Key。'), { statusCode: 400 });
      const text = await transcribeAudio(settingsService.current(), apiKey, String((request.body as { audioDataUrl?: string }).audioDataUrl ?? ''), controller.signal);
      console.info('[speech]', JSON.stringify({stage:'asr',status:text ? 'succeeded' : 'no_speech',ms:Date.now()-started}));
      response.json({ text });
    } catch (error) {
      console.info('[speech]', JSON.stringify({stage:'asr',status:controller.signal.aborted?'cancelled':'failed',ms:Date.now()-started,code:error instanceof DOMException?error.name:'ServiceError'}));
      if (!controller.signal.aborted) response.status(Number((error as { statusCode?: number }).statusCode ?? 502)).json({ message: error instanceof Error ? error.message : '语音识别失败。' });
    } finally { response.removeListener('close', cancel); }
  });

  app.post('/api/speech/synthesize', async (request, response) => {
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel);
    try {
      const apiKey = settingsService.effectiveApiKey();
      if (!apiKey) throw Object.assign(new Error('请先配置百炼 API Key。'), { statusCode: 400 });
      const audioDataUrl = await synthesizeSpeech(settingsService.current(), apiKey, String((request.body as { text?: string }).text ?? ''), controller.signal);
      if (!controller.signal.aborted) response.json({ audioDataUrl });
    } catch (error) {
      if (!controller.signal.aborted) response.status(Number((error as { statusCode?: number }).statusCode ?? 502)).json({ message: error instanceof Error ? error.message : '语音合成失败。' });
    } finally { response.removeListener('close', cancel); }
  });

  app.post('/api/speech/connection/test', async (request, response) => {
    const body = request.body as { purpose?: string; url?: string; model?: string; voice?: string; instruction?: string };
    if (!['asr', 'tts'].includes(body.purpose ?? '') || typeof body.url !== 'string' || typeof body.model !== 'string' || body.url.length > 500 || body.model.length > 160 || (body.purpose === 'tts' && (typeof body.voice !== 'string' || body.voice.length > 160 || typeof body.instruction !== 'string' || body.instruction.length > 500))) {
      response.status(400).json({ message: '语音连接草稿不完整。' }); return;
    }
    const apiKey = settingsService.effectiveApiKey();
    if (!apiKey) { response.status(400).json({ message: '当前执行服务器未配置语音服务凭据。' }); return; }
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    try {
      const current = settingsService.current();
      if (body.purpose === 'asr') {
        const wave = Buffer.alloc(44 + 32000);
        wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
        wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
        wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
        wave.write('data', 36); wave.writeUInt32LE(32000, 40);
        await transcribeAudio({ ...current, speechLegacyRecognitionBaseUrl: body.url.trim(), speechRecognitionModel: body.model.trim() }, apiKey, `data:audio/wav;base64,${wave.toString('base64')}`, signal);
        if (!signal.aborted) response.json({ connected: true, stage: 'provider-response', detail: '服务已响应静音测试；尚未验证麦克风或真人语音识别。' });
      } else {
        const audio = await synthesizeSpeech({ ...current, speechLegacySynthesisBaseUrl: body.url.trim(), speechSynthesisModel: body.model.trim(), speechVoice: String(body.voice ?? '').trim(), speechInstruction: String(body.instruction ?? '').trim() }, apiKey, '希微连接测试。', signal);
        if (!signal.aborted) response.json({ connected: audio.startsWith('data:audio/'), stage: 'audio-generated', detail: '服务已生成音频；尚未验证扬声器实际出声。' });
      }
    } catch (error) {
      if (!signal.aborted) response.status(Number((error as { statusCode?: number }).statusCode ?? 502)).json({ message: error instanceof Error ? error.message : '连接测试失败。' });
    } finally { response.removeListener('close', cancel); }
  });
}
