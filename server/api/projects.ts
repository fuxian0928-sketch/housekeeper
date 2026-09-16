import type { Express, Request, Response } from 'express';
import type { ScanProgress, ScanResult } from '../vault.js';
import { confirmProjectSuggestions, createProject, listProjects, projectDocuments, projectOverview, recordProjectScan, restoreProject, trashProject, updateProject } from '../domain/projects/project-service.js';

type Settings = { aiEnabled: boolean; hasApiKey: boolean; vaultPath: string };
type Dependencies = { settings: () => Settings; scan: (options?: { signal?: AbortSignal; onProgress?: (progress: ScanProgress) => void }) => Promise<ScanResult>; generateSuggestions: (signal?: AbortSignal, progress?: (message: string) => void) => Promise<unknown>; requestSignal: (request: Request, response: Response) => AbortSignal };
function send(response: Response, error: unknown) { response.status(Number((error as { statusCode?: number }).statusCode ?? 500)).json({ message: error instanceof Error ? error.message : '项目操作失败。' }); }
function begin(response: Response) { response.status(200); response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); response.setHeader('Cache-Control', 'no-cache, no-transform'); response.setHeader('X-Accel-Buffering', 'no'); response.flushHeaders(); }
function write(response: Response, value: Record<string, unknown>) { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(value)}\n`); }

export function registerProjectRoutes(app: Express, dependencies: Dependencies) {
  app.get('/api/projects', (request, response) => response.json(listProjects(request.query.includeArchived === '1')));
  app.post('/api/projects', (request, response) => { try { response.status(201).json(createProject(request.body, dependencies.settings().vaultPath)); } catch (error) { send(response, error); } });
  app.get('/api/projects/trash', (_request, response) => response.json(listProjects(true, true)));
  app.delete('/api/projects/:id', (request, response) => { try { response.json(trashProject(request.params.id, String(request.body?.confirmationName ?? ''))); } catch (error) { send(response, error); } });
  app.post('/api/projects/:id/restore', (request, response) => { try { response.json(restoreProject(request.params.id)); } catch (error) { send(response, error); } });
  app.patch('/api/projects/:id', (request, response) => { try { response.json(updateProject(request.params.id, request.body, dependencies.settings().vaultPath)); } catch (error) { send(response, error); } });
  app.get('/api/projects/:id/overview', (request, response) => { try { response.json(projectOverview(request.params.id)); } catch (error) { send(response, error); } });
  app.get('/api/projects/:id/documents', (request, response) => { try { response.json(projectDocuments(request.params.id)); } catch (error) { send(response, error); } });
  app.post('/api/projects/:id/scan', async (request, response, next) => { try { response.json(recordProjectScan(request.params.id, await dependencies.scan())); } catch (error) { next(error); } });
  app.post('/api/projects/suggestions/generate', async (_request, response) => {
    const settings = dependencies.settings(); if (!settings.aiEnabled || !settings.hasApiKey || !settings.vaultPath) { response.status(400).json({ message: !settings.vaultPath ? '请先到“资料库”选择 Obsidian 仓库位置。' : '请先到“设置 → 模型连接”开启大模型并填写当前电脑的 API Key。' }); return; }
    try { const scan = await dependencies.scan(); response.json({ suggestions: await dependencies.generateSuggestions(), scannedDocuments: scan.indexed, scannedChunks: scan.chunks, failedCount: scan.failed.length }); } catch (error) { send(response, error); }
  });
  app.post('/api/projects/suggestions/stream', async (request, response) => {
    begin(response); const signal = dependencies.requestSignal(request, response); const startedAt = Date.now();
    try {
      const settings = dependencies.settings(); if (!settings.aiEnabled || !settings.hasApiKey) throw new Error('请先到“设置 → 模型连接”开启大模型并填写当前电脑的 API Key。'); if (!settings.vaultPath) throw new Error('请先到“资料库”选择 Obsidian 仓库位置。');
      const scan = await dependencies.scan({ signal, onProgress: (progress) => write(response, { type: 'progress', scope: 'project-suggestions', ...progress, elapsedMs: Date.now() - startedAt }) });
      write(response, { type: 'stage', scope: 'project-suggestions', stage: 'analyzing', message: '资料索引已就绪，开始识别项目…', current: scan.indexed, total: scan.total, elapsedMs: Date.now() - startedAt });
      const suggestions = await dependencies.generateSuggestions(signal, (message) => write(response, { type: 'stage', scope: 'project-suggestions', stage: 'analyzing', message, current: scan.indexed, total: scan.total, elapsedMs: Date.now() - startedAt }));
      write(response, { type: 'complete', scope: 'project-suggestions', result: { suggestions, scannedDocuments: scan.indexed, scannedChunks: scan.chunks, failedCount: scan.failed.length }, elapsedMs: Date.now() - startedAt });
    } catch (error) { write(response, { type: signal.aborted ? 'cancelled' : 'error', scope: 'project-suggestions', message: error instanceof Error ? error.message : '项目识别失败。', elapsedMs: Date.now() - startedAt }); }
    response.end();
  });
  app.post('/api/projects/suggestions/confirm', (request, response) => { try { response.status(201).json(confirmProjectSuggestions(request.body?.suggestions, dependencies.settings().vaultPath)); } catch (error) { send(response, error); } });
}
