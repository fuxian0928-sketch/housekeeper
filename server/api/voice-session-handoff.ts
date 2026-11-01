import type { Express } from 'express';
import { VoiceSessionHandoffService, type VoiceSessionScope } from '../domain/conversations/voice-session-handoff.js';

export function registerVoiceSessionHandoffRoutes(app: Express, service: VoiceSessionHandoffService) {
  app.post('/api/voice/session-close', (request, response) => {
    const { conversationId, routingMode = 'life', projectId = null, deviceId = null } = request.body ?? {};
    if (typeof conversationId !== 'string' || typeof routingMode !== 'string' || (projectId !== null && typeof projectId !== 'string') || (deviceId !== null && typeof deviceId !== 'string')) {
      response.status(400).json({ message: '语音会话参数无效。' }); return;
    }
    try {
      const result = service.close(conversationId, { routingMode, projectId } as VoiceSessionScope, deviceId);
      response.json(result);
      if (result.created) setImmediate(() => { void service.summarize(conversationId); });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      response.status(message === 'VOICE_HANDOFF_NOT_VOICE_CONVERSATION' ? 404 : 400)
        .json({ message: message === 'VOICE_HANDOFF_NOT_VOICE_CONVERSATION' ? '这段语音对话不存在。' : '语音会话参数无效。' });
    }
  });
}
