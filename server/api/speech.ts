import type { Express } from 'express';
import type { SettingsService } from '../domain/settings/settings-service.js';
import { synthesizeSpeech, transcribeAudio } from '../providers/speech-provider.js';

export function registerSpeechRoutes(app: Express, settingsService: SettingsService) {
  const feedbackCache = new Map<string, Promise<Record<string, Array<{text: string; audioDataUrl: string}>>>>();
  app.post('/api/speech/feedback', async (_request, response) => {
    try {
      const settings = settingsService.current();
      const apiKey = settingsService.effectiveApiKey();
      if (!apiKey) { response.json({}); return; }
      const key = JSON.stringify([settings.speechServiceBaseUrl, settings.speechSynthesisModel, settings.speechVoice, settings.speechInstruction]);
      let cached = feedbackCache.get(key);
      if (!cached) {
        const phrases = {
          thinking: ['嗯，让小E想一下。', '我还在整理怎么跟你说，主人稍等一下。'],
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
    try {
      const apiKey = settingsService.effectiveApiKey();
      if (!apiKey) throw Object.assign(new Error('请先配置百炼 API Key。'), { statusCode: 400 });
      const audioDataUrl = await synthesizeSpeech(settingsService.current(), apiKey, String((request.body as { text?: string }).text ?? ''));
      response.json({ audioDataUrl });
    } catch (error) { response.status(Number((error as { statusCode?: number }).statusCode ?? 502)).json({ message: error instanceof Error ? error.message : '语音合成失败。' }); }
  });
}
