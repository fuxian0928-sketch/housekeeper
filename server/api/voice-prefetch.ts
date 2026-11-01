import type { Express } from 'express';
import { VoicePrefetchCandidates } from '../domain/memories/voice-prefetch-candidates.js';

export function registerVoicePrefetchRoutes(app: Express, candidates: VoicePrefetchCandidates) {
  let active = 0;
  app.post('/api/voice/memory-prefetch', async (request, response) => {
    if (active >= 2) {
      response.status(429).json({ message: '预取繁忙，正式回答将正常检索。' });
      return;
    }
    active++;
    const controller = new AbortController();
    const rejectCandidate = () => {
      if (!response.destroyed && !response.writableEnded) {
        response.status(409).json({ message: '预取未采用，正式回答将正常检索。' });
      }
    };
    const timer = setTimeout(() => {
      controller.abort();
      rejectCandidate();
    }, 1000);
    const cancel = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', cancel);
    try {
      const result = await candidates.prepare(request.body, controller.signal);
      if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) response.json(result);
    } catch {
      rejectCandidate();
    } finally {
      // Hold physical capacity until the provider settles, even after HTTP timeout.
      clearTimeout(timer);
      response.off('close', cancel);
      active--;
    }
  });
}
