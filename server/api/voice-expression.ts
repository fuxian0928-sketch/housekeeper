import type { Express } from 'express';
import { DEFAULT_VOICE_EXPRESSION, validateVoiceExpression, type VoiceExpression } from '../domain/settings/voice-expression.js';

export function readVoiceExpression(raw: string | undefined): VoiceExpression {
  try { return validateVoiceExpression(JSON.parse(raw ?? '')); } catch { return { ...DEFAULT_VOICE_EXPRESSION }; }
}
export function registerVoiceExpressionRoutes(app: Express, storage: { read: () => string | undefined; save: (value: string) => void }) {
  app.get('/api/voice/expression', (_request, response) => response.json(readVoiceExpression(storage.read())));
  app.put('/api/voice/expression', (request, response) => {
    let value: VoiceExpression;
    try { value = validateVoiceExpression(request.body); }
    catch (error) { response.status(400).json({ message: (error as Error).message }); return; }
    storage.save(JSON.stringify(value));
    response.json(value);
  });
}
