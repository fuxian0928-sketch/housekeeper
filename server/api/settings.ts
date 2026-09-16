import type { Express } from 'express';
import type { SettingsService, SettingsUpdate } from '../domain/settings/settings-service.js';

type Dependencies = { settings: SettingsService; restartVaultWatcher: () => void; restartSync: () => void; testModel: () => Promise<string>; testRetrieval: () => Promise<string>; testWebSearch: () => Promise<string>; listModels: (input: { apiBaseUrl?: string; apiKey?: string }) => Promise<unknown> };

export function registerSettingsRoutes(app: Express, dependencies: Dependencies) {
  app.get('/api/settings', (_request, response) => response.json(dependencies.settings.current()));
  app.patch('/api/settings', (request, response) => {
    try { const body=request.body as SettingsUpdate; const changedVault = body.vaultPath !== undefined; const changedSync=changedVault || body.syncEnabled !== undefined || body.syncDeviceName !== undefined; const result = dependencies.settings.update(body); if (changedVault) dependencies.restartVaultWatcher(); if(changedSync) dependencies.restartSync(); response.json(result); }
    catch (error) { response.status(Number((error as { statusCode?: number }).statusCode ?? 500)).json({ message: error instanceof Error ? error.message : '设置保存失败。' }); }
  });
  app.post('/api/settings/test', async (_request, response) => {
    try { response.json({ ok: true, message: await dependencies.testModel() }); } catch (error) { response.status(400).json({ message: error instanceof Error ? `连接失败：${error.message}` : '连接失败。' }); }
  });
  app.post('/api/settings/test-retrieval', async (_request, response) => {
    try { response.json({ ok: true, message: await dependencies.testRetrieval() }); } catch (error) { response.status(400).json({ message: error instanceof Error ? `检索连接失败：${error.message}` : '检索连接失败。' }); }
  });
  app.post('/api/settings/test-web-search', async (_request, response) => {
    try { response.json({ ok: true, message: await dependencies.testWebSearch() }); } catch (error) { response.status(400).json({ message: error instanceof Error ? `搜索连接失败：${error.message}` : '搜索连接失败。' }); }
  });
  app.post('/api/settings/models', async (request, response) => {
    try { response.json(await dependencies.listModels(request.body as { apiBaseUrl?: string; apiKey?: string })); } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '模型列表读取失败。' }); }
  });
}
