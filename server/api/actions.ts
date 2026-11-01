import type { Express } from 'express';
import { cancelAction, confirmAction, listActions, undoActionProposal } from '../actions/action-service.js';

export function registerActionRoutes(app: Express) {
  app.get('/api/actions', (request, response) => {
    const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : null;
    response.json(listActions(conversationId));
  });

  app.post('/api/actions/:id/cancel', (request, response) => {
    try { response.json(cancelAction(request.params.id)); } catch (error) { const status = Number((error as { statusCode?: number }).statusCode ?? 500); response.status(status).json({ message: error instanceof Error ? error.message : '取消失败。' }); }
  });

  app.post('/api/actions/:id/confirm', async (request, response, next) => {
    try {
      response.json(await confirmAction(request.params.id,{deviceId:request.body?.deviceId,computerCaller:request.body?.computerCaller}));
    } catch (error) { next(error); }
  });

  app.post('/api/actions/:id/undo', async (request, response, next) => {
    try { response.json(await undoActionProposal(request.params.id)); } catch (error) { next(error); }
  });
}
