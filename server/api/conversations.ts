import type { Express } from 'express';
import { compressionTranscript, getConversation, listConversations, saveCompression, renameConversation, deleteConversation } from '../domain/conversations/conversation-service.js';

type Dependencies = { canUseModel: () => boolean; complete: (input: string, options: { instruction: string; maxTokens: number }) => Promise<string> };
function send(response: any, error: unknown) { response.status(Number((error as { statusCode?: number }).statusCode ?? 500)).json({ message: error instanceof Error ? error.message : '对话操作失败。' }); }

export function registerConversationRoutes(app: Express, dependencies: Dependencies) {
  app.patch('/api/conversations/:id', (request, response) => { try { response.json(renameConversation(request.params.id, request.body?.title)); } catch (error) { send(response, error); } });
  app.delete('/api/conversations/:id', (request, response) => { try { response.json(deleteConversation(request.params.id)); } catch (error) { send(response, error); } });
  app.get('/api/conversations', (request, response) => { try { response.json(listConversations({ scope: typeof request.query.scope === 'string' ? request.query.scope : undefined, projectId: typeof request.query.projectId === 'string' ? request.query.projectId : null })); } catch (error) { send(response, error); } });
  app.get('/api/conversations/:id', (request, response) => { try { response.json(getConversation(request.params.id)); } catch (error) { send(response, error); } });
  app.post('/api/conversations/:id/compress', async (request, response) => {
    try {
      if (!dependencies.canUseModel()) { response.status(400).json({ message: '请先在设置中开启大模型并填写 API Key。' }); return; }
      const { messages, transcript } = compressionTranscript(request.params.id);
      const summary = await dependencies.complete(transcript, { instruction: '把这段对话压缩成可供后续继续交流的中文上下文。保留用户目标、已经确认的事实、决定、约束、未解决问题和关键资料来源；删除寒暄、重复表达和无关细节。只输出摘要正文。', maxTokens: 1200 });
      response.json(saveCompression(request.params.id, summary, messages.length));
    } catch (error) { send(response, error); }
  });
}
