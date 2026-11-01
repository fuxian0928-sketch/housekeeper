import type { Express, Response } from 'express';
import { acceptCentralDocument, centralBlob, centralSyncStatus, compareCentralManifest, deleteCentralDocument } from '../sync/central-document-service.js';
import {database} from '../db.js';

function sendError(response: Response, error: unknown) {
  const status = Number((error as { statusCode?: number })?.statusCode ?? 500);
  response.status(status).json({ message: error instanceof Error ? error.message : '设备文档同步失败。' });
}

export function registerDeviceSyncRoutes(app: Express, dependencies: { onDocumentAccepted?: (documentId: string) => void } = {}) {
  app.use('/api/device-sync',(request,response,next)=>{
    if(request.method==='POST'&&database.prepare("SELECT value FROM app_settings WHERE key='device_sync_suspended'").get()?.value==='1'){
      response.status(409).json({code:'LIBRARY_IMPORT_SUSPENDED',message:'资料库已初始化，旧设备自动导入已暂停。请重新选择要导入的资料后再启用。'});return;
    }
    next();
  });
  app.get('/api/device-sync/status', (_request, response) => response.json(centralSyncStatus()));
  app.post('/api/device-sync/manifest', (request, response) => {
    try { response.json(compareCentralManifest(request.body)); } catch (error) { sendError(response, error); }
  });
  app.post('/api/device-sync/documents', async (request, response) => {
    try {
      const result = await acceptCentralDocument(request.body);
      response.json(result);
      if (result.accepted && result.indexed?.documentId) dependencies.onDocumentAccepted?.(result.indexed.documentId);
    } catch (error) { sendError(response, error); }
  });
  app.post('/api/device-sync/delete', (request, response) => {
    try { response.json(deleteCentralDocument(request.body)); } catch (error) { sendError(response, error); }
  });
  app.get('/api/device-sync/blobs/:hash', async (request, response) => {
    try {
      const blob = await centralBlob(request.params.hash);
      response.setHeader('Content-Type', blob.mime_type);
      response.setHeader('Content-Length', String(blob.bytes));
      response.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
      response.send(blob.content);
    } catch (error) { sendError(response, error); }
  });
}
