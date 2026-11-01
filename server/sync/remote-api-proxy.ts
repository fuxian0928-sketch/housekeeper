import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';
import type { SettingsService, SettingsUpdate } from '../domain/settings/settings-service.js';
import type { CentralSyncClient } from './central-sync-client.js';

const localSettingKeys = new Set<keyof SettingsUpdate>(['vaultPath', 'syncEnabled', 'syncDeviceName']);
const nativeConnectionKeys = [
  'speechServiceBaseUrl', 'speechRealtimeRecognitionModel',
  'speechRealtimeSynthesisBaseUrl', 'speechRealtimeSynthesisModel', 'speechRealtimeVoice'
] as const;

function mirrorNativeConnection(settings: SettingsService, remoteSettings: Record<string, unknown>) {
  const connection: SettingsUpdate = {};
  const local = settings.current();
  const execution = remoteSettings.speechExecution === 'local' ? 'local' : 'cloud';
  if (execution !== local.speechExecution) connection.speechExecution = execution;
  for (const key of nativeConnectionKeys) {
    if (typeof remoteSettings[key] !== 'string') throw new Error(`中央语音配置缺少 ${key}，本机语音未切换到旧配置。`);
    if (remoteSettings[key] !== local[key]) (connection as Record<string, string>)[key] = remoteSettings[key];
  }
  if (Object.keys(connection).length) settings.update(connection);
}

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

async function remoteFetch(request: Request, signal: AbortSignal, override?: { path?: string; method?: string; body?: unknown }) {
  const remote = remoteConfiguration();
  const path = override?.path ?? request.originalUrl;
  const method = override?.method ?? request.method;
  const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase());
  const deviceContext=(globalThis as typeof globalThis & {__AI_SECRETARY_DEVICE_CONTEXT__?:()=>Record<string,unknown>}).__AI_SECRETARY_DEVICE_CONTEXT__?.();
  const originalBody=override&&'body' in override?override.body:request.body??{};
  const bound=/^\/api\/(?:chat\/stream|agent\/runs(?:\/[^/]+\/continue)?|actions\/[^/]+\/(?:confirm|cancel))$/.test(path.split('?')[0]);
  const body=bound&&deviceContext?{...originalBody as object,...deviceContext}:originalBody;
  return fetch(`${remote.url}${path}`, {
    method,
    headers: remoteHeaders(remote.token, hasBody),
    body: hasBody ? JSON.stringify(body) : undefined,
    signal
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
  await pipeline(Readable.fromWeb(remote.body as never), response);
}

export function registerRemoteApiProxy(app: Express, settings: SettingsService, centralSync: CentralSyncClient) {
  const remote = remoteConfiguration();
  if (!remote.url) return;

  void (async () => {
    const response = await fetch(`${remote.url}/api/settings`, { headers: remoteHeaders(remote.token), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return;
    const current = await response.json() as { hasApiKey?: boolean; hasRetrievalApiKey?: boolean; hasWebSearchApiKey?: boolean;hasVisionApiKey?:boolean };
    const update: Record<string, string> = {};
    if (!current.hasApiKey && settings.effectiveApiKey()) update.apiKey = settings.effectiveApiKey()!;
    if (!current.hasRetrievalApiKey && settings.effectiveRetrievalApiKey()) update.retrievalApiKey = settings.effectiveRetrievalApiKey()!;
    if (!current.hasWebSearchApiKey && settings.effectiveWebSearchApiKey()) update.webSearchApiKey = settings.effectiveWebSearchApiKey()!;
    const local=settings.current();
    if(current.hasVisionApiKey===false&&local.visionApiKeySource!=='fallback'&&settings.effectiveVisionApiKey()){
      update.visionApiKey=settings.effectiveVisionApiKey()!;update.visionApiBaseUrl=local.visionApiBaseUrl||local.apiBaseUrl;update.visionModel=local.visionModel;
    }
    if (!Object.keys(update).length) return;
    await fetch(`${remote.url}/api/settings`, { method: 'PATCH', headers: remoteHeaders(remote.token, true), body: JSON.stringify(update), signal: AbortSignal.timeout(30_000) });
  })().catch(() => undefined);

  app.get('/api/settings', async (_request, response) => {
    try {
      const remoteResponse = await fetch(`${remote.url}/api/settings`, { headers: remoteHeaders(remote.token), signal: AbortSignal.timeout(30_000) });
      const remoteSettings = await remoteResponse.json() as Record<string, unknown>;
      if (!remoteResponse.ok) throw new Error(String(remoteSettings.message ?? `中央服务器返回 ${remoteResponse.status}`));
      mirrorNativeConnection(settings, remoteSettings);
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
      mirrorNativeConnection(settings, remoteSettings);
      response.json({ ...remoteSettings, vaultPath: local.vaultPath, vaultLastScannedAt: local.vaultLastScannedAt, syncEnabled: local.syncEnabled, syncDeviceName: local.syncDeviceName });
    } catch (error) { response.status(502).json({ message: error instanceof Error ? error.message : '中央设置保存失败。' }); }
  });

  app.use('/api', async (request, response, next) => {
    if (isLocalDeviceRoute(request.originalUrl.split('?')[0])) { next(); return; }
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', cancel);
    const budget = request.originalUrl.split('?')[0] === '/api/speech/synthesize' ? 20_000 : 600_000;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(budget)]);
    try { await sendRemote(response, await remoteFetch(request, signal)); }
    catch (error) {
      if (!controller.signal.aborted && !response.destroyed && !response.headersSent) response.status(502).json({ message: error instanceof Error ? `中央服务器连接失败：${error.message}` : '中央服务器连接失败。' });
    } finally { response.removeListener('close', cancel); }
  });
}
