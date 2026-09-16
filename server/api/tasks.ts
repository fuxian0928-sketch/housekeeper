import type { Express } from 'express';
import { createTask, createTaskBatchProposal, listProjectTasks, updateTask, type TaskInput } from '../domain/tasks/task-service.js';

function sendError(response: Parameters<Express['get']>[1] extends never ? never : any, error: unknown) {
  const status = Number((error as { statusCode?: number }).statusCode ?? 500);
  response.status(status).json({ message: error instanceof Error ? error.message : '任务操作失败。' });
}

export function registerTaskRoutes(app: Express) {
  app.get('/api/projects/:id/tasks', (request, response) => response.json(listProjectTasks(request.params.id)));
  app.post('/api/projects/:id/task-batch-proposals', (request, response) => {
    try {
      const body = request.body as { tasks?: unknown; suggestionId?: string | null };
      response.status(201).json(createTaskBatchProposal(request.params.id, body?.tasks, body.suggestionId));
    } catch (error) { sendError(response, error); }
  });
  app.post('/api/projects/:id/tasks', (request, response) => {
    try { const result = createTask(request.params.id, request.body as TaskInput); response.status(result.created ? 201 : 200).json(result.task); } catch (error) { sendError(response, error); }
  });
  app.patch('/api/tasks/:id', (request, response) => {
    try { response.json(updateTask(request.params.id, request.body as TaskInput)); } catch (error) { sendError(response, error); }
  });
}
