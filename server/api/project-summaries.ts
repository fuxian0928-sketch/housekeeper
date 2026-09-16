import type { Express } from 'express';
import { generateProjectSummary, listProjectSummaryVersions } from '../summaries/project-summary.js';

type Dependencies = { canUseModel: () => boolean; model: () => string; complete: (input: string) => Promise<string> };

export function registerProjectSummaryRoutes(app: Express, dependencies: Dependencies) {
  app.post('/api/projects/:id/summary', async (request, response) => {
    if (!dependencies.canUseModel()) { response.status(400).json({ message: '请先在设置中配置并开启大模型回答。' }); return; }
    try { response.json(await generateProjectSummary(request.params.id, dependencies.model(), dependencies.complete)); }
    catch (error) { response.status(Number((error as { statusCode?: number }).statusCode ?? 400)).json({ message: error instanceof Error ? `大模型总结失败：${error.message}` : '大模型总结失败，请稍后重试。' }); }
  });
  app.get('/api/projects/:id/summary/versions', (request, response) => response.json(listProjectSummaryVersions(request.params.id)));
}
