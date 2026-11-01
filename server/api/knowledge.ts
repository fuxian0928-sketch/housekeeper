import type { Express, Request, Response } from 'express';
import type { ScanProgress, ScanResult } from '../vault.js';
import { createKnowledgeDocument, getKnowledgeDocument, getKnowledgeDocumentVersion, listKnowledgeDocumentVersions, setProjectDocumentLink, setTaskDocumentLink, updateKnowledgeDocument } from '../domain/documents/knowledge-document-editor.js';
import { importOfficeDocument, listOfficeImports, officeCapabilityStatus } from '../domain/documents/office-document-parser.js';
import {fileCapabilityStatus,importUploadedFile} from '../domain/documents/uploaded-files.js';
import {registerRagRoutes} from '../retrieval/rag-api.js';

type Settings = { retrievalApiBaseUrl: string; embeddingModel: string; hasRetrievalApiKey: boolean; vaultPath: string; knowledgeDocumentCount: number; knowledgeChunkCount: number };
type Dependencies = {
  settings: () => Settings;
  scan: (options?: { signal?: AbortSignal; onProgress?: (progress: ScanProgress) => void }) => Promise<ScanResult>;
  rebuildSemantic: (signal?: AbortSignal) => Promise<unknown>;
  listDocuments: () => unknown;
  requestSignal: (request: Request, response: Response) => AbortSignal;
};

function begin(response: Response) {
  response.status(200); response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); response.setHeader('Cache-Control', 'no-cache, no-transform'); response.setHeader('X-Accel-Buffering', 'no'); response.flushHeaders();
}
function write(response: Response, event: Record<string, unknown>) { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(event)}\n`); }

export function registerKnowledgeRoutes(app: Express, dependencies: Dependencies) {
  registerRagRoutes(app,dependencies.requestSignal);
  app.post('/api/knowledge/scan', async (_request, response, next) => { try { response.json({ ...(await dependencies.scan()), settings: dependencies.settings() }); } catch (error) { next(error); } });
  app.post('/api/knowledge/semantic-index', async (request, response, next) => { try { if (!dependencies.settings().hasRetrievalApiKey) throw new Error('建立 BGE-M3 语义索引前，请先配置检索模型 API Key。'); response.json(await dependencies.rebuildSemantic(dependencies.requestSignal(request, response))); } catch (error) { next(error); } });
  app.post('/api/knowledge/scan/stream', async (request, response) => {
    begin(response);
    const signal = dependencies.requestSignal(request, response);
    const startedAt = Date.now();
    try {
      const result = await dependencies.scan({ signal, onProgress: (progress) => write(response, { type: 'progress', scope: 'knowledge', ...progress, elapsedMs: Date.now() - startedAt }) });
      write(response, { type: 'complete', scope: 'knowledge', result: { ...result, settings: dependencies.settings() }, elapsedMs: Date.now() - startedAt });
    } catch (error) { write(response, { type: signal.aborted ? 'cancelled' : 'error', scope: 'knowledge', message: error instanceof Error ? error.message : '资料读取失败。', elapsedMs: Date.now() - startedAt }); }
    response.end();
  });
  app.get('/api/knowledge/documents', (_request, response) => response.json(dependencies.listDocuments()));
  app.get('/api/knowledge/capabilities', (_request, response) => response.json([officeCapabilityStatus(),fileCapabilityStatus()]));
  app.post('/api/knowledge/import-file',async(request,response,next)=>{
    try{response.status(201).json(await importUploadedFile(request.body??{},dependencies.requestSignal(request,response)));}catch(error){next(error);}
  });
  app.get('/api/knowledge/office-imports', (_request, response) => response.json(listOfficeImports()));
  app.post('/api/knowledge/import-office', async (request, response, next) => {
    try {
      const result = await importOfficeDocument(request.body ?? {});
      response.status(201).json(result);
    } catch (error) { next(error); }
  });
  app.get('/api/knowledge/documents/:id', (request, response, next) => { try { response.json(getKnowledgeDocument(request.params.id)); } catch (error) { next(error); } });
  app.post('/api/knowledge/documents', (request, response, next) => { try { response.status(201).json(createKnowledgeDocument(request.body)); } catch (error) { next(error); } });
  app.patch('/api/knowledge/documents/:id', (request, response, next) => { try { response.json(updateKnowledgeDocument(request.params.id, request.body)); } catch (error) { next(error); } });
  app.get('/api/knowledge/documents/:id/versions', (request, response, next) => { try { response.json(listKnowledgeDocumentVersions(request.params.id)); } catch (error) { next(error); } });
  app.get('/api/knowledge/documents/:id/versions/:revision',(request,response,next)=>{try{response.json(getKnowledgeDocumentVersion(request.params.id,Number(request.params.revision)));}catch(error){next(error);}});
  app.put('/api/projects/:projectId/documents/:documentId', (request, response, next) => { try { response.json(setProjectDocumentLink(request.params.projectId, request.params.documentId, true)); } catch (error) { next(error); } });
  app.delete('/api/projects/:projectId/documents/:documentId', (request, response, next) => { try { response.json(setProjectDocumentLink(request.params.projectId, request.params.documentId, false)); } catch (error) { next(error); } });
  app.put('/api/tasks/:taskId/documents/:documentId', (request, response, next) => { try { response.json(setTaskDocumentLink(request.params.taskId, request.params.documentId, true)); } catch (error) { next(error); } });
  app.delete('/api/tasks/:taskId/documents/:documentId', (request, response, next) => { try { response.json(setTaskDocumentLink(request.params.taskId, request.params.documentId, false)); } catch (error) { next(error); } });
}
