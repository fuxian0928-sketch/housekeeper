import type { Express, Response } from 'express';
type SyncService = { status: () => Record<string, unknown>; run: () => Promise<Record<string, unknown>> };

function send(response: Response, error: unknown) {
  response.status(Number((error as { statusCode?: number }).statusCode ?? 500)).json({ message: error instanceof Error ? error.message : '设备同步失败。' });
}

export function registerSyncRoutes(app: Express, sync: SyncService) {
  app.get('/api/sync/status', (_request, response) => response.json(sync.status()));
  app.post('/api/sync/run', async (_request, response) => {
    try { response.json({ ...(await sync.run()), status: sync.status() }); } catch (error) { send(response, error); }
  });
}
