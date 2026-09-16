import type { Express } from 'express';
import type { EmbeddingProvider } from '../providers/embedding-provider.js';
import { createMemory, getMemoryOverview, indexSingleMemory, listMemories, listMemorySources, updateMemory, type CreateMemoryInput } from '../domain/memories/memory-service.js';
import { captureUnobservedEvents, getUserProfile, listMemoryObservations, memoryLearningStatus, processPendingObservations, updateUserProfile, type CuratorCompletion } from '../domain/memories/memory-curator.js';

type Dependencies = { embeddingProvider: () => EmbeddingProvider | null; requestSignal: (request: Parameters<Express['get']>[0] extends never ? never : any, response: any) => AbortSignal; canUseModel: () => boolean; complete: CuratorCompletion };

function statusCode(error: unknown) { return Number((error as { statusCode?: number }).statusCode ?? 500); }

export function registerMemoryRoutes(app: Express, dependencies: Dependencies) {
  app.get('/api/memory-overview', (request, response) => response.json(getMemoryOverview(typeof request.query.projectId === 'string' ? request.query.projectId : null)));
  app.get('/api/memories', (request, response) => response.json(listMemories({ status: typeof request.query.status === 'string' ? request.query.status : null, projectId: typeof request.query.projectId === 'string' ? request.query.projectId : null })));
  app.get('/api/memories/:id/sources', (request, response) => { try { response.json(listMemorySources(request.params.id)); } catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '记忆来源读取失败。' }); } });
  app.post('/api/memories', async (request, response, next) => {
    try {
      const result = await createMemory(request.body as CreateMemoryInput, dependencies.embeddingProvider(), dependencies.requestSignal(request, response));
      response.status(result.created ? 201 : 200).json({ ...result.memory, relatedMemories: result.relatedMemories });
    } catch (error) {
      const status = statusCode(error);
      if (status < 500) response.status(status).json({ message: error instanceof Error ? error.message : '记忆操作失败。', code: (error as { code?: string }).code, relatedMemories: (error as { relatedMemories?: unknown }).relatedMemories, existingMemoryId: (error as { existingMemoryId?: string }).existingMemoryId });
      else next(error);
    }
  });
  app.patch('/api/memories/:id', async (request, response, next) => {
    try {
      const memory = updateMemory(request.params.id, request.body as Parameters<typeof updateMemory>[1]);
      if (memory.status === 'confirmed') await indexSingleMemory(request.params.id, dependencies.embeddingProvider(), dependencies.requestSignal(request, response)).catch(() => false);
      response.json(memory);
    } catch (error) { const status = statusCode(error); if (status < 500) response.status(status).json({ message: error instanceof Error ? error.message : '记忆更新失败。' }); else next(error); }
  });
  app.get('/api/memory-learning/status', (_request, response) => response.json(memoryLearningStatus()));
  app.get('/api/memory-learning/observations', (request, response) => response.json(listMemoryObservations(Math.min(Number(request.query.limit) || 100, 500))));
  app.post('/api/memory-learning/run', async (_request, response) => {
    try {
      if (!dependencies.canUseModel()) { response.status(400).json({ message: '自动整理记忆需要先开启大模型并配置 API Key。' }); return; }
      captureUnobservedEvents();
      response.json(await processPendingObservations(dependencies.complete, dependencies.embeddingProvider(), 100));
    } catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '自动整理记忆失败。' }); }
  });
  app.get('/api/user-profile', (_request, response) => response.json(getUserProfile()));
  app.put('/api/user-profile', async (request, response) => {
    try {
      const result = updateUserProfile((request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>);
      if (dependencies.canUseModel()) await processPendingObservations(dependencies.complete, dependencies.embeddingProvider(), 20);
      response.json({ ...result, learning: memoryLearningStatus() });
    } catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '用户介绍保存失败。' }); }
  });
}
