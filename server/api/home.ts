import type { Express } from 'express';
import { buildHomeSnapshot } from '../domain/home/home-service.js';

export function registerHomeRoutes(app: Express) {
  app.get('/api/home', (_request, response) => response.json(buildHomeSnapshot()));
}
