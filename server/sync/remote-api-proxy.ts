import { Readable } from 'node:stream';
import type { Express, Request, Response } from 'express';
import type { SettingsService, SettingsUpdate } from '../domain/settings/settings-service.js';
import type { CentralSyncClient } from './central-sync-client.js';

const localSettingKeys = new Set<keyof SettingsUpdate>(['vaultPath', 'syncEnabled', 'syncDeviceName']);

function remoteConfiguration() {
  return {
    url: String(process.env.AI_SECRETARY_REMOTE_URL ?? '').trim().replace(/\/+$/, ''),
    token: String(process.env.AI_SECRETARY_REMOTE_TOKEN ?? '').trim()
  };
}

function remoteHeaders(token: string, json = false) {
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

export function isLocalDeviceRoute(path: string) {
  return path === '/api/health' || path === '/api/settings' || path.startsWith('/api/sync/');
}

async function remoteFetch(request: Request, override?: { path?: string; method?: string; body?: unknown }) {
  const remote = remoteConfiguration();
  const path = override?.path ?? request.originalUrl;
  const method = override?.method ?? request.method;
  const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase());
  return fetch(`${remote.url}${path}`, {
    method,
    headers: remoteHeaders(remote.token, hasBody),
    body: hasBody ? JSON.stringify(override && 'body' in override ? override.body : request.body ?? {}) : undefined,
    signal: AbortSignal.timeout(600_000)
  });
}

async function sendRemote(response: Response, remote: globalThis.Response) {
  response.status(remote.status);
  response.setHeader('X-AI-Secretary-Execution', 'central-server');
  for (const header of ['content-type', 'cache-control', 'content-disposition']) {
    const value = remote.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  if (!remote.body) { response.end(); return; }
  Readable.fromWeb(remote.body as never).pipe(response);
}

export function registerRemoteApiProxy(app: Express, settings: SettingsService, centralSync: CentralSyncClient) {
  const remote = remoteConfiguration();
  if (!remote.url) return;

  void (async () => {
    const response = await fetch(`${remote.url}/api/settings`, { headers: remoteHeaders(remote.token), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return;
    const current = await response.json() as { hasApiKey?: boolean; hasRetrievalApiKey?: boolean; hasWebSearchApiKey?: boolean };
    const update: Record<string, string> = {};
    if (!current.hasApiKey && settings.effectiveApiKey()) update.apiKey = settings.effectiveApiKey()!;
    if (!current.hasRetrievalApiKey && settings.effectiveRetrievalApiKey()) update.retrievalApiKey = settings.effectiveRetrievalApiKey()!;
    if (!current.hasWebSearchApiKey && settings.effectiveWebSearchApiKey()) update.webSearchApiKey = settings.effectiveWebSearchApiKey()!;
    if (!Object.keys(update).length) return;
    await fetch(`${remote.url}/api/settings`, { method: 'PATCH', headers: remoteHeaders(remote.token, true), body: JSON.stringify(update), signal: AbortSignal.timeout(30_000) });
  })().catch(() => undefined);

  app.get('/api/settings', async (_request, response) => {
    try {
      const remoteResponse = await fetch(`${remote.url}/api/settings`, { headers: remoteHeaders(remote.token), signal: AbortSignal.timeout(30_000) });
      const remoteSettings = await remoteResponse.json() as Record<string, unknown>;
      if (!remoteResponse.ok) throw new Error(String(remoteSettings.message ?? `中央服务器返回 ${remoteResponse.status}`));
      const local = settings.current();
      response.json({ ...remoteSettings, vaultPath: local.vaultPath, vaultLastScannedAt: local.vaultLastScannedAt, syncEnabled: local.syncEnabled, syncDeviceName: local.syncDeviceName });
    } catch (error) { response.status(502).json({ message: error instanceof Error ? error.message : '中央设置读取失败。' }); }
  });

  app.patch('/api/settings', async (request, response) => {
    try {
      const body = request.body as SettingsUpdate;
      const localBody = Object.fromEntries(Object.entries(body).filter(([key]) => localSettingKeys.has(key as keyof SettingsUpdate))) as SettingsUpdate;
      const remoteBody = Object.fromEntries(Object.entries(body).filter(([key]) => !localSettingKeys.has(key as keyof SettingsUpdate)));
      const local = Object.keys(localBody).length ? settings.update(localBody) : settings.current();
      if (localBody.vaultPath !== undefined || localBody.syncEnabled !== undefined || localBody.syncDeviceName !== undefined) centralSync.restart();
      const remoteResponse = Object.keys(remoteBody).length
        ? await fetch(`${remote.url}/api/settings`, { method: 'PATCH', headers: remoteHeaders(remote.token, true), body: JSON.stringify(remoteBody), signal: AbortSignal.timeout(30_000) })
        : await fetch(`${remote.url}/api/settings`, { headers: remoteHeaders(remote.token), signal: AbortSignal.timeout(30_000) });
      const remoteSettings = await remoteResponse.json() as Record<string, unknown>;
      if (!remoteResponse.ok) throw new Error(String(remoteSettings.message ?? `中央服务器返回 ${remoteResponse.status}`));
      response.json({ ...remoteSettings, vaultPath: local.vaultPath, vaultLastScannedAt: local.vaultLastScannedAt, syncEnabled: local.syncEnabled, syncDeviceName: local.syncDeviceName });
    } catch (error) { response.status(502).json({ message: error instanceof Error ? error.message : '中央设置保存失败。' }); }
  });

  app.use('/api', async (request, response, next) => {
    if (isLocalDeviceRoute(request.originalUrl.split('?')[0])) { next(); return; }
    try { await sendRemote(response, await remoteFetch(request)); }
    catch (error) { if (!response.headersSent) response.status(502).json({ message: error instanceof Error ? `中央服务器连接失败：${error.message}` : '中央服务器连接失败。' }); }
  });
}
