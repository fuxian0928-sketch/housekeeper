import type { Express } from 'express';
import { configuredRealtimeAsrFactory, type TrustedRecognitionSettings } from '../providers/configured-realtime-asr.js';
import { createQwenRealtimeAsr } from '../providers/qwen-realtime-asr.js';

export function registerRealtimeSpeechRoutes(app: Express, settings: TrustedRecognitionSettings, connect = createQwenRealtimeAsr) {
  let testing = false;
  app.post('/api/speech/realtime/test', async (_request, response) => {
    if (testing) { response.status(409).json({message:'实时连接正在检测，请稍后再试。'}); return; }
    testing = true;
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel);
    const started = performance.now();
    try {
      const session = configuredRealtimeAsrFactory(settings,connect)(controller.signal,()=>{});
      await session.ready;
      if (!controller.signal.aborted) response.json({connected:true,recognitionVerified:false,latencyMs:Math.round(performance.now()-started)});
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof Error ? error.message : '';
      const message = code === 'ASR_REALTIME_NOT_CONFIGURED' ? '请先填写并保存实时识别模型。'
        : code === 'ASR_KEY_NOT_CONFIGURED' ? '请先配置语音服务使用的 API Key。'
        : code === 'ASR_AUTH_FAILED' ? '服务拒绝了认证，请检查密钥与业务空间是否对应。'
        : code === 'ASR_REALTIME_MODEL_UNSUPPORTED' ? '该模型不支持当前实时协议，请检查模型 ID。'
        : code.includes('TIMEOUT') ? '连接超时，请检查网络和服务地址后重试。'
        : '实时连接未通过，请检查模型、服务地址和密钥后重试。';
      response.status(502).json({message});
    } finally {
      controller.abort(); response.removeListener('close',cancel); testing=false;
    }
  });
}
